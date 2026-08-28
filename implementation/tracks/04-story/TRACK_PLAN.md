# Track 04｜Story & Script Studio

TRACK: `04-story`  
MODEL: `GPT-5.6 Sol`  
REASONING: `High`

1. 本轨目标：复用 Host 章节编辑器，在独立 Feature Flag 下提供剧本版本、逐字对白差异、稳定 Cue/Section 影响预览和显式人工 Script Lock 边界。
2. 当前基线：integration `c703dc89` 已包含 Track 04 纯领域 `ScriptVersion` / `ScriptDecision` / hash / dialogue fidelity / impact analysis；Film Core 已实现 `POST /script-versions/lock`（`filmScriptVersionLock`），只接受 human actor，并同时创建 locked ScriptVersion、ScriptDecision 与审计事件。
3. `REUSE`：现有章节 Tiptap 正文和 dirty/saved 状态、Host Unit/Shot 数据、已有 Story 纯领域合同；面板不保存第二份正文。
4. `BUILD`：`web/src/film/story/` 内默认关闭的 Story Flag、Host 草稿只读预览、稳定 Cue/Section 解析、审查面板、真实 Core lock 请求形状的类型化端口与人类确认门禁。
5. `EXTEND`：在 `chapters.tsx` 做必要的最小接线；Flag 关闭时保持原编辑器 DOM，Story 组件不挂载、不执行 effect、不发请求。
6. `DEFER`：当前 `GET /projects/{hostProjectId}/context` 不返回 ScriptVersion/ScriptDecision，仓库也没有按 Host Unit 查询正式剧本版本的端口；因此本切片不展示伪正式版本、不提供伪锁定按钮、不执行 lock 或 STALE 写入。
7. 正式边界：Web 只做 preview/recommendation。未来 lock 必须取得 Core 正式源版本 ID/version/hash，调用 `filmScriptVersionLock`，并要求 human confirmation；Agent 确认在端口前被拒绝。STALE 只能经明确 Core command 执行，本切片没有 apply 端口。
8. 系统 A Story Skills、系统 B 剧本打磨方法：当前仓库及明确路径仍无可验证正式源，标记 `UNVERIFIED / DEFER`，不从记忆或外部项目补事实。
9. 测试：`bun test test/film-story-domain.test.ts test/film-story-review.test.tsx`、`bun run typecheck`、`bun run build`；覆盖默认关闭、稳定 ID、逐字差异、hash、只读影响建议、Agent/未确认零 Core 调用与人类确认端口调用。
10. 回滚：回退本轨提交即可恢复原章节单栏；无数据库、Host 核心表、外部网络或正式 Film 状态变更。

STATUS: `STAGE3_REVIEW_UI_VERIFIED`
