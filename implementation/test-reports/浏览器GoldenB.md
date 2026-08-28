# 浏览器 Golden B 复核

## 结论

`PASSED_LOCAL_INTEGRATION`。真实浏览器已验证 Story Review 与 Host Asset 只读投影的显式开启态、默认关闭态和 Host 原流程连续性。浏览器操作未执行外部 Provider、上传、远程发布、积分消费或真实数据迁移。

## 测试对象

- Host Project：`Golden B 浏览器验收`
- Host Project ID：`04db1fdb394ec6ebb0b3547d6d300063`
- ContentUnit ID：`02b17cd281b89e7386f0c5d3e629f318`
- 对白：A/B/C 三名角色、六个 Cue。
- 数据边界：Backend 与 Film Core 均使用 `/tmp` 临时数据库；浏览器及全部临时服务已关闭。

## 通过证据

1. `VITE_FILM_STORY_STUDIO=true`：章节页显示 `Story / Script Review`、版本/hash、逐字差异与影响预览，并明确“预览不写正式状态”“Agent 不得批准”。
2. `VITE_FILM_HOST_ASSET_READONLY=true`：资产页显示 Host Asset / Version / Representation / Resource 只读投影，明确不复制、不上传、不把 Host confirmed 映射为 Film Approved。
3. 两个开关均为 `false`：同一临时项目的章节页和资产页均无第三阶段 Film DOM，Host 编辑器、章节和资产入口继续可用。
4. 清除登录前控制台记录后，关闭态页面为 0 error；启用态只有既有 Ant Design `maskClosable` 弃用告警，无 FilmOS 请求或渲染错误。

## 截图

- Story 开启态：`output/playwright/stage3-browser/.playwright-cli/page-2026-08-28T02-44-02-693Z.png`；SHA-256 `3ec19c7a9e102f01d756e0fd64e68511639bb1f2b36c40aa18e2014bfe2c6f98`。
- Asset 开启态：`output/playwright/stage3-browser/.playwright-cli/page-2026-08-28T02-47-31-248Z.png`；SHA-256 `d7e0f9de0ab6953073ff16fc3962d437fab9fbae2daad1215b8e0cbb940abc59`。
- Story 关闭态：`output/playwright/stage3-browser/.playwright-cli/page-2026-08-28T02-48-38-165Z.png`；SHA-256 `98d0e108042871bb0b4416b1ec97aa626854b887bfbd6fdf2543b9fa0c898a9c`。

## 联合门禁

- Film Core：44 pass；合同 `schema=0.3.0 paths=21 implemented=21 planned=0 axes=6`。
- Golden A/B Python：15 pass；Golden 本地 TypeScript：5 pass、30 assertions。
- Film Web 专项：97 pass、261 assertions；Web 全量：602 pass、2545 assertions；类型检查和生产构建通过。
- Canvas Agent：343 pass、0 fail、5 个 Windows 专项 skip；OpenAPI 同步和构建通过。
- Backend `go test ./...` 通过；迁移沙箱 8 pass；外部 Provider 调用数为 0。

## 不代表

- 不代表外部生成已提交或完成，也不代表 Candidate 已被正式批准。
- Story 面板当前是本地非正式快照与差异预览；正式 Script Lock/STALE 仍只能由 Film Core Human 命令产生。
- Host Asset 面板当前只投影已知 Host 字段；没有读取用户真实资产库，也没有把 Host 状态提升为 Film Approval。
- SceneTwin、独立 Camera/Blocking/Composition、Golden C 和完整灾难恢复仍未完成。
