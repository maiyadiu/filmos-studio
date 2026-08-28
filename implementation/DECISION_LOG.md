# FilmOS Studio 决策日志

## D-0001｜主干与基线

- 状态：已锁定
- 决策：影策上游是唯一 Host 主干；FilmOS Studio 基线固定为最新稳定 Release `v1.2.1` 的 commit `61b332583c4fcbf71890ae67e3f0f104d67706b9`。
- 依据：`EV-0001`、`EV-0002`。
- 回滚：回到标签 `v1.2.1` 或基线标签 `filmos-upstream-v1.2.1`。

## D-0002｜事实边界

- 状态：已锁定
- 决策：Host 保留 Project、ProjectUnit、Shot、Canvas、Resource、Asset/Version、Generic Task 与 Provider 权威；Film Core 用 Sidecar 保存影视语义和生产真值。
- 依据：`FG-0001`–`FG-0007`。
- 回滚：关闭 Film Feature Flags，Host 原功能仍可用。

## D-0003｜Stable ID V0

- 状态：已锁定，尚无生产数据
- 决策：`film_entity_id` 由 Film Core 生成 UUIDv4，创建后不可变；不由标题、路径、顺序、内容哈希或 Host ID 派生。Host 映射显式保存。
- 原因：内容重写、单元重排和上游升级都不应改变影视实体身份。
- 约束：任何变更属红线，需 Program Integrator 与用户裁决。

## D-0004｜状态分轴

- 状态：已锁定 V0
- 决策：正式实体使用 `creative_stage` / `execution_state` / `review_state` / `lock_state` / `delivery_state` / `stale_state`，禁止用单个 `status` 表达全部含义。

## D-0005｜第二阶段最小纵向合同

- 状态：已裁定，尚无生产数据。
- 目标：将 Golden A 从离线 Mock 提升为真实 Film Core / 已注册 MCP / 默认关闭 Web 投影 / Manual Provider 本地导入链。
- 接受 `CR-07-001`：新增 `PromptDraftProvenance` companion，不给旧 `PromptDraft` 静默补默认值。
- 接受 `CR-10-001`：新增 `GenerationAttemptEvidence`，Provider ID 保持可扩展，禁止保存密钥、Cookie、data URL、绝对路径和外部下载 URL。
- 部分接受 `CR-09-001`：本阶段正式落地 `DirectorUnit` / `CoverageLink` / `ContinuityCheckResult`；SceneTwin、Blocking、Camera 的完整持久化留到 Golden C，不因投影模块存在而宣称已实现。
- 接受 `CR-08-001`：实际 MCP 入口调用默认关闭的 Film 注册函数；增加 OpenAPI 操作面同步门，未通过前不扩展正式写入工具。
- 部分接受 `CR-04-001`：本阶段正式落地 Human-only Script Lock、`ScriptDecision` 与 version/hash 原子守卫；Cue/Section 稳定映射和精确 Impact 传播留到下一阶段，不能以当前脚本锁定链冒充已实现。
- 安全边界：本阶段 Provider 只准备 `NOT_SUBMITTED` 包并导入本地 fixture/人工结果；不进行外部生成、上传、远程发布、额度消耗或真实数据迁移。
- 正式批准：Candidate 和 Review 不得自动生成 Approval；Approval 必须由 Human 绑定当前 Candidate content hash。
- 回滚：保持全部 Film Feature Flag 默认关闭，移除 MCP 共享入口的注册调用，并回退 Sidecar 新表/路由；不修改 Host 核心表或稳定 ID。

## D-0006｜第三阶段 Golden B 与精准 STALE

- 状态：已裁定，第三阶段本地验收通过，尚无生产数据或外部执行。
- Golden B：验证多人长对白、DirectorUnit 与 Shot 多对多、Blocking/轴线/视线连续性、受审计的 J-cut 声音先入例外、Character/Costume Lock，以及上游变化后的精准 STALE。
- 剧本结构：接受 `CR-04-001` 的剩余范围；使用绑定当前 ScriptVersion version/hash 的 companion `ScriptStructureMap` 保存稳定 Section/Cue 映射，不给既有 ScriptVersion 静默补字段，也不复制正文。
- 影响图：Film Core 正式持有 `ImpactEdge`、Impact 查询和 STALE 写入；只有声明的 cue/section/VisualLock component/AssetBinding dependency 命中才传播，未映射变化只报告 unresolved，不得整图自动污染。
- Director 边界：Golden B 的 Blocking 只作为 DirectorUnit 表演调度与 Continuity 检查输入；独立 `BlockingVersion`、Camera/Composition 与 SceneTwin 仍属于 Golden C，不在本阶段伪装落地。
- 资产边界：Host 继续唯一持有 Asset/AssetVersion/Representation/Resource；Film 只保存 opaque ID、版本/hash、用途、来源/授权和影视锁语义。本地预览不得上传或绕过 workspace containment。
- UI 边界：Story Review 与 Asset 面板各自默认关闭；Web 只产生 preview/recommendation，Human 显式命令才可进入 Core 正式 lock/STALE。
- Provider 边界：本阶段可完善 Dreamina/Comfy 本地血缘与统一回执，但不执行外部生成、上传、额度消耗或远程发布。
- 回滚：保持 `film.production_core`、`film.story_studio`、`film.asset_lock` 默认关闭；撤销第三阶段 API/面板不改 Host 核心表、Stable ID 或用户媒体。
- 验收：Core `44/0`，真实 Golden B 与冲突/幂等链通过，Story/Asset 开关双态浏览器通过；详见 `阶段三验收.md` 与 `test-reports/浏览器GoldenB.md`。
