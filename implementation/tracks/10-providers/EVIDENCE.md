# Track 10｜首切片证据

STATUS: `LOCAL_VERIFIED_NOT_INTEGRATED`

## 已实施

- `web/src/film/providers/provider-runtime.ts`
  - 默认关闭的 `FilmProviderRegistry`；只有 `enabled === true` 才允许本地准备/导入。
  - Provider ID/Capability ID 为可扩展标识，不以本轨私有封闭枚举替代共享合同。
  - 内置描述只声明经源码核查的边界：Manual 为本地导入；Dreamina/Comfy 复用 Host Runtime；Flova 为 `UNVERIFIED_SOURCE_ABSENT` / `DEFERRED`。
  - Submission Package 绑定由 Film Core 分配的 stable UUID v4 Film ID、Host Project ID、目标 `expectedVersion`/当前 content hash、prompt/parameter/reference/input hash；Web Runtime 不自行生成正式身份。
  - 包清单固定为 `task.json`、`prompt.txt`、`references.json`、`acceptance-checklist.md`，本切片只生成内存投影和哈希，不写包、不上传。
  - 引用只保存 Film/Host opaque ID、content hash 和授权证据；参数拒绝密钥、Cookie、URL、data/blob/file URI、绝对路径和 locator 字段。
  - Manual Result Import 验证 package/content/input hash、目标 `expectedVersion`/当前 content hash与包→回执→导入时间顺序，记录 provider task、receipt ID/声明 hash、参数、人工来源、导入人和授权证据。未持有原始回执正文，因此不声称重新计算 receipt hash。
  - 导入输出只引用 Host Resource ID 与 Film Representation ID，不保存二进制、路径或 URL；结果固定为 `candidate / pending / not_approved`，无审批入口。
- `web/src/film/providers/provider-runtime.test.mjs`：11 个专项测试。
- `implementation/CHANGE_REQUESTS/CR-10-001.md`：请求共享合同 Owner 评估回执/人工导入证据投影，本轨未修改 `film-contracts/**`。

## 只读核查结论

### REUSE

- Host Task：`backend/internal/model/models_task.go` 已有 provider request、poll、lease、cancel、受保护 input、result 与 billing 关联字段。
- Host Service：`task_creation.go` 负责鉴权/配额/密钥保护；`provider_task_recovery.go` 复用原 provider request 并先持久化结果；`provider_task_cancellation.go` 明确取消确认/不确定状态。
- Host Capability：`model_capability.go` 已有 provider-neutral 能力归一与校验，本轨不复制。
- Comfy：Bridge token hash、持久队列、claim/terminal/restart recovery 已存在；claimed workflow 的取消能力不能泛化成可靠取消。
- Dreamina：严格请求 schema、request hash/幂等、pending/accepted receipt、`SUBMISSION_UNCERTAIN`、账号绑定、物化与私有 artifact manifest 已存在。

### BUILD / DEFER

- 未发现统一 Film Manual Result Import，故仅在本轨 owned path 建本地投影。
- 未发现 Flova 源码实现；共享 schema 中出现 `flova_cli` 不能作为集成证据，状态保持 `UNVERIFIED_SOURCE_ABSENT` / `DEFERRED`。
- 未实现或调用真实 `submit/query/cancel/resume/collect`；API/Blender Provider、UI 接线、Host 持久化与共享 schema 变更均后置。

## 验证

### 新增模块

```text
cd web
bun test src/film/providers/provider-runtime.test.mjs
11 pass, 0 fail, 44 expect() calls

bun x tsc --noEmit --pretty false
PASS (exit 0, no output)
```

### 复用边界相邻测试

```text
cd backend
go test ./internal/service -run '^(TestComfyBridgeRequestSurvivesServiceRestart|TestFetchRunningHubAppInfoKeepsAPIKeyOutOfURL|TestGeminiProviderCancellationAndConfirmation|TestVolcengineArkProviderCancellationUsesDelete|TestDefaultVideoCapabilityUsesProtocolSpecificResolutionTiers)$' -count=1
PASS

go test ./internal/repository -run '^(TestClaimTaskProviderCancellationOnlySucceedsOnce|TestDeferredProviderPollKeepsOriginalTaskIdentityWithoutImmediateReclaim)$' -count=1
PASS

cd canvas-agent
tsx --test --test-concurrency=1 test/dreamina-task-contract.test.ts test/dreamina-provider-artifacts.test.ts
15 pass, 0 fail
```

轨内首轮验证曾从主工作区只读临时软链复用依赖并在命令后删除；Program Integrator 复核时另按 `bun install --frozen-lockfile` 安装本 worktree 依赖。锁文件未变化。

### 静态边界

- 新增运行时与测试中未检出 `fetch`、Axios、`channelRequest`、上传、积分消费调用。
- `git diff --check` 通过。
- 源码 SHA-256：`6a58ae5a4962a4280d08de7ab8d95417577f1026c720b6a7109d6730e4a0bb4b`。
- 测试 SHA-256：`da1d8e0f4949379441b2fe7ae59e7fed36e04f8085f9f6b82cfe3b8430748c49`。

## 未验证与缺口

- 没有真实 Provider 登录、提交、查询、取消、回收、上传、生成或积分验证；这些不是本切片的成功声明。
- Registry 尚未接入中央 Feature Flag 或 UI/Host 持久化；中央 `film.dreamina_provider`、`film.flova_provider` 仍为 false。
- Dreamina/Comfy 描述表示“源码存在、应复用”，不表示 Film 适配器已经接线；Comfy 具体模型能力仍须按 Bridge heartbeat 实时核验。
- Dreamina 当前只声明源码可证实的图像/视频结果能力，不把 text-to-image 中的 text 输入误报为文本输出能力。
- Flova 源码缺失，未调用本机或网页 Flova，也不把外部项目状态当本地事实。
- `CR-10-001` 尚未获 Program Integrator / Track 02 接受，私有投影不能冒充共享正式合同。
- Candidate 尚未进入 Review/Approval；本轨有意不提供审批函数。

## 外部副作用与回滚

- 外部提交/上传/积分：`0`。
- 数据库迁移、用户数据迁移、服务启动：`0`。
- 回滚：保持 runtime gate=false，并还原本轨提交；无数据库或外部状态需要补偿。
