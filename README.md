# WinKit

WinKit 是一款面向 Windows 11 x64 的本地优先桌面效率工具箱，采用 Tauri 2 + React + TypeScript + Vite + Rust 构建，支持简体中文与英文界面，所有处理均在本机完成，不包含遥测、账号体系或云端上传。

## 当前可用范围

工程当前处于阶段 0–1 开发与交付窗口：

- **阶段 0 基座**：Tauri 2 + React + TypeScript + Rust 桌面工程、双语与主题基础设施、102 项工具全量对照基线。
- **阶段 1 目标工具**（随阶段 1 提交陆续闭环）：
  - `D01` JSON 格式化与校验
  - `D03` 哈希校验工具（阶段 1 实现 UTF-8 文本与本地文件流式 SHA-256 及摘要比对子集）
  - `I03` 截图美化（阶段 1 实现 PNG/JPEG 纯色装裱、留白、圆角、阴影及原始/`1:1`/`16:9` 原分辨率 PNG 导出子集）

完整阶段规划与功能覆盖状态请参阅：

- [阶段路线图 (docs/ROADMAP.md)](./docs/ROADMAP.md)
- [102 项功能对照表 (docs/PARITY_MATRIX.md)](./docs/PARITY_MATRIX.md)
- [架构说明 (docs/ARCHITECTURE.md)](./docs/ARCHITECTURE.md)
- [视觉规范 (docs/DESIGN.md)](./docs/DESIGN.md)
- [验证记录 (docs/VERIFICATION.md)](./docs/VERIFICATION.md)
- [接续说明 (docs/HANDOFF.md)](./docs/HANDOFF.md)

## 环境要求（Windows 11 x64）

- Node.js 22+ 与 npm
- Rust stable (`x86_64-pc-windows-msvc`)
- Visual Studio 2022 C++ Build Tools + Windows 10/11 SDK
- Microsoft Edge WebView2 Runtime

## 常用开发与检查命令（兼容 PowerShell 5.1）

在仓库根目录 `D:\Projects\WinKit` 执行：

```powershell
# 安装前端依赖
npm install

# 启动 Tauri 桌面开发窗口
npm run tauri dev

# 前端检查与测试
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build

# Rust 检查与测试
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml

# 构建 Windows NSIS 安装包
npm run tauri build -- --bundles nsis
```
