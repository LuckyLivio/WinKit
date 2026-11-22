# WinKit 架构与技术决策 (ARCHITECTURE.md)

## 1. 工程结构

工程直接位于仓库根目录（不嵌套次级同名目录），前后端职责清晰分离：

```text
WinKit/
├── docs/                       # 路线图、102 项对照表、设计规范、架构、验证与交接文档
├── src/                        # React + TypeScript 前端界面与确定性转换引擎
│   ├── components/             # 侧栏、顶栏、搜索框、ShutdownDialog 三态退出弹窗等壳层组件
│   ├── i18n/                   # zh-CN / en-US 双语文案字典与严格类型约束
│   ├── lib/                    # 偏好持久化、会话内存态、前端退出门控与 Worker 协调、Tauri IPC
│   ├── registry/               # 轻量工具注册表 src/registry/tools.ts（稳定编号、分类、关键词、真实实现状态）
│   ├── styles/                 # 语义色彩令牌与桌面自适应布局样式
│   └── tools/                  # 当前真实上线的 19 个工具工作区、独立 Worker 与测试
├── src-tauri/                  # Rust 后端与桌面宿主配置
│   ├── capabilities/           # 最小权限声明（core:default、core:window:allow-destroy、dialog 打开/保存）
│   ├── icons/                  # 原创应用图标资源
│   └── src/                    # 文件安全守卫、TaskRegistry 退出准入协调、流式哈希、编解码、UUID、密码生成、JWT 验签、Unicode 16.0 检查、图像装裱
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
- **会话内存态**（`SessionStoreProvider`）：工作区可在当前进程内存中保留输入与选项（`D13` 生成密码在切换返回时自动恢复掩码显示，清空或重新生成立即释放旧引用），窗口退出即释放，默认绝不将用户输入文本、链接、密码、JWT 令牌、密钥、差异文本或路径落盘。

### 2.4 窗口退出生命周期、准入同步与 Worker 收尾机制（阶段 1.1 + 阶段 2B1–2B3 加固）

- **Tauri 2 关闭链路约束**：前端注册 `onCloseRequested` 后，Tauri Rust 层会自动执行 `api.prevent_close()`，后续无论空闲直接关闭还是确认后关闭，都依赖显式调用 `window.destroy()`（需 `core:window:allow-destroy` 权限）。
- **StrictMode 安全监听释放**：通过 `bindDisposableListener` 封装全部异步 `listen` / `onCloseRequested` / `onDragDropEvent` 注册；若组件在 Promise 解析前已卸载，解析后立即执行 `unlisten()`，彻底杜绝重复监听与重复弹窗。
- **前后端统一退出准入与条件变量排空**：
  - 所有可能产生文件副作用或后台读写工作的命令（`save_text_file`、`hash_file_multi`、`codec_transform_file`、`codec_save_output`、`export_beautified_png`、`read_diff_text_file`、`read_tabular_text_file`、`read_coord_batch_text_file`）在排入 `spawn_blocking` **之前**同步获取 `TaskTokenGuard` 并移交工作闭包，消除“请求已入队但工作线程尚未登记”的竞态窗口。
  - 原生关闭请求调用 `request_window_close`（`TaskRegistry::evaluate_close_request`）：在同一把互斥锁内判断活动任务数——若 `active_count == 0` 则原子置位 `shutting_down = true` 拒绝后续新任务并直接销毁窗口；若存在活动任务则保持 `shutting_down = false` 且不提前取消任务，交由单实例 `ShutdownDialog` 向用户确认。
  - 前端 `shutdownGate` 与窗口关闭流程同步：进入关闭/排空后禁止创建新 Web Worker 并立即 `terminate()` 纯内存计算 Worker（`D07`、`D08`、`D10`、`D14`）；若 `window.destroy()` 失败或排空超时，前后端同步重置关闭门控恢复正常任务准入。
  - 进度事件终态保真：仅在 `Completed` 时发布确定性 `100%` 进度；`Error` 与 `Cancelled` 保留真实已知进度或不确定状态，并填入真实错误码与脱敏提示。

### 2.5 工具的核心正确性设计

- **`D01` JSON 格式化与校验**：独立 RFC 8259 词法与递归下降语法分析器，数字字面量以原始词法切片保存，零损保留超 `2^53 - 1` 大整数与小数位；提供 1 基精确行号与列号报错。
- **`D02` Base64 / Hex / 二进制编解码**：区分 UTF-8 文本与本地原始字节小文件（绝不把二进制输入文件先当 UTF-8 解码）；解码产出非 UTF-8 字节时明确标记 `RAW BYTES` 并提供前 256 字节十六进制预览与无损字节另存，绝不静默替换为乱码字符；超 65,536 字符结果自动截断界面预览并保持复制/导出为完整结果。
- **`D03` 哈希校验工具**：支持 `MD5`、`SHA-1`、`SHA-256`、`SHA-384`、`SHA-512` 单选或多选；文件模式在**单次 256 KB 分块流式读取**中同步更新全部选中摘要状态，避免重复读盘；`MD5`/`SHA-1` 明确标注仅用于兼容性校验；期望值比对按十六进制长度给出可解释候选算法提示。
- **`F01` 二维码生成与识别**。生成结果绑定内容和样式，预览与图像输出共享二维码矩阵。读取前校验输入大小与图像尺寸，逐图在本地 Worker 中调用随应用分发的 ZXing-C++ WASM。识别得到的地址作为文本展示，打开浏览器来自单独的用户操作。
- **`F02` 批量重命名**。前后端双重校验 Windows 文件名合法性与大小写不敏感槽位冲突；Rust 后端通过不带 `MOVEFILE_REPLACE_EXISTING` 标志的 Win32 `MoveFileExW(..., 0)` 执行 `原路径 -> 唯一临时路径 -> 目标路径` 两阶段事务，天然支持仅改大小写与互换循环，并在异常时按“已提交目标退回暂存名 → 暂存名退回原名”两步逆序回滚，杜绝静默覆盖外部文件。
- **`D04` UUID 生成与解析**：使用操作系统 CSPRNG（Rust `uuid` crate / WebCrypto `getRandomValues`，绝不使用 `Math.random`）生成 RFC 9562 `v4` 与 `v7`；解析器严格区分版本位与变体位，仅对 `v7` 提取 48 位毫秒时间戳，绝不为 `v4` 编造时间。
- **`D05` JWT 本地解码与验签**：复用 `D01` 无损 JSON AST 解析器保留 64 位整数声明，识别五段式 JWE 保护头并明确不解密；使用 Rust `hmac` + `subtle` 恒定时间实现直接对原始编码片段 `<headerB64>.<payloadB64>` 执行 `HS256`/`HS384`/`HS512` 验签（绝不重序列化 JSON），拦截未支持的 `crit` 关键扩展，严格分离展示结构解码、签名状态与 NumericDate 实时时间核对。
- **`D06` Unix 时间戳转换**：全链路采用 `BigInt` 欧几里得整除/取模运算处理秒、毫秒、微秒、纳秒，杜绝 JS `Number` 舍入；严格校验格里高利历闰日，拒绝日期溢出自动滚月；对无偏移日期通过 `Intl.DateTimeFormat` 探测目标 IANA 时区窗口偏移，显式拦截并拒绝夏令时春季跳变缺失时刻与秋季回拨重复时刻。
- **`D07` 文本与文件差异对比**：基于整数内联键的 Myers `O((N+M)D)` 行级对比与行内词/字符高亮，在独立可中止 Worker 中执行并支持上下文折叠与分批渲染；严格保留 UTF-8 BOM、`CRLF`/`LF` 与末尾无换行标记并拒绝含 NUL 字节的二进制文件；在开启忽略空白/大小写展示过滤时，始终从原始未过滤 A/B 生成可被 `git apply` 精确还原 B 的 Unified Diff 补丁，另存时同时保护左右两侧源文件不被覆盖。
- **`D08` 正则表达式测试**：明确标注 **ECMAScript / JavaScript `RegExp`** 语义并记录与 ICU 正则的语法差异；编译、匹配与替换 100% 运行于同源模块 Web Worker 中（零 UI 线程不受控同步正则），主线程看门狗在 `2,000 ms` 预算超时或输入替换时调用真实 `worker.terminate()` 抢占终止灾难性回溯；按 ECMAScript 代理对规范推进零宽全局匹配，明确使用 0 基 UTF-16 偏移与 1 基行列（上限：`16,384` UTF-16 代码单元表达式、`2 MiB` 文本、`2,000` 处匹配）。
- **`D09` 链接跟踪参数清理与已知跳转解包**：仅用 `URL` 校验语法与识别主机边界（`host === domain || host.endsWith("." + domain)`），对查询串采用词法切片逐段过滤，绝不用 `URLSearchParams` 重序列化整串，确保未删参数的 `+`/`%20`/`%2B`/`%252F`/`~`、重复键、空值与 `#fragment` 字节级不变；在首次解包前及进入每层包装前均先行检查 `sig`/`X-Amz-Signature` 等签名特征并命中即停止原样保留；跳转解包每层仅解码一次且上限 5 层带环路检测，绝不发起网络请求。
- **`D10` 坐标转换与测距（离线子集）**：内部固定显式二维 `Wgs84Point { latitude, longitude, datum: "WGS84" }` 模型，严格区分普通文本（默认纬度在前，仅无半球标签时可切换）、GeoJSON `[经度, 纬度]`、WKT `POINT (经度 纬度)`、`geo:纬度,经度` 与官方 Apple/Google 坐标链接轴序；采用最小刻度整数分解处理分秒舍入进位（杜绝 `59′60″` 与 `-0`），并确保显示精度调整绝不截断内部坐标与测距输入；本地打包 `geographiclib-geodesic@2.2.0` 执行 Karney WGS 84 椭球逆测地线计算；有限批量模式运行于独立可取消 Web Worker，复用 `D14` 增量 UTF-8 预算 CSV 生成器与可选公式保护。
- **`D11` Unicode 隐形与混淆字符检查**：内嵌固定版本 **Unicode 16.0.0** 官方数据（`unicode_names2`、`unicode-general-category`、`unicode-script`、`unicode-segmentation`、`unicode-security`）完全离线运行（上限 `512 KiB / 50,000 码点`），精确区分码点序号、UTF-16 偏移与 UAX #29 字素簇序号；基于 UTS #39 `skeleton` 提供可解释的单码点 ASCII 视觉原型提示（标“可能混淆”，不宣称可识别全部欺骗文本）；可预览清理默认保留换行、Tab、Emoji `ZWJ` 与波斯/印地语 `ZWNJ` 连接符。
- **`D12` Lorem Ipsum 占位文本生成**：基于古典拉丁语固定词表离线生成词（`1–5,000`）、句（`1–500`）、段（`1–100`），经典开头严格计入请求总数且 HTML `<p>` 标签不计入词数，输出始终作为纯文本渲染以杜绝脚本执行。
- **`D13` 随机密码与口令短语生成**：使用操作系统 CSPRNG（Rust `OsRng` `try_fill_bytes` / Web Crypto `getRandomValues`）配合 32 位区间拒绝采样消除取模偏差；必含所选类别约束采用完整均匀候选上的有界拒绝采样（`4,096` 次上限），并按容斥原理计算精确有效集合对数位数；口令短语采用去连字符后的 EFF `7,772` 纯小写字母词表（`CC-BY-4.0`）独立均匀有放回抽样；生成结果绑定请求代次与配置快照签名，编辑/清空即时作废在途响应。
- **`D14` CSV ↔ JSON 与 Markdown 表格转换**：在独立可取消 Web Worker（服从 `shutdownGate`、防抖期即时终止旧 Worker 与保存快照校验）中结合 RFC 4180 字符状态机与 `D01` 无损 JSON AST，实现零 `Number` 精度损失的大整数（`9007199254740993`）、精确小数（`19.90`）与前导零编号（`00123`）转换；在分配/补齐矩阵前先行校验含存在/导出表头在内的总单元格预算（`1,000,000`），并在 JSON/CSV/Markdown 生成期通过 `BoundedUtf8Builder` 增量累计 UTF-8 字节预算（`16 MiB` 超限即时中止）。
- **`T08` 字数与阅读统计**：采用 Unicode UAX #29 字素簇（`Intl.Segmenter` `grapheme`）统计用户感知字符（正确处理 ZWJ 组合 emoji 与组合重音符），采用 `Intl.Segmenter` `word`/`sentence` 分段处理中英文混排，大文本启用防抖并设 2 MiB 上限。
- **`T09` 大小写与命名转换**：按行保留换行边界转换全部 12 种样式，统一拆分大写缩写串（`HTTPResponse`）、驼峰、数字边界与连续分隔符，保留原始输入不被覆盖。
- **`I03` 截图美化**：前后端共用同一纯像素框体公式，按原图 1:1 真实像素执行 SDF 抗锯齿圆角与可分离盒式近似高斯阴影合成。
