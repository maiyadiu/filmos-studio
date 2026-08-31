# Codex Subscription Coordinator 图

基线只有 `CodexReviewWatcher.poll/watch`，没有打包进 App，也没有回调执行器。

目标组件 `ReviewCodexCoordinator`：

```text
Watcher change
-> load full local issue/evidence/findings/task package
-> create or resume Codex subscription session
-> enforce lane and owner gates
-> structured Codex action
-> Review Bus writeback
-> durable coordinator receipt
```

边界：只使用本机 Codex subscription adapter/app-server；不得设置 OpenAI API Key，不得调用模型 API；费用、上传、外部项目、不可逆迁移和超 scope 文件必须停止。
