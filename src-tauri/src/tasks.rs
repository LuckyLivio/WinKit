use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const TASK_PROGRESS_EVENT: &str = "winkit://task-progress";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskLifecycleState {
    Running,
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressPayload {
    pub task_id: String,
    pub tool_id: String,
    pub state: TaskLifecycleState,
    pub processed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTaskSummary {
    pub task_id: String,
    pub tool_id: String,
    pub interruptible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRegistrySnapshot {
    pub shutting_down: bool,
    pub active_count: usize,
    pub interruptible_count: usize,
    pub write_finishing_count: usize,
    pub tasks: Vec<ActiveTaskSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownDrainResult {
    pub ready_to_close: bool,
    pub remaining_tasks: Vec<ActiveTaskSummary>,
}

struct TaskEntry {
    tool_id: String,
    interruptible: bool,
    cancel_flag: Arc<AtomicBool>,
}

#[derive(Default)]
struct RegistryInner {
    shutting_down: bool,
    active: HashMap<String, TaskEntry>,
}

#[derive(Clone, Default)]
pub struct TaskRegistry {
    state: Arc<(Mutex<RegistryInner>, Condvar)>,
}

impl TaskRegistry {
    /// Registers a background task or output write operation.
    /// Rejects new tasks if the application is currently draining for shutdown.
    pub fn register_checked(
        &self,
        task_id: &str,
        tool_id: &str,
        interruptible: bool,
    ) -> Result<TaskTokenGuard, AppError> {
        let (lock, _) = &*self.state;
        let mut inner = lock.lock().expect("task registry mutex poisoned");
        if inner.shutting_down {
            return Err(AppError::new(
                "APP_SHUTTING_DOWN",
                "Application is shutting down; new tasks cannot be started.",
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        inner.active.insert(
            task_id.to_string(),
            TaskEntry {
                tool_id: tool_id.to_string(),
                interruptible,
                cancel_flag: Arc::clone(&flag),
            },
        );
        Ok(TaskTokenGuard {
            task_id: task_id.to_string(),
            flag,
            registry: self.clone(),
        })
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        let (lock, _) = &*self.state;
        let inner = lock.lock().expect("task registry mutex poisoned");
        if let Some(entry) = inner.active.get(task_id) {
            entry.cancel_flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn running_count(&self) -> usize {
        let (lock, _) = &*self.state;
        let inner = lock.lock().expect("task registry mutex poisoned");
        inner.active.len()
    }

    pub fn snapshot(&self) -> TaskRegistrySnapshot {
        let (lock, _) = &*self.state;
        let inner = lock.lock().expect("task registry mutex poisoned");
        Self::build_snapshot(&inner)
    }

    /// Enters draining shutdown mode, requests cancellation on all active tasks, and blocks the
    /// caller thread (via Condvar, releasing the mutex while waiting so `TaskTokenGuard::drop`
    /// never deadlocks) until all active tasks finish and drop their guards, or `timeout` elapses.
    pub fn begin_shutdown_and_drain(&self, timeout: Duration) -> ShutdownDrainResult {
        let (lock, cvar) = &*self.state;
        let mut inner = lock.lock().expect("task registry mutex poisoned");
        inner.shutting_down = true;
        for entry in inner.active.values() {
            entry.cancel_flag.store(true, Ordering::SeqCst);
        }

        let deadline = Instant::now() + timeout;
        while !inner.active.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(now);
            let (guard, wait_res) = cvar
                .wait_timeout(inner, remaining)
                .expect("task registry condvar poisoned");
            inner = guard;
            if wait_res.timed_out() {
                break;
            }
        }

        if inner.active.is_empty() {
            ShutdownDrainResult {
                ready_to_close: true,
                remaining_tasks: Vec::new(),
            }
        } else {
            // Timed out: restore `shutting_down = false` so the window remains operable if user stays
            inner.shutting_down = false;
            let snap = Self::build_snapshot(&inner);
            ShutdownDrainResult {
                ready_to_close: false,
                remaining_tasks: snap.tasks,
            }
        }
    }

    /// Resets `shutting_down` if a window destroy call failed after draining so user is not stuck.
    pub fn abort_shutdown(&self) {
        let (lock, _) = &*self.state;
        let mut inner = lock.lock().expect("task registry mutex poisoned");
        inner.shutting_down = false;
    }

    fn build_snapshot(inner: &RegistryInner) -> TaskRegistrySnapshot {
        let mut interruptible_count = 0usize;
        let mut write_finishing_count = 0usize;
        let mut tasks: Vec<ActiveTaskSummary> = inner
            .active
            .iter()
            .map(|(id, entry)| {
                if entry.interruptible {
                    interruptible_count += 1;
                } else {
                    write_finishing_count += 1;
                }
                ActiveTaskSummary {
                    task_id: id.clone(),
                    tool_id: entry.tool_id.clone(),
                    interruptible: entry.interruptible,
                }
            })
            .collect();
        tasks.sort_by(|a, b| a.task_id.cmp(&b.task_id));

        TaskRegistrySnapshot {
            shutting_down: inner.shutting_down,
            active_count: tasks.len(),
            interruptible_count,
            write_finishing_count,
            tasks,
        }
    }

    fn remove_and_notify(&self, task_id: &str) {
        let (lock, cvar) = &*self.state;
        let mut inner = lock.lock().expect("task registry mutex poisoned");
        inner.active.remove(task_id);
        cvar.notify_all();
    }
}

pub struct TaskTokenGuard {
    task_id: String,
    flag: Arc<AtomicBool>,
    registry: TaskRegistry,
}

impl TaskTokenGuard {
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }
}

impl Drop for TaskTokenGuard {
    fn drop(&mut self) {
        self.registry.remove_and_notify(&self.task_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn task_registry_tracks_lifecycle_and_cancellation() {
        let reg = TaskRegistry::default();
        assert_eq!(reg.running_count(), 0);

        {
            let guard = reg
                .register_checked("hash-001", "D03", true)
                .expect("register");
            assert_eq!(reg.running_count(), 1);
            assert!(!guard.is_cancelled());

            assert!(reg.cancel("hash-001"));
            assert!(guard.is_cancelled());
            assert!(!reg.cancel("non-existent"));
        }

        assert_eq!(reg.running_count(), 0);
    }

    #[test]
    fn shutdown_drain_waits_for_worker_drop_without_deadlock_and_blocks_new_tasks() {
        let reg = TaskRegistry::default();
        let worker_guard = reg
            .register_checked("worker-1", "D03", true)
            .expect("register worker");

        let reg_for_worker = reg.clone();
        let handle = thread::spawn(move || {
            // Wait until shutdown signals cancellation, then simulate 60ms of handle/temp cleanup before Drop
            while !worker_guard.is_cancelled() {
                thread::sleep(Duration::from_millis(5));
            }
            // While draining, new task registrations must be rejected
            let blocked = reg_for_worker.register_checked("new-during-drain", "I03", false);
            assert!(blocked.is_err());

            thread::sleep(Duration::from_millis(60));
            drop(worker_guard);
        });

        let start = Instant::now();
        let drain = reg.begin_shutdown_and_drain(Duration::from_secs(2));
        let elapsed = start.elapsed();

        assert!(drain.ready_to_close);
        assert!(drain.remaining_tasks.is_empty());
        assert!(elapsed >= Duration::from_millis(50));
        assert_eq!(reg.running_count(), 0);
        handle.join().expect("worker joined");
    }

    #[test]
    fn shutdown_drain_timeout_preserves_operability_and_reports_stuck_tasks() {
        let reg = TaskRegistry::default();
        let _stuck_guard = reg
            .register_checked("stuck-io", "I03", false)
            .expect("register stuck");

        let drain = reg.begin_shutdown_and_drain(Duration::from_millis(40));
        assert!(!drain.ready_to_close);
        assert_eq!(drain.remaining_tasks.len(), 1);
        assert_eq!(drain.remaining_tasks[0].task_id, "stuck-io");

        // After timeout, shutting_down resets to false so user can still interact or retry
        assert!(!reg.snapshot().shutting_down);
    }
}
