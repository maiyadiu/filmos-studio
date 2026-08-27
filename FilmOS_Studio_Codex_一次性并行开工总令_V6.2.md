# FilmOS Studio｜Codex 一次性并行开工总令 V6.2

> 本文件必须与《AI影视工作台一次性并行实施总计划 V6.1》一起使用。
> 
> 产品正式名称统一为：**FilmOS Studio**  
> 内部架构名统一为：**Film Production OS**  
> 后续仓库、分支、任务、ADR、测试、文档和UI文案不得再混用“新工作台 / AI短剧工作台 / 影策改版”等临时名称。

## 一、总开工令

```text
你现在负责实施 FilmOS Studio。

执行依据：
《AI影视工作台一次性并行实施总计划 V6.1》

FilmOS Studio 以 ddcat-ai/open-ai-canvas（影策）为唯一主干，
在真实核查影策现有源码、数据库、界面和测试后做最小差异扩展；
不得先凭设计文档重造影策已经存在的能力。

本计划采用一次性全量铺开、并行实施方式。
你必须从第一天同时铺开全部 Track，但必须使用 Git Worktree、文件所有权、共享合同、Feature Flag 和 integration 分支，禁止多个线程在同一分支无序修改。

立即完成：
1. Fork 并固定影策当前最新稳定 Release；开工当天重新核查 Release，不得机械使用历史版本号；
2. 建立 upstream-yingce、reference-tigerowo、reference-basket；
3. 创建 integration 和全部 Track worktree；
4. 创建 implementation 控制文件、ADR目录、风险台账、证据台账和 Golden 测试目录；
5. 由 Program Integrator 建立 Film Contracts V0、稳定ID规则、状态枚举和文件所有权；
6. 各 Track 分别先读取本轨真实源码、测试、数据库、界面和运行路径，形成 TRACK_PLAN.md；
7. 每个 Track 只允许使用 REUSE / EXTEND / BUILD / DEFER 四种结论；完成本轨 Fit-Gap 后立即实施，不等待全局审计结束；
8. 不得重新设计影策已经存在的项目、ProjectUnit、画布、资产、AssetVersion、Shot、Workflow、Task、MCP、Canvas Agent、Dreamina CLI 等能力；必须先核查后最小扩展；
9. 所有 FilmOS 专有能力优先放在隔离目录、Sidecar、Adapter 或稳定扩展槽中，并受 Feature Flag 控制；不得为了省事直接侵入影策核心实现；
10. 每日至少两次合入 integration，并运行影策原生测试、Film Contract Test、MCP Test、Golden Vertical Slice 和恢复测试；
11. 只有破坏数据、改变稳定ID、替换画布引擎、放弃影策主干、不可逆迁移、Golden项目损坏或与已锁定目标发生冲突时才暂停并请求用户裁决；
12. 其他普通实现问题由 Track 自行解决，不得因为小问题停工等待；
13. 每次提交必须说明：核查了什么、复用了什么、扩展了什么、没有改什么、测试结果、回滚方式；
14. 禁止“顺手重构”任务范围之外的模块，禁止因为模型认为架构可以更漂亮就扩大修改面。

第一条必须尽快打通的真实可用链：
项目 → 动态 ContentUnit → ScriptVersion → DirectorUnit → Shot → Production Canvas → PromptDraft → Manual Provider结果导入 → Candidate → QC → Approved。

FilmOS Studio 的正式产品原则：
- 影策是唯一Host主干；
- Film Core保存影视正式语义与生产真值；
- Canvas是交互和投影，不是正式事实源；
- Codex / DeepSeek / 未来Agent共享同一套Production / Canvas / Director / Provider工具；
- 本地模式本地为权威，远端模式远端为权威，Hybrid选择性同步；
- DirectorUnit与Shot分离；
- SceneTwin是空间真值；
- VisualLockSet负责视觉约束版本；
- Prompt Translation & Learning Kernel负责导演语言到模型语言的翻译与沉淀；
- 生成成功只产生Candidate，必须经过QC与批准才能进入正式链。
```

---

## 二、Codex 模型分配规则

### 总原则

**默认主力：GPT-5.6 Sol + High reasoning。**

不要把所有任务都设为最高思维，也不要为了速度把核心工程任务交给 Luna。

如果当前 Codex 环境不能针对不同线程单独选择 reasoning，则：

> **统一使用 GPT-5.6 Sol + High 开工。**

只有在明确的架构、迁移、并发、数据完整性或跨系统难题上，再临时升到 XHigh / Max。

### A｜Program Integrator / 总工程师线程

使用：

**GPT-5.6 Sol + XHigh**

以下情况可临时升到 **Max**：
- 领域模型最终裁决；
- 数据迁移与不可逆风险判断；
- 影策上游 Breaking Change；
- 多 Track 共享合同冲突；
- Film Core 与影策边界重构；
- MCP 权限与正式写入安全；
- 并发、幂等、恢复和数据一致性故障；
- SceneTwin / VisualLock / STALE 传播的底层设计冲突；
- Golden 流程出现无法解释的数据损坏。

Program Integrator 的职责是裁决、合并、控制边界和发现发散，不负责大量重复编码。

### B｜核心架构 Track

以下 Track 默认使用：

**GPT-5.6 Sol + XHigh**

包括：
- Film Core / Domain Contracts；
- 上游兼容与 Host Bridge；
- 数据迁移与版本；
- Local / Remote / Hybrid 权威模型；
- Agent Brain Gateway / MCP；
- SceneTwin；
- VisualLockSet / STALE；
- Continuity / QC / Version Lineage；
- Prompt Translation Kernel 的核心中间表示和模型能力合同；
- Provider统一任务生命周期；
- 并发、恢复、幂等与任务协调。

进入具体实现阶段、架构已确定后，可降回 **Sol + High**。

### C｜常规功能开发 Track

默认使用：

**GPT-5.6 Sol + High**

适用于：
- Project / ContentUnit UI 客制化；
- Story / Script Studio；
- Episode / ContentUnit Production Canvas；
- Asset Studio；
- Prompt Lab UI；
- Inspector；
- Provider Adapter；
- CLI接入；
- 普通 API；
- 普通数据库 CRUD；
- Feature Flag；
- 桌面壳普通功能；
- 测试与Bug修复。

这是 FilmOS Studio 项目的默认开发档位。

### D｜Luna Worker

**GPT-5.6 Luna 不承担架构所有权。**

只用于高吞吐、低风险、可自动验收的 Worker 任务，例如：
- 批量补测试；
- 文档整理；
- 批量类型同步；
- 格式化与简单Lint修复；
- 测试夹具生成；
- 扫描重复定义；
- 报告和日志分类；
- 迁移清单整理；
- 批量重命名（前提是有明确映射表）；
- Schema / OpenAPI生成后的机械同步；
- Prompt Casebook数据清洗；
- 无创意判断的数据搬运。

Luna 不得独立决定：
- Domain Model；
- 数据迁移；
- Stable ID；
- 数据库主结构；
- Host Bridge；
- MCP权限；
- SceneTwin；
- VisualLockSet；
- Workflow状态语义；
- Provider任务状态机；
- 上游兼容策略；
- 跨Track重构。

### E｜自动升档规则

出现以下关键词或风险时，从 **Sol High → Sol XHigh**：

architecture
migration
domain model
upstream compatibility
data integrity
concurrency
idempotency
recovery
MCP permissions
SceneTwin
VisualLock
STALE propagation
cross-module refactor
storage authority
version lineage

如果 XHigh 仍无法稳定裁决，再由 Program Integrator 使用 **Sol Max** 处理。

### F｜禁止的模型使用方式

1. 禁止所有线程长期使用 Max；
2. 禁止 Luna 对核心架构做自主重构；
3. 禁止因为 Max “想得更完整”就扩大任务边界；
4. 禁止为了节省时间跳过真实影策源码核查；
5. 禁止用更高 reasoning 替代测试、运行证据和数据验证；
6. 禁止不同 Track 各自创造重复领域模型。

---

## 三、每个 Track 的强制执行模板

每个 Codex Track 开工前必须先输出并保存：

```text
TRACK
MODEL
REASONING

1. 本轨目标
2. 核查过的影策真实源码 / 数据库 / 测试 / UI
3. 当前影策已存在能力
4. Fit-Gap：REUSE / EXTEND / BUILD / DEFER
5. 本次最小修改范围
6. 明确不做什么
7. 受影响文件与数据对象
8. 测试计划
9. 回滚方式
10. 与其他Track的依赖
```

没有上述记录，不允许进入编码。

---

## 四、命名锁定

从本命令生效后统一使用：

- 产品名：**FilmOS Studio**
- 中文简称：**FilmOS 工作台**
- 架构名：**Film Production OS**
- 推荐主仓库名：`filmos-studio`
- Film Core：`film-production-core`
- 桌面应用：`FilmOS Studio.app`

影策只称为：

**Yingce Upstream / 影策上游**

不得把最终产品继续命名为“影策改版”。
