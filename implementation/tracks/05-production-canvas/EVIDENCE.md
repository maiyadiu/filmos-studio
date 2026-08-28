# Track 05 证据

## 代码核查

- Host `CanvasUnitLink` 已存在，但唯一键不等价于“每 Unit 唯一 production 画布”。
- `LinkCanvasUnit` 已校验项目、画布、Unit 归属并 bump Project revision，但没有 expected revision/hash 入参。
- `upsertProjectChapterStoryboard` 会将 Host Shot 投影为 Storyboard row；这是可复用的旧 Storyboard 能力，不是 Film 正式事实源。
- 当前项目页会新建章节画布并写 `role=storyboard`；本轨未修改 Track 03 页面。
- Canvas Agent 已有 Shot/工作流工具，但没有 Film Core DirectorUnit/Coverage 正式合同；本轨未把 Agent 输出升级为 Approved。

## 已实施

- `web/src/film/canvas/production-canvas.ts`：默认关闭的 navigation resolver、revision/hash 写命令、五泳道纯投影、关系重建与 Candidate 构造器。
- 集成复核补强：实体、关系和 Candidate 仅接受 Film Core 已签发 UUIDv4；正式快照版本从 1 起，未知实体类型与重复关系 ID 被拒绝，Canvas 不生成正式身份。
- 投影输出只含实体 ID、节点类型、泳道、布局、关系和正式快照版本标记；不复制台词、Prompt、审批或资产正文。
- 多个 production 链接返回显式 conflict；单一链接复用原 Canvas；无链接仅返回 create intent。
- `CR-05-001`：向共享 Owner 请求正式幂等写路径、唯一性和乐观并发约束。
- `POST /projects/:id/units/:unitId/production-canvas`：默认 403；只接受 Human 显式确认、安全 `confirmationId`、精确 Project revision 和服务端复核的 SourceText SHA-256。
- Host `CanvasProject`/`CanvasUnitLink` 模型不加 Film 字段。`ProductionCanvasGuard` 是隔离 companion，以 Project+Unit 自然键守护唯一性和创建回执相关性。
- Canvas、Link、Guard、`AdminAuditEvent`、Project revision 在同一数据库事务写入；audit 插入失败时五者全部回滚。
- 幂等不依赖请求号生成对象；以 `projectId + unitId + role=production` 自然键取得原 Canvas/Link，回传首次 Human 确认和 Audit ID。
- 通用 `LinkCanvasUnit` 在分配画布到项目之前拒绝 `role=production`，既有关系读取不变。历史多 production 关联返回 409 并列出精确 Canvas IDs。
- Canvas payload 只初始化普通 Host 画布结构，不保存或信任 Film 正式 hash/状态；Unit 正文变更后仍复用原 Canvas。

## 验证

- `cd backend && go test ./internal/service -run 'ProductionCanvas|ProductionRole' -count=5`：通过；10 个专项用例重复 5 轮，包含两个独立 Service/Repository 对 SQLite 双并发返回同 Canvas/Link/Audit ID、事务内 SourceText 二次校验、删除 Unit 清理 guard 但保留追加 audit，以及强制 audit 失败零 orphan。
- `cd backend && go test ./internal/repository -run ProductionCanvas -count=5`：通过；并发错误后的 existing retry fallback 也会重读 Unit 归属和 SourceText hash，不能绕过事务守卫。
- `cd backend && go test ./...`：通过。
- `cd web && bun test test/film-production-canvas.test.ts test/film-production-entry.test.tsx`：13 pass / 0 fail / 39 assertions。
- `cd web && bun run typecheck`：通过。

## 集成完成/边界

- Web 已接入二次 Human 确认 UI，Web 双 flag 与 Host 写 flag 均默认关闭；集成分支 Playwright 已验证创建、刷新唯一复用与关闭回退。
- 集成 Owner 已同步 `docs/content/docs/backend/backend-database.mdx`、待测试专题和 `implementation/test-reports/浏览器GoldenC.md`。
- 未创建 Film Core DirectorUnit/Coverage 数据或 Approved 状态。
- Track 自身未启动 dev server；集成分支只针对临时数据库启动浏览器验收服务并已关闭。全程未进行外部生成、上传或积分消费。
