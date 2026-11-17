use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

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

#[derive(Default, Clone)]
pub struct TaskRegistry {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl TaskRegistry {
    pub fn register(&self, task_id: &str) -> TaskTokenGuard {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = self.active.lock().expect("task registry mutex poisoned");
        guard.insert(task_id.to_string(), Arc::clone(&flag));
        TaskTokenGuard {
            task_id: task_id.to_string(),
            flag,
            registry: self.clone(),
        }
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        let guard = self.active.lock().expect("task registry mutex poisoned");
        if let Some(flag) = guard.get(task_id) {
            flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn running_count(&self) -> usize {
        let guard = self.active.lock().expect("task registry mutex poisoned");
        guard.len()
    }

    fn remove(&self, task_id: &str) {
        let mut guard = self.active.lock().expect("task registry mutex poisoned");
        guard.remove(task_id);
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
        self.registry.remove(&self.task_id);
    }
}

pub fn emit_task_progress(app: Option<&AppHandle>, payload: &TaskProgressPayload) {
    if let Some(handle) = app {
        let _ = handle.emit(TASK_PROGRESS_EVENT, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_registry_tracks_lifecycle_and_cancellation() {
        let reg = TaskRegistry::default();
        assert_eq!(reg.running_count(), 0);

        {
            let guard = reg.register("hash-001");
            assert_eq!(reg.running_count(), 1);
            assert!(!guard.is_cancelled());

            assert!(reg.cancel("hash-001"));
            assert!(guard.is_cancelled());
            assert!(!reg.cancel("non-existent"));
        }

        // Automatically removed on Drop
        assert_eq!(reg.running_count(), 0);
    }
}
