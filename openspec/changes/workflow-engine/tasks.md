## 1. P1 通用引擎核心

- [ ] 1.1 定义 WorkItem 类型与状态机（phase/suspended/currentStep/tags/metadata/children/writeback；phase 共用命名空间规则、tags 仅承载裁决、下划线前缀内部字段规则）
- [ ] 1.2 实现 workflow YAML loader（schema 校验、transition 目标解析含 done/halt、非法配置报错）
- [ ] 1.3 实现 tag 裁决与裁决缓存（passed 跳过 / failed 重派 / pending 分派 / always_run 强制）
- [ ] 1.4 实现 children 联动与 phase 门禁（正向 gate / 反向终态保持、review 中间态由 reviewer 裁定、未提交置 todo）
- [ ] 1.5 实现重试检查点逻辑（retryCount>0 且为 effective_max_retries 整数倍、continue/giveup、首轮不触发）
- [ ] 1.6 实现 suspended 调度跳过（parent 冻结 children、child 阻塞 gate 时提示人工）
- [ ] 1.7 引擎核心单元测试（src/core/workflow/）

## 2. P2 通用 submit 工具

- [ ] 2.1 实现 opx_agent_submit：step_id 路由与调用者归属校验
- [ ] 2.2 实现提交内 gate 检查与 children 更新（fixed→done / exempt→tag / new_children）
- [ ] 2.3 实现豁免路由与裁定（metadata.source 匹配 review step agents；dismissed/rejected；无匹配时提示人工）
- [ ] 2.4 实现非阻塞异步写回与失败重试（lastAttempt/lastSuccess/error）
- [ ] 2.5 用 opx_agent_submit 替换现有 role-specific submit（tool/task/quality）及其测试

## 3. P3 迁移 OpenSpec collector

- [ ] 3.1 实现 OpenSpec collector adapter（扫描 openspec changes）
- [ ] 3.2 定义 task workflow YAML（analyze/implement/verify_tool/verify_task/verify_quality）
- [ ] 3.3 现有流程迁移到新引擎运行（去重、状态文件兼容）
- [ ] 3.4 迁移回归测试全绿

## 4. P4 新 workflow 与 ADO stub

- [x] 4.1 issue 不设独立 workflow：删除 assets/workflows/issue.yaml（未接线纸面文件），issue 统一由 task workflow 的 children 机制承载
- [ ] 4.2 实现 ADO collector adapter 占位（pull 返回空、不抛错）
- [ ] 4.3 实现自定义 adapter 注册机制
- [ ] 4.4 收集器定时拉取与去重调度（pollIntervalMs 默认 30s）

## 5. P5 看板升级

- [ ] 5.1 看板 5 列布局（todo→待办、in_progress→处理中、review→审核中、done→完成、cancelled→已取消）
- [ ] 5.2 卡片信息渲染（标题/描述/labels/来源图标/currentStep/severity 色条）
- [ ] 5.3 suspended 子状态展示（[暂停] tag、暂停原因展开可见）
- [ ] 5.4 多 agent 进度 tag 汇总展示
- [ ] 5.5 task 与 issue 卡片样式区分

## 6. P6 opx_status 视图重构

- [ ] 6.1 视图通用化：按 workflow/step 动态渲染推荐，解耦硬编码 agent 名
- [ ] 6.2 检查点呈现与 continue/giveup 决策入口
- [ ] 6.3 capability tag → skill 动态加载与优雅降级
- [ ] 6.4 操作指引按角色与阶段渲染

## 7. P7 清理与收尾

- [ ] 7.1 移除硬编码 phase/agent/dimension 常量
- [ ] 7.2 移除 execution_boundary_source 等冗余概念
- [ ] 7.3 工具实现与 agent 定义同步一致（术语、参数、职责）
- [ ] 7.4 README 与流程文档同步
- [ ] 7.5 全量测试与 typecheck 通过
