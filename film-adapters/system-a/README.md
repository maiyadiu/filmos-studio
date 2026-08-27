# 系统 A Adapter

首切片只允许在带 `.filmos-migration-sandbox` 标记的 fixture/临时目录中执行 inventory、dry-run manifest、export 与 verify。

真实系统 A 数据、数据库、资产目录和配置均未读取或修改。正式 Adapter 必须先通过 `CR-11-001` 的合同、备份和授权门禁。
