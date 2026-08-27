# FilmOS Studio 决策日志

## D-0001｜主干与基线

- 状态：已锁定
- 决策：影策上游是唯一 Host 主干；FilmOS Studio 基线固定为最新稳定 Release `v1.2.1` 的 commit `61b332583c4fcbf71890ae67e3f0f104d67706b9`。
- 依据：`EV-0001`、`EV-0002`。
- 回滚：回到标签 `v1.2.1` 或基线标签 `filmos-upstream-v1.2.1`。

## D-0002｜事实边界

- 状态：已锁定
- 决策：Host 保留 Project、ProjectUnit、Shot、Canvas、Resource、Asset/Version、Generic Task 与 Provider 权威；Film Core 用 Sidecar 保存影视语义和生产真值。
- 依据：`FG-0001`–`FG-0007`。
- 回滚：关闭 Film Feature Flags，Host 原功能仍可用。

## D-0003｜Stable ID V0

- 状态：已锁定，尚无生产数据
- 决策：`film_entity_id` 由 Film Core 生成 UUIDv4，创建后不可变；不由标题、路径、顺序、内容哈希或 Host ID 派生。Host 映射显式保存。
- 原因：内容重写、单元重排和上游升级都不应改变影视实体身份。
- 约束：任何变更属红线，需 Program Integrator 与用户裁决。

## D-0004｜状态分轴

- 状态：已锁定 V0
- 决策：正式实体使用 `creative_stage` / `execution_state` / `review_state` / `lock_state` / `delivery_state` / `stale_state`，禁止用单个 `status` 表达全部含义。

