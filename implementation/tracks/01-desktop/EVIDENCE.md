# Track 01 证据

## 本批结论

第一个可运行最小切片已实现并在 macOS arm64 上构建/测试通过。实际交付是 SwiftPM + Foundation/AppKit 桌面核心，不是已签名、已公证的 `FilmOS Studio.app`。

## 基线与历史证据

- 上游稳定基线：`v1.2.1` / `61b332583c4fcbf71890ae67e3f0f104d67706b9`。
- 当前 Track 开工点：`f3a1bc925aca081816d1771f451b5d4cfcec6b76`。
- 交叉核查索引：`origin/integration:implementation/源码索引.md` / `e90e0577cc62daa41892f449f34b0d46ca5eb1d1`。当前 Track 分支未含该文件，本轨未复制或修改集成轨的索引。
- `git ls-tree -r --name-only v1.2.1 | rg '(^desktop/|\\.swift$)'`：无输出。
- `git log --all -- desktop '*.swift'`：没有现有桌面壳实现记录。
- 裁决：Swift/AppKit 壳为 **BUILD**，不是 EXTEND。

## 已核查现有能力

| 现有能力 | 主要证据 | 处理 |
| --- | --- | --- |
| Go Host 本地数据目录 | `backend/cmd/server/main.go`、`backend/internal/database/database.go`、Compose 中 `CANVAS_BACKEND_DATA_DIR` | REUSE；本批不修改 Host |
| Canvas Agent Local Runtime | `canvas-agent/src/local-runtime-host.ts`、`canvas-agent/src/config.ts`；loopback `127.0.0.1:17371` | EXTEND；本批只建 Supervisor 骨架 |
| Web Local Runtime 安全会话 | `web/src/services/local-runtime-session.ts`、`web/src/stores/use-local-runtime-store.ts` | REUSE；不另造第二协议 |
| Web 本地大对象存储 | `web/src/lib/localforage-storage.ts`、`file-storage.ts`、`image-storage.ts`、`resource-blob-cache.ts` | DEFER 到 Host Bridge/迁移协议 |
| Docker/命令行启动 | `.env.example`、`docker-compose*.yml`、`scripts/install-server*.sh` | REUSE 配置事实；不将其冒充为桌面壳 |

## 已实施

### WorkspaceManager

- 创建 `<项目名>.filmproject/`，原子写入 `manifest.json`。
- manifest 包含 schema version、UUID、显示名、时间和 `WorkspaceLayout`；布局仅允许当前锁定的相对路径。
- 创建 `host-snapshot/`、`canvas/`、`media/objects/`、`media/proxies/`、`scene-twins/`、`prompts/`、`tasks/`、`receipts/`、`deliverables/`、`audit/`、`cache/`、`backups/`。
- 仅保留 `film-core.sqlite` 相对位置，未创建伪 SQLite 文件；真实 schema 由 Track 02 后续接入。
- 打开时校验扩展名、manifest schema、UUID、当前布局、相对路径与必需目录。
- `copyWorkspace`复制完整项目目录并用同一打开校验重新验证，形成当前可测的迁移路径。

### 本机数据边界

- 项目便携数据：全部位于 `.filmproject/`，业务 manifest 不保存主机绝对路径。
- 主机级数据：`~/Library/Application Support/FilmOS Studio/`下的 `Runtime/`、`Logs/`、`MigrationStaging/`、`Bookmarks/`。这些 URL 由运行时解析，不进入项目 manifest。

### ServiceSupervisor

- 提供 `ServiceDefinition`、`ServiceLaunchPolicy`、`ServiceState` 和 `ServiceSupervisor`。
- 只允许开白名单根下的绝对可执行文件/工作目录；直接使用 `Process.executableURL`，不通过 shell 字符串执行。
- 白名单根、可执行文件和工作目录按最深存在祖先解析符号链接后再比较；注册和启动时均重新校验，并向启动器传递 canonical URL。
- 拒绝将 token、secret、password、cookie、API key 或 authorization 类环境变量放入可持久配置；后续由 CredentialVault 提供运行时注入边界。
- 状态明确区分 `notConfigured / stopped / starting / running / stopping / failed`。
- 启动器可注入；单测全部使用 fake launcher，没有启动 backend、Web、Canvas Agent 或任何子进程。

### 集成前安全修复

- `openWorkspace` 对 `.filmproject` 根、`manifest.json` 和全部布局目录执行 canonical containment 校验，拒绝符号链接逃逸。
- `FilmWorkspace.url(forRelativePath:)` 对尚未创建的目标文件也先解析最深存在祖先，避免 symlink 父目录绕过。
- 新增真实临时 symlink 回归：可执行文件、工作目录、manifest、布局目录与未来 workspace 文件 URL；临时文件系统返回 `ENOTSUP` 时明确输出 `SKIP` 后退出该用例。

### AppKit 入口

- SwiftPM 可执行产物 `FilmOSStudioDesktop` 可构建，有最小 AppKit 窗口入口。
- 本批未运行该可执行文件，也未启动任何服务。

### 交付哈希（SHA-256）

| 文件 | SHA-256 |
| --- | --- |
| `desktop/macos/Package.swift` | `2d607ebf8c85517da6fcfbc1bb904a834ce93591d9cadda2077ee5483d531395` |
| `desktop/macos/Sources/FilmOSDesktopCore/LocalDataLayout.swift` | `06fa830c4929efeb0bcc593c3991ce1de84637b643d158291a9cf6a74ed449a9` |
| `desktop/macos/Sources/FilmOSDesktopCore/ServiceSupervisor.swift` | `9a034ab08382592408b6664926987c7d846d002e77d0d1c946fa1ae37ebf9d5a` |
| `desktop/macos/Sources/FilmOSDesktopCore/Workspace.swift` | `2a21d224e9789c82fd8cd0cff73b1c739192bcc916d7a5f377a5e66ddc08c95e` |
| `desktop/macos/Sources/FilmOSStudioDesktop/main.swift` | `c5b941974f49dadb502640ec0ba68cff22369d5b565c590e04fa5b1259070a14` |
| `desktop/macos/Tests/FilmOSDesktopCoreTests/LocalDataLayoutTests.swift` | `e993addb9347ffc86560f4b182bab4f1881b19718286f2f18c74cc92ca6027c5` |
| `desktop/macos/Tests/FilmOSDesktopCoreTests/ServiceSupervisorTests.swift` | `8023c7593858acfd460fc46de3417cef226ab2850920f308a95a612e66629403` |
| `desktop/macos/Tests/FilmOSDesktopCoreTests/WorkspaceManagerTests.swift` | `24f46b87e6ab523ee4b3ac6d54d9c0452ef42c682d2537fbfd3e07f705f2a56e` |
| `desktop/macos/Tests/FilmOSDesktopCoreTests/SymlinkTestSupport.swift` | `bb7dffafb80d6926665fcdfc75e3b0cd50d994d9c3a006c94cc09fc65e87e2d9` |

## 验证

工具链：

```text
Apple Swift version 6.3.3
Target: arm64-apple-macosx26.0
Developer directory: /Library/Developer/CommandLineTools
```

### 构建

```text
Command: cd desktop/macos && swift build
Result: PASS
Evidence: Build complete! (0.94s; incremental post-fix build)

Command: swift build --package-path desktop/macos -c release
Result: PASS
Evidence: Build complete! (1.85s; incremental post-fix build)
```

### 单测

当前 Command Line Tools 包含 `Testing.framework` 和 `lib_TestingInterop.dylib`，但 SwiftPM 没有自动加入它们的 framework/runtime 搜索路径。为了不把当前机器的绝对工具链路径写进 Package，保留便携的 `Package.swift`，并在本次验证命令中显式注入工具链路径。

```text
Command: env DYLD_LIBRARY_PATH=/Library/Developer/CommandLineTools/Library/Developer/usr/lib \
  swift test \
  -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -F -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib
Result: PASS
Evidence: 14 tests in 3 suites passed; 0 issues
Duration: 0.019s (final test execution)
```

覆盖：

- Workspace 创建、重开、目录布局和 manifest 无主机路径/密钥线索；
- 非 `.filmproject` 拒绝；
- manifest 绝对路径拒绝；
- 完整复制后的项目 ID、receipt 和重开；
- Application Support 主机布局与文件系统根拒绝；
- Supervisor 注册、启动、停止、失败状态、可执行文件边界、敏感环境变量拒绝；
- canonical symlink 边界：服务可执行文件、工作目录、workspace manifest、布局目录与未来文件 URL 均拒绝逃逸；
- Supervisor 使用 fake launcher，真实 launcher 调用数为 0。

原始 `swift test` 失败路径也保留事实记录：先因 `XCTest` 不可见切换为 Swift `Testing`；再因 SwiftPM 未自动搜索 `Testing.framework`失败；显式加入 framework 后暴露 `lib_TestingInterop.dylib` 未进入 rpath；最终使用上述工具链路径命令通过。

## Known gaps

1. 尚无 Xcode app target、`.app` bundle、图标、entitlements、代码签名、公证、更新或安装包。
2. AppKit 入口只是可构建的最小窗口；尚无创建/打开 Workspace 的原生 UI、WebView 或菜单接线。
3. ServiceSupervisor 是受控骨架；尚未建立 backend/Web/Canvas Agent 正式 service catalog，也没有就绪检测、重启策略、日志管道、优雅退出或崩溃恢复。
4. `CredentialVault`、`FileBookmarkManager`、`ProcessLogCenter`、`CrashRecovery`、`UpdateManager`、`NativeCommandBroker` 未实现。
5. `film-core.sqlite` 尚未由 Track 02 初始化；Host SQLite 与资源目录也尚未指向项目内路径。
6. Web IndexedDB/localforage、Host Snapshot、内容寻址媒体、文件监听和外链失效诊断尚未接入 `.filmproject`。
7. 复制迁移已有临时目录自动测试，但尚未在另一台 Mac 进行真机恢复 Golden。
8. 当前纯 Command Line Tools 环境需要显式 Testing framework/runtime 路径，且该 `Testing.framework` 构建目标为 macOS 14；尚未用完整 Xcode/CI 工具链复核无参数 `swift test` 和 macOS 13 真机运行。

## 回滚

- 回退本 Track 提交即可；本批未修改 Host、Web、Canvas Agent、数据库 schema 或其他 Track 所有权路径。
- 本批没有对用户数据执行迁移；测试数据只在随机 XCTest/Swift Testing 临时目录中创建并随用例清理。
- 全局开关 `film.desktop_host` 和 `film.local_workspace` 仍为 `false`，新代码未与原影策流程接线。
