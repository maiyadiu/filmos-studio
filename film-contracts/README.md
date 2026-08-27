# Film Contracts V0

本目录是 Film Core、Web、MCP 与 Provider Adapter 的共享合同源。V0 先锁定身份、Host 引用、多轴状态、并发写入和第一条纵向链所需对象，不在此复制影策 Project、Shot、Asset 或 Task。

- `schemas/core.schema.json`：影视语义、稳定引用和状态。
- `openapi.json`：Film Core V0 HTTP 工具面。
- `稳定ID.md`：ID 生成、映射与不可变规则。

修改本目录必须经 `implementation/CHANGE_REQUESTS/` 和 `track-film-core` Owner，并同步合同测试。

