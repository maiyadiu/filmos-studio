# Track 01｜桌面壳与 Local Workspace

TRACK: `01-desktop`
MODEL: `GPT-5.6 Sol`
REASONING: `High`
STATUS: `FIRST_SLICE_VERIFIED`

## 1. 本轨目标

在不修改影策 Host 核心表、不启动任何服务的前提下，建立 FilmOS Studio macOS 桌面核心的第一个可构建切片：

- 创建和打开可整体复制的 `.filmproject` 目录；
- 使用仅含稳定 ID、时间和相对路径的 `manifest.json`；
- 明确项目内可迁移数据与主机级 Application Support 数据的边界；
- 建立受控的 ServiceSupervisor 配置、状态与可注入进程启动器骨架；
- 提供最小 AppKit 可执行入口，但不将 SwiftPM 可执行文件冒充为已签名 `.app`。

## 2. 已核查真实源码、配置与历史

- 仓库规则：`AGENTS.md`。
- 执行与验收：`AI影视工作台_影策主干_一次性并行实施总计划_V6.1.md` 的总治理、Track 01、文件所有权、提交要求、Codex 约束和 Definition of Done；`FilmOS_Studio_Codex_一次性并行开工总令_V6.2.md` 全文。
- 上游索引：`origin/integration:implementation/源码索引.md`；当前 Track 分支未含该文件，不在本轨复制一份。
- 基线与历史：`v1.2.1` 指向 `61b332583c4fcbf71890ae67e3f0f104d67706b9`；已检查 `v1.2.1` 树和全部可见 Git 历史中的 `desktop/`、`*.swift`、`implementation/源码索引.md`。
- 启动与环境：`.env.example`、`docker-compose*.yml`、`scripts/install-server.sh`、`scripts/install-server-image.sh`。
- Web Local Runtime：`web/src/main.tsx`、`web/src/services/local-runtime*.ts`、`web/src/stores/use-local-runtime-store.ts`、`web/src/lib/canvas/local-runtime-connection.ts`及主要调用方。
- Web 工作区和浏览器存储：`web/src/components/layout/workspace-*.tsx`、`web/src/lib/workspace-*.ts`、`web/src/lib/localforage-storage.ts`、`web/src/services/file-storage.ts`、`web/src/services/image-storage.ts`、`web/src/services/resource-blob-cache.ts`。
- Canvas Agent Runtime：`canvas-agent/README.md`、`canvas-agent/package.json`、`canvas-agent/src/index.ts`、`canvas-agent/src/local-runtime-host.ts`、`canvas-agent/src/local-runtime*.ts`、`canvas-agent/src/config.ts`。
- Host 数据目录：`backend/cmd/server/main.go`、`backend/internal/database/database.go`及 Compose 中的 `CANVAS_BACKEND_DATA_DIR`。

## 3. 已存在能力

- **REUSE**：Go Host 支持通过 `CANVAS_BACKEND_DATA_DIR` 选择 SQLite 与资源数据目录，默认 SQLite 文件为 `open_ai_canvas.db`。
- **REUSE**：Canvas Agent 已有只监听 `127.0.0.1:17371` 的 Local Runtime、签名会话、模块状态、工作区路径与本机配置目录逻辑。
- **REUSE**：Web 已有 Local Runtime 安全连接客户端，固定精确 loopback origin，使用 IndexedDB 保存不可导出的浏览器私钥。
- **REUSE**：Web 的用户级大对象使用 localforage/IndexedDB，并有用户 scope 隔离。
- **REUSE**：Compose 已区分源码热更新、本地构建和生产部署，但它们仍需要 Docker/命令行，不是桌面壳。

## 4. Fit-Gap：REUSE / EXTEND / BUILD / DEFER

| 能力 | 分类 | 裁决 |
| --- | --- | --- |
| Swift/AppKit 桌面壳 | **BUILD** | `v1.2.1` 和可见历史没有 `desktop/` 或 Swift 源码，不得写成 EXTEND。 |
| `.filmproject` 目录与 manifest | **BUILD** | 新增项目级便携式容器，manifest 只保存相对路径。 |
| Go Host 数据目录选择 | **REUSE** | 后续桌面编排通过环境注入项目内数据目录；本批不改 Host。 |
| Canvas Agent Local Runtime | **EXTEND** | 保留现有安全协议与端口；本批仅建立桌面进程配置/状态骨架，未接线启动。 |
| Web IndexedDB/localforage 转项目文件 | **DEFER** | 需要 Host Bridge 和迁移协议，本批不改 Web 所有权路径。 |
| Keychain / 安全书签 / 更新 / 崩溃恢复 | **DEFER** | 属桌面后续切片，本批不伪装已完成。 |
| 签名公证 `.app` | **DEFER** | 本批只提供 SwiftPM AppKit 可执行入口。 |

## 5. 本次最小修改范围

- `desktop/macos/**`：Swift Package、Foundation/AppKit 核心、单测。
- `implementation/tracks/01-desktop/TRACK_PLAN.md`：本轨真实 Fit-Gap 和切片边界。
- `implementation/tracks/01-desktop/EVIDENCE.md`：核查、构建、测试与缺口证据。

## 6. 明确不做

- 不启动 Web、Go backend、Canvas Agent 或 dev server。
- 不修改 Host 核心表、Web 和其他 Track 所有权路径。
- 不把真实密钥、Cookie、Token 或主机绝对路径写入业务 manifest。
- 不宣称完整 `.app`、代码签名、公证、安装包或恢复测试已完成。

## 7. 受影响文件与数据对象

- 新增类型：`WorkspaceManifest`、`WorkspaceLayout`、`WorkspaceManager`、`LocalDataLayout`、`ServiceDefinition`、`ServiceState`、`ServiceSupervisor`。
- 新增文件：`.filmproject/manifest.json` 和规划内的相对子目录。
- 本批无数据库 schema、API、OpenAPI、MCP 或 Host 对象改动。

## 8. 测试计划

- `swift test`：创建/重开 Workspace、拒绝非 `.filmproject`、拒绝绝对/越界路径、复制迁移后可重开、Application Support 布局、ServiceSupervisor 配置校验与状态转移。
- ServiceSupervisor 测试使用 fake launcher，不启动真实 dev server 或子进程。

## 9. 回滚方式

- 代码回滚：回退本轨提交即可；新能力尚未与 Host/Web 接线。
- 数据回滚：本批不执行现有数据迁移；测试只在 XCTest 临时目录中创建数据。
- Feature Flag：全局已有 `film.desktop_host=false` 和 `film.local_workspace=false`，本批不修改共享开关文件。

## 10. 与其他 Track 的依赖

- Track 02：后续提供真实 Film Core SQLite 初始化与 schema；本轨只保留 `film-core.sqlite` 相对位置，不创建伪数据库。
- Track 08：后续确认桌面 NativeCommandBroker 与现有 Local Runtime/MCP 的协议边界。
- Track 13：后续补签名 `.app` 启动、崩溃恢复和跨 Mac 真机 Golden。
