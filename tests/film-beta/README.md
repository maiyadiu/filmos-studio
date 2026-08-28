# Beta 本地门禁

- `beta-performance.json`：签入的 `NOT_RUN` 固定数据集与预算，不被某次运行结果回写。
- `performance_local.py`：使用临时 Film Core SQLite 测量真实 Project Context、Entity Read 与 Command Preview，并读取已构建 Web bundle；不调用网络或外部 Provider。
- `performance_surface.ts`：使用 80 ContentUnits / 80 Assets / 80 Candidate results 的真实 Remote Preview，以及 DeepSeek-compatible Gateway 的 Read → Preview → Apply 拒绝链；不执行 Apply、网络或 Provider。
- `test_performance_local.py`：验证硬预算和状态边界。超过 500 KB 的 JavaScript 记录 warning；超过 2.5 MB 才阻断当前本地 Beta，不能把 warning 隐藏成无风险。
- `test_performance_surface.test.ts`：验证 Remote/Agent p95、零错误、零网络、零上传和零 Agent Apply。

运行：

```bash
PYTHONPATH=film-core/src:tests/film-beta /tmp/filmos-core-venv-02/bin/python -m pytest -q tests/film-beta
PYTHONPATH=film-core/src /tmp/filmos-core-venv-02/bin/python tests/film-beta/performance_local.py
bun test tests/film-beta/test_performance_surface.test.ts
bun tests/film-beta/performance_surface.ts
```

真实浏览器路径使用临时 Host 项目和 Playwright CLI，在页面上下文顺序读取 40 次 `/api/projects/:id`，按同一规格计算 p50/p95；该命令与结果固化在第五阶段 Beta 报告，不把一次页面健康检查冒充性能证据。
