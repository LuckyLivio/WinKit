# WinKit 阶段交接说明

## 阶段 6（进行中：T03、T04 已合入，P04 独立 PR 待审核）

`src/registry/tools.ts` 当前已收录 **69 个**真实可用工具入口（新增 `T03`「图片与扫描件文字提取」、`T04`「屏幕区域取字」与 `P04`「扫描版 PDF 转可搜索」；另含侧栏共用能力 `C08`「PDF 快速预览」）。

- **PR #37（已合入 `main`：`626b1db`）｜`T03` 图片与扫描件文字提取 + 离线 RapidOCR 基础设施**：
  - 经同组中英混排截图与扫描件实测选定 **RapidOCR `PP-OCRv4 mobile`（`Apache-2.0`）+ 微软官方签名 `onnxruntime.dll 1.23.2`（`MIT`，Authenticode `Valid`）**，通过 `scripts/ensure-ocr-runtime.mjs` 校验拉取不入源码库，纯 Rust 动态加载 ONNX Runtime C ABI v17 运行于独立 `--ocr-worker`（Windows Job Object 2 GiB 限额、单进程与取消/退出即时回收）。
  - 输出可供 `T04` 与 `P04` 复用的结构化 `OcrPageResult`（每行含 `quadPx`/`quadNorm`/`bboxPx`/`bboxNorm`/`angleDeg`/`rotated180` 及 CTC 词级 `spans`，每页含像素尺寸、请求 DPI 与 PDF 页面点尺寸）；支持队列全源文件 `forbiddenSourcePaths` 防覆盖导出、手工校对内容保留与显式重新识别，并在 Windows CI 上以随仓样张 `src-tauri/tests/fixtures/ocr_bilingual_sample.png` 实际执行 RapidOCR 与 PDFium 200 DPI 渲染扫描 PDF 集成测试。
- **PR #38（已合入 `main`：`68477d2`）｜`T04` 屏幕区域取字**：
  - 复用 `I01` 屏幕框选（补强 `PerMonitorV2DpiGuard`、`SetWindowPos`、`WM_DPICHANGED` 忽略、窗口原点偏移补偿的 `map_virtual_selection_to_capture_rect` 以及按鼠标所在屏居中的 `compute_instruction_pill_origin`）、`ImageAssetStore` 内存零落盘传递（含共享 24 项 LRU 淘汰后经 `storePngAsset` 自动恢复「重新识别」）、`T03` `--ocr-worker`（`T04` 独立注册为可中断任务支持推理期间确认退出即时回收 worker，同时保留 `T03` 既有行为）与原生剪贴板。
- **阶段 6 PR 3（PR #39，`feat/phase-6-pr3-p04-searchable-pdf`）｜`P04` 扫描版 PDF 转可搜索 + `ocr_core` 旋转阅读方向与安全收尾**：
  - 修正 `src-tauri/src/ocr_core.rs` 竖排条在 `rotate270` 后的词元回映射方向，并增补真实阅读方向四边形 `reading_quad_px`（基线 `read_BL→read_BR` + 上行 `read_BL→read_TL`，覆盖 0°/90° CW/180°/270° CW 四方向）同时保留 `T03`/`T04` 既有 `quad_px`/`bbox_px` 预览语义。
  - 在 `pdf_pdfium.rs` 新增 `FPDF_DeviceToPage` 精确仿射设备→页面变换及逐页文字层检测 `inspect_pages_text_status_with_pdfium`；在 `pdf_searchable.rs` 中以单 `TJ` 文本对象按行写入不可见 Unicode 文字层（修复 PDFium 在 180° 倒置扫描页上拆分重排相邻 Span 的选区问题），并在 `doc.save()` 写完 `.tmp` 之后、`commit_existing_tmp()` 之前二次检查取消标记保护已有目标文件。
  - 在 `src/tools/pdf-searchable/PdfSearchableWorkspace.tsx` 中将覆盖确认绑定至完整转换请求（输入/目标/参数变更即失效）并加入单调加载令牌防止快速切档或加载中清空后的迟到响应回写；通过 `C08` 检索高亮、Google Chrome 原生 PDF 查看器四方向旋转页实测拖选复制与独立 `pypdf` 复核。

## v0.18.0 · 阶段 5B（进阶 PDF 处理与文档水印）

`src/registry/tools.ts` 收录 **66 个**真实可用工具入口（文档与 PDF 分类增至 `13` 项：`P06–P17` 与 `P23`；既有 `I13` 同步补齐 PDF 水印模式并升级为 `待验收`，沿用同一入口不重复计数；侧栏共用能力 `C08`「PDF 快速预览」不计入 102 项工具条目数）。本轮按三个连续独立 PR（PR #33、PR #34、PR #35）顺序交付，完成真实 Windows 11 `150%` 缩放安装版全链路串联实测与单版本正式发布 `v0.18.0`。

- **PR #33（`d902ee8`）｜`--pdf-worker` 资源加固 + `P06` PDF 签名 + `P13` PDF 页面裁剪 + `I13` PDF 水印**：
  - **`src-tauri/src/pdf_worker.rs`**：为独立 `--pdf-worker` 渲染子进程的 Windows Job Object 增补 `JOB_OBJECT_LIMIT_PROCESS_MEMORY`（1 GiB）与 `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`（1），叠加原有 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 与调用超时自动重启保护（诚实边界：Windows Job Object 属资源与生命周期回收隔离，不等同完整操作系统级安全沙箱）。
  - **`src-tauri/src/pdf_sign_crop_wm.rs` + `src/tools/pdf-sign/`（`P06`）+ `src/tools/pdf-crop/`（`P13`）+ `src/tools/image-watermark/`（`I13` PDF 模式）**：`P06` 支持手绘/四款字体样式文字/透明 PNG 签名与页面交互式定位、缩放、旋转及不透明度调节，明示为可视电子签名而非 CA 数字证书，临时签名默认驻留内存、仅用户主动保存才落盘模板；`P13` 非破坏性更新 `/CropBox`（适配 0°/90°/180°/270° 旋转、自动白边检测及 A4/Letter/快递面单预设），明示非永久涂黑脱敏；`I13` 扩展「PDF 水印」标签并以单共享 Image XObject 叠加保留可选文字层与链接。
- **PR #34（`6f88d72`）｜离线随包 `qpdf v12.4.2` + `P15` PDF 加密 + `P16` PDF 解除密码 + `C08` 加密联动**：
  - **`scripts/ensure-qpdf.mjs` + `src-tauri/src/pdf_qpdf.rs` + `pdf_crypto.rs`**：固定选用官方 [`qpdf/qpdf` `v12.4.2`](https://github.com/qpdf/qpdf/releases/tag/v12.4.2)（`Apache-2.0`，Windows x64 `qpdf-12.4.2-msvc64.zip` `28,183,147` B，SHA-256 `db87077e683630c1217e0e8f9a20a9749d952ab676e881c3689187763a5de25d`），构建期校验提取 `qpdf/qpdf30.dll`（`7,448,064` B，SHA-256 `8812952678de93e0750308a113aa650e9161af466f9770679ea9673adeb61041`）及 3 个应用本地 MSVC 运行时 DLL（4 个 DLL 未压缩合计 `8,320,304` B / `7.93 MiB`，附 `licenses/qpdf-notices.txt` `2,552` B 与 `THIRD_PARTY_NOTICES.md`，不入源码库，CI 强制核验安装后字节与摘要一致）。全部加解密与无损结构重写通过短生命周期 `winkit.exe --qpdf-worker` 子进程调用 `qpdf30.dll` C API `qpdfjob_initialize_from_json`，经匿名标准输入管道传入内存 JSON 作业参数（零命令行密码暴露、零密码临时文件、内存缓冲区清零、支持取消与 Job Object 回收）。
  - **`src/tools/pdf-encrypt/`（`P15`）+ `src/tools/pdf-decrypt/`（`P16`）+ `C08` 加密分流**：`P15` 支持单/批 AES-256（PDF 2.0 R6）加密、完整 Unicode/Emoji 密码、打印/复制/修改权限位及无权限密码时自动生成随机所有者密码；`P16` 精准区分未加密/需打开密码/仅限权/密码错误/文件损坏，仅使用用户已知密码解锁并经 `PDFium` 独立复核无密码可读；`C08` 遇到加密文档时明示「需要密码」而非报损坏，并提供一键直达 `P16`。
- **PR #35（`ee67756`）｜`P14` PDF 压缩 + `P23` Markdown 转 PDF + `v0.18.0` 发布与全链路实测**：
  - **`src-tauri/src/pdf_compress.rs` + `src/tools/pdf-compress/`（`P14`）**：提供「无损结构优化（`qpdf` 对象流与冗余清理）」「均衡（不透明位图最大边 `1600 px` / JPEG Q78 + 结构优化）」「最小体积（最大边 `1150 px` / JPEG Q62 + 结构优化）」三档，绝不整页光栅化、自动跳过含 `/SMask`/`/Mask`/`/ImageMask` 透明图、逐图及全局自动防膨胀（未缩小保留原件字节），支持批量队列、取消清理 `.tmp` 与 PDFium 页数核验。
  - **`src-tauri/src/pdf_markdown.rs` + `src/tools/pdf-markdown/`（`P23`）**：纯 Rust `pulldown-cmark 0.13` CommonMark + GFM（表格/删除线/任务列表）AST 安全白名单过滤（转义全部原始 HTML、拒绝危险协议链接与全部远程图片、仅允许规范化位于源目录内的本地相对图片嵌入），前端实时预览运行在 `<iframe sandbox="">` 中，导出调用本机离线 Microsoft Edge 无头模式（`--disable-javascript --disable-extensions --disable-background-networking --host-resolver-rules=MAP * ~NOTFOUND` + 严格 CSP + 独立临时配置目录用后删除 + Job Object 进程树回收）输出真矢量 PDF，并经 `PDFium` + `lopdf` 写入 H1–H3 UTF-16BE 层次书签（`/Outlines`）。
  - **正式 Release `v0.18.0` 与公开升级复测**：已由 `main` CI（[Actions #45318328504](https://github.com/LuckyLivio/WinKit/actions/runs/45318328504)）构建发布 `WinKit_0.18.0_x64-setup.exe`（`18,553,410` B，SHA-256 `e370cf4352d7d2f6e6eea0c2aba46770e1b804a73010ae780cc56c2a93b4f0f9`，Authenticode `NotSigned`），并完成公网回下校验与隔离沙箱内的 `v0.17.0 → v0.18.0` 原地覆盖升级及离线 `P06`/`I13`/`P15`/`P16` 复测（详见 `docs/VERIFICATION.md`）。

## 下一阶段

下一阶段为 **阶段 6：本地识别、语音与端侧模型能力**（交付 `I04` 图片抠图去背景、`P04` 扫描版 PDF 转可搜索、以及 `T01–T07` 本地 OCR、离线语音转写/补齐 `A02` 与 `V02` 自动转写、本地 TTS 及经用户确认模型方案后的端侧摘要/问答/翻译）；随后推进阶段 7（`P01–P03`/`P05`/`P18–P22` 永久涂黑、表单填写拼合与 Office/网页转 PDF）。

## v0.17.0 · 阶段 5A（基础 PDF 工作台与内置 PDF 快速预览）

`src/registry/tools.ts` 收录 **60 个**真实可用工具入口（新增「文档与 PDF」分类含 `7` 项独立工具 `P07–P12`/`P17`，并交付侧栏共用能力 `C08`「PDF 快速预览」，不计入 102 项工具条目数）。本轮按三个连续独立 PR（PR #29、PR #30、PR #31）顺序落地离线 `PDFium` 独立渲染子进程、纯 Rust `lopdf` 矢量结构引擎、`C08` 快速预览与全部 7 项基础 PDF 工具，完成真实 Windows 11 `150%` 缩放安装版全链路与 300 页长文档压测，并单版本正式发布 `v0.17.0`。

- **PR #29（`11bce24`）｜离线 PDF 基础设施 + `C08` 内置快速预览 + `P07` PDF 合并 + `P08` PDF 拆分**：
  - **`scripts/ensure-pdfium.mjs` + `src-tauri/src/pdf_pdfium.rs` + `pdf_worker.rs` + `pdf_core.rs`**：固定选用 [`bblanchon/pdfium-binaries` `chromium/8179`](https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium/8179)（`PDFium 160.0.8179.0`，Windows x64，`pdfium.dll` `7,849,984` B，SHA-256 `b9324fe77556753e24443b8ff1d03b39a3aa01ccd6e56e7debb82922438e8965`，附 `licenses/pdfium-notices.txt` `134,943` B 与 `THIRD_PARTY_NOTICES.md`，构建期拉取校验不入源码库，CI 强制核验安装后文件存在与摘要一致）。全部页面光栅化与文字层提取隔离运行在 `winkit.exe --pdf-worker` 子进程（受 Windows Job Object `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 托管，退出自动回收），主进程维护 64 项 / 64 MiB 有界 LRU 缓存与 `AtomicPdfOutput` 防覆盖原子写入。
  - **`src/components/PdfReaderView.tsx`（`C08`）**：支持拖放与对话框打开本地 PDF、懒加载缩略图/目录书签/文档信息侧栏、缩放/适应页宽/适应整页/全屏、可选文字层复制、`Ctrl+F` 全文搜索与命中高亮跳转、页内与外部 HTTP(S) 链接点击（外链交默认浏览器）、扫描件/加密/数字签名诚实提示，以及一键送入 `P07`/`P08`/`P09`/`P10`/`P11`/`P17`（并在真机截图目视复查中修复了 `rootMargin` 预渲染区导致的首页页码误跳 `2/6` 问题，改为按实际可视重叠像素同步当前页）。
  - **`src-tauri/src/pdf_ops.rs` + `src/tools/pdf-merge/`（`P07`）+ `src/tools/pdf-split/`（`P08`）**：基于 `lopdf 0.47` 纯矢量页面组装（不光栅化页面，保留文字/矢量/页面尺寸/外链与重映射内链及书签）；`P07` 支持多 PDF 与图片混排、首页缩略图、拖拽调序与可选文件名书签；`P08` 支持逐页、每 N 页与自定义多段区间（中英文标点兼容、预览输出文件清单与越界/重叠校验）及取消清理 `.tmp`。
- **PR #30（`074f3b5`）｜`P09` 页面整理 + `P10` 删除页面 + `P11` 提取页面**：
  - **`src/tools/pdf-shared/PdfPageGrid.tsx` + `pageRangeUtils.ts` + `pdf-organize/` + `pdf-delete/` + `pdf-extract/`**：抽离复用懒加载缩略图网格（72 项有界缓存、Shift 多选、拖拽/按钮调序、旋转预览、待删标红与现/原页码对照）。`P09` 支持重排/90°·180°·270° 旋转/标记删除/撤销重做；`P10` 支持勾选+页码表达式双联动删页并强制拦截删空全部页面；`P11` 支持合并单一新 PDF（去重保序）或每页独立导出；后端统一保留矢量文字、自动重映射保留页的内部跳转与书签并剔除悬空链接。
- **PR #31（`dbdb400`）｜`P12` 图片转 PDF + `P17` PDF 转图片 + `v0.17.0` 发布与全链路实测**：
  - **`src-tauri/src/pdf_ops.rs`（`images_to_pdf_impl`）+ `src/tools/pdf-images-to-pdf/`（`P12`）**：支持 PNG/JPEG/WebP/BMP/TIFF（及系统 WIC HEIC）拖拽排序，按 EXIF 自动矫正正立像素、透明图按底色合成避免黑底、提供原图尺寸 / A4 / Letter、自动/竖向/横向方向与无/小/中/大边距排版，输出单 PDF 并可直达 `C08`/`P07`/`P09`。
  - **`src-tauri/src/pdf_export_images.rs` + `src/tools/pdf-to-images/`（`P17`）**：经 `--pdf-worker` 渲染输出全部页面或指定页码为 `72`/`150`/`300 DPI` 的 PNG/JPEG/WebP（及系统 WIC 编码可用时的 HEIC），导出前实时预估首页与最大页像素并对超大图纸按 `8,192 px` / `48 MP` 安全上限等比缩放并明示提示，默认建立防重名子目录、逐页错误隔离与随时取消清理 `.tmp`。
  - **正式 Release `v0.17.0` 与公开升级复测**：已由 `main` CI（[Actions #45240344992](https://github.com/LuckyLivio/WinKit/actions/runs/45240344992)）构建发布 `WinKit_0.17.0_x64-setup.exe`（`15,928,546` B，SHA-256 `2b76683865c3e613146208cf4558e0cf4cf9a0c95c7aecd98a79a0828b3a8fa1`，Authenticode `NotSigned`），并完成公网回下校验与隔离沙箱内的 `v0.16.0 → v0.17.0` 原地覆盖升级与离线 PDF 复测（详见 `docs/VERIFICATION.md`）。

## 下一阶段

下一阶段为 **阶段 5B：进阶 PDF 处理与文档水印**（交付 `P06` PDF 签名、`P13` PDF 页面裁剪、`P14` PDF 压缩、`P15` PDF 加密保护、`P16` PDF 解除密码、`P23` Markdown 转 PDF，并为既有 `I13` 补齐 PDF 水印模式）；随后推进阶段 6（本地 OCR、`I04` 抠图及 `A02`/`V02` 离线语音转写）。

## v0.16.0 · 阶段 4B2 第二批（录音机、屏幕录制与视频下载，阶段 4 收官）

`src/registry/tools.ts` 收录 **53 个**真实可用工具入口（视频分类达 `15/15` 全量上线、音频分类达 `5/5` 全量上线、图片/文件/开发者/文本非媒体分类 `33` 项）。本轮按三个连续独立功能 PR（PR #25、PR #26、PR #27）顺序交付 `A02`、`V05` 与 `V01`，完成真实 Windows 11 `150%` 缩放安装版全链路实测与单版本正式发布 `v0.16.0`。

- **PR #25（`0b90658`）｜`A02` 录音机**：
  - **`src-tauri/src/audio_wasapi.rs` + `audio_recorder.rs` + `src/tools/audio-recorder/`**：新增可复用 Windows 原生 WASAPI 枚举与采集引擎（仅读设备属性不主动激活 `IAudioClient`，在用户主动监听或开始录制时才占麦），支持麦克风选择、实时电平/削波表、开始/暂停（暂停期间零帧写入）/继续/停止试听、展示实际采样率与声道、导出无损 WAV（无需 FFmpeg）或 M4A/AAC、一键送往 `A03`/`A01`，完善处理无麦克风、系统权限被拒、设备断开保留已录内容与三态录制关窗保护，停止/放弃同步释放设备并支持立即重录。离线语音转写留阶段 6（矩阵标记 `部分实现`）。
- **PR #26（`64ac47f`）｜`V05` 屏幕录制**：
  - **`src-tauri/src/screen_recorder.rs` + `screen_capture.rs` 区域选框复用 + `src/tools/screen-recorder/`**：基于 Windows.Graphics.Capture（Direct3D 11，非 DWM 表面自动安全回退 `PrintWindow` / Z 序合成并如实报告 `captureEngine`）支持显示器、单个窗口与复用 `I01` 物理 DPI 坐标的框选区域；集成独立或双路混录的 WASAPI 系统播放回环与麦克风音频（开始前清晰说明「录哪里 / 录哪些声音」及单窗口下设备级系统回环范围）；默认 H.264 MP4（支持 MOV）、原尺寸/1440p/1080p/720p、30/60 fps、指针显示、点击高亮与 `WDA_EXCLUDEFROMCAPTURE` 悬浮状态停止条；壁钟主节拍 + 流式 FFmpeg 编码保持长录制有界内存与音画同步，明确区分「停止并保存」与「放弃」，并在目标窗口关闭/设备失效/关窗时尽可能保留已录内容。
- **PR #27（`b5bd544`）｜`V01` 视频下载 + `v0.16.0` 发布与全链路实测**：
  - **`src-tauri/src/ytdlp_core.rs` + `video_download.rs` + `src/components/YtdlpSetupPanel.tsx` + `src/tools/video-download/`**：支持粘贴一条或多条 HTTP(S) 链接解析标题、可用清晰度与音轨语言，提供最佳/最高 1080p/最高 720p/仅音频 M4A 与优先 H.264，队列逐项展示进度、取消（Windows Job Object 终止 `yt-dlp` 与子级 `ffmpeg` 进程树并清理 `.part`/`.tmp`）、准确错误分类（登录/年龄/地区/DRM/JS 运行时/断网等）与重试，完成后经本地 `ffprobe` 展示实际分辨率、视频/音频编码与音轨语言并一键送往 `V10`/`V11`/`V04`/`A03`。普通直链媒体无需 `yt-dlp` 即可独立下载并保持原字节 SHA-256；受管 `yt-dlp` 固定官方 `2026.10.26`（校验 SHA-256 与 `The Unlicense` 许可、更新或自检失败保留可用旧版、自动检测 Deno/Node.js 等 JS 运行时、不修改系统 `PATH`）；全部界面、日志与错误提示自动脱敏令牌、认证与签名参数。

## 下一阶段

下一阶段为 **阶段 5：基础 PDF 工作台**（交付 `P06–P17`、`P23`、`C08` 基础 PDF 阅读/快速派发，并补齐 `I13` PDF 水印）；随后推进阶段 6（本地 OCR、`I04` 抠图及 `A02`/`V02` 离线语音转写）。

## v0.15.0 · 阶段 4B2 第一批（音频处理、视频换音轨、硬字幕烧录与视频水印）

`src/registry/tools.ts` 收录 **50 个**真实可用工具入口（视频分类增至 `13` 项、音频分类增至 `4` 项、图片/文件/开发者/文本非媒体分类 `33` 项，其中已有 `I13` 同步扩展视频水印模式但不重复计数）。本轮按三个连续独立 PR（PR #21、PR #22、PR #23）完成 `A03`、`A05`、`A01`、`V14`、`V02` 与 `I13` 视频水印交付，并完成真机 `150%` 缩放安装版全链路实测与单版本正式发布 `v0.15.0`。

- **PR #21（`e1d0f1e`）｜`A03` 音频剪切 + `A05` 音频格式转换**：
  - **`A03` 音频剪切（`src-tauri/src/audio_trim.rs` + `src/tools/audio-trim/`）**：有界内存流式波形（在 PR #23 真机 E2E 发现低采样率对高频/人声的混叠衰减后，升级为固定 `8 kHz` / `32 KiB` 缓冲流式读取以覆盖 `4 kHz` 人声与乐器频带）、拖动选区、精确起止时间、与播放头同步的选区试听、独立淡入/淡出（短选区明示有效范围）、切换工具保留选区与防覆盖导出。
  - **`A05` 音频格式转换（`src-tauri/src/audio_convert.rs` + `src/tools/audio-convert/`）**：单文件与批量转换为 MP3 / M4A (AAC) / WAV / FLAC / AIFF，按格式展示码率/采样率/位深控件；扩展 `AudioStreamInfo` 暴露源 `sample_fmt` 与 `bits_per_sample`，无损格式默认保留源位深、采样率与声道（已验证 24-bit 左右异声道 `WAV → FLAC → WAV` 零比特误差往返），单条损坏隔离、同名自动防覆盖编号。
- **PR #22（`0724b10`）｜`A01` 音频降噪与增强 + `V14` 替换视频音频**：
  - **`A01` 音频降噪与增强（`src-tauri/src/audio_cleanup.rs` + `src/tools/audio-cleanup/`）**：支持音频与含音轨视频，提供轻/中/强 `afftdn` 离线降噪、可选 85 Hz 高通 + 50/60 Hz 交流哼声陷波、两遍 EBU R128 `loudnorm` 标准化（默认 `-16 LUFS`、真峰值 `-1.5 dBTP`，全静音 `-inf` 安全保护不放大底噪）、同片段处理前/后切换试听与实测响度展示、纯音频专属静默裁剪（视频严格禁用保音画同步），视频直拷贝视频流并原样保留其余音轨。
  - **`V14` 替换视频音频（`src-tauri/src/video_replace_audio.rs` + `src/tools/video-replace-audio/`）**：支持音频文件或另一段视频的指定音轨，提供替换/混音双模式、独立原声/新音频音量（0%–200%）、短音频「循环铺满 / 仅播放一次」、静音目标视频配音、`amix(normalize=0)+alimiter` 防单次播放结束后原声音量跳变、兼容容器视频流直拷贝及导出前音画同步试听。
- **PR #23（`b8dce91`）｜`V02` 视频烧录字幕 + `I13` 视频水印 + `v0.15.0` 发布与全链路实测**：
  - **`V02` 视频烧录字幕（`src-tauri/src/media_subtitles.rs` + `src/tools/video-subtitles/`）**：支持 UTF-8（含 BOM/CRLF/LF）SRT 与 WebVTT 严格解析（畸形文件精准报行号/条目错误）、字号/顶部底部位置/描边阴影或半透明黑底框样式、点击任意字幕即刻渲染真实烧录预览帧、FFmpeg `ass` 滤镜以临时工作目录相对路径 + `fontsdir='C\:/Windows/Fonts'` 离线渲染系统微软雅黑中文字幕（规避中文空格路径转义陷阱，自动正立烘焙 90° 竖拍、无软字幕轨、保留原音频）。自动语音转字幕保留至阶段 6（`V02` 矩阵状态为 `部分实现`）。
  - **`I13` 视频水印（`src-tauri/src/video_watermark.rs` + `image_watermark.rs` + `src/tools/image-watermark/`）**：在同一 `I13` 工作区新增「视频水印」标签并复用同一 `WatermarkStyleConfig`、`watermarkStamp.ts` 与 `render_watermark_overlay_rgba` 透明图层生成算法，保证横屏、竖屏及 90° 旋转视频预览与导出 1:1 一致、清零旋转标记、保留原音频与时长，同时完整保留 `I13` 单图/批量图片水印与透明 PNG 透明通道。PDF 水印留阶段 5（`I13` 保持 `部分实现`）。

## 下一阶段

阶段 4B2 第二批将交付阶段 4 剩余三项媒体工具：`V01` 视频下载（按需受管 `yt-dlp`）、`V05` 屏幕录制（Windows WGC + WASAPI）与 `A02` 录音机（WASAPI）；随后进入阶段 5（基础 PDF 工作台与 `I13` PDF 水印）与阶段 6（本地 OCR / 抠图 / `V02` 与 `A02` 离线语音转写）。

## v0.14.0 · 阶段 4B1（六项视频编辑工具与 V04 精确时间点修复）

`src/registry/tools.ts` 收录 **45 个**真实可用工具入口（视频分类由 `5` 项扩展至 `11` 项，音频分类 `1` 项，非媒体工具 `33` 项）。本轮按三个连续独立 PR（PR #17、PR #18、PR #19）完成 `V04` 高帧率/长保持 VFR 抽帧修复，交付 `V07`、`V06`、`V08`、`V09`、`V03`、`V12` 六项本地离线视频处理工具，并完成真机安装版端到端实测与单版本正式发布 `v0.14.0`。

- **PR #17（`cc7fc26`）｜`V04` 抽帧精确时间点修复 + `V07` 格式转换 + `V06` 视频压缩 + `v0.13.0` 公开验证回填**：
  - **`V04` 修复（`src-tauri/src/media_frames.rs`）**：复现旧 `fps=50:round=down` 在 `120 fps` 无损样片 `t = 0.031 s` 处因 `20 ms` 网格量化错误返回第 `7` 帧（应为第 `3` 帧，起始 `0.025 s`），同时修正 `SingleTime` 尾部 `safe_dur - 0.01` 过早夹断导致末尾帧丢失的问题。改为分段 `ffprobe -read_intervals start%end`（覆盖 B 帧重排与稀疏长保持 VFR 自动扩窗）解析真实显示 PTS 与前置关键帧，再用 `-noaccurate_seek -ss <kf> -copyts -vf "select='gte(t,<pts>)'" -fps_mode passthrough -frames:v 1` 精确导出；仓内已固化 `120 fps` 无损边界、长保持 VFR 与 120 秒长视频快定位回归单测。
  - **`V07` 格式转换（`src-tauri/src/media_convert.rs` + `src/tools/video-convert/`）**：覆盖 MP4、MOV、WebM（VP9/Opus）、M4V 与 MKV 单文件及批量转换；执行前逐轨生成「无损直拷 / 重编码 / 容器限制省略」计划，存在不兼容轨道（如附件轨或位图字幕）时须用户显式确认才放行，导出后由 `ffprobe` 二次核验封装、编码与轨数，单条损坏不中断其余项。
  - **`V06` 视频压缩（`src-tauri/src/media_compress.rs` + `src/tools/video-compress/`）**：高质量/均衡/小体积三档与 H.264/HEVC，原尺寸/1080p/720p/480p 不放大上限；对本机硬件编码器（NVENC/QSV/AMF/MF）做真实短片试编探测（仅列出真正可用的编码器并在结果记录 `actualEncoderUsed` 与节省率）；开启“未缩小保留原件”时绝不负优化，支持取消清理 `.tmp`。
- **PR #18（`43e7b2a`）｜`V08` 视频尺寸调整 + `V09` 视频裁剪与旋转**：
  - **`V08` 尺寸调整（`src-tauri/src/media_resize.rs` + `src/tools/video-resize/`）**：预设分辨率、`1:1`、`9:16` 与自定义宽高，清晰区分 Fit / Pad / Fill 与仅解锁比例才可用的 Stretch；按正立显示方向实时预估导出偶数尺寸、自动清零旋转元数据并支持批量套用。
  - **`V09` 裁剪与旋转（`src-tauri/src/media_crop.rs` + `src/tools/video-crop/`）**：提取正立预览帧渲染交互式裁剪框（自由/`1:1`/`16:9`/`9:16`、左/右 90°、水平/垂直翻转、重置），经规范 $D_4$ 变换保证手机 90° 竖拍预览与导出像素 1:1 一致、导出清零 `rotate=0`，并支持一键送入 `V03`/`V12`/`V06`/`V10`。
- **PR #19｜`V03` 视频变速 + `V12` 视频合并 + `v0.14.0` 发布与全链路实测**：
  - **`V03` 视频变速（`src-tauri/src/media_speed.rs` + `src/tools/video-speed/`）**：`0.25×`–`4×` 单/批变速与预计时长，默认多级 `atempo` 保原音调与声画同步（可选静音），无音轨视频稳定处理。
  - **`V12` 视频合并（`src-tauri/src/media_merge.rs` + `src/tools/video-merge/`）**：2 段及以上正立缩略图排序与总时长，统一 H.264 MP4，支持跟随首段或预设分辨率，横竖屏混排默认等比留黑，有声+静音+有声混拼自动合成精确时长静音轨保证后续音画同步。

## 下一阶段

阶段 4B2 将继续复用现有本地媒体组件基础设施并按需集成 `yt-dlp`，交付剩余视频与音频工具（`V01` 视频下载、`V02` 烧录字幕、`V05` 屏幕录制、`V14` 替换/混音音轨、`A01` 降噪响度、`A02` 录音机、`A03` 音频剪切、`A05` 音频格式转换）及 `I13` 视频水印；随后进入阶段 5（基础 PDF 工作台）。

## v0.13.0 · 阶段 4A（本地媒体组件基础设施与六项核心音视频工具）

`src/registry/tools.ts` 收录 **39 个**真实可用工具入口（新增「视频」「音频」两个分类）。本轮按三个连续批次独立 PR（PR #14、PR #15、PR #16）落地共用本地 FFmpeg/ffprobe 发现与用户主动一键安装体系、`winkitmedia` 分段流式本地预览协议以及 `V10`、`V11`、`V13`、`A04`、`V04`、`V15` 六项音视频核心工具，完成全流程真机安装版端到端验证并单版本发布 `v0.13.0`。

- **共用本地媒体组件配置与安全执行（PR #14，`src-tauri/src/media_core.rs` + `src/components/MediaToolsSetupPanel.tsx`）**：
  - 自动探测系统 `PATH` 中可用的 `ffmpeg` / `ffprobe`，也允许用户手动选择本地目录；缺少依赖时在所有媒体工具及「设置 → 媒体组件」展示清晰的「配置媒体组件」入口，由用户主动点击触发一次性下载配置。
  - 固定选型：[`GyanD/codexffmpeg` Release `9.1`](https://github.com/GyanD/codexffmpeg/releases/tag/9.1)（上游 `FFmpeg/FFmpeg@74e4393595`，Asset `ffmpeg-9.1-essentials_build.7z`，下载体积 `36,671,021` 字节 / `34.97 MiB`，SHA-256 `835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c`，GNU GPL v3）。下载通过原生 Windows WinHTTP 流式接收并逐字节计算 SHA-256，校验通过后仅解压 `bin/ffmpeg.exe`、`bin/ffprobe.exe` 与完整 `LICENSE` / `README.txt`（安装占用 `221,044,037` 字节 / `210.80 MiB`）至 `%LOCALAPPDATA%\com.luckylivio.winkit\media-tools\ffmpeg-9.1-essentials`（绝不修改系统 `PATH`），通过 `ffmpeg -version` 与 `ffprobe -version` 双自检后原子切换生效；中途取消或断网自动清理暂存并支持重试，安装后完全离线运行。
  - 新增白名单 `MediaPreviewRegistry` 与自定义协议 `winkitmedia`（支持 RFC 7233 `Range` `206 Partial Content` 分段流式播放）及 `extract_media_poster_data_url` 首帧提取回退，WebView2 无法直接播放的封装/编码明确提示「素材完好，并非损坏」而不误报损坏；全部 FFmpeg 外部子进程接入 `TaskRegistry` 与取消轮询，取消或退出时主动终止子进程并经 `AtomicMediaOutput` 清理 `.tmp` 临时文件。
- **V10 媒体信息检测 & V11 视频剪切（PR #14，`media_info.rs` / `media_trim.rs`）**：`V10` 解析容器、时长、体积、码率、编码尺寸 vs 旋转后显示尺寸（标注横竖屏）、实际帧率与 CFR/VFR 判定（排除 B 帧重排尾部截断误判）、每条音轨语言/标题/声道/采样率/码率与标签，支持文本/JSON 复制导出及一键交接至 `V11`/`V13`/`A04`/`V04`/`V15`；`V11` 提供视频播放、可拖时间轴、播放头设起止点与选段预览，明确区分「快速流复制（含关键帧偏移探测与如实提示）」与「精确剪切（重编码）」，保留竖拍方向与音画同步并强制禁止覆盖源文件或已有目标。
- **V13 视频静音 & A04 提取视频音频（PR #15，`media_mute.rs` / `media_extract_audio.rs`）**：`V13` 支持单视频与批量视频以 `-map 0:v -an -c:v copy` 无重编码移除全部音轨（含多音轨视频），导出后自动 `ffprobe` 复检音轨数为 `0`，原本无音轨视频如实标注且不重复写出；`A04` 支持单/批导出为 `M4A`/`MP3`/`WAV`/`FLAC`，多音轨视频提供 30 秒片段直接试听选轨，自动区分并明示「无损直拷 / 重编码」，无音轨视频清晰提示跳过且不产生空文件。
- **V04 视频抽帧 & V15 视频转 GIF（PR #16，`media_frames.rs` / `media_gif.rs`）**：`V04` 支持单时间点、固定间隔（秒）与均匀 N 张抽取，采用 `fps=50:round=down:eof_action=pass,trim=start=rem` 精准命中 VFR 保持帧，支持原尺寸/1080p/720p（不放大小视频）、PNG/JPEG/WebP 及系统 WIC HEIC、自动竖拍正立导出与图集预览；`V15` 支持整段/区间、10/15/24 fps、320/480/640/原宽（默认不放大）、无限循环/单次播放，经 `palettegen=stats_mode=diff` + `paletteuse=dither=sierra2_4a` 双遍高质量调色板编码并立即展示真实帧数、尺寸、体积与动图预览。

## 下一阶段

阶段 4B 将继续复用本轮已落地的本地 FFmpeg/ffprobe 基础设施与 `winkitmedia` 协议，按需接入 `yt-dlp`，交付剩余视频与音频工具（`V01–V03`、`V05–V09`、`V12`、`V14`、`A01–A03`、`A05`）及 `I13` 视频水印；随后推进阶段 5（基础 PDF 工作台）。

## v0.12.0 · 阶段 3B2（人脸自动打码与屏幕取色对比度）

`src/registry/tools.ts` 收录 **33 个**真实可用工具入口。本轮通过两个独立 PR（PR #12、PR #13）交付 `I02` 离线 CPU 人脸自动打码（并在 `I11` 复用「查找人脸」）以及 `I10` Windows 屏幕取色、图片主色提取与 WCAG 2.x 对比度工具，完成真机安装版端到端验证与单版本正式发布。

- **离线人脸检测选型与打包（PR #12，`src-tauri/src/face_detect.rs`）**：选用 MIT 许可的 OpenCV Zoo **YuNet**（`face_detection_yunet_2023mar.onnx`，固定提交 `opencv/opencv_zoo@f12e12798e8314f7c074a6656816c048dcc95b7a`，精确体积 `232,589` 字节，SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`）搭配纯 Rust **`tract-onnx 0.23.10`**（`MIT OR Apache-2.0`，无外部 DLL）。构建脚本 `scripts/ensure-face-model.mjs` 在构建期按固定 SHA-256 获取模型至忽略目录并随 NSIS 安装包打包至 `models/face_detection_yunet_2023mar.onnx`（附 `licenses/I02-yunet-mit.txt` 与 `THIRD_PARTY_NOTICES.md`），模型不以二进制入源码库；加载期裁剪全部关键点输出，严格仅执行 2D 人脸边界框检测，不提取任何身份向量。
- **I02 人脸自动打码 & I11 查找人脸复用（PR #12）**：`I02` 支持单张或批量照片拖入，先按 EXIF 方向矫正再在普通 CPU 上离线检测（空缓存首次实测 `88 ms`，热态 `51–55 ms`），默认置信度阈值 `0.60`，复用 `I11` 画布实现逐脸取消、手动补框、移动、8 控制点缩放、撤销/重做与前后对照；提供高斯模糊、像素化与不透明实色遮盖及强度调节，单批明确区分「检测到 N 张脸 / 未检测到人脸 / 检测失败」，批量导出不覆盖源文件、默认复用 `I09` 清理隐私元数据、支持随时取消（清理 `.tmp`）并将已烘焙新图送入 `I12` / `I03` / `I13`。`I11` 同步新增「查找人脸」按钮，一键将离线检出的人脸作为可编辑选区加入当前画布。
- **I10 屏幕取色、图片主色与 WCAG 2.x 对比度（PR #13，`src-tauri/src/color_picker.rs` + `src/tools/color-picker/`）**：复用 `screen_capture.rs` 虚拟屏逻辑提供原生 Win32 `WDA_EXCLUDEFROMCAPTURE` 全屏取色放大镜（`11×11` 像素格、高对比度中心十字、方向键 `1 px` 微调、左键/`Enter` 确认、`Esc`/右键取消，并明示仅采集桌面合成 sRGB RGB）；支持直接解析手写色值与 20 项最近取色历史（内存会话、一键清空）；输出 `HEX`、`RGB`、`HSL`、`OKLCH`、`CSS #RRGGBBAA`、`WinUI/XAML #AARRGGBB`、`C# Color.FromArgb` 及 `Tailwind`（精确任意值 `bg-[#...]` + 244 色官方色板最近命名色显式标“近似”）；图片提色支持 5–8 种主色并自动跳过完全透明像素；WCAG 2.x 对比度按未舍入真实比值判定 AA/AAA（展示比值向下截断，杜绝 `< 4.5` 误显为 `4.50`），半透明前景先与背景合成并明示合成色值。`I10` 作为 Windows 平台替代方案在用户验收前于矩阵中标记为 `部分实现`。

## 下一阶段

图片分类阶段 3（除留归阶段 6 的 `I04` 抠图去背景及 `I11` 自动 OCR 文字检测外）已全部收官；后续按路线图推进阶段 4（视频与音频工具）、阶段 5（基础 PDF 工作台与 PDF 水印）与阶段 6（端侧 OCR、抠图与语音能力）。

## v0.11.0 · 阶段 3B 第一批（截图、局部打码、批注、美化升级与图片水印）

`src/registry/tools.ts` 收录 **31 个**真实可用工具入口（沿用原 `I03` 入口不重复计数）。本轮通过三个连续独立 PR（PR #9、PR #10、PR #11）建立零落盘内存图像管道（`ImageAssetStore`）与共享原图像素画布引擎，完整打通 `I01 → I11 → I12 → I03 → I13` 跨工具原始分辨率无损工作流，并完成 Windows 11 安装版端到端验证。

- **零落盘内存图像与原生双格式剪贴板（`src-tauri/src/image_assets.rs`）**：内存 LRU 池（上限 24 项 / 192 MiB / 单图 16,384 px / 48 MP）支持各图像工具之间直接传递原始分辨率无损 PNG，用户仅需在最终导出或复制时选择一次保存路径；写入剪贴板同时提供 `PNG`（保留透明通道）与 `CF_DIB`（兼容画图等传统 Win32 应用）并附带 `ExcludeClipboardContentFromMonitorProcessing`。
- **I01 屏幕截图与长截图（PR #9）**：支持区域（全虚拟屏冻结框选，`Esc`/右键取消）、指定窗口（`PrintWindow(PW_RENDERFULLCONTENT)` 遮挡窗口完整捕获 + `DWMWA_EXTENDED_FRAME_BOUNDS` 裁剪 + 严格遵守 `GetWindowDisplayAffinity` 受保护内容限制）、指定显示器与滚动长截图。滚动长截图在解锁桌面提供 GDI `BitBlt` 优先与 Z 序非受保护窗口 `PrintWindow` 回退，以及 `SendInput` + `PostMessageW(WM_MOUSEWHEEL)` 滚动投递，自动识别吸顶栏与右侧滚动条、按重叠内容精准拼接、展示明确停止原因（到达底部 / 手动停止 / 无法对齐 / 尺寸上限 / 最大帧数），支持部分长图预览确认保留或放弃，停止或取消后立即中止后续滚动。
- **I03 截图美化升级（PR #9）**：沿用既有 `I03` 入口，在纯色、留白、SDF 圆角、阴影与 `原图`/`1:1`/`16:9` 基础上新增线性渐变、自选本地背景图（居中 Cover 裁切与预览 1:1 匹配）、`4:5` 与 `9:16` 画布、多图批量套用、剪贴板粘贴/复制与内存原图交接，小图与超长滚动图完整呈现构图不变形。
- **I11 图片局部打码 & I12 截图批注（PR #10）**：共用 `canvasViewport.ts` 原图像素坐标与适应/`1:1`/缩放/平移/撤销重做逻辑；`I11` 支持多区域模糊、像素化与不透明实色遮盖，导出/复制/交接时经 Rust `image_redact.rs` 不可逆烘焙为平坦新像素（实色 100% 替换原像素，零可移除遮罩层与零原图缩略图，默认复用 `I09` 清理隐私元数据）；`I12` 支持箭头、直线、矩形、椭圆、中文文字（`Microsoft YaHei UI`）、高亮、连续编号、画笔、局部模糊与精确像素裁剪，切换工具保留会话内编辑进度。
- **I13 图片水印（PR #11）**：支持中英文文字与透明 PNG Logo、九宫格定位、边距、大小、不透明度与斜向平铺，横图/竖图/不同分辨率图片实时预览落位，始终导出不覆盖新副本并保留透明 PNG 通道。矩阵中已将图片（本版交付）、PDF（阶段 5）与视频（阶段 4）拆分记录。

## 下一阶段

阶段 3B 剩余项（`I02` 人脸检测、`I10` 屏幕取色）与自动 OCR、PDF 水印（阶段 5）、视频水印（阶段 4）按后续阶段继续跟踪。

## v0.10.0 · 阶段 3A（图片批处理五项工具）

`src/registry/tools.ts` 收录 **27 个**真实可用工具入口。本轮通过三个连续独立 PR（PR #6、PR #7、PR #8）构建统一图片批处理工作台（`ImageBatchShell` + `image_core.rs` + `wic_heic.rs` + `image_transform.rs` + `image_metadata.rs`），完整交付 `I05–I09` 五项本地离线图片批处理工具，并同步补齐 `v0.9.0` 公开交付记录与 `docs/VERIFICATION.md`。

- **统一批处理架构与 Windows WIC HEIC 桥接**：五项工具共享主图预览 + 右侧参数栏 + 底部文件队列的布局规范，支持多选文件/文件夹与桌面拖放、按 `SessionStoreProvider` 在切换工具时保留队列/实时进度/取消按钮、安全写入独立目录（同名来源自动编号永不覆盖源图，写入经临时文件原子提交）、取消即停并清理未完成暂存。通过 STA COM 桥接 Windows Imaging Component（WIC）动态探测本机 HEIF/HEVC 编解码扩展，已安装时离线支持 HEIC 读/写与手机 HEIC→JPG，缺失时在界面与结果项明确提示并引导，绝不假装支持或静默失败。
- **I05 图片格式转换**：支持 JPEG、PNG、WebP、TIFF、BMP 与 Windows WIC HEIC 互转，提供有损质量调节、WebP 无损选项与透明 PNG 转 JPEG/BMP 背景填充色实时预览；动图与多页 TIFF 显式标注仅处理首帧/首页。
- **I06 图片压缩**：支持 JPEG（`jpeg-encoder`）、PNG（明确区分 `oxipng` 无损优化与 `exoquant` 调色板有损压缩）与 WebP（`libwebp`）低/中/高三档批量压缩，主预览区内置可拖动的前后细节对比滑块与预计节省率；已压缩小图若变大则自动保留原始字节（标记「保留原件」），绝不负优化。
- **I07 图片批量缩放**：Lanczos3 高质量重采样，支持百分比、最长边像素与指定宽高三种模式，默认保持宽高比并禁止放大更小的图片；按 EXIF 实际显示方向实时计算并展示每张图的最终像素尺寸。
- **I08 图片旋转与翻转**：支持左/右转 90°、旋转 180°、水平与垂直翻转按点击顺序组合、撤销与重置；预览与导出均先按 EXIF 方向矫正再烘焙为 `Orientation = 1` 正立像素，避免 Windows 照片应用二次旋转。
- **I09 图片元数据清除**：容器级无损剥离 JPEG、PNG、WebP 与经典 TIFF 中的 GPS 定位、相机/软件、拍摄时间、EXIF、XMP、IPTC、注释及重复段与尾部数据（不重复有损编码像素），默认仅保留单条 `Orientation` 与 ICC/sRGB/gAMA 色彩配置并在写入前二次复检确认零残留；BigTIFF、SubIFD/RAW、HEIC、GIF、BMP 等无法可靠容器清理时逐项报错且绝不计为已清除。

## 下一阶段

阶段 3B 将继续完成图片分类剩余工具（`I01` 屏幕截图与长截图、`I02` 人脸打码、`I03` 截图美化进阶能力、`I10` 屏幕取色、`I11` 局部打码、`I12` 截图批注、`I13` 水印）。

## v0.9.0 · 阶段 2C4–2C5（文件分类收官）

`src/registry/tools.ts` 收录 **22 个**真实可用工具入口。本轮先后通过独立 PR 交付 `F04`（压缩与解压）与 `F05`（下载图片按来源归档），至此「文件」分类 `F01–F05` 全部 5 项工具完成交付。

- **F04 压缩与解压**。采用纯 Rust 离线解码/编码栈（`zip`、`sevenz-rust2`、`unrar-rs` 只读并随包附带 `licenses/F04-unrar-rs.txt`、`tar`、`flate2`、`lzma-rust2`、`bzip2-rs` 及自研 `iso_reader.rs`），提供「解压压缩包」与「创建压缩包」两个视图。支持多包拖入预览条目列表/路径/大小、每包独立隔离目录（同名包不混写）、跳过 `.DS_Store`/`__MACOSX`、Zip-Slip/驱动器路径/Windows 保留名/符号链接拦截、4 GiB 实际写入字节上限、实时进度与取消自动清理暂存目录，以及内存态加密密码（支持 AES-256 / ZipCrypto ZIP 创建与解压、7z/RAR 密码解压与输错重试）。
- **F05 下载图片按来源归档**。按确认的 Windows 文件夹归档方案实现：仅作用于用户手动选择的本地图片文件夹（不自动扫描日常「下载」目录）；本地读取已有 NTFS `:Zone.Identifier` 备用数据流中的 `HostUrl` / `ReferrerUrl` 并仅保留域名（丢弃完整 URL 与查询参数）；支持按域名或可编辑 CDN→站点映射表命名（严格域边界匹配）；无来源/不可读/非 NTFS 默认保持原位并支持可选归入「未知来源」；执行前逐项核对文件长度、修改时间、NTFS File ID 与 SHA-256（跳过预览后被修改项），通过 `MoveFileExW(..., 0)` 原子同卷移动且绝不覆盖已有目标，完整保留原始 `ZoneId` 与 `:Zone.Identifier` 字节流，二次运行自动识别已归档图片不再重复移动。

## 下一阶段

阶段 3 将进入图片处理与屏幕标注工具批次（`I01–I02`、`I03` 进阶能力与 `I05–I13`）。

## v0.8.0 · 阶段 2C3

`src/registry/tools.ts` 收录 20 个工具入口。新增的 `F03`（重复文件查找）位于「文件」分类，支持多文件夹递归扫描、三级流式内容比对、保留策略预设以及严格限定为 Windows 回收站的清理流程。

- **F03 目录去重与三级流式扫描**。合并重复路径与父子目录（如同时添加 `Root` 与 `Root\Sub`），默认跳过目录联接与符号链接，通过 `GetFileInformationByHandleEx` / `GetFileInformationByHandle` 识别指向同一物理分配的 NTFS/ReFS 硬链接（排除硬链接虚增的可释放空间）。按“字节大小 → 首尾各 64 KiB 指纹 → 256 KiB 流式整文件 SHA-256”逐级筛选，正确处理 `0` 字节空文件与小文件，无权/占用/消失项记录跳过原因且不中断其余扫描；进度流托管于 `SessionStoreProvider`，扫描期间切换工具再返回仍可实时查看进度并取消。
- **F03 保留约束与原生 Windows 回收站保护**。默认不勾选待移除项，手选与预设（保留最新、最旧、最短路径、指定目录）均强制每组至少保留一份副本；确认后后端先逐组复核保留副本与待移除文件的物理标识和完整 SHA-256（保留副本消失、被替换或内容改变时整组跳过），再通过独立 STA 线程调用 Win32 `IFileOperation`（`FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE` + `BitBucket` 策略预检 + `IFileOperationProgressSink::PreDeleteItem` 校验 `TSF_DELETE_RECYCLE_IF_POSSIBLE`），目标卷或系统设置无法保证进入回收站时立即跳过，严禁退化为永久删除。界面明确展示“已移入回收站”数量、大小及回收站仍占用磁盘空间的提示。

## 下一阶段

F04 压缩与解压（及待确认替代边界的 F05 下载项按来源归档）是文件分类的后续批次。

## v0.7.0 · 阶段 2C2

`src/registry/tools.ts` 收录 19 个工具入口。新增的 `F02`（批量重命名）位于「文件」分类，复用 `RenameRules` 规则与排序组件并补齐完整桌面预览、Windows 冲突校验、Rust 两阶段非覆盖重命名事务及最近批次撤销。

- **F02 规则与全量预览**。支持查找与替换（含字面量与正则表达式 `$1`、`${name}` 捕获组、`$$` 转义）、添加前后缀、序号与文件日期（`YYYY-MM-DD`，支持从 `0` 起算与位数补零）和大小写转换，按文件名自然序、创建时间或修改时间升序计算全批预览。拦截 Windows 禁止字符、末尾句点/空格、DOS 保留设备名、批内大小写不敏感重名及同目录外部同名冲突。
- **F02 两阶段非覆盖执行与撤销**。Rust 后端（`src-tauri/src/batch_rename.rs`）通过 `MoveFileExW(..., 0)`（不启用 `MOVEFILE_REPLACE_EXISTING`）执行 `原文件 -> 唯一临时名 -> 目标文件` 两阶段事务：支持仅改大小写与两文件互换名称；若预览后外部新建同名文件或中途遇到被占用文件，立即拒绝覆盖并将本批已移动项两步逆序回滚至原名；最近成功批次可在内存态中一键撤销，撤销时若原名已被其他新文件占用则保护双方文件不被覆盖。
- **Windows 交付**。保持 `com.luckylivio.winkit` 与当前用户 NSIS 升级方式，发行附件提供 `WinKit_0.7.0_x64-setup.exe` 与 `SHA256SUMS.txt`。

## v0.6.0 · 阶段 2C1

`src/registry/tools.ts` 收录 18 个工具入口。新增的 F01 位于「文件」，沿用工作台的搜索、收藏和最近使用。已注册工具的用户验收状态与本版本的测试范围分别见[功能矩阵](./PARITY_MATRIX.md)和[验证记录](./VERIFICATION.md)。

- **D10 坐标测距**。`80733e1` 已修复两处坐标误用。向测距页发送未舍入的结构化经纬度，保留轴序。解析地点和搜索链接时，不以视图中心代替目标位置。
- **D03 哈希校验**。`046f89b` 已交付多文件队列、逐文件比对、取消、同会话继续、失败重试、批量复制和 CSV 导出，支持完整的分组 SHA-256。v0.6.0 将清空操作限定在当前模式，清空文本不打断正在计算的文件批次。
- **F01 二维码生成与识别**。生成端从链接、文本和 Wi-Fi 信息生成可复制、可导出的图片。读取端从多选、Explorer 拖入或剪贴板取得图片，本地 Worker 和随包 WASM 识别二维码和条形码。敏感内容仅在内存中处理，主动复制或保存时才输出。
- **Windows 交付**。沿用 `com.luckylivio.winkit` 与当前用户 NSIS 安装方式。发行附件为 Windows x64 安装程序和 `SHA256SUMS.txt`。按源提交、Windows CI 运行、安装器字节数、SHA-256 和签名状态核对每次发行。下载入口见[项目首页](../README.md)。

## v0.5.0 历史记录

- **阶段 2B3（`v0.5.0`）交付闭环**：
  1. **三项有据局部正确性修复**：
     - **`D09` 解包前签名保护（`[C1]`）**：抽离复用 `findPresignedSignatureParamKey`，在首次解包前及进入每一层嵌套包装前均先行检查 `sig`/`X-Amz-Signature` 等已知签名字段；外层带签名时整条原样保留（不解包、不剥离参数），无签名外层包裹有签名内层时解开外层并在抵达有签名内层后立即停止保留。
     - **`D13` / `D14` 过期异步结果与保存快照隔离（`[C2]`、`[C3]`）**：`D13` 绑定请求序号与配置快照签名 `generatedConfigSignature`，修改长度/模式/类别、点击清空或卸载退出时立即作废在途请求；`D14` 在输入/选项变更进入防抖等待时立即终止旧 Worker 并递增代次，且另存对话框跨越输入/选项变更时检测代次不一致即取消保存，杜绝新后缀混用旧内容。
     - **`D14` 补齐矩阵单元格预算与增量 UTF-8 输出上限（`[C4]`）+ EFF 许可核实（`[R9]`）**：在分配表头与补齐短行矩阵之前先行校验含表头在内的总行列乘积预算（`1,000,000` 单元格，拦截 `1,002 × 1,000` 稀疏行扩张），并在 JSON、CSV、Markdown 全部生成路径中采用 `BoundedUtf8Builder` 增量累计 UTF-8 字节数，超 `16 MiB` 尽早停止；同时核实 `eff.org/dice` 页脚指向的 EFF 现行版权政策（`eff.org/copyright`），将 `THIRD_PARTY_NOTICES.md` 中 `D13` 词表许可说明校准为 `CC-BY-4.0`（附历史说明与 4 项连字符词条排除记录）。
  2. **`D10` 坐标转换与测距（离线子集，部分实现）**：
     - 统一内部二维 `Wgs84Point` 模型（显式字段 `latitude`、`longitude`、`datum: "WGS84"`，消除 `-0` 并保留 `0, 0` 有效原点），拒绝显式 `GCJ-02`/`BD-09`/非 4326 `SRID`/三维高程与 `geo:` 不确定度扩展。
     - 支持单框表达式/链接与独立纬经度双输入，离线输出并复制全部 **8 种表示**：`DD`、`DMS`、`DM`、`GeoJSON Point`（固定 `[经度, 纬度]`）、`WKT POINT (经度 纬度)`（按 WGS 84 约定）、`geo:纬度,经度`、官方 `Apple Maps` 与 `Google Maps` 坐标链接（含分秒进位且调整显示精度绝不截断内部坐标或测距输入）。
     - 本地打包官方维护的 `geographiclib-geodesic@2.2.0`（`MIT`，无 CDN），实现 **WGS 84 参考椭球逆测地线距离**（`km`/`m`/`mi`），稳定覆盖同点、极点、跨日界线与近对跖点。
     - 在独立可取消 Web Worker 中提供有限批量坐标解析与导出（`1 MiB / 5,000 行 / 单行 16 KiB / 输出 8 MiB`），复用 `D14` 增量预算 CSV 生成器与可选公式保护，默认导出含失败原因的完整状态表。
     - **未交付在线子项保留跟踪**：在线底图与点击选点、地点/地址搜索、地址反查、批量正反向地理编码、当前设备位置、外部地图打开动作与在线设置。
