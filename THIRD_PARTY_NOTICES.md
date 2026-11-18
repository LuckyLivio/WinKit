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

| Crate                                                                                                             | License                                  | Purpose                                                                                                   |
| :---------------------------------------------------------------------------------------------------------------- | :--------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `tauri`, `tauri-build`                                                                                            | Apache-2.0 OR MIT                        | Desktop application framework and WebView2 host                                                           |
| `tauri-plugin-dialog`                                                                                             | Apache-2.0 OR MIT                        | Native file dialog bridge                                                                                 |
| `serde`, `serde_json`                                                                                             | Apache-2.0 OR MIT                        | Structured IPC serialization                                                                              |
| `md-5`                                                                                                            | MIT OR Apache-2.0                        | Pure-Rust RFC 1321 MD5 compatibility checksums                                                            |
| `sha1`                                                                                                            | MIT OR Apache-2.0                        | Pure-Rust SHA-1 compatibility checksums                                                                   |
| `sha2`                                                                                                            | Apache-2.0 OR MIT                        | Pure-Rust SHA-256, SHA-384, and SHA-512 cryptographic digests                                             |
| `hmac`, `subtle`                                                                                                  | MIT OR Apache-2.0                        | Constant-time RFC 2104 HMAC-SHA256/384/512 verification                                                   |
| `unicode_names2`                                                                                                  | (MIT OR Apache-2.0) AND Unicode-DFS-2016 | Official Unicode 16.0.0 character & CJK/Hangul name tables                                                |
| `unicode-general-category`, `unicode-script`, `unicode-security`, `unicode-segmentation`, `unicode-normalization` | MIT OR Apache-2.0                        | Unicode 16.0.0 UAX #44 category, UAX #24 script, UAX #29 grapheme, and UTS #39 confusable skeleton tables |
| `uuid`                                                                                                            | Apache-2.0 OR MIT                        | RFC 9562 UUID v4 and time-ordered v7 generation via OS CSPRNG                                             |
| `image`                                                                                                           | Apache-2.0 OR MIT                        | Pure-Rust PNG and JPEG decoding and encoding                                                              |
| `base64`                                                                                                          | Apache-2.0 OR MIT                        | RFC 4648 Standard and URL-safe Base64 encoding and decoding                                               |
| `thiserror`                                                                                                       | Apache-2.0 OR MIT                        | Structured error derivation                                                                               |

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
