# Track 01｜桌面壳与 Local Workspace

TRACK: `01-desktop`  
MODEL: `GPT-5.6 Sol`  
REASONING: `High`

1. 本轨目标：macOS 一键启动与可整体迁移的 `.filmproject`。
2. 核查源：待读取现有桌面壳、启动脚本、本地存储、`.env.example` 和 Compose。
3. 已有能力：`UNVERIFIED`。
4. Fit-Gap：待核查后仅用 `REUSE / EXTEND / BUILD / DEFER`。
5. 最小修改：限所有路径，Feature Flag 默认关闭。
6. 不做：不启动 dev server；不写入真实密钥；不把绝对路径放入业务对象。
7. 影响文件：见 `FILE_OWNERSHIP.yaml#desktop`。
8. 测试：进程管理、Workspace 创建/重开、另一台 Mac 恢复包。
9. 回滚：关闭 `film.desktop_host` / `film.local_workspace`。
10. 依赖：Track 00、02、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`

