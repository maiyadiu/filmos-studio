# 上游兼容状态

## 当前基线

- Yingce Upstream：`ddcat-ai/open-ai-canvas`
- 稳定 Release：`v1.2.1`
- Release commit：`61b332583c4fcbf71890ae67e3f0f104d67706b9`
- 核查时的 upstream `main`：`4ee5b630edfbd6da1e41b98ef1d2f3b1184c345a`
- Tigerowo 参考：`57b13aa1a2d7439955b0e65abe742bc7144df32f`
- Basket 参考：`ed013e8e5ce8ccab47cf2fc779f8e94555eb4c23`

`reference-tigerowo` 与 `reference-basket` 只用于差异检索，禁止整仓合并。

## 兼容分级

- `A_AUTO_COMPATIBLE`：合同、模型、迁移、Canvas/MCP Schema 均无影响。
- `B_ADAPTER_CHANGE`：仅需隔离 Adapter 调整。
- `C_MIGRATION_REQUIRED`：需可回滚迁移与 Golden 验证。
- `D_BLOCKED`：触发红线，不得合入。

## 当前判定

`NOT_CLASSIFIED`。Track 00 必须先实现 Release/API/Model/Migration/Canvas/MCP 差异脚本，才能对 upstream `main` 做正式分级。

