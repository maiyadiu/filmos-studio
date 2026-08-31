# 外部验收纠偏结论

固定基线：`ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a`

任务包 SHA-256：`7cf9bed457611e44a6b1f1bbb96968f20d83edec0d7d00bedfc73c7cdea2a10f`

本轮只收口 V1.1 双专家运行闭环，不重建 Review Bus、Film Core、Agent Runtime、Candidate 或 Tool Broker。

## 已确认 P0

1. `ReviewBusService` 只有单一 `active_candidate`，不能完成 Candidate A→B。
2. Chrome Bridge 不能原子写回 ChatGPT Verdict 与严格 Findings。
3. Consensus 只有底层 service 方法，没有 Proposal、双响应、CLI/UI/Bridge 编排。
4. Codex Watcher 只轮询并输出 JSON，没有打包 Helper、Session 协调或自动继续任务。
5. Web 没有 Review Center 路由和可见运行状态。
6. Issue Evidence 依赖 URL 推断；附件字节停留在浏览器 LocalForage，Review Bus 只收到引用。
7. 全局 V1.1 Task Package Hash 被误用为未来所有 Issue 的任务权威。
8. Chrome Options 仍要求长期 Bridge Token，不是一次性配对。
9. GitHub Run/Artifact 由 Candidate 自报，Machine Verdict 未独立验证。
10. Acceptance 主要是静态合同，未运行真实 Candidate A→B Roundtrip。

## 用户 Pilot 反馈

- 长篇剧本导入不能受错误字数/格式限制，应自动拆分章节。
- 反馈框应支持直接粘贴剪贴板截图并保存真实附件字节。
- Issue 写入后 Codex 没有被 Watcher 激活；ChatGPT 也没有生成安全的一键接管待办。
- 章节正文需要同一权威内容源上的“易读 / Markdown”双视图。

以上非闭环 P0 的产品问题不得扩大本任务总体架构；可在完成闭环能力时实施最小 UI 修复，其余记录在 `V1_1_CLOSURE_NEW_FINDINGS.md`。
