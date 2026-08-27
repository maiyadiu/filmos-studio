# Track 04 证据

## 已核查事实

| 能力            | 证据                                                                                                                                             | 结论                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 章节编辑        | `web/src/pages/projects/detail/chapters.tsx`                                                                                                     | Tiptap 编辑器按单章加载；正文保存前保留本地 dirty 状态，AI 分析要求先保存。`REUSE`。                                                                             |
| 小说导入        | `chapters.tsx`、`web/src/lib/canvas/canvas-document.ts`、`backend/internal/handler/project.go`、`service/project.go`、`repository/repository.go` | 支持 UTF-8/UTF-16/GB18030、章节标题拆分、最多 2500 章、32 MiB 请求、同一事务分批写入。`REUSE`。                                                                  |
| 用户与项目归属  | `backend/internal/service/project.go`                                                                                                            | Unit 读取、创建、导入、更新、删除前均以 `ProjectForUser(userID, projectID)` 校验项目归属。`REUSE`。                                                              |
| AI 角色提取     | `web/src/pages/projects/detail/project-chapter-ai.ts`、`chapters.tsx`、`backend/internal/service/provider.go`                                    | 保存后的正文通过通用后端文本任务，`promptTemplateOperation=character_extract`；结构校验后仅创建 `pending_confirmation` 资产候选，不直接确认为正式角色。`REUSE`。 |
| PromptTemplate  | `backend/internal/model/models_project.go`、`service/prompt_template.go`、`prompt_template_defaults.go`                                          | 运营模板按 operation/version 管理；用户定制仅保存策略层；动态上下文和受保护输出契约由服务端重新注入。未来 Story 审查操作可扩展，首切片不改后端。`EXTEND`。       |
| 插件 skills     | `plugins/yingce/README.md`、`.codex-plugin/plugin.json`、`plugins/yingce/skills/*/SKILL.md`                                                      | 当前仅有打开画布、上下文、编辑、资源感知生成等画布 skills；无 Story/Script skill。`BUILD`，本切片 `DEFER`。                                                      |
| Script 正式语义 | 全仓 `rg`；`film-contracts/schemas/core.schema.json`                                                                                             | V0 合同只有基础 `ScriptVersion`；Web/后端无版本、决策、锁定、对白映射和脚本影响实现。纯领域首切片 `BUILD`；正式持久化依赖 Track 02。                             |
| 系统 A/B        | 仓库目录与文本检索                                                                                                                               | 计划提及系统 A Story Skills、系统 B 剧本打磨方法，但当前仓库没有可验证正式入口或资料路径。`UNVERIFIED / DEFER`，不从记忆或外部项目补事实。                       |

## 首切片证据

- `web/src/film/story/script-version.ts`：Feature Flag 显式门禁、SHA-256 内容哈希、版本创建、哈希绑定决策、人审批准后显式 Script Lock、下游资格只读判断。
- 集成复核补强：Web 只接受 Film Core 已签发的 UUIDv4，决策和锁定均同时校验 `expectedVersion + expectedContentHash`；Web 不生成正式 Film ID。
- `web/src/film/story/dialogue-fidelity.ts`：稳定 Cue ID 下的说话人、逐字文本、增删与顺序差异；长对白不截断、不归一化。
- `web/src/film/story/impact-analysis.ts`：仅对绑定到变化 Cue/Section 且源哈希一致的依赖返回 `mark_stale` 建议；不写正式状态，未映射变化显式返回 unresolved。
- `web/src/film/story/integration.ts`：页面/持久化可依赖的端口，不依赖未合入 Film Core runtime。
- `web/test/film-story-domain.test.ts`：本轨专项测试。

## 尚未验证/尚未实现

- 未启动浏览器，未验证右侧面板；本轨未修改 Track 03 页面。
- 未实现 Film Core Sidecar/API、正式审计或 STALE 写入。
- 未实现 Story Bible、Character Arc、Season Arc、Episode Outline、RewriteTask、ScriptReview UI。
- 未实现 Story 插件 skill；系统 A/B 来源仍为 `UNVERIFIED`。

## 验证结果

- `cd web && bun test test/film-story-domain.test.ts`：`9 pass / 0 fail`；新增非 Film ID 与过期版本冲突门禁。
- `cd web && bun run typecheck`：通过，`tsc --noEmit` 无错误。
- `cd web && bunx prettier --check ...`：本轨 TS、测试、计划、证据与 RFC 通过格式检查。
- 未运行浏览器或全站构建；本切片无页面接线、样式或运行时副作用，专项测试与全量 TypeScript 类型检查构成最小充分验证。
