# ADR-003：Context 与 Tool 权威

Status：Accepted

## Context

当前各大脑分别拼接上下文和工具，身份主要依赖进程环境，容易产生重复 Schema、过期 Canvas/Film 收据和供应商私有写入绕行。

## Decision

- `AgentContextBroker` 是当前 Project/Unit/Scene/Shot/Canvas/Selection/Asset 的唯一摘要入口。
- 每次上下文生成不可变 `AgentContextReceipt`，绑定 revision/hash 与 TTL。
- `CanonicalAgentToolManifest` 是跨 Adapter 的唯一工具源，MCP Surface 只是其过滤视图。
- `AgentPolicyGateway` 从受信 Session 注入 actor/profile/billing，模型参数不能覆盖。
- Read 可直接执行；draft/preview 返回可验证 receipt；write/destructive/paid/approval/publish 必须创建 Session scoped confirmation。
- Apply 前重新校验 Film version/contentHash 与 Canvas revision/stateHash；完成后验证 postcondition 并写 Audit。
- Track 08 Film Gateway 继续是正式 Film 写入的最终安全边界。

## Consequences

Canvas、Project、Film、Generation 和 ChatGPT Handoff 工具不按大脑复制。关闭普通确认偏好不能关闭 paid/destructive/approval/publish 门。

