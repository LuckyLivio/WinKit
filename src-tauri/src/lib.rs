use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppRuntimeInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
}

#[tauri::command]
fn get_runtime_info() -> AppRuntimeInfo {
    AppRuntimeInfo {
        name: "WinKit",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_runtime_info])
        .run(tauri::generate_context!())
        .expect("error while running WinKit application");
}

#[cfg(test)]
mod tests {
    use super::get_runtime_info;

    #[test]
    fn runtime_info_returns_winkit_identity() {
        let info = get_runtime_info();
        assert_eq!(info.name, "WinKit");
        assert_eq!(info.version, "0.1.0");
    }
}
