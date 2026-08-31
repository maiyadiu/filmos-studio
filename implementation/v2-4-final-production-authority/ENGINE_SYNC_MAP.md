# Engine Connection 同步图

```text
Runtime doctor/auth observation
  → EngineConnectionSynchronizer.observe
  → exact status + source locator + observed_at
  → catalog hash + binding version
  → routing store
  → project resolver / settings UI
```

- 唯一同步器：`web/src/film/generation-routing/engine-connection-synchronizer.ts`。
- Dreamina：只有 Runtime 模块存在、Doctor 成功且登录证据完整时为 ready。
- RunningHub/ComfyUI：由各自真实配置/Bridge 探测进入统一 Observation。
- Flova：未选择为 `not_configured`；已选择未登录为 `auth_required`；Doctor 与账户证据均通过才为 ready。
- Binding 轮换会使旧默认路由失效，避免 UI 假绿。
- 账户只保留伪名化引用，不保存 Cookie、登录令牌或浏览器 Profile。
