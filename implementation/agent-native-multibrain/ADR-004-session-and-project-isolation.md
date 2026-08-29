# ADR-004：Session 与项目隔离

Status：Accepted

## Context

全局 `codexThreadId`、单队列、全局 Pending Tool 和全局 ChatGPT observation 会在多项目、多画布和多 Brain 间串线。

## Decision

`BrainSession` 的安全作用域至少包含：

```text
projectId + canvasId + brainProfileId
```

- 单一 app-server owner 可以复用进程，但 queue、providerThreadId、turn、confirmation、context receipt 按 Session 隔离。
- 同一 provider Thread 串行，不同 Thread 可并行。
- 任何 Session Grant 绑定 session/connection/project/surface/nonce/expiry。
- Confirmation 只能由创建它的 Session 使用一次；结束、超时、断连后拒绝。
- ChatGPT Host 项目切换必须轮换 Grant/Header/Challenge，清除旧 reachability 后等待新项目真实读取。
- Web 消息、Threads、Pending Confirmation 按 Session 存储；旧偏好幂等迁移。

## Consequences

旧 `/agent/codex/*` 保留为兼容代理，但不得成为新 UI 的依赖。关闭新 Feature Flag 可恢复旧 UI，新 Session Store 可忽略且不删除旧 Codex Thread。

