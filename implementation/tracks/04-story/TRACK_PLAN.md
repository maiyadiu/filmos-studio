# Track 04｜Story & Script Studio

TRACK: `04-story`  
MODEL: `GPT-5.6 Sol`  
REASONING: `High`

1. 本轨目标：故事圣经、大纲、剧本版本、显式审查、Script Lock 和只读影响建议；第一切片先建立可测试的 Web 纯领域边界。
2. 已核查：`web/src/pages/projects/detail/chapters.tsx`、`project-chapter-ai.ts`、`web/src/lib/canvas/canvas-document.ts`、`web/src/services/api/projects.ts`、项目 Unit handler/service/repository、`backend/internal/model/models_project.go`、PromptTemplate service/defaults/provider 编译链及测试、`plugins/yingce` manifest/README/全部现有 skills。
3. 已有能力：章节 Tiptap 富文本编辑、按需读取和保存；TXT/Markdown 解码拆章及最多 2500 章事务导入；登录用户范围内的章节 CRUD；AI 角色提取进入通用生成任务并由服务端编译 `character_extract` 模板，结果只进入待确认资产候选；运营 PromptTemplate 与用户个性化策略已分层。不存在可验证的 ScriptVersion、ScriptDecision、Script Lock、对白保真差异或脚本影响映射。
4. Fit-Gap：`REUSE` 章节编辑/导入/角色提取/PromptTemplate；`EXTEND` 未来右侧 Story 面板和 Film Core 持久化适配；`BUILD` `web/src/film/story/` 纯领域版本、决策、锁定、哈希、对白差异、影响建议和端口；`DEFER` 系统 A Story Skills、系统 B 剧本打磨方法（仓库无正式源，`UNVERIFIED`）、Story 插件、页面接线、正式 STALE 写入和 Sidecar 持久化。
5. 本次最小修改：只新增 `web/src/film/story/`、专项测试、本轨证据和跨轨短 RFC；不修改 Track 03 页面和 Track 02 共享合同。
6. 明确不做：不复制章节编辑器；不自动重写用户正文；不让 Agent 正式批准或锁定；不让未审查/未锁版本进入下游；不执行正式 STALE 写入；不接触外部项目或媒体生成。
7. 受影响文件与对象：见 `FILE_OWNERSHIP.yaml#story`；新增 Web 领域 `ScriptVersion`、`ScriptDecision`、对白 Cue/Diff、影响建议及 `StoryStudioPort`。共享接线和合同扩展只通过 `implementation/CHANGE_REQUESTS/` 请求。
8. 测试：`bun test test/film-story-domain.test.ts`；`bun run typecheck`。覆盖默认关闭、精确正文哈希、人审批准后显式锁定、篡改阻断、长对白逐字保真、Cue/Section 精确影响与未映射变化不自动 STALE。
9. 回滚：不接线时删除本轨新增模块即可；未来接线必须先检查 `film.story_studio`，关闭后保持原章节流程。
10. 依赖：Track 02 提供正式 ScriptDecision/对白映射/Impact 合同与持久化；Track 03 按 RFC 接入右侧面板；Track 13 可把专项测试纳入 Film 合同/Golden。

STATUS: `FIRST_SLICE_VERIFIED`
