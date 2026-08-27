# Director 首切片

本目录是默认关闭的 Film 导演领域门禁，不替换现有 Three.js 导演台。

- DirectorUnit 与 Shot 通过 Coverage 多对多关联，不按一镜一个导演意图建模。
- Blocking 明确记录脚位、躯干、脸、视线、双手、动作入出状态和轴线侧。
- 道具交互必须闭合“演员—手—目标道具—接触状态”链。
- 连续 Shot 会核对轴线、机位侧、脚位、躯干、脸、视线、手、动作和道具状态。
- Film 正式身份必须是 UUIDv4；写入必须带 `expectedVersion` 和小写 SHA-256。
- Three.js、Blender 与 Canvas 只能产生 projection/Candidate，不拥有事实和审批权。
