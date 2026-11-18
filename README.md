# WinKit

WinKit 是一款面向 Windows 11 x64 的本地优先桌面效率工具箱，基于 Tauri 2 + React + TypeScript + Vite + Rust 构建，提供简体中文与英文界面。全部计算与文件处理均在本机离线完成，不包含遥测、账号体系或云端上传。

## 当前已上线能力（v0.2.0 · 阶段 2A）

### 桌面工作台与基础设施

- **工具检索与导航**：左侧分类导航、分类筛选（开发者 / 文本与语音 / 图片）、即时关键词搜索（`Ctrl+K`）、收藏夹、最近使用记录。
- **外观与双语**：浅色主题（默认）、深色主题与跟随系统切换；简体中文（`zh-CN`）与英文（`en-US`）实时切换与偏好持久化，用户态覆盖升级保留设置。
- **隐私、文件安全与窗口退出闭环**：
  - 工具切换在当前进程内存中保留工作状态，默认绝不将用户输入文本、路径或潜在密钥写入磁盘。
  - 原生文件打开/保存对话框与桌面拖放接入，后端强制阻止覆盖源文件、拦截同名静默覆盖，并通过临时文件原子提交避免写出半成品。
  - 统一接入后端 `TaskRegistry`：空闲点击 `×` 或按 `Alt+F4` 直接干净退出进程；存在运行中任务时弹出单实例确认框，确认退出后阻止新任务进入、通知可中断任务取消并等待文件句柄与短写入安全收尾后再销毁窗口（当前版本不在系统托盘常驻）。

### 当前可用本地工具（共 8 项）

1. **`D01` JSON 格式化与校验**（完整基线范围，待用户验收）
   - 支持对象、数组与合法 JSON 标量的 2 空格 / 4 空格 / Tab 格式化、单行压缩与语法校验，1 基精确行列定位，无损保留超 `2^53 - 1` 大整数与小数位字面量，支持按键排序与本地 `.json` 打开/另存。
2. **`D02` Base64 / Hex / 二进制编解码**（阶段 2A 部分实现：单次文本上限 2 MiB、原始字节小文件上限 8 MiB）
   - 支持标准 Base64、URL-Safe Base64、十六进制与 8 位二进制编码/解码（注：数据编码并非加密），提供 64/76 列换行、`=` 填充与空白控制、1 基字符偏移报错、非 UTF-8 原始字节十六进制预览与防覆盖另存。
3. **`D03` 哈希校验工具**（阶段 2A 部分实现：单文件五种摘要已齐备，多文件批处理归阶段 2C）
   - 支持 UTF-8 文本与任意大小单个本地文件在同一次分块流式读取中计算 `MD5`、`SHA-1`、`SHA-256`、`SHA-384`、`SHA-512`（默认 `SHA-256`），提供真实字节进度、中途取消、逐项复制、`MD5`/`SHA-1` 兼容性说明与按长度推断候选算法的期望值校验。
4. **`D04` UUID 生成与解析**（完整基线范围，待用户验收）
   - 采用操作系统密码学安全随机源（CSPRNG）批量生成 RFC 9562 UUID `v4` 与毫秒时间序 `v7`（单批 1–500 个），支持大小写与连字符切换，并可解析任意 UUID 的规范格式、版本、变体、Nil/Max 与 `v7` 内嵌时间戳（不为 `v4` 编造时间）。
5. **`D06` Unix 时间戳转换**（阶段 2A 部分实现：核心四级精度与夏令时校验已闭环）
   - 基于 `BigInt` 精确整数运算（零 `Number` 舍入）支持秒、毫秒、微秒、纳秒与 `UTC`、本机时区、指定有效 IANA 时区的 ISO 8601 双向转换；严格拒绝非法闰日及无偏移输入下的夏令时跳变缺失或重复歧义时刻。
6. **`T08` 字数与阅读统计**（完整基线范围，待用户验收）
   - 基于 Unicode 字素簇（Grapheme）统计含/不含空白字符，基于 `Intl.Segmenter` 统计中英文词数与句数，固定空文本/CRLF/行数/段落口径，展示 UTF-8 字节、预计默读/朗读时长估算与停用词过滤前 10 高频词（上限 2 MiB）。
7. **`T09` 大小写与命名转换**（完整基线范围，待用户验收）
   - 支持 `UPPERCASE`、`lowercase`、`Title Case`、`Sentence case`、`camelCase`、`PascalCase`、`snake_case`、`CONSTANT_CASE`、`kebab-case`、`dot.case`、`alternating`、`inverse` 全部 12 种样式，按行保留换行边界且不覆盖原始输入。
8. **`I03` 截图美化**（阶段 1 部分实现：基础纯色装裱子集）
   - 支持 PNG / JPEG 纯色背景装裱、留白、SDF 抗锯齿圆角、柔和阴影与原始比例 / `1:1` / `16:9` 原分辨率 PNG 导出（渐变/背景图/系统抓图归阶段 3）。

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
# 严格按锁文件安装前端依赖
npm ci

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
