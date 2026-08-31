# Broker 路径图

```text
Composer / Canvas Agent / Acceptance helper
  → GenericAgentRuntime.proposeTool
  → CanonicalAgentToolBroker.execute
  → GrantRepository + ConfirmationRepository + Policy
  → registered Production Tool Provider
  → Audit + Postcondition
  → Decision Receipt hashes
  → Film Core authorization
```

- 唯一 Broker：`canvas-agent/src/brains/tool-broker.ts`。
- Provider 注册：`canvas-agent/src/brains/tool-providers.ts`。
- 两阶段提议/决定：`canvas-agent/src/brains/generic-agent-runtime.ts`。
- HTTP 提议入口：`canvas-agent/src/modules/canvas-agent-http.ts`。
- Web 调用：`web/src/film/agent/agent-client.ts`。
- Composer 不生成 Receipt；Acceptance helper 也实例化真实 Broker。
- `generation_submit` 必须携带 Broker ID、Decision ID、Grant ID、Confirmation ID 与内容哈希；Film Core 拒绝 synthetic receipt。
