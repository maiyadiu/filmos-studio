# 权威冲突报告

## 裁决

生产生成只有一条写链：`ProductionGenerationService → CanonicalAgentToolBroker → Film Core GenerationProductionStore → GenerationBudgetRepository / FormalService`。Acceptance、Composer、Agent 与普通项目不再拥有平行 Runtime、Broker、Budget 或 Candidate 权威。

## 已消除冲突

| 原冲突 | 收口结果 | 机器证据 |
| --- | --- | --- |
| Acceptance Runtime 与普通项目分叉 | `acceptance-production-runtime.ts` 仅装配 Fixture，普通项目与验收都实例化同一 `ProductionGenerationService` | `project-production-runtime.test.ts`、`production-generation_composition.py` |
| Composer 自行合成确认/Receipt | Composer 使用内部 `human.only` Session，经 Canonical Broker 产生真实 Decision Receipt | `production-tool-broker.test.ts`、Canonical Broker Gate |
| 旧表形成平行 Candidate | 迁移触发器拒绝新 legacy authority kind；正式结果由 `FormalService.import_production_result` 写 GenerationPackage、AttemptEvidence、Candidate | Film Core tests、Formal Authority Gate |
| 预算仅为 Trace 字符串 | `GenerationBudgetRepository` 持久化 append-only 事件并校验 Projection | Budget Ledger Gate |
| Engine UI 与实际 Doctor/Auth 不一致 | `EngineConnectionSynchronizer` 把 Observation、Catalog Hash、Binding Version 写入统一 Store | Engine Connection Sync Gate |
| ChatGPT 已有项目仍报 Host not ready | 上下文哈希改为完整 SHA-256，原生层保留精确 bridge code | Canvas Agent / Desktop Swift tests |

外部 Provider 请求与付费操作均由 Acceptance 断言为 0。
