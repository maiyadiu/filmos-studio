# Track 03｜项目管理与动态 ContentUnit

TRACK: `03-project-ui`  
MODEL: `GPT-5.6 Sol`  
REASONING: `High`

1. 目标：扩展影策现有项目工作台和动态 ContentUnit。
2. 待核查：`detail.tsx`、`overview.tsx`、`chapters.tsx`、`project-workbench.ts`、`projects.ts`、Project model/service/tests。
3. 已知线索：Host 已有 Unit kind/parent/position/导入/排序/Canvas 链接，须本轨复核。
4. Fit-Gap：待核查后记录。
5. 最小修改：复用现有列表和排序，增加 Film 投影与多轴状态。
6. 不做：不新建 Project Hub，不固定 60 集，不重写虚拟滚动。
7. 影响：见 `FILE_OWNERSHIP.yaml#project_ui`。
8. 测试：导入、排序、拆分/合并、单一默认生产画布导航。
9. 回滚：关闭 `film.dynamic_content_units`。
10. 依赖：Track 02、05、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`

