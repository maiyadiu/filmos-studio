# PILOT_BASE_0 基线核验

## 冻结结论

`6ea93bfa08381264a1379fe938ade3a7513c7bba` 固定为 `PILOT_BASE_0`，对应 tree `51896f7874e21cc9868cb1bfa33b302cd323a925`。它是可供真实项目副本无费用试用的 Pilot 基线，不是 Stable，不是 RC1。

## 现场证据

- 已安装逻辑位置：`$HOME/Applications/FilmOS Studio.app`。
- `SourceIdentity.json` 已校验上述 Commit、Tree 和源码指纹。
- Film Core、Local Runtime、Backend、Web、MCP 与 Secure Tunnel 曾在该基线运行现场核验中通过；本清单不把随时会变的当前进程状态写成固定事实。
- 基线应用在新施工进行时继续供 Pilot 使用，不在运行中的 Pilot 工作树内开发。
- 已安装基线的 `InternalRuntime.json` 为 schema 2、profile `integration`，未内嵌 release channel 和付费 Submit 技术开关；因此 `PILOT_BASE_0` 上的零费用仍是治理禁令，不宣称已有技术 fail-closed。新 Candidate 必须嵌入并验证该边界。

## 副本与费用边界

Pilot 只使用正式数据中选定项目聚合的 SQLite 一致性、项目级脱敏副本，副本位于独立 Application Support 根，项目名强制带 `-PILOT`。复制脚本不修改源数据库，仅保留目标项目关联的素材、资源和项目内容，并清空 API Key、Cookie、CLI 登录凭据、会话、分享与账务状态。新 Pilot Candidate 构建中的真实付费 Submit 必须技术关闭。

## 可复现入口

- 项目副本：`desktop/macos/scripts/prepare-pilot-project-copy`
- 每日备份：`desktop/macos/scripts/backup-pilot-data`
- 恢复演练：`desktop/macos/scripts/restore-pilot-backup`（只恢复到新验证目录，不覆盖当前 Pilot）
- Pilot App 原子替换：`desktop/macos/scripts/install-pilot-app`（始终替换唯一 `$HOME/Applications/FilmOS Studio.app`，不创建第二个 App 或程序坞图标）
- 机器清单：`PILOT_BASE_0_MANIFEST.json`
- 统一问题入口：`web/src/components/governance/ReportIssuePortal.tsx`
