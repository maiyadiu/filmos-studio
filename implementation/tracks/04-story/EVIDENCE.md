# Track 04 证据

## Fit-Gap

| 能力              | 证据                                                                                                | 结论                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 章节编辑与导入    | `web/src/pages/projects/detail/chapters.tsx`、`web/src/pages/projects/detail/project-chapter-ai.ts` | 继续复用单一 Tiptap 正文和原保存/导入/AI 角色提取链；Story 面板只读当前 saved/draft 文本，不创建第二正文。`REUSE`。                                                                                       |
| Story 领域合同    | `web/src/film/story/script-version.ts`、`dialogue-fidelity.ts`、`impact-analysis.ts`                | 已有 ScriptVersion、ScriptDecision、精确 hash、人审锁定门禁和只读影响建议。`REUSE / EXTEND`。                                                                                                             |
| Core Script Lock  | `film-core/src/film_production_core/api.py`、`formal_models.py`、`formal_service.py`                | `POST /script-versions/lock` / `filmScriptVersionLock` 已实现；human-only，要求 create guards 和 source ID/version/hash，原子创建 locked ScriptVersion、ScriptDecision、审计事件。`REUSE PORT CONTRACT`。 |
| Core 正式版本读取 | `film-core/src/film_production_core/models.py#FilmProjectContext`、`service.py#project_context`     | Context 只含 film project、content units、shots、audit count；没有 ScriptVersion/ScriptDecision 列表，且没有按 Host Unit 查询正式版本 API。`GAP / DEFER`。                                                |
| Host Shot 影响    | `chapters.tsx` 的 `detail.shots`、`review-preview.ts`                                               | 仅把 Shot 描述中对源对白/Section 标题的逐字命中视为可证依赖；模糊推断不写正式状态。`PREVIEW ONLY`。                                                                                                       |
| 系统 A/B          | 仓库目录与文本检索                                                                                  | 无可验证正式来源。`UNVERIFIED / DEFER`。                                                                                                                                                                  |

## 第三阶段首切片准确位置

- `web/src/film/story/feature-flag.ts`：独立环境开关 `VITE_FILM_STORY_STUDIO`，只有显式字符串 `true` 才启用，默认关闭。
- `web/src/film/story/review-preview.ts`：从现有 saved/draft 正文构造内存预览；输出完整 SHA-256、稳定 Cue/Section、逐字对白 diff 与 Shot 影响建议，不创建正式 Film ID。
- `web/src/film/story/review-panel.tsx`：展示版本 hash、review/lock 状态、逐字对白变化、Cue/Section 影响和 `建议 STALE`；明确标注本地预览与无正式写入。
- `web/src/film/story/review-entry.tsx`：只在挂载后计算本地模型，无 fetch、无持久化。
- `web/src/film/story/core-command.ts`：对齐 Core lock 必填 create guards、actor kind、源 ID/version/hash 的类型化端口；Agent 或未确认的人类不会触发端口。
- `web/src/pages/projects/detail/chapters.tsx`：只做 Flag 条件布局和 Shot 投影；复用同一个 `editorSurface`，Flag 关闭时 Story DOM 不创建。
- `web/test/film-story-review.test.tsx`：Flag、稳定 ID、diff/impact/面板输出和 Core 命令人审门禁专项测试。

## 状态真实性

- 当前 UI 模式为 `host_preview`：source 是 Host 已保存正文，target 是当前正文或未保存草稿；二者均标记非正式、`not_reviewed`、`unlocked`。
- 面板不提供 lock 按钮；`StoryCoreCommandPort` 是待正式版本读取能力就绪后的合同边界，当前页面没有实现或调用网络适配器。
- `automaticWrites` 固定为 `false`；页面没有 STALE apply 端口，所有影响都是 recommendation。
- 未改 backend、Host 核心表、Film Core、插件或外部项目；未调用外部网络。

## 验证结果

- `cd web && bun test test/film-story-domain.test.ts test/film-story-review.test.tsx`：`15 pass / 0 fail`。
- `cd web && bun run typecheck`：通过，`tsc --noEmit` 无错误。
- `cd web && bun run build`：通过，Vite `12697 modules transformed`、`built in 2.11s`；只有仓库既有的大 chunk 警告。
- 未启动浏览器；组件输出以 React SSR 专项测试验证，交互浏览器验收仍可后续补充，但不影响本切片默认关闭与零写入边界。
