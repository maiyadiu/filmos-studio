# Film Golden

Golden 是真实纵向链验收，不把单元测试通过写成产品已批准。

- Golden A：故事到关键帧，第一条必通链。
- Golden B：多人长对话，验证 DirectorUnit 与 Shot 非 1:1、Blocking、轴线、视线和视觉锁。
- Golden C：复杂空间和视频，验证 SceneTwin、机位、表演调度、构图、预演和空间连续性。

生成成功只能将结果记为 Candidate。`Approved` 必须有 QC Review 和独立 Approval 记录。

## Golden A 离线基线

`golden-a.json` 是签入仓库的可执行规格，其 `execution.test_status` 固定保持
`NOT_RUN`，不将过去某次执行伪装成当前验收。每次运行单独输出 `PASSED`
或失败；业务对象状态则始终使用 `Candidate` 和 `Approved`。

执行时不启动服务，不读写项目数据，不调用外部 Provider：

```bash
python3 tests/film-golden/test_golden_a.py
python3 tests/film-golden/run_golden_a.py
```

离线 Mock 验证：DirectorUnit 与 Shot 分离、所有正式写入携带
`expected_version`、手动结果首先产生 Candidate、未有 Review 和 Approval 时
禁止进入 Approved，以及 10 个观测字段完整。该骨架是首批合同验收，
不代表真实 UI、数据库、MCP 或 Provider 纵向链已通。

## Golden A 真实 Sidecar 入口

`run_golden_a_real.py` 会启动临时端口与临时 SQLite 的真实 Film Core HTTP
Sidecar，读取其 `/openapi.json`，并要求 D-0005 裁定的正式操作全部存在：

- `POST /formal-records`、`GET /formal-records/{filmEntityId}`；
- human-only `POST /script-versions/lock`；
- `POST /prompts/compile`、`POST /manual-results/import`；
- `POST /reviews`、`POST /approvals`、`POST /continuity/check`。

如果当前 Core 分支尚未提供任一操作，运行结果必须是
`BLOCKED_MISSING_CORE_OPERATION`，并分别报告 `prepared/persisted/reviewed/approved`
均为 `false`、外部调用为 `0`、`fallback_mock_used=false`。它不会退回离线
Mock，也不会把本地准备写成已持久化或已批准。

操作齐全时，runner 通过真实 HTTP 创建 Project/ContentUnit/Shot、未锁
ScriptVersion，再执行人工 Script Lock，原子取得 ScriptDecision 与新的 locked
ScriptVersion；DirectorUnit 只绑定这两个正式来源。之后写入 CoverageLink、
VisualLockSet、AssetBinding，调用真实本地 Production Canvas、Prompt compiler
与 Manual Provider 模块，再由 Core 持久化 PromptDraft、GenerationPackage、
AttemptEvidence、Candidate、Continuity QC、Review 和独立 Human Approval。
全链外部 Provider 调用数为 0。

`golden_a_local.ts` 是真实本地域段：直接复用 Production Canvas 投影、
`compilePromptDraft`、`prepareSubmissionPackage` 和
`importManualProviderResult`。它只能报告 `prepared=true`、`persisted=false`，
ManualImport 结果保持 `Candidate/pending/not_approved`，外部调用固定为 0。
本地域段同时保留 formal record aggregate `contentHash` 与 raw Director IR、
VisualLock、Asset source hash，二者分别校验，不能互相冒充。
只有完整 Sidecar HTTP 的 Review 与 Human Approval 回执才能改变后续状态。

```bash
FILMOS_CORE_PYTHON="$PWD/film-core/.venv/bin/python" \
  python3 tests/film-golden/test_golden_a_real.py
FILMOS_CORE_PYTHON="$PWD/film-core/.venv/bin/python" \
  python3 tests/film-golden/run_golden_a_real.py
```

## Golden B 已锁定规格

`golden-b.json` 固定多人长对白、DirectorUnit/Shot 多对多、五维连续性、仅声音先入可用的 J-cut 例外、Character/Costume Lock 和精准 STALE 验收范围。签入状态保持 `NOT_RUN`，不保存某次运行的成功状态；真实执行不得回退 Mock，也不得调用外部 Provider。

```bash
python3 tests/film-golden/test_golden_b_spec.py
```

真实 Golden B runner 已接入临时 Sidecar/SQLite/HTTP；检查 `ScriptStructureMap`、ImpactEdge、Cue/Costume 精准 STALE、未映射变化、零部分写入与幂等回执。缺少正式 operation 时仍只能返回 `BLOCKED_MISSING_CORE_OPERATION`，不得回退 Mock。

```bash
FILMOS_CORE_PYTHON=/path/to/film-core-python \
  python3 tests/film-golden/test_golden_b_real.py
bun test tests/film-golden/test_golden_b_local.test.ts \
  tests/film-golden/test_golden_b_assets_local.test.ts
```

签入的 `golden-b.json` 继续保持 `NOT_RUN`，因为它是不可被某次本地运行污染的验收规格；本次真实运行结论记录在 `证据.md` 与 `implementation/阶段三验收.md`。

## Golden C 真实 Sidecar 与恢复

`golden-c.json` 锁定 SceneTwin → 3 Cameras → Blocking → Composition → Previs → Prompt/Provider → Video → Spatial Continuity QC，签入状态仍为 `NOT_RUN`。

`golden_c_real.py` 使用临时真实 Film Core SQLite/HTTP，检查 SceneTwin 和 3 套独立 Camera/Blocking/Composition 版本，并运行 Sidecar 重启、SQLite backup/restore、事务故障注入、幂等回放和 stale guard。缺 operation 时只返回 `BLOCKED_MISSING_CORE_OPERATION`，不回退 Mock。

Previs 是绑定正式 SceneTwin/Camera/Blocking/Composition hash 的本地投影；Manual Result 只导入本地视频 Candidate。本 runner 不调用外部 Provider，不产生 Approved。

```bash
python3 tests/film-golden/test_golden_c_spec.py
bun test tests/film-golden/test_golden_c_local.test.ts
FILMOS_CORE_PYTHON=/path/to/film-core-python \
  python3 tests/film-golden/test_golden_c_real.py
```
