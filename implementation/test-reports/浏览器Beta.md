# 浏览器 Beta 复核

## 结论

`PASSED_LOCAL_WITH_BOUNDARIES`。真实浏览器完成 Remote/Hybrid 本地清单导入、Preview、Human 二次确认、本地回执、刷新恢复与 Feature Flag 回退。确认动作没有新增 HTTP 请求，Host 数据库没有 Film/Remote 写入，未调用外部 Provider、未上传资源、未发布或消费额度。

## 测试对象

- Host Project：`Stage 5 Beta Browser`
- Project ID：`7f5749e4497580df31a7fcce69a167f8`
- User ID：`37e6b7f7e81a291fb451fdaffd520ca2`
- 导入清单：`output/playwright/stage5-browser/remote-plan.json`
- 导入文件 SHA-256：`7538063ff03ca0dce97eb51389b091c779a76563636ba4cc357a6d1292a3a0b6`
- 运行边界：Backend 与 Web 使用临时本地环境；服务、浏览器与临时数据库均已关闭和清理。

## 本地回执与恢复

1. `VITE_FILM_REMOTE_SYNC=true` 时页面只出现一个 Remote 入口；导入 1 个 ContentUnit、1 个 Asset 和 1 个远端 Candidate-only 结果。
2. Preview 状态为 `READY`，manifest hash 为 `fb93f0c204a238701efb409196f9bc619d6fba0626ed5771b8d61f8c15c0a5a0`，`network.executed=false`。
3. Human 确认后只保存本地回执 `76b79fd9-61d6-4391-ac0c-27273e9c60f1`；状态为 `NOT_EXECUTED`，结果仍是 `CANDIDATE_ONLY`。
4. 刷新后恢复同一 receipt 和 manifest，没有重复写入或状态提升。
5. 导入/确认前后的浏览器请求清单只有 Host 本机读取；确认链没有新增请求，没有 Remote endpoint、上传或外部域名。
6. 临时 Host 数据库最终计数为 Project `1`、ContentUnit `0`、Canvas `0`、Asset `0`、Task `0`、API Call `0`。
7. 关闭 `VITE_FILM_REMOTE_SYNC` 后 Remote DOM 数量为 `0`，同一 Host 项目仍正常显示。

## 浏览器性能

在已登录 Host 项目页面顺序读取本机 `/api/projects/:id` 40 次：p50 `6.5 ms`，p95 `8.9 ms`，max `17.5 ms`，错误 `0`，外部域名 `0`；通过 `100 ms` 的本地 Beta p95 预算。首次单次导航 DCL/load 为 `84.6/84.7 ms`，只作观察，不冒充 p95。

最终刷新后的浏览器 Console 为 `0 error / 0 warning`；只保留 Vite 与 React 开发提示。登录前的 401 与旧 Ant Design 弃用提示不作为已认证最终状态。

## 截图

- 启用入口：`output/playwright/stage5-browser/remote-enabled.png`；SHA-256 `b5443720171726f193ebe6b356045a265b32b2cf2e88e709dd7db50d87692359`。
- 本地预演：`output/playwright/stage5-browser/remote-preview.png`；SHA-256 `c510423892ebd1e9ebc1b59d7e19c81a027b788ea674b3950d49468881a963fd`。
- Human 门禁：`output/playwright/stage5-browser/human-gate.png`；SHA-256 `867ef6d3d617c9aa03655e951d8cac4d99bee0ce0d85a84225fac63a58646299`。
- 本地回执：`output/playwright/stage5-browser/local-receipt.png`；SHA-256 `cfb30d1889b75acff7f5bdea094eb31f657fbdc73f96ab67093cd3024e8ecc7c`。
- 刷新恢复：`output/playwright/stage5-browser/recovered.png`；SHA-256 `26b4e09ee5533ece074e38b4fe83b8db6386895d9e000efef8eaa658bf17e170`。
- 开关回退：`output/playwright/stage5-browser/flag-off.png`；SHA-256 `1b56ece9fa4b0c1241b6be898f02798a044cc0c35284d8c1c1099ef76f1f14f0`。

## 不代表

- 不代表 Remote 执行器、Host 远端权限校验、上传、重试、发布回执或生产同步已经实现或执行。
- 不代表 Candidate 获得 Review/Approval，也不代表用户真实数据库已迁移。
- 不代表生产 Feature Flag 已开启。
