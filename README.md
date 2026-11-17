# WinKit

WinKit 是一款面向 Windows 11 x64 的本地优先桌面效率工具箱，基于 Tauri 2 + React + TypeScript + Vite + Rust 构建，提供简体中文与英文界面。全部计算与文件处理均在本机离线完成，不包含遥测、账号体系或云端上传。

## 当前已上线能力（v0.1.0 · 阶段 1）

### 桌面工作台与基础设施

- **工具检索与导航**：左侧分类导航、即时关键词搜索（`Ctrl+K`）、收藏夹、最近使用记录。
- **外观与双语**：浅色主题（默认）、深色主题与跟随系统切换；简体中文（`zh-CN`）与英文（`en-US`）实时切换与偏好持久化。
- **隐私与文件安全边界**：
  - 工具切换在当前进程内存中保留工作状态，默认绝不将用户输入文本、路径或潜在密钥写入磁盘。
  - 原生文件打开/保存对话框与桌面拖放接入，后端强制阻止覆盖源文件、拦截同名静默覆盖，并正确处理中文、空格、只读目录与文件占用错误。
  - 运行长耗时任务时关闭窗口会弹出明确提示（当前版本不在系统托盘后台继续运行）。

### 可用本地工具

1. **`D01` JSON 格式化与校验**（完整支持）
   - 支持对象、数组与合法 JSON 标量的 2 空格 / 4 空格 / Tab 美化格式化、单行压缩与纯校验。
   - 基于独立无损词法/语法分析器（绝不使用 `eval`），100% 保留超 `2^53 - 1` 大整数与精确小数位字面量，提供 1 基精确行号/列号报错与一键定位，支持按键排序、本地 `.json` 打开/另存、复制与清空。
2. **`D03` 哈希校验工具**（阶段 1 部分实现：SHA-256 子集）
   - 支持 UTF-8 文本（原样保留空格与换行，不暗中裁剪）及任意大小本地文件的 Rust 256 KB 分块流式 SHA-256 计算。
   - 支持真实字节进度展示、中途取消（取消或报错绝不残留成功状态）、大小写切换、一键复制，以及支持 `sha256:` 前缀 / `shasum` 行格式 / 冒号分隔的期望摘要比对。
3. **`I03` 截图美化**（阶段 1 部分实现：基础装裱子集）
   - 导入本地 PNG / JPEG 图片并实时预览，支持纯色背景预设与自定义色值、留白、SDF 抗锯齿圆角、柔和投影，以及原始比例 / `1:1` / `16:9` 输出画布。
   - 预览与导出共用同一纯像素框体公式，按原图 1:1 真实像素合成高清 PNG（不把缩小预览截图当导出，不无提示拉伸原图），内置单图 50 MB 与画布 10000 px / 4800 万像素内存保护。

## 项目文档索引

- [阶段路线图 (docs/ROADMAP.md)](./docs/ROADMAP.md)
- [102 项全量功能对照表 (docs/PARITY_MATRIX.md)](./docs/PARITY_MATRIX.md)
- [架构与安全设计 (docs/ARCHITECTURE.md)](./docs/ARCHITECTURE.md)
- [视觉与交互规范 (docs/DESIGN.md)](./docs/DESIGN.md)
- [验证记录 (docs/VERIFICATION.md)](./docs/VERIFICATION.md)
- [阶段交接说明 (docs/HANDOFF.md)](./docs/HANDOFF.md)
- [第三方开源声明 (THIRD_PARTY_NOTICES.md)](./THIRD_PARTY_NOTICES.md)

## 开发、检查与打包命令（兼容 Windows PowerShell 5.1）

在仓库根目录 `D:\Projects\WinKit` 执行：

```powershell
# 安装前端依赖
npm install

# 启动真实 Windows Tauri 桌面开发窗口
npm run tauri dev

# 前端格式、类型、Lint、单元测试与构建检查
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build

# Rust 格式、Clippy、单元/集成测试与编译检查
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml

# 生成本地 Windows x64 NSIS 安装程序（产物位于 src-tauri/target/release/bundle/nsis/，不入库）
npm run tauri build -- --bundles nsis
```
