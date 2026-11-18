# WinKit 架构与技术决策 (ARCHITECTURE.md)

## 1. 工程结构

工程直接位于仓库根目录（不嵌套次级同名目录），前后端职责清晰分离：

```text
WinKit/
├── docs/                       # 路线图、102 项对照表、设计规范、架构、验证与交接文档
├── src/                        # React + TypeScript 前端界面与确定性转换引擎
│   ├── components/             # 侧栏、顶栏、搜索框、ShutdownDialog 三态退出弹窗等壳层组件
│   ├── i18n/                   # zh-CN / en-US 双语文案字典与严格类型约束
│   ├── lib/                    # 偏好持久化、会话内存态、Tauri IPC 与 StrictMode 安全事件订阅
│   ├── registry/               # 轻量工具注册表（稳定编号、分类、关键词、真实实现状态）
│   ├── styles/                 # 语义色彩令牌与桌面自适应布局样式
│   └── tools/                  # 当前真实上线的 8 个工具工作区与对应测试（D01/D02/D03/D04/D06/T08/T09/I03）
├── src-tauri/                  # Rust 后端与桌面宿主配置
│   ├── capabilities/           # 最小权限声明（core:default、core:window:allow-destroy、dialog 打开/保存）
│   ├── icons/                  # 原创应用图标资源
│   └── src/                    # 文件安全守卫、TaskRegistry 退出协调、单遍多算法流式哈希、字节编解码、UUID、图像装裱
├── README.md
└── THIRD_PARTY_NOTICES.md
```

## 2. 关键技术决策

### 2.1 稳定的应用标识与原生窗口宿主

- 应用标识固定为 `com.luckylivio.winkit`，产品名固定为 `WinKit`，安装模式默认 `currentUser`（支持从旧版原地覆盖升级并保留用户偏好设置）。
- 保留 Windows 原生标题栏（`decorations: true`），完整继承系统窗口拖拽、最大化贴靠布局（Snap Layouts）与 `Alt+F4` / `×` 关闭生命周期。
- 开启 `dragDropEnabled: true`，直接接收桌面原生文件路径拖放事件。

### 2.2 最小权限与集中式文件安全

- 前端不持有任意 `shell`、`process` 或全盘自由 `fs` 权限；`src-tauri/capabilities/default.json` 仅授予 `core:default`、窄窗口销毁权限 `core:window:allow-destroy` 以及受控的 `dialog:allow-open`、`dialog:allow-save`。
- 所有文件读取与导出统一经过 Rust 后端 `fs_guard` 校验：
  - 校验路径非空、不含控制字符、目标类型正确，完整兼容中文、空格与非 ASCII 路径。
  - **禁止覆盖原文件**：对输入路径与输出路径执行规范化比对（Windows 下大小写不敏感），若指向同一路径立即返回 `SAME_INPUT_AND_OUTPUT`。
  - **防静默覆盖与原子临时落盘**：通过 `write_output_bytes_cancellable` 先写入同目录唯一 `.tmp` 临时文件并检查取消标志，成功后再通过 `hard_link`（不覆盖已有文件）或 `rename`（显式确认覆盖时）原子提交；中途取消或异常自动清理本次 `.tmp` 文件，绝不留下残损输出。
  - **隐私最小化**：错误提示与日志绝不拼接或回显用户正文、编码载荷或图片像素缓冲区。

### 2.3 偏好持久化与会话工作状态分离

- **磁盘持久化**（`localStorage`）：仅存储主题模式（`light`/`dark`/`system`）、界面语言（`zh-CN`/`en-US`）、收藏工具 ID 列表、最近使用工具 ID 与访问时间。
- **会话内存态**（`SessionStoreProvider`）：在 8 个工具间切换时于当前进程内存中保留输入与选项，窗口退出即释放，默认绝不将用户输入文本、路径或潜在密钥落盘。

### 2.4 窗口退出生命周期与后台任务收尾机制（阶段 1.1 修复）

- **Tauri 2 关闭链路约束**：前端注册 `onCloseRequested` 后，Tauri Rust 层会自动执行 `api.prevent_close()`，后续无论空闲直接关闭还是确认后关闭，都依赖显式调用 `window.destroy()`（需 `core:window:allow-destroy` 权限）。
- **StrictMode 安全监听释放**：通过 `bindDisposableListener` 封装全部异步 `listen` / `onCloseRequested` / `onDragDropEvent` 注册；若组件在 Promise 解析前已卸载，解析后立即执行 `unlisten()`，彻底杜绝重复监听与重复弹窗。
- **后端权威计数与条件变量排空**：
  - `D03` 流式文件哈希、`D02` 原始文件编解码/保存、`D01` 文本另存与 `I03` 高清 PNG 导出全部注册进 `TaskRegistry`。
  - 空闲关闭（`active_count == 0`）直接销毁窗口结束进程，无多余提示。
  - 存在活动任务时展示单实例 `ShutdownDialog`（默认聚焦非破坏按钮“继续使用”，支持焦点环与关闭后焦点恢复）。
  - 用户确认退出后进入 `draining` 收尾态（屏蔽 `Esc` 与重复点击），后端置 `shutting_down = true` 拒绝新任务进入，向全部活动任务广播取消标志，并通过 `Condvar::wait_timeout`（等待期间释放互斥锁，避免与工作线程 `TaskTokenGuard::drop` 死锁）等待工作线程真正退出及文件句柄释放后再销毁窗口；若超时则重置 `shutting_down = false` 并展示未结束任务与“重试退出 / 继续使用”恢复入口，绝不使用 `taskkill` 或无条件 `process::exit` 硬杀进程。

### 2.5 已上线八项工具的核心正确性设计

- **`D01` JSON 格式化与校验**：独立 RFC 8259 词法与递归下降语法分析器，数字字面量以原始词法切片保存，零损保留超 `2^53 - 1` 大整数与小数位；提供 1 基精确行号与列号报错。
- **`D02` Base64 / Hex / 二进制编解码**：区分 UTF-8 文本与本地原始字节小文件（绝不把二进制输入文件先当 UTF-8 解码）；解码产出非 UTF-8 字节时明确标记 `RAW BYTES` 并提供前 256 字节十六进制预览与无损字节另存，绝不静默替换为乱码字符；超 65,536 字符结果自动截断界面预览并保持复制/导出为完整结果。
- **`D03` 哈希校验工具**：支持 `MD5`、`SHA-1`、`SHA-256`、`SHA-384`、`SHA-512` 单选或多选；文件模式在**单次 256 KB 分块流式读取**中同步更新全部选中摘要状态，避免重复读盘；`MD5`/`SHA-1` 明确标注仅用于兼容性校验；期望值比对按十六进制长度给出可解释候选算法提示。
- **`D04` UUID 生成与解析**：使用操作系统 CSPRNG（Rust `uuid` crate / WebCrypto `getRandomValues`，绝不使用 `Math.random`）生成 RFC 9562 `v4` 与 `v7`；解析器严格区分版本位与变体位，仅对 `v7` 提取 48 位毫秒时间戳，绝不为 `v4` 编造时间。
- **`D06` Unix 时间戳转换**：全链路采用 `BigInt` 欧几里得整除/取模运算处理秒、毫秒、微秒、纳秒，杜绝 JS `Number` 舍入；严格校验格里高利历闰日，拒绝日期溢出自动滚月；对无偏移日期通过 `Intl.DateTimeFormat` 探测目标 IANA 时区窗口偏移，显式拦截并拒绝夏令时春季跳变缺失时刻与秋季回拨重复时刻。
- **`T08` 字数与阅读统计**：采用 Unicode UAX #29 字素簇（`Intl.Segmenter` `grapheme`）统计用户感知字符（正确处理 ZWJ 组合 emoji 与组合重音符），采用 `Intl.Segmenter` `word`/`sentence` 分段处理中英文混排，大文本启用防抖并设 2 MiB 上限。
- **`T09` 大小写与命名转换**：按行保留换行边界转换全部 12 种样式，统一拆分大写缩写串（`HTTPResponse`）、驼峰、数字边界与连续分隔符，保留原始输入不被覆盖。
- **`I03` 截图美化**：前后端共用同一纯像素框体公式，按原图 1:1 真实像素执行 SDF 抗锯齿圆角与可分离盒式近似高斯阴影合成。
