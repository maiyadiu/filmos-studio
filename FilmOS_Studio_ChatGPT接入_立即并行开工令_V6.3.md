# FilmOS Studio｜ChatGPT 接入立即并行开工令 V6.3

## 一、执行定位

你正在执行《FilmOS Studio 一次性并行实施总计划 V6.3｜ChatGPT接入整合版》。

当前主计划已经进入第五阶段。**不得回滚、不得重启前四阶段、不得暂停现有开发。**

本轮新增一条独立并行工作流：

```text
Track 14｜FilmOS ChatGPT App、Secure Bridge 与提案回传
```

目标是在不破坏当前 Codex、本地画布、Film Core、Provider 和第五阶段交付的前提下，使 ChatGPT 能成为 FilmOS 的外部大脑入口。

---

## 二、模型分配

### 总控与核心实现

```text
GPT-5.6 Sol + High
```

用于：

- 读取现有实现；
- 编写 MCP Server；
- 编写 Film Core Client；
- Widget；
- Desktop Connector；
- Proposal Import；
- 测试与集成。

### 以下任务升到 Sol + XHigh

- ChatGPT Pro / Business 能力边界；
- Secure MCP Tunnel安全模型；
- OAuth、Project Grant和媒体代理；
- Tool Contract版本兼容；
- Proposal签名、state hash与冲突处理；
- 跨 Track 共享合同变更；
- Prompt Injection与权限威胁模型。

### Luna仅用于低风险Worker任务

```text
GPT-5.6 Luna + High
```

可做：

- 文档；
- 测试样例；
- Schema快照；
- Widget视觉回归数据；
- 批量生成类型定义；
- 兼容矩阵整理。

Luna不得独立决定安全、认证、权限、数据模型和共享合同。

---

## 三、立即创建独立Worktree

```bash
git worktree add ../wt-chatgpt-app -b feature/chatgpt-app-v1 integration
```

Track 14只拥有：

```text
packages/filmos-tool-contracts/
services/filmos-chatgpt-app/
desktop-shell/FilmOSChatGPTBridge/
web/src/film/chatgpt/
plugins/filmos-chatgpt/
film-core/app/external_brains/chatgpt/
```

若目录尚不存在，可以创建。

禁止直接修改其他 Track 的共享业务实现。需要共享合同时，写入：

```text
_program/contract-requests/TRACK-14.md
```

---

## 四、第一步：真实核查，但不得阻塞全局

开工后第一小时内完成并写入：

```text
TRACK_PLAN.md
```

必须核查：

1. 当前 Film Core OpenAPI、稳定ID、state hash、expected_version；
2. 影策 Canvas Agent和MCP工具；
3. Codex app-server侧栏；
4. Remote/Hybrid现有同步与资源代理；
5. 桌面壳本地服务和Keychain；
6. 当前OpenAI官方Apps SDK、MCP、Secure MCP Tunnel和ChatGPT计划能力；
7. 当前ChatGPT Pro是否仅允许只读/fetch；
8. ChatGPT App工具冻结快照更新机制。

每项标记：

```text
REUSE
EXTEND
BUILD
DEFER
UNVERIFIED
```

完成后直接编码，不等待用户逐项批准；只有触发总计划红线才暂停。

---

## 五、必须锁定的能力边界

### 当前Pro交付

```text
ChatGPT → FilmOS读取
ChatGPT内FilmOS Widget
ChatGPT分析项目和镜头
ChatGPT导出.filmosproposal
FilmOS本地导入、Preview、用户批准
```

### 当前不得伪造

- 不得把Pro只读MCP伪装成完整写入；
- 不得把ChatGPT Pro订阅伪装成可嵌入FilmOS的API；
- 不得让ChatGPT直接连接localhost；
- 不得把本地HTTP端口公开到互联网；
- 不得让ChatGPT直接修改Approved/Locked对象。

### 未来可选

```text
Business / Enterprise / Edu Full MCP Write
OpenAI API / ChatKit内嵌面板
```

必须通过Feature Flag独立启用。

---

## 六、五日并行实施

### Day 1｜合同与只读MCP骨架

交付：

- Tool Contract v1；
- `search`；
- `fetch`；
- `filmos_get_project_context`；
- `filmos_get_content_unit_context`；
- `filmos_get_shot_context`；
- Film Core只读Client；
- ChatGPT Feature Flags；
- Contract Tests。

### Day 2｜安全连接

交付：

- Remote MCP Server；
- Secure MCP Tunnel开发连接；
- Desktop Connector；
- Project-scoped Context Grant；
- Keychain Token；
- 工具扫描通过；
- Golden ChatGPT A第一版。

### Day 3｜ChatGPT Widget

交付：

- ProjectOverviewWidget；
- ContentUnitProgressWidget；
- ShotReviewWidget；
- 媒体代理；
- 无媒体降级；
- ChatGPT读取真实FilmOS Candidate项目。

### Day 4｜Proposal Handoff

交付：

- `FilmOSProposalPackage`；
- ProposalExportWidget；
- `.filmosproposal`文件类型；
- FilmOS桌面导入；
- 签名、过期、项目、state hash验证；
- Command Preview；
- Golden ChatGPT B。

### Day 5｜硬化与Candidate

交付：

- Prompt Injection测试；
- 权限隔离；
- Tunnel断线；
- Tool Snapshot兼容；
- 重复导入幂等；
- 影策升级兼容测试；
- Candidate构建；
- 使用与恢复文档。

未完成部分必须由Feature Flag关闭，不能阻塞主产品。

---

## 七、V1工具清单

### 标准工具

```text
search
fetch
```

### FilmOS只读工具

```text
filmos_get_project_context
filmos_get_content_unit_context
filmos_get_shot_context
filmos_get_asset_version
filmos_get_scene_twin_summary
filmos_get_continuity_report
filmos_get_generation_attempts
filmos_get_review_queue
filmos_get_blockers
filmos_get_recent_changes
```

全部必须：

- readOnlyHint=true；
- 返回稳定URI、版本和state hash；
- 不返回本地绝对路径；
- 不返回密钥、Cookie、Token；
- 不默认返回原始4K媒体；
- 不允许项目文本中的指令改变权限。

### Full MCP预留工具

当前Pro隐藏：

```text
filmos_create_proposal
filmos_command_preview
filmos_command_apply
filmos_review_submit
filmos_task_create
filmos_prompt_draft_create
filmos_director_decision_create
```

---

## 八、Proposal Handoff硬规则

`.filmosproposal`必须包含：

```text
schema_version
proposal_id
source_brain
host_project_id
base_state_hash
base_versions
proposal_type
summary
items
created_at
expires_at
content_hash
signature
```

导入只能产生：

```text
Proposal
Candidate
Review Draft
```

禁止直接产生：

```text
Approved
Locked
Formal Apply
Paid Provider Task
Delete
```

---

## 九、安全红线

触发以下任一情况立即暂停Track 14并报告Program Integrator：

1. 需要公开暴露本地端口；
2. 需要上传整个本地项目；
3. 工具输出包含绝对路径或密钥；
4. Pro必须依赖写工具才能运行；
5. 需要修改Film Core稳定ID；
6. 需要绕过Command Preview；
7. 需要把ChatGPT会话当正式事实源；
8. Secure Tunnel实现与OpenAI当前官方方式冲突；
9. Widget必须依赖未公开内部API；
10. 当前第五阶段功能被破坏。

---

## 十、每日合并要求

每日两次向`integration`提交可运行切片。

每次提交必须包含：

```text
功能摘要
实际核查证据
Feature Flag
测试结果
安全影响
回滚方式
共享合同变更
未验证项
```

提交信息格式：

```text
feat(chatgpt-app): ...
test(chatgpt-app): ...
fix(chatgpt-app): ...
```

---

## 十一、Definition of Done

本轮完成标准：

1. ChatGPT Pro能读取明确授权的FilmOS项目；
2. 未授权项目不可见；
3. 至少Project、ContentUnit、Shot三个Widget可用；
4. 不暴露本地路径、密钥和数据库；
5. Secure MCP Tunnel断开时安全失败；
6. `.filmosproposal`可一键打开FilmOS；
7. 提案导入有Preview、版本冲突和审计；
8. Pro不暴露直接写工具；
9. Codex现有本机执行不受影响；
10. 关闭`film.chatgpt_app`后主工作台完整可用；
11. 影策/Film Core升级后旧工具合同有兼容测试；
12. Golden ChatGPT A、B通过。

---

## 十二、首条执行指令

现在立即：

1. 创建`wt-chatgpt-app`；
2. 写`TRACK_PLAN.md`；
3. 核查官方能力与现有代码；
4. 建立Tool Contract v1；
5. 实现只读`search/fetch/project context`；
6. 不等待当前第五阶段结束；
7. 不触碰其他Track未授权文件；
8. 当天提交第一条可运行MCP只读链到`integration`。
