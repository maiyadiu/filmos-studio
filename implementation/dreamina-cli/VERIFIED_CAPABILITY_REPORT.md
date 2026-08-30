# Dreamina CLI 能力核验

## 结论

- 状态：`PASS_AUTOMATED`
- 真实外部消耗：`0`
- 未执行生成、上传、外部项目创建或付费 Submit。
- F0/F1 使用真实本机 CLI 执行，而不是 Mock。

## 受控读取证据

2026-08-30 在 V2.4 独立 worktree 中执行：

```text
dreamina version
dreamina -h
dreamina user_credit -h
dreamina list_task -h
dreamina user_credit
dreamina list_task --limit 1
```

CLI 返回版本 `54f1bdf-dirty` / commit `54f1bdf`，且真实账号状态、余额读取、任务列表读取均成功。原始账号与任务标识仅存在当次本机命令输出，未写入仓库、报告或用户 ZIP。

## Catalog Evidence

FilmOS 现有 Dreamina Runtime 对 CLI 版本进行真实发现；型号和参数 Schema 由同一运行时请求合同源生成：

- `canvas-agent/src/dreamina-cli-contract.ts`
- `canvas-agent/src/dreamina-model-catalog.ts`
- `canvas-agent/src/dreamina-cli.ts`
- `canvas-agent/src/dreamina-cli-runtime.ts`

Catalog Evidence 类型：`verified_static_version_bound`。当 CLI 版本变化、静态证据过期或所选 Descriptor 不再可用时，Submit 前 Catalog Validation 必须 fail closed，不得静默替换。

## 生命周期继承

V2.4 不新建 Dreamina Task Store；继承现有 receipt-first、idempotency、`submission_unknown`、restart recovery、reconcile 和 Candidate 物化路径。

## 外部 Gate

`DREAMINA-SUBMIT-PARAMETER-BINDING-001` 和真实生成仅能在用户单独授权后进入 `READY_FOR_USER_AUTHORIZATION` / `PASS_REAL_EXTERNAL`；本次不进入该 Gate。
