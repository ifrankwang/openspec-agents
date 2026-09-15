# openspec-agents

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Built for OpenSpec](https://img.shields.io/badge/built%20for-OpenSpec-6b46c1.svg)

> 让多个 AI 智能体按规范流程协作，把 OpenSpec 变更规范落地为经过审查的高质量代码。

`openspec-agents` 是一组面向 AI 编码工具的插件，把 OpenSpec 的「需求 → 设计 → 任务拆分」成果，自动推进到「实现 → 验证 → 质量审查 → 收尾合并」的完整实施流程。主智能体负责调度，专职智能体分别承担实现、检查与质量把关，每一步都有门禁确认，全程可审计、可恢复。

## 特性

- **多工具支持**：Claude Code、Codex、ZCode、DeepSeek Harness（DSH）、OpenCode 均可原生接入。
- **规范驱动**：直接消费 OpenSpec 变更规范（proposal / design / tasks / specs），流程与规范一一对应。
- **智能体团队**：不再是单个 AI 从头写到尾，而是「实现者 + 审查者 + 质量把关者」分工协作，结果更稳。
- **质量门禁**：实现之后经过工具检查、任务验证与多维度质量审查；发现的问题自动回退修复，也可按规则豁免并留痕。任务验证层（任务审查 / 合并审查）以通过（passed）提交时必须逐项确认全部已申报任务（verified_tasks 全覆盖为工具强制门禁）；已通过但漏带确认导致阻塞时，审查者可补交确认结果解除阻塞。simple 模式下验证按性质分流——开发者执行确定性检查并申报，审查者分级复验（低成本项实跑、高成本项核验申报加抽样重放）并专注对抗性判断。
- **隔离执行**：每个变更在独立的环境中实施，互不干扰；变更完成后合并并清理。
- **过程可审计**：进度、结论、豁免与恢复点全程记录，随时可以接着上次的进度继续。人工执行或环境不可验证的任务经 blocker 上报、用户确认留痕（blocker_updates）后凭记录申报完成；恢复参数 reset_steps 按流程模式（full / simple）校验各自的审查步骤值域后生效。

## 快速开始

1. 准备环境：**Node.js ≥ 23.6**（或 Bun）与 **git**。
2. 按下方「安装」选择你正在使用的 AI 工具完成安装。
3. 重启该工具后，把下面「一句话接入」的提示词发给你的 AI 即可开始。

## 安装

按你使用的 AI 工具选择一种方式：

### Claude Code

```bash
claude plugin marketplace add https://github.com/ifrankwang/claude-code-plugins
claude plugin install openspec-agents@ifrankwang
```

### Codex

```bash
codex plugin marketplace add https://github.com/ifrankwang/codex-plugins
codex plugin add openspec-agents@ifrankwang
```

### ZCode

打开 ZCode 插件页，添加市场 `ifrankwang/zcode-plugins`，然后安装 `openspec-agents`。

### DeepSeek Harness（DSH）

```bash
dsh plugin --profile web add @ifrankwang/openspec-agents
```

安装后重启 `dsh web` 即可。

### OpenCode

```bash
npm install -D @ifrankwang/openspec-agents
```

然后在 OpenCode 配置中加载 `@ifrankwang/openspec-agents` 插件，重启 OpenCode。

## 让 AI 帮你接入（一句话）

安装后（甚至还没安装时），直接把这句提示词发给你的 AI 编码工具：

> 请帮我安装并启用 openspec-agents 插件，然后基于当前项目的 OpenSpec 变更规范，执行完整的变更实施编排流程。

英文版：

> Please install and enable the openspec-agents plugin for my current AI coding tool, then run the OpenSpec change orchestration workflow on this repository.

如果已经安装，只需说一句「请运行 openspec-agents 编排流程」即可开工。AI 会负责完成安装、初始化、任务分派与质量把关的全部步骤。

## 工作原理（简述）

1. **输入**：项目中的 OpenSpec 变更规范（变更说明、设计、任务清单、验收规格）。
2. **分派**：主智能体把任务交给专职智能体——实现者负责写代码，审查者负责检查，质量把关者负责多维验证。
3. **门禁**：每一步的结论通过检查后才进入下一步；不通过的结论自动回到实现环节修复。
4. **收尾**：变更完成后自动合并分支并清理执行环境；change 的全部任务组完成后，主智能体按状态视图指引汇总部署注意事项（规划文档提取 + 开发者实施补充点）向用户汇报。全程留痕可审计。

## 独立审查会话

除绑定 OpenSpec 变更的编排流程外，插件支持不绑定任何变更的独立代码审查——对某个 PR 的改动区间或整个代码库做一次完整审查。

- **入口**：初始化时传 `review_scope`（与 `change_id`/`task_group_id` 二选一，互斥），说明三件事——审查范围（`pr`=两个本地分支之间的改动区间，或 `full`=全量代码库）、颗粒度（`thorough`=工具检查 → 回归验证 → 五个维度的质量审查三层；`simple`=单个审查者合并完成全部检查）、修复策略（`fix`=发现问题后自动修复再重审；`none`=只审不修，问题报告本身就是交付物）。工具按审查范围推导出会话 ID 并在返回结果里告知，后续步骤都用这个会话 ID 进行。
- **流程**：审查在独立 worktree 中进行（PR 形态从目标分支建工作分支，全量形态从当前分支建）；`fix` 模式下审查不通过会回退给开发者按问题清单修复，修完再回到第一层审查重跑；`none` 模式下审查失败直接收口，不会进入修复环节。
- **回归验证**：thorough 颗粒度的第二层是回归验证——构建必须通过、既有测试不得出现新失败（首轮跑出的存量失败会作为问题上报进入处置通道），可启动服务时还会做冒烟与既有 API 测试。
- **收尾**：`fix` 模式审查全部通过后，把工作分支合并回目标分支并清理环境；`none` 模式不合并，直接销毁工作环境，收尾返回按严重级别、维度、文件位置归并的审查结果摘要。
- **恢复**：与变更编排一致，中断后可用恢复参数回到指定审查层继续（独立审查会话的恢复步骤值域按颗粒度校验）。

## 适用场景与代价

| | |
|---|---|
| 适合 | 对代码质量、过程可控性要求高的团队与项目 |
| 代价 | 比单个 AI 直接修改更慢，API 消耗更高 |

如果你愿意用一点成本换取稳定、可复现、可审计的实施过程，这个项目就是为你准备的。

## 开发

```bash
bun install            # 安装依赖
bun test               # 运行测试
bun run typecheck      # 类型检查
bun run build:plugins  # 构建各平台的插件包（发布用）
```

## 贡献

欢迎提交 [Issue](https://github.com/ifrankwang/openspec-agents/issues) 与 Pull Request，也欢迎 Star 支持。

## 致谢

本项目基于 [OpenSpec](https://github.com/Fission-AI/OpenSpec)（[openspec.sh](https://openspec.sh)）构建——感谢 OpenSpec 团队带来的规范驱动开发方法：先写规范、再写代码，让 AI 开发有据可依。本插件专注于补全 OpenSpec 变更的**实施与质量把关**环节，是对 OpenSpec 工作流的编排增强。

## 许可证

[MIT](LICENSE) © 2025 ifrankwang
