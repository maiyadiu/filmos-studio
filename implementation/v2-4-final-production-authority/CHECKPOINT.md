# FilmOS V2.4 最终生产权威收口检查点

## 当前目标

从固定基线 `1b0ff49a1aff900d0005254911bf09540a9ced86` 完成最终生产权威收口：统一 ProductionGenerationService、Canonical Broker、Film Core Generation/Candidate、Budget Ledger、Engine Connection 与 Project Policy/Lock，并修复 ChatGPT Handoff 的生产上下文哈希合同。

## 活动工作区

- Worktree：独立工作树 `wt-v2-4-final-production-authority-v1`
- Branch：`fix/v2-4-final-production-authority-v1`
- Base Tree：`55db4acf786b557be42012d00713f2573295110e`

## 锁定约束

- 不修改 `main`，不 amend 基线，不创建或移动 RC1 Tag。
- 外部网络请求、真实 API Completion、真实图片/视频生成、素材上传、外部 Project 创建和付费操作均为 0。
- Acceptance Mock 只能作为 Provider Adapter；不得形成第二套 Runtime、Broker、Budget 或 Candidate 权威。
- 最终以远程固定 Commit、GitHub Run、Artifact 和唯一 Handoff ZIP 为准。
- 每轮源码修改的最后步骤必须重新打包、替换并校验 `~/Applications/FilmOS Studio.app` 与最终 Commit 一致。

## 已完成

- 完整读取 1397 行权威任务包。
- 核验基线 Commit 与 Tree。
- 创建独立 worktree 和指定分支。
- 确认原主工作区存在用户历史改动，实施过程不触碰原工作区。

## 已收口 P0

- Acceptance 与普通项目共用 `ProductionGenerationService`；Acceptance 仅保留本地 Mock Provider Adapter。
- Composer 和 Agent 共用 `CanonicalAgentToolBroker` 的 Grant、Confirmation、Decision Receipt、Audit 与 Postcondition。
- 正式 GenerationPackage、GenerationAttemptEvidence、Candidate 只写入 Film Core 正式实体；旧生产表禁止新增平行权威。
- Budget 进入 `GenerationBudgetRepository` 的原子 Reserve/Authorize/Submit/Settle/Release/Reconcile 事务。
- Engine Doctor/Auth/Catalog 由 `EngineConnectionSynchronizer` 同步为版本化连接证据。
- ChatGPT Handoff 使用完整 64 位 SHA-256，并保留精确 `chatgpt_host_context_invalid` 错误。

## 下一步

1. 完整运行零外部成本 Acceptance。
2. 固定 Commit/Tree 并推送候选分支。
3. 等待 GitHub Acceptance 并生成 artifact-only Release Manifest。
4. 最终重打包、替换并校验本机 App。
5. 生成唯一 Handoff ZIP。
