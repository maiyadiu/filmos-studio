# Track 13 证据

## 范围

- Worktree：`/Users/apple/Downloads/other/短剧/wt-qa`
- Branch：`track/qa`
- 基线提交：`f3a1bc92`
- 生产代码变更：无
- 外部 Provider 调用：0
- dev server：未启动

## 核查输入

| 输入 | SHA-256 |
| --- | --- |
| `AGENTS.md` | `48ec58f5212fd86d7784219d12393b11ff0d2cd6ff21a824de52f15f44e0dda8` |
| `AI影视工作台_影策主干_一次性并行实施总计划_V6.1.md` | `354a3375a6dbadd76c9a373e644463a013d5f376c546b038e63bc925b982ddda` |
| `FilmOS_Studio_Codex_一次性并行开工总令_V6.2.md` | `cd8e1601a545155eab0e3e7825ab2a7f61f54d6b7df7032b09aef95713a1e983` |
| `web/package.json` | `a7dcf222a4a790d26e93604d256743926badae7504193df5a604a38f7e16c322` |
| `web/bun.lock` | `b2b7925179b801aaea6c3383800a23da6186f5fc9ecc14083bc685d10beb8dda` |
| `backend/go.mod` | `2b82901254270156e367ed4d6f109a50b70da0c7141bf6954bb9cba46afa62d6` |
| `canvas-agent/package.json` | `18cea35087e39b99d62659872f3d532accfdc8713b0fb3debf02c824713e463b` |
| `canvas-agent/bun.lock` | `cf7cfdd1eb4d39e8a1c59a645ba3d0c59f04aea522ecbd904d26a52c2b7b9fbd` |
| `.github/workflows/quality.yml` | `bc8bc17422b7158a74c45ede531b342e1097c78ba2359d9d95ef1b31842c5dc1` |
| `tests/film-contract/validate_contracts.py` | `554d3315e3fd8808113f020b8a68560bb9a4f9f16a3266c791c974bd04a6e46c` |

## 可重放命令与回执

| 命令 | 当次状态 | 关键回执 |
| --- | --- | --- |
| `python3 tests/film-contract/validate_contracts.py` | `PASSED` | `FILM_CONTRACTS_OK schema=0.1.0 paths=9 axes=6` |
| `cd backend && go test ./...` | `SETUP_BLOCKED` | 默认 `proxy.golang.org` IPv6 下载超时，未进入完整业务测试 |
| `cd backend && GOPROXY=https://goproxy.cn,direct go test ./...` | `PASSED` | 所有可测试包通过，`real 23.92s` |
| `cd web && bun install --frozen-lockfile` | `PASSED` | 1287 packages，`real 5.01s` |
| `cd web && bun run test` | `PASSED` | 471 pass，0 fail，58 files，`real 3.93s` |
| `cd web && bun run build` | `PASSED_WITH_WARNING` | Bridge + TypeScript + Vite 通过，`real 5.55s`；存在 >500 kB chunk 告警 |
| `cd canvas-agent && bun install --frozen-lockfile` | `PASSED` | 154 packages，`real 0.25s` |
| `cd canvas-agent && npm test` | `PASSED` | 321 tests，316 pass，0 fail，5 Windows-specific skip，`real 42.60s` |
| `cd canvas-agent && npm run build` | `PASSED` | TypeScript 构建通过，`real 0.92s` |
| `python3 tests/film-golden/test_golden_a.py` | `PASSED` | 4 tests，0 fail |
| `python3 tests/film-golden/run_golden_a.py` | `PASSED` | `NOT_RUN -> PASSED`；`Candidate -> Approved`；external calls=0 |

## Golden A 状态证据

- 签入规格：`execution.test_status=NOT_RUN`。
- 当次运行回执：`test_status=PASSED`。
- 手动 Mock 结果导入：首先产生 `Candidate`。
- 无 Review/Approval 直接批准：失败关闭，Candidate 保持不变。
- QC Review 通过且独立 Approval 已记录：才进入 `Approved`。
- 正式写入：14 次，每次包含 `expected_version`。
- 观测：V6.1 规定的 10 个字段全部存在且非空。

## 未运行

- 真实 Film Core / DB / UI / Canvas / MCP / Provider 纵向 Golden A：`NOT_RUN`。
- Golden B：`NOT_RUN`。
- Golden C：`NOT_RUN`。
- Recovery / Migration / Upstream Compatibility 演练：`NOT_RUN`。
- 浏览器 E2E 与真实加载性能：`NOT_RUN`。

## 清理证据

Python 运行生成的 `tests/film-golden/__pycache__/` 是可再生缓存；本批在该目录增加局部 `.gitignore` 规则并在提交前删除当次缓存。该清理不包含测试规格、回执、项目数据或生产资产。

## 边界

该证据只证明原生基线与 Golden A 离线合同 Mock 在本次环境可重放，不证明真实 Film Core / DB / UI / Canvas / MCP / Provider 纵向链通过，不证明 Golden B/C、Recovery 或 Beta 验收通过。
