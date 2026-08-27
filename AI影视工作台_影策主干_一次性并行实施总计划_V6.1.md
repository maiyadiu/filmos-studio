# AI影视工作台一次性并行实施总计划 V6.1

> **状态**：正式执行版，替代 V6.0 中“WP-00 完成后才开始编码”的串行方式。  
> **主干**：`ddcat-ai/open-ai-canvas`（影策）稳定 Release Fork。  
> **目标**：在不重复开发影策既有能力、不牺牲上游兼容性的前提下，一次性铺开桌面化、Local-first、影视生产语义、动态剧集管理、单元生产画布、资产一致性、SceneTwin、Prompt Kernel、CLI/Provider、多 Agent 与旧系统迁移。  
> **执行方法**：多 Worktree、多 Codex 线程并行；核查与实施在每条工作流内部同步完成，不再把全局只读审计作为所有开发的前置阻断。  
> **默认大脑**：Codex；必须保留 DeepSeek、Claude、本地模型和 Human Only 的切换能力。  
> **默认产品形态**：macOS 桌面应用，Local-first；支持 Remote 和 Hybrid。  

---

# 0. 总裁决：一次性全部铺开，但绝不“大爆炸式乱改”

用户已明确要求快速实施，因此从本计划生效开始：

- 不再执行“先完成 WP-00，再开始 WP-01”的全局串行模式；
- 不再要求每个小任务都等待用户单独批准后编码；
- 所有主要工作流在第 1 天同时启动；
- 每条工作流在动手前，必须核查自己涉及的影策、Tigerowo、Basketikun、系统 A、系统 B、Flova 或执行器代码；
- 核查结果直接决定该工作流采用 `REUSE / EXTEND / BUILD / DEFER`，不阻塞无关工作流；
- 所有新增能力先放在独立目录、独立服务、Sidecar 表或扩展槽中；
- 影策主干文件只做最小接线修改；
- 所有功能默认受 Feature Flag 控制；
- 每天至少一次合并到 `integration`，持续运行完整测试；
- 只在红线条件下暂停并询问用户。

正确理解：

```text
一次性全部铺开
≠
所有人同时改同一批文件

一次性全部铺开
=
共享合同先行 + 14 条并行工作流 + 每日集成 + 功能开关 + Golden 流程持续验收
```

---

# 1. 已核验的影策基础：必须最大化复用

实施人员不得假设影策只是一个普通画布。当前公开代码已经证明下列能力存在：

## 1.1 项目管理骨架

影策已有：

- 项目详情路由；
- 制作概览；
- 剧情章节；
- 项目画布；
- 角色与资产；
- 项目设置；
- 当前任务；
- 项目阶段；
- 章节进度；
- Shot、画布、待处理统计；
- 章节画布创建与关联；
- 已有 Shot 初始化成 Storyboard。

主要入口：

```text
web/src/pages/projects/detail.tsx
web/src/pages/projects/detail/overview.tsx
web/src/pages/projects/detail/chapters.tsx
web/src/pages/projects/detail/assets.tsx
web/src/pages/projects/detail/settings.tsx
web/src/lib/project-workbench.ts
web/src/services/api/projects.ts
```

裁决：不新建另一套 Project Hub；客制化现有项目工作台。

## 1.2 动态内容单元基础

影策已有：

- `ProjectUnit.kind`；
- `parentId`；
- 稳定 ID；
- `position`；
- 导入；
- 编辑；
- 虚拟列表；
- 搜索；
- 拖拽重排；
- 指定位置移动；
- Unit 与 Canvas 链接。

裁决：动态 Episode/Chapter/Season/Arc 只做扩展，不重写列表和排序。

## 1.3 Shot、资产和工作流基础

影策已有：

- `Shot`；
- `Asset`；
- `AssetVersion`；
- `AssetRepresentation`；
- `ShotAssetReference`；
- `ProjectAssetCandidate`；
- `WorkflowTemplateVersion`；
- `WorkflowInstance`；
- `WorkflowStepInstance`；
- `WorkflowStepTask`；
- `CanvasUnitLink`；
- 通用 Task；
- 资源长期 ID；
- SQLite / PostgreSQL；
- 对象存储与本地缓存；
- 任务恢复、取消和重试。

裁决：Film Core 只补影视深层语义，不复制这些通用对象。

## 1.4 风格执行基础

影策已有：

- StyleProfile；
- 项目风格快照；
- 图片/视频模型执行计划；
- 完整执行 / 降级执行 / 阻断；
- 风格资产引用。

裁决：VisualLockSet 建在现有 StyleProfile 之上。

## 1.5 Agent、MCP 与 CLI 基础

影策已有：

- Canvas Agent；
- Codex MCP；
- Codex App 插件；
- `canvas_get_context`、`canvas_find_nodes`、`canvas_validate_ops`、`canvas_apply_ops` 等工具；
- 网页侧边栏复用 Codex Thread；
- 写入前确认；
- Dreamina CLI 登录、状态、积分、任务投递与恢复；
- ComfyUI Bridge。

裁决：不重建 Agent 和本地运行时；增加 Production / Director / Prompt 工具面。

---

# 2. 最终目标架构

```text
AI Film Studio.app
│
├── Swift/AppKit Desktop Host
│   ├── 进程管理
│   ├── Keychain
│   ├── 文件授权与安全书签
│   ├── 多窗口 / 拖放 / Quick Look
│   ├── 日志、通知、崩溃恢复
│   └── 更新、备份、回滚
│
├── Yingce Host Fork
│   ├── 现有项目管理
│   ├── 现有无限画布
│   ├── 现有资产、任务、Provider
│   ├── 现有导演台
│   ├── Canvas Agent / MCP
│   └── Film Extension Slots
│
├── Film Production Core
│   ├── Story / Script
│   ├── ContentUnit / Scene
│   ├── DirectorUnit / Coverage
│   ├── Shot影视扩展
│   ├── SceneTwin
│   ├── VisualLock / Continuity
│   ├── Prompt Kernel
│   ├── Review / Approval / Audit
│   └── STALE / Impact Graph
│
├── Agent Brain Gateway
│   ├── Codex Adapter
│   ├── DeepSeek Adapter
│   ├── Claude Adapter
│   ├── Local Model Adapter
│   └── Human Only
│
├── Execution Runtime
│   ├── Dreamina CLI
│   ├── Flova CLI
│   ├── Manual Web Provider
│   ├── API Providers
│   ├── ComfyUI Bridge
│   └── Blender Bridge
│
└── Storage Modes
    ├── Local Workspace
    ├── Remote Workspace
    └── Hybrid Publish
```

---

# 3. 快速实施的仓库与分支组织

## 3.1 主仓库

以影策稳定 Release 创建 Fork：

```text
ai-film-studio-yingce/
```

推荐目录：

```text
ai-film-studio-yingce/
├── web/                         # 影策现有前端
├── backend/                     # 影策现有Go后端
├── canvas-agent/                # 影策现有Agent
├── plugins/                     # 影策现有插件
│
├── film-core/                   # 新增，FastAPI/Pydantic/SQLite
├── film-contracts/              # 新增，OpenAPI/JSON Schema/共享枚举
├── film-adapters/               # 新增，系统A/B、Flova、Host映射
├── film-provider-runtime/       # 新增，CLI/Manual/外部Provider
├── desktop/macos/               # 保留并升级Swift壳
├── tests/film-golden/           # 新增Golden纵向测试
├── scripts/upstream/            # 上游同步和差异检测
├── docs/film-adr/               # 架构决策
└── implementation/              # 执行台账、Fit-Gap、风险、日报
```

## 3.2 Git远端

```text
origin              用户自己的产品Fork
upstream-yingce     ddcat-ai/open-ai-canvas
reference-tigerowo tigerowo/infinite-canvas
reference-basket   basketikun/infinite-canvas
```

只有 `upstream-yingce` 进入常规合并流程。其他两个只做差异检索和模块参考。

## 3.3 分支

```text
main                    正式稳定版
integration             每日集成分支
candidate               Golden通过的候选版
upstream-sync/*         上游同步
track/*                 并行工作流分支
release/*               桌面发布
```

## 3.4 Worktree

第一天建立：

```text
../wt-upstream
../wt-desktop
../wt-film-core
../wt-project-ui
../wt-story
../wt-production-canvas
../wt-assets
../wt-prompt
../wt-agent
../wt-director
../wt-providers
../wt-migration
../wt-remote
../wt-qa
```

每个 Worktree 使用独立 Codex Thread。禁止两个工作流同时修改同一批核心文件。

---

# 4. 执行治理：快速，但不发散

## 4.1 唯一总控线程

指定一个 Codex Thread 为：

# Program Integrator

只负责：

- 维护总体计划；
- 分配工作流；
- 管理共享合同；
- 审核跨轨变更；
- 解决冲突；
- 每日合并；
- 运行Golden；
- 生成日报。

它不承担大量具体编码，避免总控线程被实现细节淹没。

## 4.2 必须维护的文件

```text
implementation/PROGRAM_BOARD.yaml
implementation/EVIDENCE_LEDGER.csv
implementation/FIT_GAP_MATRIX.csv
implementation/FILE_OWNERSHIP.yaml
implementation/INTEGRATION_STATUS.yaml
implementation/RISK_REGISTER.csv
implementation/DECISION_LOG.md
implementation/UPSTREAM_COMPATIBILITY.md
implementation/MIGRATION_MAP.md
implementation/DAILY_REPORT.md
implementation/SCOPE_LOCK.yaml
```

## 4.3 每条工作流的执行循环

不再等待全局 WP-00。每个 Track 自己执行：

```text
1. VERIFY：读取实际源码、测试、界面和数据库
2. CLASSIFY：REUSE / EXTEND / BUILD / DEFER
3. RECORD：写入证据和Fit-Gap
4. IMPLEMENT：立即做最小差异实现
5. TEST：本轨测试
6. INTEGRATE：合并integration
7. GOLDEN：运行受影响纵向链
```

## 4.4 无需逐项向用户等待批准

以下范围已视为用户预批准：

- 新增独立目录和 Sidecar 表；
- 新增测试；
- 新增 Feature Flag；
- 新增 Adapter；
- 新增 MCP Tool；
- 现有页面的非破坏性扩展；
- 现有对象的 Sidecar Extension；
- 本地工作空间和Provider接入；
- 不可见的基础设施重构。

只有下列红线需要暂停：

1. 删除或不可逆迁移用户数据；
2. 改变稳定 ID；
3. 替换画布引擎；
4. 放弃影策主干；
5. 修改上游核心表且无法 Sidecar；
6. 引入新的大型框架或数据库；
7. 需要公开上传本地未授权资产；
8. Golden数据损坏；
9. 与用户已经锁定的产品目标冲突。

---

# 5. 共享合同：所有轨道第一天同时依赖

由 Track 02（Film Core）负责，24小时内给出可用 V0，不要求等到完整。

## 5.1 ID与引用

```text
host_project_id
host_unit_id
host_shot_id
host_asset_id
host_asset_version_id
host_canvas_id
host_resource_id
film_entity_id
content_hash
expected_version
```

## 5.2 核心对象

```text
FilmProjectExtension
ContentUnitExtension
StoryBibleVersion
SeasonArcVersion
EpisodeOutlineVersion
ScriptVersion
Scene
DirectorUnit
CoverageLink
ShotExtension
SceneTwin
SpatialVersion
CameraVersion
BlockingVersion
CompositionVersion
VisualLockSet
ContinuityState
PromptDraft
GenerationPackage
GenerationAttemptExtension
Review
Approval
AuditEvent
ImpactEdge
```

## 5.3 状态必须分轴

```text
creative_stage
execution_state
review_state
lock_state
delivery_state
stale_state
```

禁止使用一个 `status` 表达全部含义。

## 5.4 API

Film Core 通过 OpenAPI 输出，前端自动生成 TypeScript Client：

```text
GET  /film/projects/{hostProjectId}/context
GET  /film/units/{hostUnitId}
GET  /film/shots/{hostShotId}
POST /film/commands/preview
POST /film/commands/apply
GET  /film/impacts/{entityId}
POST /film/reviews
POST /film/prompts/compile
POST /film/continuity/check
```

MCP Schema 从同一 Pydantic/JSON Schema 生成，避免 API、Agent和UI三套定义漂移。

---

# 6. 十四条并行工作流

所有 Track 第一天同时启动。

---

## Track 00｜上游基线与持续兼容

### 目标

让影策快速更新时，新功能可快速吸收，私有影视系统不被破坏。

### 先核查

- 最新稳定 Release；
- 当前 main；
- API；
- GORM Models；
- Migration；
- Canvas Node Schema；
- MCP Tool Schema；
- 本地 Runtime；
- Director数据；
- Provider协议。

### 立即实现

```text
scripts/upstream/check-release
scripts/upstream/diff-api
scripts/upstream/diff-models
scripts/upstream/diff-migrations
scripts/upstream/diff-canvas-schema
scripts/upstream/diff-mcp
scripts/upstream/run-compat
```

建立：

```text
Stable / Candidate / Dev
```

兼容等级：

```text
A_AUTO_COMPATIBLE
B_ADAPTER_CHANGE
C_MIGRATION_REQUIRED
D_BLOCKED
```

### 交付

- 自动Release扫描；
- 差异报告；
- Candidate构建；
- 一键回滚；
- 上游修改清单；
- Thin Patch Manifest。

### 文件所有权

```text
scripts/upstream/
.github/workflows/film-upstream-compat.yml
implementation/UPSTREAM_COMPATIBILITY.md
```

---

## Track 01｜桌面壳与Local Workspace

### 目标

把影策变成真正的本地桌面AI影视工作台，而不是要求用户打开终端和localhost。

### 先核查

- 现有Swift/AppKit壳；
- 影策本地启动方式；
- Web/Go/Canvas Agent进程；
- 本地资源存储；
- Keychain；
- 当前IndexedDB和Local Runtime。

### 立即实现

```text
AI Film Studio.app
├── ServiceSupervisor
├── WorkspaceManager
├── CredentialVault
├── FileBookmarkManager
├── ProcessLogCenter
├── CrashRecovery
├── UpdateManager
└── NativeCommandBroker
```

本地项目目录：

```text
<Project>.filmproject/
├── manifest.json
├── film-core.sqlite
├── host-snapshot/
├── canvas/
├── media/objects/
├── media/proxies/
├── scene-twins/
├── prompts/
├── tasks/
├── receipts/
├── deliverables/
├── audit/
├── cache/
└── backups/
```

导入方式：

```text
Managed Copy
Linked External File
Regenerable Cache
```

### 快速落地顺序

1. 一键启动影策原版；
2. 选择/创建 `.filmproject`；
3. Film Core DB放入项目目录；
4. 保存Host Snapshot；
5. 项目级媒体转入内容寻址目录；
6. 文件监听和外链失效诊断；
7. 复制项目目录到另一台Mac进行恢复测试。

### 文件所有权

```text
desktop/macos/
film-core/app/workspace/
web/src/film/workspace/
```

---

## Track 02｜Film Core、合同与审计

### 目标

建立影视语义真值，不复制影策通用对象。

### 先核查

- Project/Unit/Shot/Asset/Task API；
- 现有 revision；
- GORM models；
- Workflow；
- 资源ID；
- Style快照。

### 立即实现

- FastAPI；
- Pydantic；
- SQLite WAL；
- Alembic或等价迁移；
- OpenAPI；
- TypeScript生成Client；
- Query/Command/Event；
- expected_version；
- Audit；
- ImpactGraph；
- STALE传播；
- Host映射。

### 权威边界

影策权威：

```text
Project基本信息
ProjectUnit基本信息
Shot基本信息
Canvas
Resource
Asset/AssetVersion通用数据
Generic Task
Provider
```

Film Core权威：

```text
故事和剧本版本
DirectorUnit
CoverageLink
SceneTwin
Camera/Blocking/Composition版本
VisualLockSet
Continuity
PromptDraft
影视Review/Approval
Impact/STale
生产血缘
```

### 文件所有权

```text
film-core/
film-contracts/
web/src/generated/film-core/
```

---

## Track 03｜项目管理与动态ContentUnit

### 目标

在影策现有项目管理上升级，不另建Project Hub。

### 先核查

```text
web/src/pages/projects/detail.tsx
overview.tsx
chapters.tsx
project-workbench.ts
projects.ts
models_project.go
```

### 立即实现

制作概览扩展：

- 动态 ContentUnit 统计；
- 剧本锁定率；
- DirectorUnit覆盖率；
- Shot覆盖率；
- 关键帧批准率；
- 视频批准率；
- SceneTwin覆盖率；
- STALE；
- 待审；
- 阻断；
- Next Best Action；
- Agent活动。

ContentUnit扩展：

```text
chapter
episode
special
trailer
extra
film
season
arc
volume
```

功能：

- 新增；
- 批量导入；
- 重排；
- 拆分；
- 合并；
- 复制方案；
- 分季/卷/Arc；
- 归档；
- 多轴状态；
- 点击进入生产画布。

### 不允许

- 重写现有章节列表；
- 重写虚拟滚动；
- 重写导入、排序和画布链接；
- 固定60集。

### 文件所有权

```text
web/src/pages/projects/detail/
web/src/lib/project-workbench.ts
web/src/film/project/
film-core/app/content_units/
```

---

## Track 04｜Story & Script Studio

### 目标

让工作台从项目Brief、故事和剧本打磨开始，而不是从分镜开始。

### 先核查

- 现有章节富文本编辑器；
- 导入小说；
- AI角色提取；
- PromptTemplate；
- 系统A Story Skills；
- 系统B剧本打磨方法。

### 立即实现

对象：

```text
StoryBibleVersion
CharacterArcVersion
SeasonArcVersion
EpisodeOutlineVersion
ScriptVersion
ScriptDecision
RewriteTask
ScriptReview
```

能力：

- Story Bible编辑；
- 人物关系与角色弧；
- 项目结构；
- ContentUnit大纲；
- 剧本版本；
- 对白、动机、节奏、钩子和反转审查；
- Codex编剧Skill；
- Script Lock；
- 修改影响分析；
- 下游精准STALE。

### UI

复用现有章节编辑器，在其右侧增加：

```text
版本
Skill
审查
差异
影响
锁定
Agent线程
```

### 文件所有权

```text
web/src/film/story/
film-core/app/story/
film-core/app/script/
plugins/film-story/
```

---

## Track 05｜ContentUnit生产画布、DirectorUnit与Shot

### 目标

点击任意内容单元，直接进入同一个固定生产画布；同时承载导演意图轨和实际Shot轨。

### 先核查

- 章节画布创建；
- `CanvasUnitLink`；
- `upsertProjectChapterStoryboard`；
- Canvas节点注册；
- Shot API；
- Canvas Agent工作流。

### 立即实现

画布作用域：

```text
role=production
unit_id=<hostUnitId>
```

节点：

```text
SceneNode
DirectorUnitNode
ShotNode
CoverageLink
AssetBindingNode
PrevisNode
PromptDraftNode
CandidateNode
ApprovedNode
ReviewNode
```

布局：

```text
Scene Lane
DirectorUnit Lane
Shot / Coverage Lane
Candidate / Approved Lane
Task / Review Lane
```

规则：

- 一个 Unit只有一个默认生产画布；
- 重开时复用，不重复创建；
- Canvas只存实体ID、布局和视觉投影；
- 影视正式字段从Film Core读取；
- 项目资产只绑定，不复制。

Inspector：

```text
剧本
导演意图
表演
Blocking
SceneTwin
Camera
Composition
VisualLock
Prompt
生成
Continuity
QC
版本
```

### 文件所有权

```text
web/src/film/canvas/
web/src/lib/canvas/film-*
film-core/app/director_units/
film-core/app/coverage/
```

---

## Track 06｜Asset Studio、Local Media与VisualLock

### 目标

复用影策Asset/Version/Representation，升级为资产意图、版本、用途、锁定和跨镜一致性系统。

### 先核查

- 现有Asset页面；
- AssetVersion；
- CharacterRepresentations；
- Voice；
- ProjectAssetFolder；
- ShotAssetReference；
- StyleProfile；
- Resource系统；
- 本地/远端同步。

### 立即实现

Binding Purpose扩展：

```text
character_identity
costume_reference
scene_appearance
spatial_reference
composition_reference
lighting_reference
prop_reference
first_frame
middle_frame
end_frame
motion_reference
continuity_reference
final_output
```

VisualLockSet：

```text
StyleProfileSnapshot
ArchitectureVersion
SceneTwinVersion
CharacterIdentityVersions
CostumeVersions
PropStateVersions
LightingProfileVersion
CameraVersion
BlockingVersion
CompositionVersion
ContinuityStateVersion
ReferenceRoleMap
```

计算：

```text
visual_lock_hash
```

父版本变化后精准传播STALE。

Local Media：

- Managed Copy；
- Linked File；
- Cache；
- SHA-256；
- 代理文件；
- 外链变更检测；
- 资源迁移；
- 不在业务对象中暴露绝对路径。

### 文件所有权

```text
web/src/film/assets/
film-core/app/assets/
film-core/app/visual_lock/
film-core/app/media/
```

---

## Track 07｜Prompt Translation & Learning Kernel

### 目标

把导演设计完整翻译为不同模型可执行的Prompt、参考图角色、控制输入和风险报告。

### 先核查

- Prompt Optimizer；
- PromptTemplate；
- UserPromptCustomization；
- ModelCapability；
- StyleExecutionPlan；
- 系统A Prompt Compiler；
- 系统B成功/失败案例。

### 立即实现

Director IR：

```text
Narrative Purpose
Audience Must See
Performance Beats
Action State In/Out
Blocking
Eyeline
Axis
Portal
Prop State
Camera
Lens/FOV
Camera Movement
Foreground/Midground/Background
Visual Hierarchy
Negative Space
SceneTwin
Style/Architecture/Lighting/Material
First/Middle/End State
Continuity
```

对象：

```text
GenerationIntent
PromptDraft
ModelCapabilityProfile
PromptStrategy
PromptExperiment
PromptCase
ConstraintCoverageReport
GenerationPackage
```

功能：

- 模型无关IR；
- GPT Image编译器；
- Nano Banana编译器；
- Dreamina编译器；
- Seedream编译器；
- Seedance/Kling/海螺视频编译器；
- 风险提示；
- 参考图职责；
- Prompt版本；
- 用户编辑和批准；
- 输出QC回灌；
- Prompt Casebook。

### 文件所有权

```text
film-core/app/prompt_kernel/
web/src/film/prompt/
plugins/film-prompt/
```

---

## Track 08｜Agent Brain Gateway与MCP工具面

### 目标

让Codex、DeepSeek、Claude和本地模型都能把工作台当作眼睛、手脚和正式记忆。

### 先核查

- Canvas Agent；
- Codex app-server；
- MCP Tools；
- 写入确认；
- Canvas Context；
- 当前侧边栏；
- DeepSeek Tool Call能力。

### 立即实现

统一Agent接口：

```text
AgentAdapter
AgentSession
AgentContextPack
ToolBroker
PermissionPolicy
CommandPreview
AgentAudit
```

适配器：

```text
CodexAppServerAdapter
DeepSeekAgentAdapter
ClaudeCodeAdapter
LocalModelAdapter
HumanOnlyAdapter
```

新增Production Tools：

```text
project_get_context
project_get_blockers
story_get_bible
script_get_version
content_unit_get
scene_get
director_unit_get
shot_get
asset_search
asset_get_version
scene_twin_get
workflow_get_next_actions
continuity_check
impact_analyze
command_preview
command_apply
review_submit
```

新增Director Tools：

```text
camera_create
camera_update
blocking_update
pose_update
composition_update
previs_render
spatial_compare
blender_open_session
```

新增Prompt/Provider Tools：

```text
prompt_compile
constraint_coverage_get
provider_submit
provider_query
provider_cancel
manual_package_export
manual_result_import
qc_request
```

权限：

- Agent可以创建建议、Command和Candidate；
- 不能直接修改Approved/Locked；
- 正式写入必须expected_version和审计；
- Human Only模式可完成全流程。

### 文件所有权

```text
canvas-agent/src/film/
plugins/film-agent/
film-core/app/agent_gateway/
web/src/film/agent/
```

---

## Track 09｜SceneTwin、导演台与Tigerowo差异

### 目标

解决空间、机位、人物方位、构图和预演的一致性。

### 先核查

必须真实比较：

- 影策现有导演台；
- Tigerowo全景、Camera、Timeline、关键帧、速度曲线、预演；
- 系统A Blender插件；
- 系统B数字空间母图。

输出差异矩阵：

```text
EXISTS_BETTER_IN_YINGCE
EXISTS_BETTER_IN_TIGEROWO
MISSING_BOTH
NOT_NEEDED
```

### 立即实现

SceneTwin：

```text
Geometry
CoordinateSystem
FixedArchitecture
FixedProps
Portals
WalkableZones
Anchors
CameraZones
LightingBase
ApprovedViewFamilies
RGB/Depth/Normal/ObjectID
```

Shot版本：

```text
CameraVersion
BlockingVersion
PoseVersion
CompositionVersion
PrevisVersion
```

R0-R4：

```text
R0 无3D
R1 单状态
R2 首尾状态
R3 多状态/多人
R4 Blender复杂空间
```

Tigerowo只移植差异，不整仓合并。

### 文件所有权

```text
web/src/film/director/
film-core/app/scene_twin/
film-core/app/camera/
film-core/app/blocking/
film-adapters/tigerowo/
film-adapters/blender/
```

---

## Track 10｜CLI、Provider与Flova

### 目标

让Manual、Dreamina CLI、Flova CLI、API、ComfyUI和Blender都进入同一GenerationAttempt生命周期。

### 先核查

- Dreamina现有本地Runtime；
- Generation Task；
- ComfyUI Bridge；
- Flova CLI真实能力；
- Provider取消、重试和恢复；
- 系统A Provider Adapter。

### 立即实现

Provider合同：

```text
capabilities()
auth_status()
prepare()
submit()
query()
cancel()
resume()
collect()
estimate_cost()
normalize_receipt()
```

适配器：

```text
DreaminaCliProvider
FlovaCliProvider
ManualWebProvider
ComfyBridgeProvider
BlenderProvider
GenericApiProvider
```

Manual Web Task包：

```text
task.json
prompt.txt
references/
acceptance-checklist.md
```

Flova：

```text
Inspect/Import
Execute
Result Collect
```

Flova不是本地正式事实源，结果只产生Candidate。

### 文件所有权

```text
film-provider-runtime/
film-adapters/flova/
film-adapters/dreamina/
film-adapters/comfy/
web/src/film/providers/
```

---

## Track 11｜系统A/B迁移与知识抽取

### 目标

保留两套旧系统最有价值的知识和正式数据，不复制技术债。

### 系统A导入

- Hard Lock；
- Rule Snapshot；
- Prompt/Skill知识；
- Provider配置；
- QC；
- Approval/Rollback语义；
- Blender控制包；
- 资产和版本血缘。

### 系统B导入

- Story/Script方法；
- DirectorUnit；
- 表演时钟；
- Blocking；
- Composition；
- SceneTwin；
- R0-R4；
- Workflow Recipe；
- 失败/成功案例；
- 正式资产与关键回执。

### 立即实现

```text
LegacyConsoleAdapter
ThreeHomesAdapter
MigrationPreview
ImportPlan
SourceHash
IdMapping
DryRun
Rollback
```

不迁移：

- 全部10GB历史垃圾；
- 无引用中间文件；
- 已废弃脚本；
- 重复Prompt；
- 平行状态文件。

### 文件所有权

```text
film-adapters/system-a/
film-adapters/three-homes/
film-core/app/imports/
```

---

## Track 12｜Remote/Hybrid与协作

### 目标

在Local-first不受损的前提下，支持远端工作室、审片和选择性发布。

### 先核查

- 影策Remote Sync；
- PostgreSQL/Redis；
- Resource对象存储；
- Canvas同步；
- 评论/共享；
- 本地权威边界。

### 立即实现

模式：

```text
LOCAL_AUTHORITY
REMOTE_AUTHORITY
HYBRID_LOCAL_AUTHORITY
```

Hybrid Publish Plan：

- 选择ContentUnit；
- 选择资产；
- 生成代理；
- 发布审片；
- 远端结果回收；
- 冲突解决；
- 本地批准。

未发布本地资产不得自动上传。

### 文件所有权

```text
film-core/app/sync/
web/src/film/sync/
backend/internal/filmhost/
```

---

## Track 13｜QA、Golden、性能与观测

### 目标

所有轨道从第1天起持续集成，不把测试留到最后。

### 立即实现

测试层：

```text
Unit
Contract
Schema
Migration
HostAdapter
MCP
Canvas Projection
Provider Mock
Local Workspace
Upstream Compatibility
E2E
Golden
Performance
Recovery
```

Golden A：故事到关键帧

```text
Project
→ Story Bible
→ ContentUnit
→ Script Lock
→ Scene
→ DirectorUnit
→ Shot
→ PromptDraft
→ Manual Result
→ Candidate
→ QC
→ Approved
```

Golden B：多人对话

- DirectorUnit与Shot非1:1；
- Blocking；
- 轴线；
- 视线；
- J-cut例外；
- Character/Costume Lock。

Golden C：复杂空间与视频

```text
SceneTwin
→ 3 Cameras
→ Blocking
→ Composition
→ Previs
→ Prompt/Provider
→ Video
→ Spatial Continuity QC
```

观测字段：

```text
trace_id
project_id
unit_id
shot_id
task_id
provider_task_id
visual_lock_hash
prompt_hash
input_hash
output_hash
```

### 文件所有权

```text
tests/film-golden/
tests/film-contract/
implementation/test-reports/
```

---

# 7. 文件所有权与冲突控制

`implementation/FILE_OWNERSHIP.yaml` 必须至少包含：

```yaml
shared_contracts:
  owner: track-film-core
  paths:
    - film-contracts/**
    - web/src/generated/film-core/**

project_ui:
  owner: track-project-ui
  paths:
    - web/src/pages/projects/detail/**
    - web/src/lib/project-workbench.ts

director:
  owner: track-director
  paths:
    - web/src/film/director/**

agent:
  owner: track-agent
  paths:
    - canvas-agent/src/film/**
    - plugins/film-agent/**
```

修改共享文件流程：

1. 在 `CHANGE_REQUESTS/` 创建短RFC；
2. Program Integrator确认；
3. 合同Owner修改；
4. 其他轨同步生成代码；
5. 合并integration。

禁止多个Track各自发明重复枚举和DTO。

---

# 8. Feature Flags

所有大功能都必须可独立启用和回退：

```text
film.desktop_host
film.local_workspace
film.production_core
film.dynamic_content_units
film.story_studio
film.production_canvas
film.asset_lock
film.prompt_kernel
film.agent_gateway
film.scene_twin
film.dreamina_provider
film.flova_provider
film.remote_sync
```

当某模块尚未完成时，影策原有功能必须继续可用。

---

# 9. 每日集成制度

## 9.1 每日两次集成窗口

建议：

```text
12:00  Track合入integration
22:00  第二次合入和完整Golden
```

## 9.2 Track提交要求

每次提交必须附：

```text
Evidence checked
Reuse/Extend/Build classification
Files changed
Contract changes
Migration changes
Tests
Feature flag
Rollback
Known gaps
```

## 9.3 Integration失败

- 只回退造成失败的Track；
- 其他Track继续；
- 不允许为了让测试通过删除原测试；
- 不允许临时跳过Golden；
- 不允许将失败代码合入main。

---

# 10. 快速交付节奏

所有Track第1天启动，以下只是集成目标，不是等待关系。

## 第1–2天：骨架可见

- Fork和Worktree完成；
- 影策原测试全跑；
- Film Contracts V0；
- Film Core启动；
- Swift壳能启动影策和Film Core；
- 项目概览出现Film Feature Flag；
- Production MCP出现只读工具；
- Golden框架可运行。

## 第3–7天：第一条可用纵向链

- Local Workspace可创建；
- 动态ContentUnit扩展；
- 点击Unit进入生产画布；
- ScriptVersion、DirectorUnit、Shot Extension；
- Asset Binding Purpose；
- PromptDraft；
- Manual Provider；
- Codex读取并操作；
- Golden A通过。

## 第8–14天：核心生产能力

- VisualLockSet；
- STALE传播；
- Story/Script审查；
- Asset/Media本地管理；
- Dreamina CLI影视血缘；
- Provider统一；
- 系统A/B只读导入；
- Golden B通过。

## 第15–21天：空间和视频

- SceneTwin；
- Camera/Blocking/Composition版本；
- 影策导演台Film扩展；
- Tigerowo差异补齐；
- Blender R4；
- Flova Inspect/Execute基础；
- Golden C通过。

## 第22–28天：Beta硬化

- Remote/Hybrid；
- DeepSeek Adapter；
- 性能；
- 恢复；
- 数据迁移；
- 上游兼容演练；
- 桌面安装包；
- Beta验收。

以上是激进目标，需要多个Codex Worktree持续并行。若某轨延期，不得阻塞已完成模块在Feature Flag下交付。

---

# 11. Codex不发散执行规则

## 11.1 每个Track开工时必须输出，但无需等待用户逐项批准

```text
Track ID
Requirement IDs
Actual files inspected
Existing capability found
Classification: REUSE / EXTEND / BUILD / DEFER
Implementation slice
Owned files
Shared contract requests
Tests
Feature flag
Rollback
Out of scope
```

写入Track自己的 `TRACK_PLAN.md` 后即可执行。

## 11.2 严禁

- 看到需求就新建页面；
- 看到字段不够就直接改影策核心表；
- 为同一概念新建第二套Task/Asset/Shot；
- 将正式状态放入Canvas JSON；
- 将Prompt“严禁变化”当作VisualLock；
- 绕过Task系统直接调用Provider；
- 把Codex写死为唯一Agent；
- 把本地路径写入业务对象；
- 在Track内顺手重构无关代码；
- 等所有模块完美后才集成。

## 11.3 自动继续条件

当：

- 真实代码支持计划；
- 变更在Track所有权内；
- 无破坏性迁移；
- 测试可写；
- Feature Flag可回退；

Codex应直接继续，不再询问。

## 11.4 必须暂停条件

仅红线条件暂停，见第4.4节。

---

# 12. 最终Definition of Done

1. 影策继续是唯一Host主干；
2. 上游Release可自动发现、差异分析、候选验证和回滚；
3. macOS桌面应用一键运行；
4. Local Workspace可整体迁移；
5. ContentUnit数量和结构动态；
6. 每个ContentUnit可进入固定生产画布；
7. 项目资产统一绑定，不复制；
8. Story/Script到Shot和输出具有完整血缘；
9. DirectorUnit与Shot分离；
10. SceneTwin跨镜共享；
11. Camera/Blocking/Composition独立版本；
12. VisualLockSet可追溯并传播STALE；
13. Prompt按模型编译并报告约束覆盖；
14. Manual/API/CLI结果进入同一Candidate和QC链；
15. Codex可操作工作台但不能越权；
16. DeepSeek等Agent复用同一工具面；
17. Local/Remote/Hybrid权威清晰；
18. 系统A/B知识与正式数据被保留；
19. Flova可被只读检查和受控执行；
20. 三条Golden全部通过；
21. 用户不使用Agent时仍能完成核心流程；
22. 正式项目事实不依赖聊天线程；
23. 上游升级不会要求重写Film Core；
24. 任意未完成模块可通过Feature Flag关闭，不破坏其他模块。

---

# 13. 交给Codex的总开工令

```text
你现在执行《AI影视工作台一次性并行实施总计划 V6.1》。

本计划替代V6.0的串行WP-00前置方式。你必须从第一天同时铺开全部Track，但使用Git Worktree、文件所有权、共享合同、Feature Flag和每日integration，禁止所有线程在同一分支无序修改。

立即完成：
1. Fork并固定影策最新稳定Release；
2. 建立upstream-yingce、reference-tigerowo、reference-basket；
3. 创建integration和14个track worktree；
4. 创建implementation控制文件；
5. 由Program Integrator建立Film Contracts V0和文件所有权；
6. 14个Track分别读取本轨真实源码、测试、数据库和界面，写TRACK_PLAN.md；
7. 各Track在完成本轨Fit-Gap后直接实施，不等待全局审计结束，也不等待用户逐项批准；
8. 所有新功能放在隔离目录或Sidecar扩展中，并受Feature Flag控制；
9. 每日两次合入integration，运行影策原测试、Film Contract、MCP和Golden；
10. 只有破坏数据、改变稳定ID、替换画布、放弃影策、不可逆迁移等红线才暂停询问。

第一周必须交付一条真实可用链：
项目 → 动态ContentUnit → ScriptVersion → DirectorUnit → Shot → Production Canvas → PromptDraft → Manual Provider结果导入 → Candidate → QC → Approved。

不得重新设计影策已经存在的项目、章节、画布、资产、任务、MCP或Dreamina CLI；必须先核查并最小扩展。
```

---

# 14. 最终执行裁决

用户要求的是快速落地，而不是继续停留在架构讨论。

因此正式路线为：

```text
所有主轨同时开工
+
每轨证据驱动
+
共享合同和文件所有权
+
影策最小差异扩展
+
Sidecar Film Core
+
Feature Flag持续交付
+
每日集成和Golden验收
```

不再设置“完成全局只读审计后才允许开发”的总门槛。核查仍然是强制的，但核查被嵌入每一条并行实施工作流中，与编码同步推进。
