# CR-03-001｜Host ContentUnit 合同贯通

申请 Track：`03-project-ui`

Owner：Host backend / API owner，Program Integrator 审批

状态：`PROPOSED`

## 原因

Host `ProjectUnit` 模型已有 `parent_id/kind/position`，但当前 service 创建只接受 chapter/episode，Create/Update DTO 不接受 parentId，项目详情摘要不返回 parentId，前端 ProjectUnit 类型也缺 parentId。因此 Film 动态种类和层级不能被宣称已完成。

## 精确改动

1. `backend/internal/model/models.go`
   - 经共享合同确认后补充 special/trailer/extra/film/season/arc/volume kind 常量。
2. `backend/internal/service/project.go`
   - Create/Update 请求接收可选 parentId/kind；验证父单元同项目、父类型规则和无环。
   - 创建/导入允许共享合同的全部 kind；错误文案从“章节”改为“内容单元”。
3. `backend/internal/repository/repository.go`
   - `ProjectUnitSummaries` SELECT 增加 `parent_id`。
   - 如需改父级，使用项目范围条件并保持 revision 更新。
4. `web/src/services/api/projects.ts`
   - ProjectUnit 增加 `parentId?: string`；Create/Import/Update 输入同步 kind/parentId 类型。
5. 后端专项测试
   - 全 kind 创建/导入；跨项目父级拒绝；不存在父级拒绝；直接/间接环拒绝；摘要 parentId；旧 chapter/episode 路径不回归。

拆分、合并、复制和归档不包含在本 RFC；这些操作还需要 Shot、CanvasUnitLink、Workflow、Candidate 等引用迁移与回滚合同。

## 回滚

回退上述 Host/API 提交即可；不得迁移或重写既有 ProjectUnit ID。新增 kind 数据若已产生，回退前必须先关闭写入口并保留可读性，不能静默降级成 chapter。
