# Film Contracts V0.3

本目录是 Film Core、Web、MCP 与 Provider Adapter 的共享合同源。V0.3 在 Golden A 合同上增加 ScriptStructureMap companion、精确 dependency scope、持久化 ImpactEdge、幂等 STALE 传播与 unresolved change 结果，不在此复制影策 Project、Shot、Asset 或 Task。

- `schemas/core.schema.json`：影视语义、稳定引用和状态。
- `openapi.json`：Film Core V0.3 HTTP 工具面。
- `稳定ID.md`：ID 生成、映射与不可变规则。

`openapi.json` 中每个 operation 必须使用 `x-implementation-state`：`implemented` 表示当前 Sidecar 已注册并有合同测试，`planned` 只表示目标工具面，不得宣称为可用 API。V0.3 的 21 个 operation 均为实际实现，当前没有 planned operation。

修改本目录必须经 `implementation/CHANGE_REQUESTS/` 和 `track-film-core` Owner，并同步合同测试。
