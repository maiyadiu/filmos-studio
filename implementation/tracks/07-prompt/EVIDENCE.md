# Track 07 证据

## 状态

- 首切片：`LOCAL_SLICE_IMPLEMENTED_NOT_INTEGRATED`
- Feature flag：仓库默认 `film.prompt_kernel=false`
- 外部调用：`0`
- 生成提交：`0`
- Candidate 创建：`0`
- Approval 写入：`0`

## 代码证据

- 编译器：`web/src/film/prompt/prompt-draft-compiler.ts`
- 导出入口：`web/src/film/prompt/index.ts`
- 专项测试：`web/test/film-prompt-draft.test.ts`
- 共享变更申请：`implementation/CHANGE_REQUESTS/CR-07-001.md`

## 验证

工作目录：`/Users/apple/Downloads/other/短剧/wt-prompt/web`

```text
bun test test/film-prompt-draft.test.ts
8 pass, 0 fail
```

```text
bun install --frozen-lockfile
1287 packages installed
```

```text
bun run typecheck
$ tsc --noEmit
exit 0
```

```text
bun build src/film/prompt/prompt-draft-compiler.ts \
  --target browser --outdir /tmp/filmos-prompt-build
Bundled 1 module
```

## 验证边界

- 全量 Web typecheck 已通过；未运行完整 Vite 产品构建，纯 TypeScript 首切片另以 browser bundle 验证。
- 未运行 Provider/MCP 集成测试：首切片没有接入它们。
- 未声称真实生成或 Golden A：本次只有本地 PromptDraft 编译与审计。
- Flova 在当前源码中无可验证 Provider 实现，编译器对 `flova_cli` 失败关闭并标记为 `UNVERIFIED/DEFER`。
