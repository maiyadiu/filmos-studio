# Evidence Capture 图

## 必须自动获取

- App Commit、Tree、Build ID；
- Domain/Host Project 映射；
- ContentUnit、Scene、DirectorUnit、Shot；
- Canvas ID、Revision、State Hash、Selected Node；
- Brain Profile、BrainSession、Context Receipt；
- 最近 Audit、错误、Runtime/CLI/Provider 状态；
- 数据库只读摘要与运行日志；
- 附件真实字节、SHA-256、MIME、大小、捕获时间。

## 本地路径

```text
Application Support/FilmOS Studio/review-bus/evidence/<issueId>/
```

ChatGPT 只能读取脱敏投影或物化后的安全证据；Codex 可按本机权限读取完整 Evidence。Pending Draft 在 App 启动和 Review Bus 重连后幂等重放。
