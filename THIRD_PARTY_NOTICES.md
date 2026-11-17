# Third-Party Notices

WinKit uses open-source libraries in its frontend (npm) and desktop backend (Cargo / Tauri). Exact resolved package versions and checksums are recorded in `package-lock.json` and `src-tauri/Cargo.lock`.

## Runtime Dependencies

### Frontend (npm)

| Package                     | License           | Purpose                                  |
| :-------------------------- | :---------------- | :--------------------------------------- |
| `react`, `react-dom`        | MIT               | UI component rendering                   |
| `@tauri-apps/api`           | Apache-2.0 OR MIT | Tauri IPC, window and drag-drop bindings |
| `@tauri-apps/plugin-dialog` | Apache-2.0 OR MIT | Native Windows file open/save dialogs    |
| `lucide-react`              | ISC               | Consistent linear stroke icons           |

### Backend (Rust / Crates.io)

| Crate                  | License           | Purpose                                            |
| :--------------------- | :---------------- | :------------------------------------------------- |
| `tauri`, `tauri-build` | Apache-2.0 OR MIT | Desktop application framework and WebView2 host    |
| `tauri-plugin-dialog`  | Apache-2.0 OR MIT | Native file dialog bridge                          |
| `serde`, `serde_json`  | Apache-2.0 OR MIT | Structured IPC serialization                       |
| `sha2`                 | Apache-2.0 OR MIT | Pure-Rust SHA-256 cryptographic digest computation |
| `image`                | Apache-2.0 OR MIT | Pure-Rust PNG and JPEG decoding and encoding       |
| `base64`               | Apache-2.0 OR MIT | Base64 encoding for local preview payloads         |
| `thiserror`            | Apache-2.0 OR MIT | Structured error derivation                        |

## Development & Test Dependencies

- `vite`, `@vitejs/plugin-react`, `vitest` — MIT
- `typescript` — Apache-2.0
- `eslint`, `@eslint/js`, `typescript-eslint`, `globals` — MIT / BSD-2-Clause
- `prettier` — MIT
- `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` — MIT
- `@tauri-apps/cli` — Apache-2.0 OR MIT
- `tempfile` (Rust dev-dependency) — Apache-2.0 OR MIT

## Application Icons & Visual Assets

All WinKit icons (`src-tauri/icons/*`) and UI styles are original works created specifically for WinKit. No icons, brand marks, screenshots, or code were copied from any third-party reference application.
