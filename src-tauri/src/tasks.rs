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

#[derive(Debug, Clone, PartialEq, Serialize)]
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

impl TaskProgressPayload {
    pub fn running(
        task_id: impl Into<String>,
        tool_id: impl Into<String>,
        total_bytes: Option<u64>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            tool_id: tool_id.into(),
            state: TaskLifecycleState::Running,
            processed_bytes: 0,
            total_bytes,
            percent: None,
            error_code: None,
            error_message: None,
        }
    }

    pub fn completed(
        task_id: impl Into<String>,
        tool_id: impl Into<String>,
        completed_bytes: u64,
        total_bytes: Option<u64>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            tool_id: tool_id.into(),
            state: TaskLifecycleState::Completed,
            processed_bytes: completed_bytes,
            total_bytes: total_bytes.or(Some(completed_bytes)),
            percent: Some(100.0),
            error_code: None,
            error_message: None,
        }
    }

    pub fn failed_or_cancelled(
        task_id: impl Into<String>,
        tool_id: impl Into<String>,
        known_processed_bytes: u64,
        total_bytes: Option<u64>,
        err: &AppError,
    ) -> Self {
        let state = if err.code == "TASK_CANCELLED" {
            TaskLifecycleState::Cancelled
        } else {
            TaskLifecycleState::Error
        };
        let percent = match total_bytes {
            Some(t) if t > 0 && known_processed_bytes > 0 => {
                Some(((known_processed_bytes as f64 / t as f64) * 100.0).clamp(0.0, 99.99))
            }
            _ => None,
        };
        Self {
            task_id: task_id.into(),
            tool_id: tool_id.into(),
            state,
            processed_bytes: known_processed_bytes,
            total_bytes,
            percent,
            error_code: Some(err.code.to_string()),
            error_message: Some(err.message.clone()),
        }
    }
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
pub struct CloseRequestDecision {
    pub immediate_close_allowed: bool,
    pub snapshot: TaskRegistrySnapshot,
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
            tool_id: tool_id.to_string(),
            flag,
            registry: self.clone(),
        })
    }

    pub fn ensure_not_shutting_down(&self) -> Result<(), AppError> {
        let (lock, _) = &*self.state;
        let inner = lock.lock().expect("task registry mutex poisoned");
        if inner.shutting_down {
            return Err(AppError::new(
                "APP_SHUTTING_DOWN",
                "Application is shutting down; new tasks cannot be started.",
            ));
        }
        Ok(())
    }

    /// Evaluates a native window close request atomically under the registry mutex:
    /// - When no tasks are active, atomically sets `shutting_down = true` in the same critical
    ///   section so no subsequent task can slip in while the window is being destroyed.
    /// - When active tasks exist, leaves `shutting_down = false` and does NOT prematurely cancel
    ///   tasks before the user confirms exit in the UI.
    pub fn evaluate_close_request(&self) -> CloseRequestDecision {
        let (lock, _) = &*self.state;
        let mut inner = lock.lock().expect("task registry mutex poisoned");
        if inner.active.is_empty() {
            inner.shutting_down = true;
            let snapshot = Self::build_snapshot(&inner);
            CloseRequestDecision {
                immediate_close_allowed: true,
                snapshot,
            }
        } else {
            let snapshot = Self::build_snapshot(&inner);
            CloseRequestDecision {
                immediate_close_allowed: false,
                snapshot,
            }
        }
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
            if entry.interruptible {
                entry.cancel_flag.store(true, Ordering::SeqCst);
            }
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
    tool_id: String,
    flag: Arc<AtomicBool>,
    registry: TaskRegistry,
}

impl TaskTokenGuard {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn tool_id(&self) -> &str {
        &self.tool_id
    }

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
    use std::sync::{mpsc, Barrier};
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

    #[test]
    fn shutdown_drain_cancels_interruptible_tasks_while_letting_uninterruptible_writes_finish() {
        let reg = TaskRegistry::default();
        let read_guard = reg
            .register_checked("stream-hash", "D03", true)
            .expect("register interruptible");
        let write_guard = reg
            .register_checked("atomic-export", "I03", false)
            .expect("register uninterruptible write");

        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(35));
            // Interruptible task receives cancellation, whereas uninterruptible short write does not
            assert!(read_guard.is_cancelled());
            assert!(!write_guard.is_cancelled());
            drop(read_guard);
            thread::sleep(Duration::from_millis(25));
            drop(write_guard);
        });

        let res = reg.begin_shutdown_and_drain(Duration::from_secs(2));
        assert!(res.ready_to_close);
        handle.join().expect("joined");
    }

    #[test]
    fn pre_worker_admitted_task_blocks_idle_close_without_premature_cancellation() {
        let reg = TaskRegistry::default();
        // Command synchronously registers guard BEFORE background worker begins execution
        let pre_queued_guard = reg
            .register_checked("save-text-queued", "D01", false)
            .expect("admitted before worker starts");

        let (allow_worker_tx, allow_worker_rx) = mpsc::channel::<()>();
        let (worker_waiting_tx, worker_waiting_rx) = mpsc::channel::<()>();

        let worker = thread::spawn(move || {
            worker_waiting_tx
                .send(())
                .expect("signal worker blocked before execution");
            allow_worker_rx.recv().expect("wait to execute");
            assert!(!pre_queued_guard.is_cancelled());
            drop(pre_queued_guard);
        });

        // Worker has not started writing yet when native close arrives
        worker_waiting_rx.recv().expect("worker parked");
        let decision = reg.evaluate_close_request();
        assert!(!decision.immediate_close_allowed);
        assert_eq!(decision.snapshot.active_count, 1);
        assert_eq!(decision.snapshot.write_finishing_count, 1);
        assert!(!decision.snapshot.shutting_down);

        // User confirms exit -> drain waits until worker finishes and drops guard
        let reg_drain = reg.clone();
        let drain_handle =
            thread::spawn(move || reg_drain.begin_shutdown_and_drain(Duration::from_secs(2)));

        allow_worker_tx.send(()).expect("release worker");
        worker.join().expect("worker joined");
        let drain = drain_handle.join().expect("drain joined");
        assert!(drain.ready_to_close);
        assert!(reg.snapshot().shutting_down);
    }

    #[test]
    fn concurrent_close_evaluation_and_task_registration_are_strictly_mutually_exclusive() {
        // Test simultaneous Barrier release: never allow both immediate_close_allowed == true AND task admitted
        for round in 0..8 {
            let reg = TaskRegistry::default();
            let barrier = Arc::new(Barrier::new(2));

            let reg_close = reg.clone();
            let b_close = Arc::clone(&barrier);
            let close_thread = thread::spawn(move || {
                b_close.wait();
                reg_close.evaluate_close_request()
            });

            let reg_task = reg.clone();
            let b_task = Arc::clone(&barrier);
            let task_id = format!("race-task-{round}");
            let task_thread = thread::spawn(move || {
                b_task.wait();
                reg_task.register_checked(&task_id, "D01", false)
            });

            let decision = close_thread.join().expect("close thread");
            let reg_result = task_thread.join().expect("task thread");

            match (decision.immediate_close_allowed, reg_result) {
                (true, Err(err)) => {
                    assert_eq!(err.code, "APP_SHUTTING_DOWN");
                    assert!(decision.snapshot.shutting_down);
                    assert_eq!(reg.running_count(), 0);
                }
                (false, Ok(guard)) => {
                    assert_eq!(decision.snapshot.active_count, 1);
                    assert!(!decision.snapshot.shutting_down);
                    drop(guard);
                    assert_eq!(reg.running_count(), 0);
                }
                (allowed, res) => panic!(
                    "Broken shutdown admission invariant: immediate_close_allowed={allowed}, task_ok={}",
                    res.is_ok()
                ),
            }
        }
    }

    #[test]
    fn abort_shutdown_after_destroy_failure_restores_task_admission() {
        let reg = TaskRegistry::default();
        let decision = reg.evaluate_close_request();
        assert!(decision.immediate_close_allowed);
        assert!(decision.snapshot.shutting_down);

        // While shutting_down == true, new tasks are rejected
        let rejected = reg.register_checked("rejected-1", "D02", false);
        assert_eq!(rejected.err().map(|e| e.code), Some("APP_SHUTTING_DOWN"));

        // Simulated window.destroy() failure triggers abort_shutdown()
        reg.abort_shutdown();
        assert!(!reg.snapshot().shutting_down);

        let admitted = reg
            .register_checked("admitted-after-recovery", "D02", false)
            .expect("task admission restored");
        assert_eq!(admitted.tool_id(), "D02");
        drop(admitted);
    }

    #[test]
    fn progress_payload_constructors_preserve_accurate_terminal_fields() {
        let ok_ev = TaskProgressPayload::completed("t-ok", "D01", 512, Some(512));
        assert_eq!(ok_ev.state, TaskLifecycleState::Completed);
        assert_eq!(ok_ev.processed_bytes, 512);
        assert_eq!(ok_ev.total_bytes, Some(512));
        assert_eq!(ok_ev.percent, Some(100.0));
        assert_eq!(ok_ev.error_code, None);
        assert_eq!(ok_ev.error_message, None);

        let err = AppError::target_exists();
        let err_ev = TaskProgressPayload::failed_or_cancelled("t-err", "D01", 0, Some(512), &err);
        assert_eq!(err_ev.state, TaskLifecycleState::Error);
        assert_eq!(err_ev.processed_bytes, 0);
        assert_eq!(err_ev.total_bytes, Some(512));
        assert_eq!(err_ev.percent, None);
        assert_eq!(err_ev.error_code.as_deref(), Some("TARGET_ALREADY_EXISTS"));
        assert!(err_ev.error_message.is_some());

        let cancel_err = AppError::cancelled();
        let cancel_partial = TaskProgressPayload::failed_or_cancelled(
            "t-cancel",
            "D03",
            262_144,
            Some(1_048_576),
            &cancel_err,
        );
        assert_eq!(cancel_partial.state, TaskLifecycleState::Cancelled);
        assert_eq!(cancel_partial.processed_bytes, 262_144);
        assert_eq!(cancel_partial.percent, Some(25.0));
        assert_eq!(cancel_partial.error_code.as_deref(), Some("TASK_CANCELLED"));
        assert!(cancel_partial.error_message.is_some());
    }
}
