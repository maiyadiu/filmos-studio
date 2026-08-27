# Track 09 证据

## 差异矩阵

| 分类 | 当前事实 |
| --- | --- |
| `EXISTS_BETTER_IN_YINGCE` | 当前仓库已有 React/Three.js 导演台、角色/模型/灯光/Camera、骨骼和姿态、Transform/Bone/Camera 关键帧、Sequencer、Beauty/Clay/Depth/Normal 与白膜视频。 |
| `EXISTS_BETTER_IN_TIGEROWO` | `reference-tigerowo/main` 提供隔离 iframe 导演台桥、360 全景关联/移除、Camera/Lens/Focal/Aperture profile 和截图/视频回传；其目录结构与当前 Host 不同，不可整仓合并。 |
| `MISSING_BOTH` | 未发现 Film Core SceneTwin 正式真值、DirectorUnit/Shot 多对多 Coverage、轴线/视线/动作/道具连续性门禁、ObjectID 正式 pass 血缘、expected_version/hash 导演写路径与人审 Approved 链。 |
| `NOT_NEEDED` | 本切片不启动 Blender/dev server，不执行外部生成，不移植整套 Tigerowo，不把本地 3D/Canvas 状态提升为正式事实。 |

Tigerowo 比较基线：`reference-tigerowo/main@57b13aa1a2d7439955b0e65abe742bc7144df32f`。

## 当前源码核查

- `web/src/types/director.ts` 的现有 DirectorScene/Shot ID 使用本地 `nanoid`，属于画布内部身份，不满足 Film Core 正式 UUIDv4。
- `director-scene.ts` 已支持对象/演员、Camera/Light、Transform/Bone 关键帧与插值。
- `canvas-director-workbench.tsx` 已有 Camera、镜头、姿态、关键帧、Depth/Normal 和白膜导出。
- `use-canvas-director.ts` 会把本地渲染上传并回写 Canvas 节点；当前没有 Film Review/Approval 合同，因此不能视为 Approved。
- 未发现专门 Director 领域测试或 Blender 正式桥；本轨不启动服务验证。

## 已实施

- 默认关闭的 Film Director domain gate。
- Film Core UUIDv4、expected_version/hash、投影只可 Candidate、禁止自动 Approved。
- DirectorUnit/Shot Coverage 多对多图校验。
- 轴线、Camera、脚位、躯干、脸、视线、双手、动作入出与道具接触状态连续性校验。
- projection 明确 `projection_only`、`formalMutationAllowed=false`、`approvalAllowed=false`；RGB/Depth/Normal/ObjectID 仅列为目标计划，并明确 ObjectID 当前 `MISSING_NOT_IMPLEMENTED`。
- R0-R4 纯决策函数，不启动 Blender。

## 验证

- `cd web && bun test test/film-director-domain-gate.test.ts`：9 pass / 0 fail。
- `cd web && bun run typecheck`：通过。
- `cd web && bunx prettier --check src/film/director/director-domain-gate.ts test/film-director-domain-gate.test.ts`：通过。
- `git diff --check`：通过。
- 本 worktree 先执行 `bun install --frozen-lockfile` 建立忽略的依赖目录，锁文件未变化。

## 边界

- 未改共享 Film Contracts、Host 表、现有导演台或其他 Track 文件。
- `CR-09-001` 已请求正式合同和共享接入。
