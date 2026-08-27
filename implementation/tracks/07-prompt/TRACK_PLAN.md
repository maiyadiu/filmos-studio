# Track 07｜Prompt Compiler

TRACK: `07-prompt`
OWNER: `track-prompt`
FEATURE FLAG: `film.prompt_kernel=false`
STATUS: `LOCAL_SLICE_IMPLEMENTED_NOT_INTEGRATED`

## 首切片目标

把已锁定的导演 IR、视觉锁、Host 模板版本、镜头素材绑定和 Provider 能力编译成可复现的本地 `PromptDraft`。编译器只产出草稿和审计结果，不提交生成任务，不产生 Approved 状态。

## 现状核查与 Fit-Gap

| 对象 | 现状证据 | 分类 | 首切片处理 |
| --- | --- | --- | --- |
| Host PromptTemplate | `backend/internal/service/prompt_template.go`、`backend/internal/model/models_project.go`；已有 operation、version、content、enabled 与用户定制 | REUSE + EXTEND | 复用 Host 模板 ID/operation/version/content；Film 编译时额外校验 content hash，不改 Host 表 |
| 分镜提示词 | `backend/internal/service/storyboard_prompt.go`；已有模板编译和剧情/资产/画风输入 | REUSE | 作为上游内容来源；不把其隐式兜底带入 Film 编译器 |
| Shot / ShotAssetReference | `backend/internal/model/models_project.go`、`backend/internal/service/project_shot.go`；已有 Shot 与 asset version role 关系 | REUSE + EXTEND | 输入必须同时绑定 Film ID、Host ID、version、asset hash；不改 Host 表 |
| Asset / AssetVersion | `backend/internal/model/models_project.go`；已有资产版本与表示 | REUSE + EXTEND | 只消费显式版本引用和 hash；不复制媒体、不解析 URL |
| Director prompt compiler | `web/src/lib/canvas/director/director-prompt-compiler.ts`；能把场景与镜头转成文本，但无稳定血缘与并发守卫 | EXTEND | 其输出可作为 Director IR 文本；Film 层另做 hash 复核与绑定 |
| Provider 输入 | `web/src/services/api/video-provider-*.ts`、`backend/internal/service/provider*.go`；Provider 协议分散、能力并非统一 Film 合同 | BUILD | 新建显式 capability profile；不支持的参考资产/参数直接拒绝，不静默降级 |
| MCP | `canvas-agent/src/schemas.ts`；已有生成工具和 `runGeneration` | DEFER | 首切片不接 MCP、不触发工具；后续只允许消费已审计 PromptDraft 的独立提交动作 |
| Film PromptDraft | `film-contracts/schemas/core.schema.json` 已有最小 PromptDraft | EXTEND REQUESTED | 本轨不越权修改共享合同；`CR-07-001.md` 请求补齐绑定与审计字段 |

## 已实现

- `web/src/film/prompt/prompt-draft-compiler.ts`
  - 调用方必须显式传入 `film.prompt_kernel=true`，仓库默认仍关闭。
  - Draft ID 使用 Film Core 外部分配的 UUIDv4；Web 编译器不自行生成正式身份；写入必须携带 `expectedVersion`，且 `targetVersion = expectedVersion + 1`。
  - Project、Shot、DirectorUnit、VisualLock、每个 Asset 均绑定稳定 Film ID、Host reference、version、SHA-256。
  - Director IR、VisualLock 与 Host PromptTemplate 正文逐项重算 SHA-256；不接受陈旧 hash。
  - Provider kind、输出类型、方言、支持项、必填项、字符和参考资产上限全部显式输入。
  - Host 引用与模板/能力配置 ID 只能使用不含路径或公开 URL 的稳定不透明标识；当前源码无 Flova 实现，因此 `flova_cli` 明确失败为 `UNVERIFIED/DEFER`。
  - 对资产顺序和 Host refs 做稳定排序，以 canonical JSON + SHA-256 生成 `input_hash`、`prompt_hash`、`capability_hash`。
  - 输出固定为 `NOT_SUBMITTED / CANDIDATE_ONLY / SEPARATE_HUMAN_ACTION_REQUIRED`。
- `web/test/film-prompt-draft.test.ts`
  - 覆盖可复现性、hash 血缘、feature flag、并发版本、无隐藏参数、能力拒绝和 Candidate/Approval 分离。

## 边界

- 不连接 `canvas_generate_*`、Dreamina CLI、Flova、Comfy、Blender 或任何远程 API。
- 不读取媒体 URL、不上传文件、不消费积分。
- 不创建 Candidate、Review 或 Approval；只声明后续生命周期边界。
- 不修改 `film-contracts/**`、Host 核心表、Provider Adapter 或 MCP schema。
- `manual_web` 只是目标能力标识，不代表已在外部网页提交。

## 后续依赖

1. Program Integrator / Track 02 审核 `CR-07-001.md`，决定共享合同采用内嵌字段还是 companion provenance schema。
2. Track 06 提供正式 AssetVersion / VisualLock 绑定对象，Track 09 提供 Director IR。
3. Track 10 提供经过验证的 Provider capability profiles；本编译器不自行猜测能力。
4. Track 08 如需 MCP 工具，只能新增“编译/读取草稿”，生成提交必须保持独立动作和人工门禁。

## 回滚

保持 `film.prompt_kernel=false` 即不会进入现有影策流程。删除 `web/src/film/prompt/` 和对应测试即可完整移除首切片，不影响 Host PromptTemplate、Shot、Asset、Provider 或 MCP。
