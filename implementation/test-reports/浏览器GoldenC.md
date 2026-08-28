# 浏览器 Golden C 复核

## 结论

`PASSED_LOCAL_INTEGRATION`。真实浏览器已完成 Production Canvas 创建前预演、Human 二次确认、Host 原子持久化、刷新复用唯一关联及前端开关回退。全过程使用 `/tmp` 临时数据，未调用外部 Provider，未上传、消费额度、发布或迁移用户正式数据。

## 测试对象

- Host Project：`Golden C 浏览器验收`
- Project ID：`193a3dcf9a1d6fc844cd1428bb4161bc`
- ContentUnit ID：`ad7ccf7b3ad9248d822a368626c768e5`
- Canvas ID：`3d6db614f4d4f8a61e9c9d9468649c53`
- Link ID：`ea1acaea9fa10aa9ee3c3f8c5aad7fd2`
- Audit ID：`c292842cd0a60d5af2ca5a2ca69abd17`
- 数据边界：Backend 与 Film Core 均使用临时 SQLite；浏览器和全部临时服务已关闭，临时数据库目录已清理。

## 创建与唯一性回执

1. 创建前页面明确显示“创建预演”，不发生 Host 写入。
2. 点击“准备正式创建”后出现独立的 `Human 确认正式创建` 门禁，并明确将写入 Canvas、Link 与审计。
3. 确认后页面返回 `created`、Project revision `4` 与 Audit ID；数据库中 Canvas、production Link、Guard、Audit 均为 `1`。
4. Guard 保存的 SourceText SHA-256 为 `9997b1d20048a9c6049a0805ac2e85626dc80739e8cc23e674220ed36f7f5a17`，与数据库当时的精确 SourceText 一致。
5. 刷新后页面显示“复用唯一 production 关联”，仍指向同一 Canvas；四类记录计数保持 `1/1/1/1`，Project revision 保持 `4`。
6. 将 `VITE_FILM_PRODUCTION_CANVAS=false` 后重载，同一项目与章节继续可用、画布计数仍为 1，Film Production Canvas DOM 消失，持久化记录无变化。

## 环境校正

首次启动使用的 Python 可执行文件仍以 editable 方式指向旧 Track worktree，导致浏览器探测到旧 Core 且缺少 CORS 响应头。改为显式 `PYTHONPATH` 指向当前 integration 的 `film-core/src` 后，`/health` 正确返回精确的 `Access-Control-Allow-Origin: http://127.0.0.1:13000`，随后完成上述真实浏览器链。该现象属于验收启动器路径污染，不是当前代码缺陷。

## 截图

- 创建前：`output/playwright/stage4-browser/创建前.png`；SHA-256 `25957d85891e27b079c8988ddbc102f83cfeb85e3954796f486b75bebe6c8a12`。
- Human 门禁：`output/playwright/stage4-browser/确认门禁.png`；SHA-256 `45fa1f5212acb4bc5ad84f0f15bed8f3336badcb0458be21f95e1f94f94e2abe`。
- 创建成功：`output/playwright/stage4-browser/创建成功.png`；SHA-256 `6b48478e414630bca02dbd4c6be40483e0bd20cbbf942d30607407dce6ea5adb`。
- 刷新复用：`output/playwright/stage4-browser/刷新复用.png`；SHA-256 `db7456e36f3aa95c12a65a2b1028aeb378568873299006fb76c13218cdc6d461`。
- 开关回退：`output/playwright/stage4-browser/开关回退.png`；SHA-256 `2d09971cc8ae6021c6d92d9c59e8a08048f815a0d5051e9cbea061b830263190`。

## 联合门禁

- Film Contracts：Schema `0.4.0`，23 paths 全部 implemented。
- Film Core：50 pass；Golden A/B/C Python：26 pass；Golden 本地 TypeScript：6 pass、37 assertions。
- Backend `go test ./...` 通过；Web 全量 471 pass、0 fail，类型检查和生产构建通过。
- Canvas Agent OpenAPI 同步与构建通过；全量回归为 342 pass、1 fail、5 skip，失败项是既有 Dreamina 长驻 CLI 顺序依赖用例，单独连续运行 3 次均通过，且 Stage 4 未修改该路径。
- 外部 Provider 调用数为 0，Golden C 的三个本地结果均停留在 Candidate，没有 Approval。

## 不代表

- 不代表任何外部视频已提交、生成或通过人工审片。
- 不代表用户正式数据库已迁移或 Production Canvas Flag 已在生产开启。
- 不代表 Candidate 已获批准，也不代表签名应用、远端发布或灾难恢复基础设施已验收。
