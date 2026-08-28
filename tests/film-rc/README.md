# RC 恢复验证

本目录只运行 Stage 6 的本地、合成、可回放验证，不接受用户数据库路径。

## 单一入口

```bash
scripts/recovery/RC恢复演练 --synthetic
```

可用 `--output <新文件>` 写入一次性 canonical receipt；拒绝覆盖已有文件。入口会在一个新的临时 sandbox 中串行重放：

1. Stage 5 Remote 本地 receipt 的幂等确认与恢复；
2. 全部 Film Feature Flag 默认回退和 Remote disabled blocker；
3. DeepSeek Agent Apply 拒绝与 Agent 会话丢失后必须重新 Read；
4. Stage 5 合成迁移包、故障回滚、receipt、备份恢复；
5. Film Core SQLite 逻辑状态、Stable ID、receipt 和故障原子性；
6. 固定 Candidate 的合成 schema adapter、可逆 dry-run 与精确备份回退。

`receipt_id` 来自逻辑 replay key，重放保持不变。`receipt_sha256` 还包含每次新建 SQLite 文件的物理 hash，因此是当次运行证据，不充当跨运行幂等键。

## 测试

```bash
cd web && bun test ../tests/film-rc/test_rc_surface.test.ts
python3 -m unittest tests/film-rc/test_rc_recovery.py -v
python3 -W error::ResourceWarning -m unittest discover -s tests/recovery-or-migration -v
```

已固化的当次运行回执是 `rc-recovery-receipt.json`。它只证明本地合成等价链，不证明真实 PostgreSQL、用户库、远程发布或上游合并已执行。
