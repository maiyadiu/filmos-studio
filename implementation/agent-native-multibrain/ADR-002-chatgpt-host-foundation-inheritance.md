# ADR-002：ChatGPT Host Foundation 继承

Status：Accepted

## Context

固定基线已经完成 Secure Tunnel、Keychain、Project Grant、Secure Proof、Live Gate Challenge、只读 MCP、Widget 和 Proposal Handoff。它是 Host Transport Foundation，不是另一套 Agent 产品。

## Decision

- 唯一 Tunnel Manager 继续是 `ChatGPTConnectionManager`。
- 唯一 Runtime Key 继续使用现有 Keychain service/account。
- 唯一 ChatGPT MCP Server、Grant Store、Proposal Signing 链继续位于 Track 14。
- Connection Window 继续是设置页；原生 Agent Panel 只显示 Hosted Session/Timeline/Proposal 状态。
- 全局 Connection 保存 Tunnel ID、auto-connect、connection ID；项目授权保存于独立 Host Session。
- External Observation 按 grant/project/session/challenge 隔离并带 freshness TTL。
- ChatGPT Pro 只声明 read/fetch/widget 与显式 Handoff proposal；永不直接 Apply。

## Consequences

当前产品不声称 FilmOS 能主动启动 ChatGPT Pro Turn，也不伪造 message delta。未来公开的订阅级第三方 Host 协议只能新增 Transport，不改变 Shell、Context、Tool、Session 或 Audit。

