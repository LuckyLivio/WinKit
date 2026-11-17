# WinKit 阶段交接说明 (HANDOFF.md)

## 当前进度状态

- **当前所处阶段**：阶段 0–1（本轮完成后按约束停止于阶段 1 终点）。
- **分支与身份约束**：工作分支 `main`，仓库级配置 `user.useConfigOnly=true`，提交身份锁定为仓库所有者个人身份 `Livio <liviow@163.com>`。

## 后续接续指引（阶段 1 完成后供阶段 2 使用）

1. 阅读本地 `AGENTS.md`（由 `.git/info/exclude` 排除，不入库）及 `docs/ROADMAP.md`、`docs/PARITY_MATRIX.md`。
2. 阶段 2 范围：开发者工具其余条目（`D02`、`D04–D14` 及补齐 `D03` 的 MD5/SHA-1/SHA-384/SHA-512）、文件工具（`F01–F05`）与轻量文本工具（`T08–T09`）。
3. 注意平台替代确认项：`F05`（下载来源归档）与 `D10`（地图坐标拾取）涉及平台差异（已在 `docs/PARITY_MATRIX.md` 标为 `平台替代待确认`），实施前需先向用户确认具体方案。
