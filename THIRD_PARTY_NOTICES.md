# Third-Party Notices

WinKit uses open-source libraries in its frontend (npm) and desktop backend (Cargo / Tauri). Exact resolved package versions and checksums are recorded in `package-lock.json` and `src-tauri/Cargo.lock`.

## Runtime Dependencies

### Frontend (npm)

| Package                     | License                                                   | Purpose                                                                             |
| :-------------------------- | :-------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| `react`, `react-dom`        | MIT                                                       | UI component rendering                                                              |
| `@tauri-apps/api`           | Apache-2.0 OR MIT                                         | Tauri IPC, window and drag-drop bindings                                            |
| `@tauri-apps/plugin-dialog` | Apache-2.0 OR MIT                                         | Native Windows file open/save dialogs                                               |
| `lucide-react`              | ISC                                                       | Consistent linear stroke icons                                                      |
| `geographiclib-geodesic`    | MIT                                                       | Bundled offline Karney WGS 84 ellipsoid geodesic routines (`2.2.0`, Charles Karney) |
| `qrcode`, `dijkstrajs`      | MIT                                                       | QR symbol encoding and segment selection                                            |
| `zxing-wasm/reader`         | MIT (JavaScript), Apache-2.0 (ZXing-C++ and C++ bindings) | Offline barcode recognition in a local Worker                                       |

F01 bundles the reader WASM from `zxing-wasm@3.1.7`. It contains ZXing-C++ at commit `f19f7c6e0509fe0eeb822bf35c41b0f637dec290`, the reader bindings, libzueci character conversion, stb image loading and Emscripten runtime code. The QR encoder is `qrcode@1.5.4`, based on Kazuhiko Arase's QRCode for JavaScript. Copyright notices and license texts for these components and the Windows integration are included in the desktop distribution. [F01 licenses](./licenses/F01.txt)

### Backend (Rust / Crates.io)

| Crate                                                                                                             | License                                  | Purpose                                                                                                   |
| :---------------------------------------------------------------------------------------------------------------- | :--------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `tauri`, `tauri-build`                                                                                            | Apache-2.0 OR MIT                        | Desktop application framework and WebView2 host                                                           |
| `tauri-plugin-dialog`                                                                                             | Apache-2.0 OR MIT                        | Native file dialog bridge                                                                                 |
| `arboard`                                                                                                         | MIT OR Apache-2.0                        | User-initiated local clipboard text and image transfers                                                   |
| `serde`, `serde_json`                                                                                             | Apache-2.0 OR MIT                        | Structured IPC serialization                                                                              |
| `md-5`                                                                                                            | MIT OR Apache-2.0                        | Pure-Rust RFC 1321 MD5 compatibility checksums                                                            |
| `sha1`                                                                                                            | MIT OR Apache-2.0                        | Pure-Rust SHA-1 compatibility checksums                                                                   |
| `sha2`                                                                                                            | Apache-2.0 OR MIT                        | Pure-Rust SHA-256, SHA-384, and SHA-512 cryptographic digests                                             |
| `hmac`, `subtle`                                                                                                  | MIT OR Apache-2.0                        | Constant-time RFC 2104 HMAC-SHA256/384/512 verification                                                   |
| `unicode_names2`                                                                                                  | (MIT OR Apache-2.0) AND Unicode-DFS-2016 | Official Unicode 16.0.0 character & CJK/Hangul name tables                                                |
| `unicode-general-category`, `unicode-script`, `unicode-security`, `unicode-segmentation`, `unicode-normalization` | MIT OR Apache-2.0                        | Unicode 16.0.0 UAX #44 category, UAX #24 script, UAX #29 grapheme, and UTS #39 confusable skeleton tables |
| `uuid`                                                                                                            | Apache-2.0 OR MIT                        | RFC 9562 UUID v4 and time-ordered v7 generation via OS CSPRNG                                             |
| `rand`                                                                                                            | MIT OR Apache-2.0                        | Operating-system CSPRNG (`OsRng`) interface for password and passphrase generation                        |
| `image`                                                                                                           | Apache-2.0 OR MIT                        | Pure-Rust PNG and JPEG decoding and encoding                                                              |
| `base64`                                                                                                          | Apache-2.0 OR MIT                        | RFC 4648 Standard and URL-safe Base64 encoding and decoding                                               |
| `thiserror`                                                                                                       | Apache-2.0 OR MIT                        | Structured error derivation                                                                               |
| `clipboard-win`                                                                                                   | BSL-1.0                                  | Windows clipboard image access                                                                            |
| `windows`, `windows-core`, `windows-sys`                                                                          | MIT OR Apache-2.0                        | Windows Win32 filesystem, COM `IFileOperation` Recycle Bin, and Shell API bindings                        |

## Development & Test Dependencies

- `vite`, `@vitejs/plugin-react`, `vitest` — MIT
- `typescript` — Apache-2.0
- `eslint`, `@eslint/js`, `typescript-eslint`, `globals` — MIT / BSD-2-Clause
- `prettier` — MIT
- `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` — MIT
- `@tauri-apps/cli` — Apache-2.0 OR MIT
- `tempfile` (Rust dev-dependency) — Apache-2.0 OR MIT

## Embedded Wordlist & Local Rule Data (`D09`, `D12`, `D13`)

- **`D13` Passphrase Wordlist (`eff_wordlist_7772.txt`)**:
  - **Source**: EFF Long Wordlist (`https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt`, published via `https://www.eff.org/dice`, SHA-256 `addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e`), © Electronic Frontier Foundation.
  - **License**: Creative Commons Attribution 4.0 International (`CC-BY-4.0`, `https://creativecommons.org/licenses/by/4.0/`), per EFF's Copyright Policy (`https://www.eff.org/copyright`, linked as the governing copyright notice on `https://www.eff.org/dice`, which licenses original EFF website material under CC BY 4.0 International unless otherwise noted; earlier 2016 site notices referenced CC BY 3.0 US).
  - **Modifications**: Dice roll prefixes were removed, entries were normalized to lowercase ASCII and verified for case-insensitive uniqueness, and the 4 hyphenated entries (`drop-down`, `felt-tip`, `t-shirt`, `yo-yo`) were excluded so all `7,772` retained words match `^[a-z]+$` and remain collision-free under `-`, `_`, `.`, and space separators.
- **`D12` Lorem Ipsum Vocabulary (`src/tools/lorem-ipsum/loremEngine.ts`)**:
  - Curated directly for WinKit from classical antiquity Latin vocabulary in Marcus Tullius Cicero's _De finibus bonorum et malorum_ (45 BC).
- **`D09` Link Tracking & Redirect Rule Catalog (`src/tools/clean-links/linkRules.ts`, `2026.11-r1`)**:
  - Authored directly for WinKit from publicly documented query-parameter specifications of Google Analytics/Ads (`utm_*`, `gclid`, `_ga`), Meta (`fbclid`, `igsh`), Microsoft Advertising (`msclkid`), Mailchimp, HubSpot, Marketo, Matomo, Amazon, YouTube, Spotify, TikTok, X, LinkedIn, Reddit, and Outlook Safe Links.

## Application Icons & Visual Assets

All WinKit icons (`src-tauri/icons/*`) and UI styles are original works created specifically for WinKit. No icons, brand marks, screenshots, or code were copied from any third-party reference application.
