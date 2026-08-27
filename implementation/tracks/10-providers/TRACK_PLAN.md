# Track 10｜CLI、Provider 与 Flova

TRACK: `10-providers`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

## 首切片目标

在不调用任何外部 Provider 的前提下，建立默认关闭、纯本地可测试的 Provider Registry、Capability、Submission Package 和 Manual Result Import 边界。所有导入结果只形成 Candidate；审批继续由独立 Review/Approval 合同负责。

## 只读核查

- Host Task/Result：`backend/internal/model/models_task.go`、`backend/internal/service/task_creation.go`、`provider_task_recovery.go`、`provider_task_cancellation.go`。
- Host Provider/Capability：`backend/internal/provider/interface.go`、`registry.go`、`backend/internal/service/model_capability.go`。
- Comfy Bridge：`backend/internal/model/models_bridge.go`、`backend/internal/service/comfy_bridge.go`、`backend/internal/repository/comfy_bridge.go` 及持久化测试。
- Dreamina：`canvas-agent/src/dreamina-cli-contract.ts`、`dreamina-task-contract.ts`、`dreamina-cli-runtime.ts`、`dreamina-public-result.ts`、`dreamina-provider-artifacts.ts` 及相邻测试；Web 本地投影见 `web/src/services/local-dreamina-*.ts`。
- Film 共享合同：`film-contracts/schemas/core.schema.json`、`film-contracts/openapi.json`，本轨只读。
- Flova：对 `backend/`、`canvas-agent/`、`web/src/`、`film-*`、`plugins/` 做源码检索，除共享枚举外未发现实现。
- Manual Result Import：未发现统一的 Film Provider 手动结果导入边界；现有 LibTV/TapNow 导入属于画布项目导入，不等价。

## REUSE / EXTEND / BUILD / DEFER

### REUSE

- Host Task 的鉴权、配额、密钥保护、provider request id、轮询租约、恢复、取消与 billing uncertain 语义。
- Host 的 provider-neutral 模型能力验证与协议适配。
- Comfy Bridge 的 token hash、持久请求队列、claim/terminal/restart recovery；不夸大已 claim 工作流的取消能力。
- Dreamina 的严格请求 schema、request hash/幂等、receipt-first、`SUBMISSION_UNCERTAIN`、结果物化与私有 artifact manifest。
- Film Contracts 的稳定 Film ID、`expected_version`/content hash、GenerationPackage、Candidate、Review、Approval 分离语义。

### EXTEND

- 在本轨拥有的 `web/src/film/providers/**` 中增加纯数据的 Film Provider 投影：只引用 Host task/provider 标识和哈希，不创建第二套执行队列。
- Provider Registry 只声明经源码核验的本地投影能力和来源状态；不封装网络调用。

### BUILD

- 默认关闭的本地 Registry/Capability 查询。
- 确定性 Submission Package：stable Film ID、`expected_version`、prompt/parameter/reference/input hash，引用授权证据边界。
- Manual Result Import：记录 provider/task/receipt/hash/参数和人工导入来源，输出仅为 Candidate。
- 对密钥、Cookie、data URL、绝对路径和未授权引用的 fail-closed 校验。

### DEFER

- Flova：`UNVERIFIED_SOURCE_ABSENT`，不注册为可准备/可提交能力，不声称已集成。
- 任何真实 `submit/query/cancel/resume/collect` 外部调用、上传、生成、积分消费、远程认证。
- API/Blender 的具体执行适配器及 Host UI 接线。
- 共享 Film Contract 扩展由 `implementation/CHANGE_REQUESTS/CR-10-001.md` 请求，不越权修改。

## 首切片不做

- 不修改 Host 核心表、Film Contracts、共享 Feature Flags 或其他 Track 文件。
- 不复制 Host Asset/Task/Result/Provider 表，不持久化二进制、外部 URL、文件路径或密钥。
- 不将 prepared/imported 写成 submitted/generated/approved；不提供 approval API。
- 不迁移用户数据，不启动服务，不推送、不合并。

## 最小实施与验证

1. 新建 `web/src/film/providers/provider-runtime.ts` 与同目录专项测试。
2. Feature gate 只有显式 `enabled: true` 才开启；中央 `film.dreamina_provider`、`film.flova_provider` 继续保持 false。
3. 运行专项 Bun 测试与 Web TypeScript 无输出检查；按风险补 Host 相邻测试。
4. 记录 `EVIDENCE.md`、diff、状态、提交与回滚说明。

## 回滚

- 运行时默认关闭；删除本轨新模块即可回滚，未产生数据库迁移或外部副作用。
- 若已被调用，先保持 gate=false，再移除 import/call site；本切片不创建这些接线。

STATUS: `FIRST_SLICE_COMPLETE_LOCAL_VERIFIED`
