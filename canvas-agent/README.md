# 影策 Canvas Agent

本地 Canvas Agent 用来连接画布网页和用户电脑上的 Codex / Claude Code。本地开发时优先连接 `http://localhost:3000`，不需要先使用线上站点。

## 启动

源码运行要求 Node.js >=20.9.0，与当前 sharp 原生图片处理依赖保持一致。仓库依赖以 `bun.lock` 为准，使用 Bun 1.4.0 执行 `bun install --frozen-lockfile`；不要在源码目录生成平行的 npm 锁文件。

```bash
npx -y @ddcat666/open-ai-canvas-agent
```

本仓库开发时也可以直接运行：

```bash
cd canvas-agent
bun install --frozen-lockfile
npm run build
node dist/index.js
```

启动后会输出本机地址和 token：

```txt
Local URL: http://127.0.0.1:17371
Connect token: xxxxxx
```

在画布右上角点击 `Agent`，填入地址和 token 后连接。

## 项目页上下文协议

Generic Runtime 支持无画布的真实项目上下文：浏览器快照显式使用 `contextKind: "project"`，`projectId` 与业务 `domainProjectId` 相同，服务端会话与回执的 `canvasId` 为 `null`。不能填入上一张画布、临时 ID 或隐藏创建的画布；节点、连接、选区和可见节点必须为空。项目/章节原生入口已接线并通过隔离浏览器检查，真实源码宿主更新与作品接续仍待验收。

项目页复用现有 Session、Canonical Broker 和业务项目工具。创建、恢复均从唯一工具清单中按上下文依赖收窄授权；需要画布的同步、提示词、像素、生成和正式 Film 工具在项目页拒绝执行。模型新增工具不自动获得项目页权限，API 与 ChatGPT Host 的能力边界不扩大。上下文回执校验项目、章节、画布及版本；浏览器请求只发给发布当前项目上下文的客户端，不回退到另一个画布窗口。

Codex 项目页执行临时目录使用 Runtime 下的 `project-workspaces/<projectId>`，不注册成画布，不是用户作品目录或第二源码库；会话与历史仍保存在原 Session 存储。页面接入继续复用 Host 贡献槽，影策升级必须以 FilmOS 组合回归验收，不能把本协议测试当作上游升级完成。

## 无项目工作区协议

全局页面的协议基础使用 `contextKind: "workspace"`、`projectId: null`、`canvasId: null`，不借用上次作品或创建虚拟画布。签名的 `GET /agent/workspace` 返回当前 Runtime 持久 owner 对应的 `workspaceId`；`POST /canvas/state` 从服务端绑定该身份，拒绝冒填身份、混入章节/画布/素材及设置原文。首批仅接收 `home/projects/canvases/assets/settings` 页面名称和空节点集合，不读取密钥。

该模式只开放 Codex 的 `workbench_get_context`。Session、Conversation、Grant 签名、MCP 请求头、上下文回执和审计都保留独立 workspace 身份，创建/恢复/执行前核对当前范围；无项目不能取得项目写入、画布、生成、正式 Film 或工程权限，也不扩大 API/ChatGPT Host 路径。按 workspace 查询历史不得混入项目查询。恢复沿用原 provider thread，不自动发送轮次。

执行临时目录为 Runtime 下的 `agent-workspaces/<workspaceId>`，只能匹配本 Runtime owner，不登记画布、不创建作品目录；使用原 Session 存储，不新增 Agent 服务。当前仅为底层与隔离测试交付，全局 UI、素材实际选择读取、导航与用户作品验收尚未完成，不能据此宣称全工作台可控。后续继续通过既有 Host 贡献槽接入，兼容验收以影策候选加当前 FilmOS 的组合为准。

## 工作台账号绑定边界

Generic Runtime 提供签名的 `/agent/account/challenge`、`/agent/account/bind` 和 `/agent/account`，协议详见[本机账号证明](../docs/content/docs/backend/账号证明.mdx)。身份从工作台既有登录态在线验证，不信任浏览器自报 userId；挑战一次性，绑定最长60秒，换号不能复用旧签名会话，撤销会取消在途校验。不改变默认浏览器 key、其他模块历史或既有工具权限。

Generic Runtime 的私有路由、会话创建/列表/详情/历史/恢复/审批、画布状态和事件流均消费服务端账号绑定。快照按账号保存；工具事件和回执只交给同账号的原客户端，不广播给另一账号。缺失、过期或撤销绑定拒绝执行，旧未绑定历史保留但不自动认领；旧非账号化执行/历史入口在 Generic 模式关闭。账号身份不授予工程或费用权限，原 Runtime owner 与 Grant 语义不变。

浏览器换号/关闭会撤销原私有签名会话而保留共享密钥，迟到结果不进入新生命周期，401业务操作不会自动重发。工作区入口、诊断、生产按钮和浏览器工具桥也使用账号私有懒连接，不借用聊天面板的连接生命周期。协议隔离与真实窗口验收分别记录；全局素材正文、旧历史归属确认、真实长任务及安全更新仍待验收。

画布传输层另行绑定签名 Runtime session 与 clientId：其他会话不能抢占已连接客户端、发布其状态或代交工具结果；连接断开但仍等待生成结果时也保留原请求归属。撤销会拒绝该会话所有待回执，包括已断开 SSE 的生成请求。瞬时断线可由原会话回传同一请求结果，不重发生成；请求只发给当前上下文的确切客户端，不回退其他标签页。该守卫不等于网页账号隔离，也不取消已提交的外部任务；不确定结果仍按原 requestId 回读。

## 章节脚本修订

浏览器工具桥保留后端明确的 HTTP 失败状态：404 表示目标或原回执不存在，409 表示版本/依赖冲突；不能统一解释为运行时内部故障。公开响应只含固定恢复提示和 `canvas_backend_http_<status>`，不透传后端原文、URL 或凭据。响应丢失或服务错误仍须回读原请求与当前版本，不能自动重发写入。

浏览器安全会话到期或断开后，实时上下文会清空。此时返回 `canvas_context_unavailable`（503），不是后端保存失败的证明；等待重连后显式刷新上下文并回读业务版本。浏览器安全会话十分钟、Agent 上下文凭据五分钟的原有时限不变，不保留失效上下文继续写入。

已关联短剧项目的画布可通过既有 Canonical Broker 使用三个工具：

- `project_get_script`：用章节 `unitId` 读取完整 HTML 正文、修订号和哈希。
- `project_revise_script`：用已读的 `expectedRevision`、本次唯一且可重试的 `requestId`、修改说明 `note` 和 1–20 个 `oldText/newText` 精确片段修订。原文片段必须唯一，保留未要求修改的对白、场景、动作及 HTML 格式。相同操作重发沿用同一请求 ID。
- `project_get_script_revision`：按章节及修订号读取保存的历史版本，检查正文和哈希。

工具绑定当前授权业务项目，不允许模型改写项目范围。修订只编辑 draft/ready 章节；原编辑器和 Agent 共用业务数据库修订历史，先保存再回读一致才报告成功。项目未绑定、正文片段不唯一、版本冲突或回读失败时停止并说明，不退化为写画布文本节点。正式 Film Core 审阅/锁定、付费生成和删除保持原权限边界。

用户在项目章节页的“修订历史”查看前后对照。验证以隔离测试和实际会话分别记录，不把工具调用测试当作自然语言创作质量验收。

## 业务镜头提示词

业务分镜保存后，`project_sync_storyboard` 复用原生章节导入，将当前来源的镜头投影到同一授权画布。输入来自 `project_get_shots` 的章节 ID、分镜修订号、剧本修订号及哈希；不允许模型另选画布或新建画布。返回真实节点和行 ID，后续提示词工具使用该定位。同步拒绝手工改动冲突、过期来源、重复节点/行及会移除连接的操作；保留提示词、素材和布局，不生成或上传媒体。

当前画布沿用原保存接口和同步队列，以服务端内容哈希检查并发版本。只同步这一画布，不顺带提交其他脏画布和素材。响应丢失只回读精确结果；保存、本地应用、章节关联、来源复核分别返回状态，未全部通过不得称完成。相关隔离验证和真实复合会话验收分别记录。

提示词沿用原生分镜行的图片/视频字段和普通编辑器保存路径，不另建当前提示词库：

- `project_get_prompt`：绑定当前画布和业务项目，用真实 script `nodeId`、`rowId`、`kind=image|video` 读取当前正文、版本/哈希、依赖和历史目录。
- `project_save_prompt`：携带原 `state.revision`、`state.contentHash`、`dependencyHash` 和稳定 `requestId` 保存，精确回读正文、历史及原请求。冲突时保留旧稿和手工改动；结果不全匹配不得声称当前完成。
- `project_get_prompt_revision` / `project_get_prompt_request`：回读精确历史及原请求。历史不代表最新，丢响应不得换 ID 盲写。v0 为首次保存前的原稿，没有来源证据时不补造。

原生分镜表提供易读、原文编辑、来源和版本入口；同一行等待期间发生手改则保留本地内容并提示核对。保存不会上传未同步素材、调用模型、生图/视频或正式批准。素材引用元数据也不能代替像素查看。工具接线、隔离 HTTP 和实际自然语言任务分开验收。

## 已有镜头图片读取

`project_read_shot_image` 复用当前授权画布、业务镜头/剧本和登录态资源接口，返回实际 MCP 图片内容；不是把 URL 或文件名当作看图。输入真实 script `nodeId` 和 `project-shot:镜头ID` 的 `rowId`，复核原图时可带 `expectedImageHash`；不接受任意本地路径/外部 URL。

读取前后核对当前账号/画布、已保存行、业务来源及资源版本。只支持可解码的单帧 PNG/JPEG/WebP，原始图片上限 8 MiB、16 MP、单边 8192；不转换、替换或生成图片。缺图/不可读、陈旧来源、范围不符及无效图片分别失败，不能报告已经看图。证据五分钟过期，当前行引用不证明图片创建时的来源；UI历史只保留身份/约束/哈希，不重复图片编码。真实视觉准确性与协议验证分别验收，不自动设置 QC 通过。

## ComfyUI Bridge

Bridge 让云端后端把工作流请求投递到运行 Bridge 的机器，再由该进程访问 ComfyUI。`--comfy` 可填写本机 `127.0.0.1:8188`、局域网地址或公网 HTTP/HTTPS 地址，只要运行 Bridge 的机器能够访问即可；网页和云端不直接访问该地址。

部署镜像会用 Go 标准库把 Bridge 交叉编译成站点根目录下的 Windows x64、Linux x64 和 Linux ARM64 原生程序。它们不捆绑 Node.js/Bun 运行时，运行 Bridge 的机器不需要安装 Node.js、npm 或项目源码；画布“设置 → ComfyUI Bridge”会按平台生成带当前地址、令牌和工作流目录的完整命令。

```powershell
$bridgeDir = Join-Path $env:LOCALAPPDATA "OpenAICanvas"
New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
$bridgeFile = Join-Path $bridgeDir "OpenAICanvas-ComfyBridge.exe"
Invoke-WebRequest "https://你的画布服务地址/OpenAICanvas-ComfyBridge.exe" -OutFile $bridgeFile
$bridgeStream = [System.IO.File]::OpenRead($bridgeFile)
try { $bridgeHeader0 = $bridgeStream.ReadByte(); $bridgeHeader1 = $bridgeStream.ReadByte() } finally { $bridgeStream.Dispose() }
if ($bridgeHeader0 -ne 0x4D -or $bridgeHeader1 -ne 0x5A) { throw "Bridge 下载失败：服务器未返回 Windows 可执行程序，请联系管理员重新部署 Bridge" }
& $bridgeFile --server "https://你的画布服务地址" --token "你的 Bridge Token" --comfy "http://127.0.0.1:8188" --workflow-dir "D:\\ComfyUI\\workflows"
```

Linux x64 云服务器（ARM64 服务器请把文件名中的 `amd64` 改为 `arm64`）：

```bash
bridge_dir="./openai-canvas-bridge"
mkdir -p "$bridge_dir"
curl --fail --location "https://你的画布服务地址/OpenAICanvas-ComfyBridge-linux-amd64" --output "$bridge_dir/OpenAICanvas-ComfyBridge-linux-amd64"
chmod +x "$bridge_dir/OpenAICanvas-ComfyBridge-linux-amd64"
"$bridge_dir/OpenAICanvas-ComfyBridge-linux-amd64" --server "https://你的画布服务地址" --token "你的 Bridge Token" --comfy "http://127.0.0.1:8188" --workflow-dir "/opt/ComfyUI/user/default/workflows"
```

如果 ComfyUI 和 Bridge 都在云端 Linux，`--comfy` 建议使用 `http://127.0.0.1:8188`，不要把 ComfyUI 的 8188 端口暴露给公网。生产环境可将上面的 Bridge 命令配置为 systemd 服务，确保云服务器重启后自动恢复；Bridge Token 应通过受限的环境文件或服务管理器注入，不要写进公开脚本。

工作流可以在“设置 → ComfyUI Bridge”中选择 Bridge 发现的 API JSON、粘贴 ComfyUI API 格式 JSON，也可以只填写 `workflowId`，让 Bridge 从 `--workflow-dir` 下读取同名 `.json` 文件。Bridge 会分析本机工作流，并把可配置字段回传给可视化映射面板；面板可设置任务提示词、固定文本、参考图片/视频/音频顺序、蒙版、尺寸、宽高、数量、质量、视频时长、音频参数、随机 Seed 以及必选/可选规则。未保存字段映射时，Bridge 也会在执行前按同一规则分析工作流；正向 Prompt 优先于负向文本节点。参考素材会先上传到本机 ComfyUI，多余素材或缺失的必选槽位会直接报错，可选媒体缺失时不会继续使用工作流模板中的旧文件名。映射同时兼容原项目配置里的 `node`、`input`、`default` 和 `bind_prompt` 字段。RunningHub 工作流在独立的“设置 → RunningHub 工作流”中管理，不属于模型渠道。

Bridge Token 只用于主动轮询和回传结果，不要提交到 Git 或写入公开日志。Bridge 执行长任务时每 30 秒发送心跳；远程参考素材只允许解析到公网地址，`127.0.0.1`、localhost、私网和链路本地地址会被拒绝。请求、领取状态和完成结果由后端持久化：后端重启后未领取请求会继续投递，已领取请求的迟到结果也能由恢复后的任务读取；Bridge 进程自身在执行中退出时，本机 ComfyUI 任务仍不能自动接管。工作流请求 JSON 上限为 16MB，结果 JSON（含 base64 媒体）上限为 64MB，超大视频建议改为资源上传链路。

Bridge 首次使用网页生成的命令启动后，会把服务器地址、Token、ComfyUI 地址和工作流目录保存到本机用户配置目录（权限为仅当前用户可读）。之后重启或断线恢复可以直接再次启动 Bridge 程序，不需要重新填写这些参数；如需更换连接目标，再使用带参数的启动命令覆盖旧配置。

Codex app 插件会读取启动输出里的 Local URL 和 Connect token，并直接打开画布网页地址；Canvas Agent 不负责生成画布打开 URL。

Canvas Agent 默认只监听 `127.0.0.1`。网页第一次带正确 token 连接后，Canvas Agent 会记录该网页 Origin；之后其他 Origin 不能复用这个本地 Agent，除非用户清理 `~/.infinite-canvas/canvas-agent.json` 里的 `origins`。

## Dreamina CLI 安全边界

- Generic 会话中的 `generation_*` 工具由 Canonical Broker 校验后转发到原画布客户端；它们不属于 legacy canvas 工具入口。引擎/模型发现不触发生成，付费提交保留原确认及请求身份，结果继续核对原签名客户端。无画布、未知工具或缺少 Broker 上下文时拒绝，不用 direct CLI/API 旁路补跑。
- 外部程序直接切换 Dreamina CLI 账号无法被本应用实时观测；只能在下一次 CLI 状态或命令边界重新校验，因此本机任务运行期间请不要在其他程序中换号。
- 官方 CLI 的 argv 可能被同一 OS 用户通过进程列表看到，其中可能包含 prompt、receipt 或本地路径；这是官方 CLI 的进程边界，本应用不承诺对同机用户隐藏这些参数。

## 肖像可识别性本机引擎

Canvas Agent 内置 `portrait-clearance` Local Runtime 模块。它只接收签名的画布请求，不读取项目 API Key；图片、embedding、候选和报告保存在 Agent 的配置目录，不进入画布 JSON。

本机模型不会随 npm 包发布。用户必须在肖像排查工作台中显式安装并校验 `buffalo_l` 所需的 `det_10g.onnx` 与 `w600k_r50.onnx`，安装过程保留现有可用模型并拒绝校验失败的临时文件。缺少模型时，模块返回 `portrait_model_missing`，不会伪造低风险结果。

## 发布

`canvas-agent` 使用自己的 `package.json` 版本号，不跟仓库根目录 `VERSION` 绑定。发布包名为 `@ddcat666/open-ai-canvas-agent`。

发布前需要在 GitHub 仓库 Secrets 中配置 `NPM_TOKEN`。

## Codex MCP

如果希望 Codex 终端能直接操作画布，需要先把 Canvas Agent 注册成 Codex MCP。

### Codex app 插件

仓库内提供了 Codex app 插件：`plugins/yingce`。该插件尚未上架公共插件目录，直接搜索不会显示；在 Codex app 中添加本仓库的 marketplace 后即可安装。插件会注册 `yingce` MCP，并带上画布操作说明。

添加本地 marketplace 时建议使用仓库绝对路径，避免 Codex 从其他工作目录解析失败：

```bash
cd /path/to/open-ai-canvas
codex plugin marketplace add "$(pwd)"
codex plugin add yingce@yingce-local
```

插件默认通过 npm 启动 MCP：

```bash
npx -y @ddcat666/open-ai-canvas-agent mcp
```

使用时可以直接在 Codex 里说“打开影策”，插件会优先启动本地画布和本地 Agent，读取 Local URL 和 Connect token，然后直接打开画布网页地址新建并连接画布。如果自动连接失败，再检查本地画布服务和 Canvas Agent 是否都已启动。

Canvas Agent 启动后，给 Codex 添加 MCP：

```bash
codex mcp add yingce -- npx -y @ddcat666/open-ai-canvas-agent mcp
```

本仓库开发时可以改成，实际使用建议替换为本机绝对路径：

```bash
codex mcp add yingce -- node /path/to/open-ai-canvas/canvas-agent/dist/index.js mcp
```

Canvas Agent 源码使用 TypeScript 编写，MCP 协议层使用官方 `@modelcontextprotocol/sdk`，工具入参使用 `zod` 描述。

如果希望终端里的 Codex 不被 MCP 审批卡住，可以在 `~/.codex/config.toml` 里给这个 MCP 设置自动放行：

```toml
[mcp_servers.yingce]
command = "npx"
args = ["-y", "@ddcat666/open-ai-canvas-agent", "mcp"]
default_tools_approval_mode = "approve"
```

可用工具：

- `canvas_get_state`
- `canvas_get_context`
- `canvas_find_nodes`
- `canvas_get_node`
- `canvas_get_connection`
- `canvas_get_generation_tasks`
- `canvas_get_resources`
- `canvas_validate_ops`
- `canvas_get_selection`
- `canvas_export_snapshot`
- `canvas_apply_ops`
- `canvas_create_workflow`
- `canvas_create_text_node`
- `canvas_create_image_prompt_flow`

FilmOS 的 Production / Canvas / Film MCP 工具面不绑定单一模型供应商。它默认关闭，只有 `FILMOS_AGENT_GATEWAY_ENABLED=true` 时才注册；`FILMOS_AGENT_PROFILE` 可声明 `codex_app_server`、`deepseek_compatible`、`claude_code`、`local_model`、`system` 或 `human_only`。Profile 只描述本机 MCP 身份和能力，不读取、保存或调用模型 API Key、Base URL，也不会因为声明 `deepseek_compatible` 就发起网络请求。

非人工 Profile 的权限固定为 Read → Preview；正式 Apply 必须切换到 `human_only` 并提供当次人工确认，Agent 不能 Approval 或 Locked/Script Lock。所有 Profile 复用同一组 MCP 工具名、Film Core `expected_version/content_hash` 守卫和 Canvas `revision/stateHash` 守卫；未知 Profile 或 ActorKind 会失败关闭，不会静默回退为 Codex。

`canvas_create_workflow` 是创建流水线/节点图的高阶工具，不要把工作流退化成批量文本节点。它会根据节点语义自动选择真实节点类型、按实际尺寸布局、创建默认顺序连线，并复核连接与重叠结果：

| kind | 画布节点类型 | 用途 |
| --- | --- | --- |
| `character_cards` | `image` | 角色拆分图片卡片 |
| `character_three_view` | `image` | 角色正面/侧面/背面三视图 |
| `storyboard_video` | `video` | 分镜剧情视频 |
| `script` | `script` | 剧本或分镜文字 |

媒体节点优先提供 `prompt`/`content`；对三个影视语义节点，即使模型漏填提示词，工具也会从工作流标题和节点语义生成最小可用创作提示词。已有画布素材必须先通过 `canvas_find_nodes` 或 `canvas_get_resources` 获取真实 node id，再放入 `referenceNodeIds`。

```json
{
  "title": "搞笑修仙小说流水线",
  "nodes": [
    { "ref": "cards", "kind": "character_cards", "title": "角色拆分图片卡片" },
    { "ref": "views", "kind": "character_three_view", "title": "角色三视图", "referenceRefs": ["cards"] },
    { "ref": "video", "kind": "storyboard_video", "title": "分镜剧情视频", "referenceRefs": ["views"], "runGeneration": false }
  ]
}
```

`canvas_apply_ops` 示例：

```json
{
  "ops": [
    {
      "type": "add_node",
      "nodeType": "text",
      "title": "标题",
      "position": { "x": 0, "y": 0 },
      "metadata": { "content": "文本内容" }
    }
  ]
}
```

画布写工具返回的结果包含 `ok`、`message` 和 `data`。`data.snapshot` 是本地 Runtime 写入后的最新快照，`data.verification` 会列出 `createdNodeIds`、`removedNodeIds`、缺失节点/连线、前后状态摘要和生成任务观察结果。生成任务的 `message` 会明确区分“已提交/生成中，尚未完成”和“已完成且资源就绪”；不要只根据节点已经创建就向用户报告生成完成。

推荐的 Agent 工作流是：先调用 `canvas_get_context` 读取语义化上下文和 `stateHash`；不知道节点 id 时调用 `canvas_find_nodes`，已经知道 id 后用 `canvas_get_node` 或 `canvas_get_connection` 做精确复核；需要观察生成中的节点时调用 `canvas_get_generation_tasks`；涉及图片、视频或音频参考时调用 `canvas_get_resources`；复杂写操作先调用 `canvas_validate_ops`，通过后再调用 `canvas_apply_ops`。这样 Agent 不需要猜测节点 id，也不会把 loading/error/占位媒体误判成可用资源。

## 侧边栏 Codex

Generic 面板可从签名、账号绑定的 `GET /agent/models` 读取原生 `model/list` 目录；模型和支持的思考强度由当前 CLI 返回，不硬编码某个模型可用。显式选择随原有 `/agent/sessions/:sessionId/turns` 的 `codexModel: { model, effort }` 进入原生 `turn/start`，发送前在对应会话进程重新核验组合。目录失败或组合失效不会静默换模型、改用 API 或重发任务；未显式选择则沿用线程配置，非 Codex 通道拒绝该字段。

模型选项只作用于新轮次，不改正在执行的轮次和用户全局配置。本轮请求与启动后 `thread/read` 的模型/强度元数据分别显示，回报缺失显示未知，不能用请求值或目录默认值冒充实际值；线程配置回报也不代表作品已保存或图片已生成。回执保存在既有 BrainSession，按原工作台/原生轮次绑定，换会话和新轮次清除旧显示；只读元数据查询有界，失败不重发已启动任务。协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

本地面板会把提示词发送给 Canvas Agent。Canvas Agent 使用官方 `@openai/codex` CLI 的 `codex app-server --stdio` 启动并复用同一个 Codex thread，启动时会注入 `yingce` MCP 配置并自动放行 MCP 审批，真正执行画布修改前仍由网页侧边栏二次确认。

侧边栏会展示 Codex 返回的 `thread.started`、`turn.started`、`item.*`、`turn.completed` 等结构化事件；收到 app-server 的 `item/agentMessage/delta` 时，Canvas Agent 会转成 `item.updated`，网页会用同一条消息做真实流式更新，并把工具细节收进运行日志。

多步骤创作复用 Codex 原生计划事件，在当前会话显示有序步骤及自报进度。最近一轮计划随既有 BrainSession 保存，恢复会话可查看，中断不自动标为完成；开始新一轮时清除旧进度。计划不是业务结果，保存仍须通过版本、历史和请求回执回读核验。实时正文按原始分片/全文更新，最终消息校正全文；消息身份在同一 provider turn/item 和恢复历史中保持一致，不裁掉换行、空白或重复词。

FilmOS 的普通创作会话复用上述 app-server 和 Canonical Tool Broker；业务章节绑定来自当前工作台的 `domainProjectId`，不是画布文档 ID。普通创作配置关闭工程 shell 和跨项目记忆，不通过全盘文件搜索猜测作品；独立 `review_coordinator` 的工程执行权限不受此规则变更。

普通创作会话还关闭继承的 Apps、插件及网页搜索，只使用当前授权的 `yingce` 工作台 MCP。启动和恢复时只读有效配置，以线程级覆盖禁用其它 MCP，并逐页核验实际工具目录；工具范围无法验证则不启动任务。用户全局配置和独立工程审阅配置不被改写。订阅额度不足应明确返回429、保留未发送草稿，不改走模型API。

执行中可用“停止本轮”取消当前 turn 及尚未执行的待确认工具。已经发出的保存不自动撤销；继续时先回读实际版本，确认已完成部分后再安排后续任务。会话进行中不能切换历史或新建对话，以免界面与运行中的任务串线。历史恢复来自同一个 Codex provider thread，不将空白新会话假称为恢复。

五分钟待确认超时返回 `agent_confirmation_unavailable`（409），不再包装成内部500；超时确认不能重新批准。十五分钟会话授权到期时停止后续工具，保留已保存结果；从当前会话继续会恢复原 provider thread 和授权，再回读尚未核验的部分，不自动重复保存。

Codex 原生审批与工作台业务工具审批仍分别存储，决定按原确认 ID 的归属回传，不能按通用会话类型猜测处理器。原生审批使用工作台轮次关联 UI，保留模型端 RPC 原身份；断线查询包含尚未过期的原生确认，停止或结束本轮会取消它们。原生确认两分钟未回答时拒绝执行并显示超时原因，不等同于用户主动拒绝；不会自动批准或重发工具。隔离协议测试不代替真实源码宿主的审批/图片生成验收。

面板提供“恢复当前会话”：先核对当前项目、章节、原生 thread 和真实空闲状态，同步当前上下文，再恢复并回读同一会话。它不发送模型轮次、不重放保存；草稿及当前聊天记录保留。运行中、待确认或执行状态未知时不可使用；切换作品后的迟到结果不应用到新对话。FilmOS 工具授权到期、工作台登录401、业务参数400、缺少目标或回执404、上下文/版本冲突分别提示；恢复授权不能修正参数，也不等于恢复订阅登录。

断线不等于任务停止。既有会话查询同时投影运行时真实轮次和未过期确认；页面重连后先核对，再恢复停止/确认入口。只读历史路径不会中断轮次、续授权或重复发送任务；进程尚未载入历史时明确需要空闲恢复，不能把空结果当作无历史。确认过期或已处理时须重新回读，不重复批准。

原会话同时保留最近轮次的 `latestTurnReceipt`：原 turnId、起止时间、运行/结束状态及是否尝试工作台写工具，不含正文或凭据。非只读工具到达执行器前先记录尝试，即使失败或取消也不能据此声称没有写入。原轮次 ID 的立即重复提交被拒绝；这不是跨全部历史轮次的永久去重库，业务写入仍依赖原 requestId。进程退出遗留的 running 回执不是已结束证明，查询不会补造终态或重跑。

原生分镜按钮遇到失败后会只读核对原会话和原作品；仅当原轮次已结束且从未尝试工作台写入、画布内容不变时解除按钮等待，并明确“本次未生成”。绑定章节还核对发送前业务分镜版本/哈希和原批次回执确实不存在。已经尝试写入、部分保存、网络不确定或缺少原轮次证据时仍需原请求回读，不因恢复授权自动重发。恢复后可由用户重新点击，新点击不是失败请求的隐式重试。

失败的 Codex 会话在接收下一次明确的新任务时恢复同一 provider thread，再执行新 turn；普通会话查询和历史读取不会触发恢复或模型调用。缺失原生对话身份则停止并报告，不另建替代对话。恢复、重放拒绝保留可读错误和原始业务回执边界。

长任务的上下文凭据仍有五分钟有效期。显式调用 `workbench_get_context` 会经原权限校验，返回当前快照并把同一快照的新凭据绑定到会话；不能通过重复旧写请求自动续期。上下文失效时，先读取工作台，再回读业务对象的当前版本。刷新不修改权限，也不会使旧审批或陈旧业务版本重新有效；跨项目读取失败关闭。MCP保留公开错误码及恢复提示，不暴露内部错误细节。

普通会话的 app-server 进程按 BrainSession 隔离，账户探测仍使用独立共享探测进程。恢复历史会话/轮换 grant 时，只替换对应会话进程，再恢复原 provider thread；不能依赖已加载 thread 的 `thread/resume` 或 MCP reload 重新载入授权环境。运行中的会话禁止同时恢复，避免中途更换工具身份；关闭会话释放其进程，不归档或删除历史。每个活跃会话增加一个受管理的进程，不创建新模型会话或切换模型 API。

章节正文、修订历史默认使用工作台既有易读渲染；Markdown 编辑与文字差异保留独立入口。切换显示不改写保存的原稿。修订 v1/v2 是普通章节编辑历史，不代表 Film Core 已批准或锁定。

侧边栏上传或粘贴的图片会先发到本机 Canvas Agent，再由 Canvas Agent 临时写入本机文件并作为 app-server `localImage` 输入传给 Codex；前端会提示附件体积，单次请求体限制为 30MB。

侧边栏Composer中显式选中的网页技能通过bundle传给本机Runtime，当前turn临时生成受限的`SKILL.md`。按官方app-server合同，文本携带真实`$skill-name`调用标记，同时提供对应原生`skill`输入项；不能只传路径而未触发加载，也不能仅加文字标记冒充已注入技能。技能正文不拼接进聊天Prompt、不静默截断，最多8个、每个128KiB，超限明确失败；turn结束删除临时文件。未被用户选中的技能不自动加入。

原生桥接先通过进程内`skills/extraRoots/set`注册本轮临时目录，再`skills/list`核对名称、enabled与真实路径；`skill`输入使用相同realpath，避免macOS `/var`与`/private/var`别名造成正文未加载。结束清除进程目录，不写全局skills配置；不支持此协议或核验失败时明确停止本次模型请求。共享的旧会话进程不允许同时更换在用技能目录。

“Codex编剧并保存”从项目创建入口发起，订阅会话先用`project_create_script`在同一业务项目整批保存新章及v1历史，`project_get_script_batch`按稳定requestId回读。仅本次turn可免重复确认创建指定批次和打磨其真实新章（最多所选1–3轮）；旧章、跨项目、媒体、删除及正式批准仍走原权限。取消或结束即失效，刷新导航不会自动重发不确定请求。原API编剧入口保留，ChatGPT订阅从零编剧按用户要求暂缓。

## Claude Code

Claude Code Adapter 代码暂时保留，但当前网页侧边栏只开放 Codex。后续开放 Claude 入口时，Canvas Agent 会调用本机 `claude -p --output-format stream-json` 并把流式 JSON 事件转发到侧边栏。

如果希望 Claude Code 也能操作画布，需要给 Claude Code 添加同一个 MCP。建议用 user scope，避免 Canvas Agent 从不同目录启动时找不到配置：

```bash
claude mcp add --scope user --transport stdio yingce -- npx -y @ddcat666/open-ai-canvas-agent mcp
```

本仓库开发时可以改成：

```bash
claude mcp add --scope user --transport stdio yingce -- node /path/to/open-ai-canvas/canvas-agent/dist/index.js mcp
```

Canvas Agent 调用 Claude Code 时会默认带上 `--allowedTools mcp__yingce__*`，画布写操作仍由网页侧边栏确认。
