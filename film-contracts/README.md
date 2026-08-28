# Film Contracts V0.4

本目录是 Film Core、Web、MCP 与 Provider Adapter 的共享合同源。V0.4 在 V0.3 Impact 合同上增加 `SceneTwinVersion`、`CameraVersion`、`BlockingVersion`、`CompositionVersion` 与空间组件精准 STALE scope，不在此复制影策 Project、Shot、Asset 或 Task。

- `schemas/core.schema.json`：影视语义、稳定引用和状态。
- `openapi.json`：Film Core V0.4 HTTP 工具面。
- `稳定ID.md`：ID 生成、映射与不可变规则。

`openapi.json` 中每个 operation 必须使用 `x-implementation-state`：`implemented` 表示当前 Sidecar 已注册并有合同测试，`planned` 只表示目标工具面，不得宣称为可用 API。V0.4 的 23 个 path 均为实际实现，当前没有 planned operation。

修改本目录必须经 `implementation/CHANGE_REQUESTS/` 和 `track-film-core` Owner，并同步合同测试。
