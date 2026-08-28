# 浏览器 Golden A 接线复核

## 结论

`PASSED`。真实浏览器已通过 Host 登录、临时 Project/ContentUnit、项目概览、Film Core 健康检查、Production Canvas 安全预演和 Feature Flag 回滚。浏览器操作未执行外部 Provider、上传、远程发布或积分消费。

## 测试对象

- Host Project：`Golden A 浏览器验收`
- Host Project ID：`1659c74ba3938967391c704a78416e47`
- ContentUnit：`第一集`
- ContentUnit ID：`71d180a26f59cd56edaa75124fd287ac`
- 数据边界：Backend 与 Film Core 均使用 `/tmp` 临时 SQLite；服务在复核后已关闭。

## 通过证据

1. 双开关开启：`VITE_FILM_PRODUCTION_CORE=true` 与 `VITE_FILM_PRODUCTION_CANVAS=true`。
   - 项目概览出现 `Film Production Canvas`。
   - 显示 `Sidecar 可用`。
   - ContentUnit 无 production 关联时只显示“创建预演”，明确不创建画布。
2. 浏览器到 `http://127.0.0.1:18091/health` 的请求返回 200。
   - `Access-Control-Allow-Origin: http://127.0.0.1:13000`
   - `Vary: Origin`
   - 无 `*`，无 credentials。
3. 将 `VITE_FILM_PRODUCTION_CANVAS=false` 后重载同一项目概览。
   - DOM 检查 `document.body.innerText.includes('Film Production Canvas') === false`。
   - Host 原项目概览与章节入口继续可用。

## 发现并修复的缺陷

- 准确位置：Film Core HTTP 边界未返回本机 Web Origin 的 CORS 头，真实浏览器因此屏蔽 `/health`；组件/HTTP 单测未覆盖浏览器跨域约束。
- 已实施：`film-core/src/film_production_core/cors.py`，仅允许带显式有效端口的 `127.0.0.1`、`localhost` 和合法 `::1` HTTP Origin；远端、HTTPS、无端口、通配符和非法配置 fail closed。
- 验证：Core 37 pass（新增 16 项 CORS 正反例）；共享 OpenAPI 无漂移；浏览器 `/health` 200 并回显精确 Origin。

## 截图

- 开启态：`output/playwright/stage2-browser/启用.png`；SHA-256 `222187e08e25d9359bf4a0b7b6d9ac3389b0d68ac4e8b01273362b5abc5d5ecd`。
- 关闭态：`output/playwright/stage2-browser/关闭.png`；SHA-256 `5f6fc14e8bca914278e99514331d2861a714acca6391a0751e7c937d81dfb4c2`。

## 不代表

- 不代表外部生成已提交或已完成；外部调用数为 0。
- 不代表浏览器逐步操作了全部正式对象链；Script Lock 到 Human Approval 的正式链由真实 HTTP Golden 回执证明。
- 不代表唯一 production canvas 正式创建 API 已实现；当前仍是安全预演。
