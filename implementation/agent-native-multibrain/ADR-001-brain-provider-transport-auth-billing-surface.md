# ADR-001：Brain 五维分离

Status：Accepted

## Context

当前 `online | local` 同时表达供应商、运行位置、凭据、费用和交互表面，无法安全区分 Codex 订阅、ChatGPT Host、API 与本地模型，也使订阅失败后误触 API 的风险无法被合同阻断。

## Decision

所有连接 Profile 必须独立声明：

- `provider`
- `transport`
- `authMode`
- `billingMode`
- `interactionSurface`

稳定内置 ID 为 `codex.subscription`、`chatgpt.subscription.host`、`openai.api`、`anthropic.api`、`deepseek.api`、`local.model`、`human.only`。Profile ID 是 UI、Session、Audit 和 Billing 的共同外键。

`allowApiFallback` 是显式且默认 false 的安全属性。Subscription Profile 不允许持有或实例化 Model API Adapter。API Profile 必须标记 `metered_api` 并由用户显式选择。

## Consequences

- 旧 `online/local` 仅用于迁移读取和旧 UI 回滚。
- Connection Probe 只报告真实可用性，不把已登录写成 API Key 已配置。
- Provider 私有事件必须在 Adapter 内归一化。
- 审计能稳定归因 profile/transport/auth/billing/surface。

