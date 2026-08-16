<!--
  模板说明：每个 ## N. 是一个独立迭代（task group），编排工具会逐个处理。
  每个迭代必须自带质量保证：实现代码 + 测试 + 项目质量门（见 AGENTS.md）。

  > **各组**可独立实施，组内全部完成后编译通过、可启动、测试通过。
  > **序号**即实施顺序——跨组依赖确保上游组提交后下游组可对接。
  > 每个源文件在 tasks.md 中最多出现**一次**（避免跨组并行修改冲突）。
-->

> **前置 change：** 本 change 依赖 <name> change 完成后才可开始。参见 openspec/changes/<name>/。

## 1. <迭代名称：业务价值或功能名称>

<!-- 本组 4-8 个任务。独立迭代：实现 + 测试 + 质量门。
     组内任务按依赖链排列：定义 → 实现 → 测试 → 质量门。
     每个任务以 [spec:<capability>#<requirement>] 标注追溯（纯横切基础设施任务标 [infra]）。 -->

- [ ] 1.1 <!-- 任务描述 --> [spec:<capability>#<requirement>]
- [ ] 1.2 <!-- 任务描述 --> [spec:<capability>#<requirement>]
- [ ] 1.3 <!-- 任务描述 --> [spec:<capability>]
- [ ] 1.4 <!-- 任务描述 --> [spec:<capability>]
- [ ] 1.5 <!-- 测试：UT + IT --> [spec:<capability>]
- [ ] 1.6 <!-- 质量门：项目质量门通过（见 AGENTS.md） --> [infra]

## 2. <迭代名称：业务价值或功能名称>

<!-- 本组 4-8 个任务。独立迭代：实现 + 测试 + 质量门。
     组内任务按依赖链排列：定义 → 实现 → 测试 → 质量门。 -->

- [ ] 2.1 <!-- 任务描述 --> [spec:<capability>#<requirement>]
- [ ] 2.2 <!-- 任务描述 --> [spec:<capability>#<requirement>]
- [ ] 2.3 <!-- 任务描述 --> [spec:<capability>]
- [ ] 2.4 <!-- 任务描述 --> [spec:<capability>]
- [ ] 2.5 <!-- 测试 --> [spec:<capability>]
- [ ] 2.6 <!-- 质量门 --> [infra]
