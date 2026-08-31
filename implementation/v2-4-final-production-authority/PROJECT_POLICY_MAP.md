# Project Policy 路径图

```text
Project Settings UI
  → Film Core project authority
  → allowed/default brains
  → allowed engines/routes/descriptors
  → external project binding
  → model lock + budget + upload policy
  → project production authority builder
  → deterministic resolver
  → ProductionGenerationService
```

- UI：`web/src/pages/projects/detail/project-ai-generation-settings.tsx`。
- 页面挂载：`web/src/pages/projects/detail/settings.tsx`。
- 权威构造：`project-production-authority-builder.ts`。
- 普通项目运行时：`project-production-runtime.ts`。
- 项目 override 必须落在 allowed 集合内；模型锁、Descriptor 精确选择、Engine binding 与预算不满足时 fail closed。
- UI 只展示真实同步状态，不将未配置、未授权或 stale 显示为已连接。
