# Flova CLI 当前环境能力核验

状态：`READY_FOR_USER_SELECTION`

本报告只记录 2026-08-30 在当前候选环境执行的 F0/F1 只读核验。未创建或修改
外部项目，未上传素材，未启动 `flova run`，未下载或导出，外部费用为 0。

## 真实核验

- CLI：`$HOME/.local/bin/flova`，版本 `v0.0.9`，commit `1945b3e`，darwin/arm64。
- 结构化输出：`version`、`auth status`、`account user`、`project list`、
  `skill list` 均返回 JSON envelope。
- Auth：本机 profile 有已保存凭据；报告不保存 Token、邮箱、用户 ID 或 API Base。
- Account / quota：只读查询成功且返回 credits 字段；数值不写入仓库证据。
- Project：只读 list 成功；没有自动选择项目，也没有创建项目。
- Skill：只读目录成功，含版本及模型标签；它不是完整 Model Catalog。
- Submit：真实命令面为 `flova run <project-id> --content ...`；本次未调用。
- Status / recovery：存在 `run status`、`run current`、`run result`。
- Download / recovery：存在 `download all`、`download status`、`download current`。
- Task ID：运行/下载合同公开 stream chat/task 恢复标识；本次未产生任务。
- Idempotency：CLI 未公开调用方可传入的幂等键，按
  `UNSUPPORTED_BY_VERIFIED_CLI` 处理，FilmOS 不得据此自动重提。
- Catalog：CLI 未公开独立 Image/Video Model Catalog 或 Workflow Catalog 命令；只读
  Skill Catalog 可用，商业模型目录不得由 Skill 标签冒充。
- Cost：Account 只读 quota/credits 可用；按任务的可靠预估与 Receipt 成本字段未被
  当前只读命令面证明。

## 接入裁决

F0/F1 已证明 CLI、认证、账号、项目只读、Skill 目录及恢复命令面真实存在。由于
FilmOS 尚未绑定具体外部 Project，按照 V2.4 状态闭包停在
`READY_FOR_USER_SELECTION`。项目选择属于后续用户动作；创建项目、上传、付费 Submit
仍需分别授权。未公开的 Model Catalog、Workflow Catalog、调用方幂等键和可靠费用
预估不得伪造。
