# FilmOS Studio 日报

## 2026-08-28 开工批次 01

- 状态：已进入实施，尚未进入功能验收。
- 完成：实时核查最新稳定 Release；创建产品 Fork；拉取三个远端；基线锁定 `v1.2.1`；核查 Host 核心对象、数据库注册、项目 API 和 MCP Schema。
- 复用：Project、ProjectUnit、CanvasUnitLink、Shot、Asset/Version/Representation、Workflow、Task、Canvas/Project Agent Tools。
- 扩展：仅建立治理文件和 Film Contracts V0；尚未修改 Host 表或页面。
- 测试：Film Contract Test 已通过（`FILM_CONTRACTS_OK schema=0.1.0 paths=9 axes=6`）；JSON 与 YAML 均已解析。原生测试尚未运行。
- 风险：上游 `main` 已超过 Release；14 Track 需轮转并发。
- 下一步：提交基线，创建 `integration` 和 14 个 worktree，启动 Track 00/02/13。

## 2026-08-28 开工批次 02

- 集成：Track 00 与 Track 13 已合入 `integration`；集成后专项门禁通过。
- 上游：静态兼容等级为 `C_MIGRATION_REQUIRED`；Candidate 原生验证因上游 S3 测试的外部 DNS 解析失败被正确阻断为 `D_BLOCKED`，未合并 Candidate。
- 原生基线：Backend 通过；Web `471/0` 且构建通过；Canvas Agent `316/0`、5 个 Windows 专项 skip，构建通过。
- Golden A：离线 Mock `4/0`，严格经过 `Candidate -> QC/Approval -> Approved`，外部调用 0。真实 Film Core/UI/Canvas/MCP/Provider 链仍为 `NOT_RUN`。
- 并行：Track 01、02、03 正在执行，其余 Track 保持独立 worktree ready。

## 2026-08-28 开工批次 03

- 集成：Track 02 已合入 `integration`；Film Core V0 使用独立 SQLite WAL Sidecar，不修改 Host 表。
- 已实施：Core 生成 UUIDv4、六轴状态、Host ID 显式映射、`expected_version` 乐观并发、实体与 AuditEvent 原子写入、审计事件数据库级禁止改删。
- 接口：共享 OpenAPI 共 12 条路径；8 条运行时已实现，4 条明确为 `planned` 且未注册伪路由。
- 验证：Film Core `10/0`；合同校验通过；compileall 通过；Golden A 离线 Mock `4/0`，外部调用 0。
- 未完成：Golden A 的真实 Film Core/UI/Canvas/MCP/Provider 纵向链仍是 `NOT_RUN`；Track 01、03、04 正在并行执行。

## 2026-08-28 开工批次 04

- 集成：Track 01、03、04、05 已合入 `integration`；新增能力全部默认关闭，没有改写旧影策流程。
- 桌面：SwiftPM/AppKit 最小核心已建立；Workspace 与受控进程 Supervisor 通过 canonical symlink 逃逸门禁。Debug/Release 构建通过，Swift `14/0`。
- 项目与剧本：动态 ContentUnit 只读投影 `7/0`；ScriptVersion/人审锁定/长对白保真/影响建议 `9/0`；Web 不生成正式 ID、不自动写 STALE。
- 生产画布：ID-only 纯投影、唯一默认画布冲突提示、revision/hash 写入意图和多对多 Coverage `7/0`；Canvas 仍非正式事实源。
- 联合验证：Film Web 专项合计 `23/0`，TypeScript 与生产构建通过；保留既有大 chunk 告警。
- 未完成：真实 Golden A 纵向链、浏览器 UI、签名 `.app`、Host 唯一 production 画布写路径与系统 A/B 来源验证仍未完成。

## 2026-08-28 开工批次 05

- 集成：Track 06–12 已完成首切片审查并合入 `integration`；十四轨均已启动并留下独立分支、代码/计划或核查证据。
- 资产/提示词/导演：Asset/VisualLock `10/0`，PromptDraft `8/0`，Director 连续性 `9/0`；稳定 ID、版本、哈希、Host opaque ID 和 Candidate/Approved 分离均失败关闭。ObjectID 仍为 `MISSING_NOT_IMPLEMENTED`。
- Agent：离线 Read → Preview → Apply 网关 `13/0`；Canvas Agent 原生回归 `328/0`、5 个 Windows 专项 skip。实际 Film MCP 尚未注册，真实 Sidecar/MCP Golden 未跑。
- Provider：本地 Submission Package 与 Manual Result Import `11/0`；包固定 `not_submitted`，导入只产生 Candidate。Dreamina 仅声明源码可证实的图像/视频复用边界；Comfy 未推断具体模型能力；Flova 保持 `UNVERIFIED_SOURCE_ABSENT/DEFERRED`。
- 迁移/远程：沙箱迁移预演 `8/0`，未打开数据库或真实用户数据；Remote Authority Preview `8/0`、48 assertions，网络动作和上传均为 0。
- 当前头总门禁：Film Web `69/0`、189 assertions，TypeScript 与生产构建通过；Film Core `10/0`；Contracts 通过；Golden A 离线 Mock `4/0`；迁移 `8/0`。
- 过程证据：Agent 首次集成专项因依赖目录未安装而无法加载 `zod`，按锁文件安装后专项、构建和完整回归通过；Film Core 总门禁第一次命令路径重复写入 `film-core/tests`，没有进入测试，改为当前目录 `tests` 后 `10/0` 通过。
- 准确边界：无外部生成、上传、远程发布或积分消费；Candidate 分支仍未通过真实 Golden，不是可发布候选版。

## 2026-08-28 开工批次 06｜第二阶段

- 裁定：锁定真实 Golden A 最小纵向合同；接受 Prompt/Provider/Agent 请求，部分接受 Director 与 Script 合同，未把 deferred 对象伪装为已实现。
- Core：Schema 升至 `0.2.0`，17 paths（16 implemented / 1 planned）；正式记录、Human-only Script Lock、Review/Approval 分离与双层 hash 已落地。加入严格 loopback-only CORS 后共 `37/0`。
- MCP：共享 server 已接入 Film 注册函数；默认与 `canvasOnly` 工具增量均为 0，显式开启只新增 5 个 Film 工具；真实 MCP SDK + Sidecar Read → Preview → Apply 通过。
- Web：真实 Project Overview 入口与 Production Canvas 安全预演已接线，任一 Flag 关闭即不产生 Film DOM；Film 专项 `78/0`、228 assertions，原生 Web `471/0`，类型检查和构建通过。
- Golden A：真实临时 FastAPI/SQLite HTTP 链 `2/0`，从 Host/Core Project、Script Lock、Director/Coverage、VisualLock/Asset、Prompt/Package、Manual Import、Candidate/Review 到 Human Approval 全链通过；`fallback_mock_used=false`，外部调用 0。
- 浏览器：Playwright 真实操作 Host 临时项目，发现并修复 Film Core CORS 缺口；`/health` 200 且回显精确本机 Origin，启用态显示安全预演，关闭态 Film DOM 不存在。
- 回滚/恢复：stale version/hash/revision/stateHash 全部 fail closed；当前守卫可重放；关 Flag 恢复纯 Host 概览。完整灾难恢复、唯一 production canvas 正式创建和 Impact API 尚未完成。
- 安全边界：未执行外部生成、上传、远程发布、真实数据迁移或积分消费；所有 Film Flag 仍默认关闭。

## 2026-08-28 开工批次 07｜第三阶段

- 裁定：Golden B 采用三人长对白、DirectorUnit/Shot 多对多、五维连续性、受限 J-cut、Character/Costume Lock 与精准 STALE；独立 SceneTwin/Camera/Blocking/Composition 留到 Golden C。
- Core：Schema 升至 `0.3.0`，21 paths 全部 implemented；正式 `ScriptStructureMap`、`ImpactEdge`、Impact 查询、原子 STALE、审计和幂等回执落地，44 tests passed。
- Golden B：真实临时 Sidecar/SQLite/HTTP 跑通 Cue 与 Costume 精确传播、未映射变化、stale guard 零部分写入和幂等重放；无 Mock 回退，外部调用 0。
- Web：Story Review 差异/影响预览与 Host Asset 只读投影均默认关闭；本地媒体拒绝 containment/symlink 逃逸；Film 专项 `97/0`、261 assertions，全量 `602/0`、2545 assertions，类型检查与构建通过。
- Agent/Provider：Dreamina 影视血缘只读投影默认关闭，不提交、不批准；Canvas Agent `343/0`、5 个 Windows 专项 skip，OpenAPI 同步与构建通过。
- 浏览器：真实临时 Host 项目完成 Story/Asset 开启态与关闭态复核；关闭后新增 Film DOM 消失且 Host 原页面可用。登录后只剩既有 Ant Design 弃用告警，无业务错误。
- 总结：第三阶段状态为 `PASSED_LOCAL_INTEGRATION`，不是生产批准。外部生成、上传、积分消费、远程发布和真实迁移继续关闭。

## 2026-08-28 开工批次 08｜第四阶段

- Core：Schema 升至 `0.4.0`，23 paths 全部 implemented；`SceneTwinVersion`、`CameraVersion`、`BlockingVersion`、`CompositionVersion` 使用独立 UUIDv4、version/hash 守卫与追加审计，50 tests passed。
- Golden C：真实临时 Sidecar/SQLite/HTTP 完成 SceneTwin V1→V2、三套 Camera/Blocking/Composition、四类 pass 血缘、本地 Previs 与三个 Video Candidate；只命中声明 lighting 组件的一个 Prompt STALE，未关联 Prompt 与 Candidate 保持 fresh，无 Mock 回退，外部调用 0。
- Production Canvas：新增默认关闭的 Host 正式创建 API；Human confirmation、Project revision、SourceText SHA-256、项目归属与历史重复均失败关闭。Canvas、production Link、Guard、Audit 在同一事务内创建，并发双 Service 只得到一组事实。
- 恢复：Core 重启、SQLite Online Backup 恢复、事务中途故障、错误 hash 和幂等回放均通过；失败时无孤儿记录，恢复后 Stable ID、状态、审计与 receipt 一致。
- 浏览器：真实临时 Host 项目从创建预演进入 Human 二次确认，成功返回 created/revision/audit；刷新复用同一 Canvas，关闭 `VITE_FILM_PRODUCTION_CANVAS` 后 Film DOM 消失且 Host 项目、章节和已持久化画布仍可用。
- 门禁：Contracts `0.4.0/23/0 planned`；Core `50/0`；Golden Python `26/0`，本地 TypeScript `6/0`、37 assertions；Backend、Web 471/0、类型检查和构建通过。Canvas Agent OpenAPI 同步与构建通过；全量有一个既有 Dreamina 长驻 CLI 顺序依赖测试失败，单独 3/3 通过且本阶段未改该路径，按已知非本阶段门禁记录。
- 边界：第四阶段状态为 `PASSED_LOCAL_INTEGRATION`，不是外部生成、正式 Approval、用户数据库迁移或生产开关批准；Provider、上传、额度、发布和真实迁移写入仍为 0。
