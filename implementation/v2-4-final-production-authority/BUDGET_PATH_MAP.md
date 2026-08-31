# Budget 路径图

```text
Project Budget Policy
  → Film Core project authority
  → GenerationBudgetRepository.ensure
  → reserve + authorize_submission（同一事务）
  → provider submitted
  → settled | released | reconciliation_required
  → append-only ledger events
  → projection verification
```

- 唯一账本：`film-core/src/film_production_core/generation_budget.py`。
- 原子入口：`authorize_submission` 在锁与 SQLite transaction 内完成 Reserve + Authorization。
- Provider 成功进入 `transition_reservation(... settled)`；拒绝/失败进入 release；不确定状态进入 reconciliation。
- 幂等键、expected version、scope 与金额词法均强校验。
- 本地 Mock 的预算仍走真实账本，但估算与结算金额为 0；不是跳过账本。
- 重启后 Projection 从持久事件恢复并由 `verify_ledger_against_events` 复核。
