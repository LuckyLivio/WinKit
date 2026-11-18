# WinKit 阶段交接说明 (HANDOFF.md)

## 1. 当前完成基线（阶段 1.1 + 2A + 2B1 已闭环，v0.3.0）

- **仓库与分支**：`https://github.com/LuckyLivio/WinKit.git`（`main` 分支），本地配置 `user.useConfigOnly=true`，Author 与 Committer 固定为 `Livio <liviow@163.com>`。
- **本地排除文件**：`AGENTS.md` 与 `WinKit_Phase_0_1.md` 继续通过 `.git/info/exclude` 排除，未进入版本库。
- **阶段 2B1（`v0.3.0`）交付闭环（共 12 项真实可用桌面工具）**：
  1. **退出准入同步与进度终态修正**：将文件副作用任务（`save_text_file`、`hash_file_multi`、`codec_transform_file`、`codec_save_output`、`export_beautified_png`、`read_diff_text_file`）的 `TaskTokenGuard` 登记前移至 `spawn_blocking` 入队之前；新增 `request_window_close` 在同一互斥锁内完成空闲关闭判断与 `shutting_down` 置位（配合 `begin_graceful_shutdown` 与 `abort_graceful_shutdown`），并与前端 `shutdownGate` / Worker 终止联动；修正失败或取消事件不再统一填充 `percent: 100` 且补齐真实错误码与脱敏错误信息。
  2. **`D05` JWT 本地解码与验签**：三段式 JWS（大整数零损保真，上限 `256 KiB`）、五段式 JWE 保护头只读识别、三维度状态分离（结构/签名/NumericDate 实时核对）及原始 `header.payload` 片段本地 `HS256`/`HS384`/`HS512` 恒定时间验签（密钥上限 `64 KiB`，拦截 `crit`，区分 `alg=none`，公钥算法仅解码不验签——已完整覆盖原版公开基线，RS*/PS*/ES*/EdDSA 公钥验签与 JWE 解密属未立项可选增强而非原版欠账）。
  3. **`D07` 文本与文件差异对比**：并排与内联视图、行内词/字符级高亮、BOM/CRLF/LF/末尾无换行识别与二进制拦截、忽略空白/大小写展示过滤，以及经 `git apply` 验证可精确还原目标文本的 Unified Diff 复制与 `.patch` 另存（单侧上限 `4 MiB / 50,000 行`，相较原版公开 `200,000 行` 保留真实规模差异；目录递归、三方合并与二进制对比无原版依据）。
  4. **`D08` 正则表达式测试**：明确标注 **ECMAScript / JavaScript `RegExp`** 引擎，编译/匹配/替换隔离在独立同源模块 Web Worker 中，主线程看门狗执行 `2,000 ms` 真 `worker.terminate()` 抢占终止（不保留超时前局部匹配；上限：表达式 `16,384` UTF-16 代码单元、输入文本 `2 MiB`、单次收集 `2,000` 处匹配；与原版 ICU 正则的标志、替换语法及超时局部结果策略差异如实保留，多文件正则批处理无原版依据）。
  5. **`D11` Unicode 隐形与混淆字符检查**：内嵌离线 **Unicode 16.0.0** 官方数据与 UTS #39 单码点 `skeleton` 候选提示（上限 `512 KiB / 50,000 码点`，明确不承诺识别全部欺骗文本；IDNA 域名风险评分、字体级相似度与额外规范化转换无原版依据），支持双向定位、注意项筛选及默认保留 Emoji `ZWJ` 与波斯语 `ZWNJ` 的可预览非破坏性清理。
- **验收状态边界**：全部已启用工具用户验收状态统一保持为 `待验收`（其中 `D05` 已覆盖原版公开基线改为 `待验收`，`D02`、`D03`、`D06`、`D07`、`D08`、`D11`、`I03` 因真实规模或引擎差异保持实现状态为 `部分实现`）；用户原始退出反馈仍保持“已修复可复现缺陷并加固并发准入边界，待用户日常复测”。

## 2. 当前推进范围与后续切入边界

1. **阶段 2B2（当前实施中，建议版本 `v0.4.0`，4 项纯本地开发者工具）**：
   - `D09` 链接跟踪参数清理与已知跳转包装离线解包（含一次性读取/净化剪贴板；全局剪贴板持续监听开关留阶段 8）。
   - `D12` Lorem Ipsum 占位文本生成（按词/句/段输出纯文本、HTML `<p>` 段落或 Markdown）。
   - `D13` 随机密码与口令短语（Passphrase）生成（基于 OS CSPRNG 无偏抽样，含排除易混字符与按生成模型估算的熵/强度说明）。
   - `D14` CSV ↔ JSON 互转及 CSV / JSON → Markdown 表格转换（RFC 4180 引号与字段内换行、大整数与前导零保真、嵌套对象展开、可选电子表格公式保护与错误行/记录号定位；不含无原版依据的 Markdown 反向解析）。
2. **`D10` 地图坐标拾取与换算（紧接阶段 2B2 之后的专项边界）**：
   - 离线十进制、DMS、DM、GeoJSON、WKT、`geo:` 链接互转与两点测距可纯本地实现；在线瓦片地图来源须在实施前获用户明确确认，未确认前不发起外部地图联网请求。
3. **阶段 2C（文件工具批次与 `D03` 多文件批处理）**：
   - `D03` 多文件批量哈希校验、`F01` 二维码生成与图片解码、`F02` 批量重命名（全量冲突预览 + 事务回滚）、`F03` 重复文件查找（三级流式比对 + 移入 Windows 回收站）、`F04` 压缩与解压（严格防 Zip Slip）、`F05` 下载项按来源归档（NTFS `Zone.Identifier` 方案待阶段 2C 确认）。
