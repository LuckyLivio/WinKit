# WinKit 验证记录 (VERIFICATION.md)

本文档按实际执行情况记录阶段 0 与阶段 1 的自动化测试、构建检查、真实桌面运行与安装包验证结果（随里程碑持续更新）。

## 阶段 0 环境与基线核验

- 操作系统：Windows 11 x64（PowerShell `5.1.26100.9818`）
- 工具链：
  - Git `2.52.0.windows.1`
  - Node.js `v24.11.1` / npm `11.6.2`
  - Rust `rustc 1.98.1` / `cargo 1.98.1` (`stable-x86_64-pc-windows-msvc`)，`rustfmt 1.9.0`，`clippy 0.1.98`
  - Visual Studio 2022 BuildTools（含 VC x86/x64 工具集）+ Windows SDK `10.0.22621.0` / `10.0.26100.0`
  - Microsoft Edge WebView2 Runtime `157.0.4341.46`
- 本地规则加载验证：`D:\Projects\WinKit\AGENTS.md` 已通过 `.git/info/exclude` 排除版本控制，并经实测确认可被当前安装环境自动识别注入 `<user_rules>`。
- 工程构建与桌面启动记录：见下表（随阶段 0 / 阶段 1 验证更新）。

| 类别       | 检查项 / 命令                                            | 结果 | 备注                                              |
| :--------- | :------------------------------------------------------- | :--- | :------------------------------------------------ |
| 本地工具链 | `rustc --target x86_64-pc-windows-msvc` 最小编译链接测试 | 通过 | 输出 `msvc-x64-ok`                                |
| 规则加载   | `AGENTS.md` 自动发现与 `.git/info/exclude` 排除检查      | 通过 | `git status --ignored` 确认忽略，会话实测自动加载 |
