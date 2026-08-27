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

## 验证

- `cd web && bun test test/film-production-canvas.test.ts`：7 pass / 0 fail，覆盖默认关闭、复用、重复冲突、revision/hash、Candidate、纯投影和多对多 Coverage。
- `cd web && bun run typecheck`：通过。
- `cd web && bunx prettier --check src/film/canvas/production-canvas.ts test/film-production-canvas.test.ts`：通过。
- `git diff --check`：通过。
- 首次 typecheck 因本 worktree 尚未安装依赖而报 `tsc: command not found`；执行 `bun install --frozen-lockfile` 后复跑通过，锁文件未变化。

## 未完成/边界

- 本切片未接入现有项目 UI，feature 默认关闭。
- 未创建 Host 表、Film Core DirectorUnit/Coverage 数据或 Approved 状态。
- 未启动 dev server，未进行外部生成、上传或积分消费。
