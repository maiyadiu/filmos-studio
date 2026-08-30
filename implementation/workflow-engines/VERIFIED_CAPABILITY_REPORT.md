# RunningHub / ComfyUI 工作流引擎核验

## 结论

- RunningHub 与 ComfyUI 是生成执行引擎，不是 AI 大脑。
- V2.4 复用现有 `useConfigStore` 内唯一 RunningHub/Comfy 工作流 Store。
- 未新建第二份 Workflow 数据库或 Secret Store。
- 本次只执行 Schema/Mock/Recovery 零费用验证，未向外部 Workflow API 提交。

## 复用路径

- `web/src/stores/use-config-store.ts`
- `web/src/services/api/runninghub.ts`
- `web/src/services/api/generation-task.ts`
- `backend/internal/service/comfy_bridge.go`
- `backend/internal/repository/comfy_bridge.go`

V2.4 新增的 Engine Registry、Catalog/Descriptor Receipt、Composer 和 Route Snapshot 是上述路径的稳定 Adapter，不是平行执行系统。

## 状态

- RunningHub：`READY_FOR_USER_SELECTION`（需选择已有 Workflow/App）
- ComfyUI：`READY_FOR_USER_SELECTION`（需选择已有 Bridge Workflow）
- 真实外部费用：`0`
