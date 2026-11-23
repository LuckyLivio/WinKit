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
| `image`, `png`, `tiff`, `gif`                                                                                     | Apache-2.0 OR MIT                        | Pure-Rust PNG, JPEG, WebP, TIFF, BMP, and GIF decoding, resizing, and encoding                            |
| `jpeg-encoder`                                                                                                    | (MIT OR Apache-2.0) AND IJG              | Pure-Rust JPEG encoder with quality, chroma subsampling, and ICC profile embedding                        |
| `oxipng`, `libdeflater`, `libdeflate-sys`                                                                         | MIT                                      | Lossless PNG compression optimizer                                                                        |
| `exoquant`                                                                                                        | MIT                                      | Pure-Rust perceptual color quantization for lossy indexed-palette PNG compression                         |
| `webp`, `libwebp-sys`                                                                                             | (MIT OR Apache-2.0) / BSD-3-Clause       | Google libwebp bindings for lossy and lossless WebP encoding                                              |
| `kamadak-exif`                                                                                                    | BSD-2-Clause                             | Pure-Rust EXIF metadata and orientation parser                                                            |
| `base64`                                                                                                          | Apache-2.0 OR MIT                        | RFC 4648 Standard and URL-safe Base64 encoding and decoding                                               |
| `thiserror`                                                                                                       | Apache-2.0 OR MIT                        | Structured error derivation                                                                               |
| `clipboard-win`                                                                                                   | BSL-1.0                                  | Windows clipboard image access                                                                            |
| `windows`, `windows-core`, `windows-sys`                                                                          | MIT OR Apache-2.0                        | Windows Win32 filesystem, COM `IFileOperation` Recycle Bin, and Shell API bindings                        |
| `zip`                                                                                                             | MIT                                      | Pure-Rust ZIP archive reading, extraction, and creation (Deflate, AES-256, ZipCrypto)                     |
| `sevenz-rust2`                                                                                                    | Apache-2.0                               | Pure-Rust 7z archive listing and extraction (including AES-256 password support)                          |
| `unrar-rs`                                                                                                        | Apache-2.0 (with UnRAR restriction)      | Pure-Rust read-only RAR4/RAR5 archive listing and extraction                                              |
| `tar`, `flate2`, `lzma-rust2`, `bzip2-rs`                                                                         | MIT OR Apache-2.0 / Apache-2.0           | Pure-Rust TAR, GZIP, XZ/LZMA2, and BZIP2 archive and single-stream codecs                                 |
| `tract-onnx`, `tract-core`, `tract-hir`, `tract-linalg`                                                           | MIT OR Apache-2.0                        | Pure-Rust offline CPU ONNX inference runtime (`0.23.10`) for I02/I11 local face box detection             |

I02 (`Blur Faces`) and I11 (`Detect Faces`) bundle the offline YuNet face bounding-box detection model (`face_detection_yunet_2023mar.onnx`, `232,589` bytes, SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`) sourced from `opencv/opencv_zoo` at commit `f12e12798e8314f7c074a6656816c048dcc95b7a` (upstream `ShiqiYu/libfacedetection.train`, MIT License, Copyright (c) 2020 Shiqi Yu). Landmark outputs are pruned at graph load time; WinKit performs face bounding-box detection only and never extracts identity embeddings or biometric templates. Full attribution and license notices are bundled in the desktop distribution ([I02 YuNet & tract licenses](./licenses/I02-yunet-mit.txt)).

F04 uses `unrar-rs` (`0.16.x`, read-only extraction) under its Apache-2.0 license with the upstream UnRAR read-only restriction. Full license text is bundled in the desktop distribution ([F04 unrar-rs license](./licenses/F04-unrar-rs.txt)):

> UnRAR source code may be used in any software to handle RAR archives without limitations free of charge, but cannot be used to develop RAR (WinRAR) compatible archiver and to re-create RAR compression algorithm, which is proprietary. Distribution of modified UnRAR source code in separate form or as a part of other software is permitted, provided that full text of this paragraph, starting from "UnRAR source code" words, is included in license, or in documentation if license is not available, and in source code comments of resulting package.

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

## Optional User-Installed External Media Tools (`V01`–`V15`, `A01`–`A05`, `I13`)

WinKit does **not** statically link FFmpeg or bundle FFmpeg or `yt-dlp` binaries inside the WinKit installer. When a user runs video/audio tools on a machine without these binaries on `PATH`, WinKit allows either selecting an existing local binary/folder or triggering a user-initiated one-time download of the pinned static Windows x64 builds:

- **FFmpeg / ffprobe Distribution**: `GyanD/codexffmpeg` Release `9.1` (`ffmpeg-9.1-essentials_build.7z`, `36,671,021` bytes, SHA-256 `835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c`, `https://github.com/GyanD/codexffmpeg/releases/tag/9.1`).
  - **Upstream Source**: FFmpeg `9.1` (`https://github.com/FFmpeg/FFmpeg/commit/74e4393595`).
  - **License & Preservation**: GNU General Public License v3 (`GPL-3.0`). During extraction into `%LOCALAPPDATA%\com.luckylivio.winkit\media-tools\ffmpeg-9.1-essentials\`, WinKit preserves the build's verbatim `LICENSE` and `README.txt` (including full library and source attributions) alongside `bin\ffmpeg.exe` and `bin\ffprobe.exe`, and executes them strictly as separate external CLI processes.
- **yt-dlp Distribution (`V01` Video Downloader)**: `yt-dlp/yt-dlp` Official Windows x64 Release `2026.10.26` (`yt-dlp.exe`, `23,575,744` bytes, SHA-256 `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d`, `https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26`).
  - **License & Preservation**: `yt-dlp` upstream code is dedicated to the public domain under **The Unlicense**; the official standalone Windows x64 executable is packaged with PyInstaller and bundles the CPython runtime and open-source Python packages (`certifi`, `mutagen`, `pycryptodomex`, `requests`, `urllib3`, `websockets`, `brotli`) under their respective open-source licenses. Upon user-initiated install/update into `%LOCALAPPDATA%\com.luckylivio.winkit\media-tools\yt-dlp\active\`, WinKit verifies the SHA-256 digest and `--version` self-check before atomic activation (preserving any previously working binary if verification fails), writes `LICENSE-yt-dlp.txt` alongside `yt-dlp.exe`, and invokes `yt-dlp.exe` strictly as an external child process. Direct HTTP(S) media links work independently without `yt-dlp`.

## Application Icons & Visual Assets

All WinKit icons (`src-tauri/icons/*`) and UI styles are original works created specifically for WinKit. No icons, brand marks, screenshots, or code were copied from any third-party reference application.
