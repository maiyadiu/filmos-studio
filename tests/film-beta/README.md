# Beta 本地门禁

- `beta-performance.json`：签入的 `NOT_RUN` 固定数据集与预算，不被某次运行结果回写。
- `performance_local.py`：使用临时 Film Core SQLite 测量真实 Project Context、Entity Read 与 Command Preview，并读取已构建 Web bundle；不调用网络或外部 Provider。
- `test_performance_local.py`：验证硬预算和状态边界。超过 500 KB 的 JavaScript 记录 warning；超过 2.5 MB 才阻断当前本地 Beta，不能把 warning 隐藏成无风险。

运行：

```bash
PYTHONPATH=film-core/src:tests/film-beta /tmp/filmos-core-venv-02/bin/python -m pytest -q tests/film-beta
PYTHONPATH=film-core/src /tmp/filmos-core-venv-02/bin/python tests/film-beta/performance_local.py
```
