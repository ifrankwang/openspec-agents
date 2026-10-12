# openspec-agents

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Built for OpenSpec](https://img.shields.io/badge/built%20for-OpenSpec-6b46c1.svg)

> AI 写代码很快，但没有东西替你把关。

`openspec-agents` 是一组面向主流 AI 编码工具的插件，给 AI 写代码补上「可以交付」这道关卡：一个变更从「实现 → 检查 → 验收 → 收口」逐步推进，每一步都要通过校验才能往下走，通不过就退回去修；过程留痕，中断能接上。

它补的是 [OpenSpec](https://openspec.sh) 变更从「规范写好了」到「代码真的没问题」之间的实施与把关环节。前提是你的项目在用 OpenSpec 管需求。

## 你可能正遇到这些

- AI 一次改一大片，改完说「完成了」，但没人验证过它到底改对没有。
- 一个共用逻辑被改动了，另一个入口还在用老写法，谁也没发现。
- 出了问题想复盘，只翻得到一堆对话流水，看不出当时谁按什么标准放行的。

## 它和你现在用的有什么不同

Claude Code 和 DeepSeek Harness 自带的工作流能力擅长**一次把很多活并行干完**。这个插件管的是另一件事，两者可以叠着用。

| | 工具自带的工作流 | 本插件 |
|---|---|---|
| 擅长 | 一次并行干完大量独立任务 | 一个变更按阶段推进，每步把关 |
| 怎么放行 | 脚本里的判断 | 流程规则由程序强制：检查没做完、问题没闭环就不许提交通过 |
| 换工具 | 各家私有 | 一套流程跨工具通用 |
| 中断之后 | 进度绑在对话或某次运行上 | 进度记在仓库里，换会话、换工具都能接上 |

一句话：原生工作流管「把活干完」，这个插件管「这次变更算不算通过」。

## 从零跑起来

**前提**：项目已经在用 OpenSpec。没有的话先装上并初始化：

```bash
npm install -g @fission-ai/openspec
openspec init
```

装好后项目根会出现 `openspec/` 目录。

### 第一步：安装

按你用的工具选一种，装完重启该工具。

#### Claude Code

```bash
claude plugin marketplace add https://github.com/ifrankwang/claude-code-plugins
claude plugin install openspec-agents@ifrankwang
```

#### Codex

```bash
codex plugin marketplace add https://github.com/ifrankwang/codex-plugins
codex plugin add openspec-agents@ifrankwang
```

#### ZCode

打开 ZCode 插件页，添加市场 `ifrankwang/zcode-plugins`，然后安装 `openspec-agents`。

#### DeepSeek Harness（DSH）

```bash
dsh plugin --profile web add @ifrankwang/openspec-agents
```

`web` 是 profile 名，换成你自己的（`~/.dsh/profiles/` 下的目录名）。装完重启该 profile；作用项目随当前会话所属项目自动确定，同一个 profile 下切换项目不必重装或改配置。编排工具需要在一个项目会话里使用。

#### OpenCode

要求 OpenCode 2.x（1.x 的插件接口不兼容）。

```bash
npm install -D @ifrankwang/openspec-agents
```

然后在 OpenCode 配置的 `plugins` 中登记 `@ifrankwang/openspec-agents`：

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@ifrankwang/openspec-agents"]
}
```

配置项须写作 `plugins`（复数），旧版的 `plugin`（单数）在 OpenCode 2 中不被识别。

首次加载时，插件会在项目 `.opencode/agents/` 下生成三个代理定义文件。这些文件带生成标记，插件**每次加载**都按当前版本重写；要自己改，先删掉文件里的生成标记。

### 第二步：确认装上了

重启后查看可用 skill 列表：`openspec-standard`、`orchestrator` 是插件自带的两个入口，它们和一批规范类 skill 一起出现在列表里，就说明插件已经生效。这些 skill 可以像命令一样唤起（DSH 里输入 `/` 即可看到并调用）。

### 第三步：开始

- 项目里还没提变更时，调用 `/openspec-standard`，把提案标准装进项目。
- 用 OpenSpec 提一个变更（按 OpenSpec 的用法，在你的 AI 工具里把要做的事说清楚，生成 `openspec/changes/<变更名>/` 下的文档），然后调用 `/orchestrator {change-id}` 开始编排。`{change-id}` 就是那个目录名，`openspec list` 能看到当前有哪些变更。

> 不同工具里 skill 的呈现形式可能不同，以各工具实际显示为准。

### 默认由 AI 自行拍板

各安装方式**默认都开启无人值守**：流程里需要人拍板的环节（方案怎么选、无法自动验证的部分）由编排 AI 自行决断，不会停下来问你——**审查和门禁照常跑，变的只是「要不要来问你」**。希望它在这些地方先问你，让它关掉无人值守模式即可。

### 顺手加两行进 `.gitignore`

```
.worktree/
openspec/states/
```

两者都不该进版本库：前者是变更（以及独立审查）的独立工作副本，后者是流程进度。

## 它替你守住什么

- **分工协作**：不再是单个 AI 从头写到尾、写完自己说没问题。完整模式下，实现、检查、验收、质量审查是彼此分开的角色；精简模式把确定性检查交给开发者执行，再由一个审查者合并复核。
- **每一步都要过校验**：完整模式下，实现完先过工具检查，再走独立验收，最后过多个维度的质量审查，结论不通过就退回修复。流程规则由程序强制——检查没做完、问题没闭环，就不可能以「通过」提交；至于质量判断本身，仍由承担该环节的审查角色给出。
- **问题跟到底**：变更编排里，审查发现的问题会一直挂在变更上，要么修好，要么走豁免流程由报出该问题的审查者裁定通过，否则不允许继续推进。
- **写隔离**：变更在独立分支和独立工作副本里做，收口前你的基准分支上看不到这些改动。
- **中断能接上**：进度记在仓库里，问一句「现在跑到哪了」就能看到；关掉工具、隔一天、换个工具，都能从上次的位置继续。
- **规范驱动**：直接消费 OpenSpec 的提案、规格、设计、任务清单，流程与规范一一对应。

初始化编排时选流程模式，**默认是精简模式**：精简模式把确定性检查交给开发者执行、审查者分级复验，小改动不必走全套；完整模式开头多一道方案预检，验收也拆得更细。

## 内置的规范库

插件自带 22 份 skill（含两个流程入口），装了就有，不用自己写提示词；审查的 AI 会按当前任务需要自动挂上对应的一组。

**两个入口**

- `orchestrator` —— 编排准则，主代理按它分派子代理、推进流程。
- `openspec-standard` —— 提案标准初始化。

**9 份通用规范**：DDD 分层与六边形、REST 接口约定、数据库设计约定、安全审查基线、确定性质量门、技术债识别、架构演进审查、API 自动化测试、隔离环境清理。

**11 份 Java 后端配套**：在通用规范之上补齐 Java / Spring 的实现细节 —— Lombok、日志与命名约定、REST 接口的 Java 实现、MyBatisPlus 与 Flyway、DDD 的 Java 实现与 ArchUnit 规则、Maven / Spotless / PMD / SonarQube 质量门、工具规则改进、Java 开发实践、Java 安全实现、Java 性能与可维护性、Java 技术债形态。

Java 后端项目会自动带上配套那套；其它语言目前只有通用规范生效，具体的构建与检查命令由你项目的规范补充。

## 提案标准化

OpenSpec 官方默认的流程是 `proposal → specs → design → tasks`，给出文档骨架与写作要求。这套标准在它前面加一道澄清与确认关，并把改动范围、契约变更、文档语言钉得更死。

| | OpenSpec 官方 `spec-driven` | 插件提供的 `spec-driven-standard` |
|---|---|---|
| 阶段 | proposal → specs → design → tasks | 最前面多一个 **clarify**（澄清） |
| 需求澄清 | 澄清不强制，靠 explore 用法自行把握 | 决策树逐轮提问，每题附推荐答案；事实类疑问自己查代码，不抛给你 |
| 动笔门禁 | 无 | 疑点问完 + 你确认方案，才允许开始写文档；确认必须文字回复，点选项不算 |
| 改动范围 | proposal 里一句 Impact 描述 | 关联场景清点：把用到这块逻辑的入口、复用链路、数据上下游全列出来，每条附代码位置，逐条跟你确认纳入还是排除；共用逻辑的所有入口必须同一变更里一起改 |
| 契约变更 | 无专门要求 | 逐条列：建表到列（名/类型/可空/默认值/用途）、接口到字段与方法路径、兼容性影响 |
| 文档语言 | 要求 spec 避免类名、函数名 | 方案摘要与实施逻辑也必须用人话，禁止类名、方法名这类代码黑话（契约事实与技术设计文档除外） |
| 任务划分 | 分组 + 每条带验证方式 | 追加：每组必须有真实代码改动（禁止「收尾组」凑数）、测试跟着实现同组、只覆盖本仓库 |
| 归档 | 官方归档命令本身会同步主规格 | 追加写作纪律：主规格只写终态，不留「原 X 改为 Y」；废弃项显式删除并补 REMOVED；同语义合并去重 |

用法：在目标项目的普通会话里调用 `/openspec-standard`（不要在被编排流程占用的会话里调用，那种会话不能改文件）。它会先检查项目有没有 `openspec/` 目录，再把标准写进去。

已经装过标准的项目重跑就是升级：标准更新到插件当前版本，你自己加的规则条目和项目背景会保留。

## 独立审查会话

除了绑定变更的编排，插件也支持不绑定任何变更的独立代码审查：对一个 PR 的改动区间、或整个代码库做一次完整审查。

初始化时说明三件事：

- **审查范围**：`pr`（两个**本地**分支之间的改动区间，远端分支名会被拒）或 `full`（全量代码库）。
- **颗粒度**：`thorough`（工具检查 → 回归验证 → 风格 / 架构 / 性能 / 安全 / 可维护性五个维度的质量审查）或 `simple`（一个审查者合并完成全部检查）。
- **修复策略**：`fix`（发现问题自动修复再重审）或 `none`（只审不修，问题报告本身即交付物）。

审查在独立工作副本里进行。`fix` 模式全部通过后把工作分支合并回目标分支并清理环境；`none` 模式不合并，直接销毁工作环境并按严重级别、维度、文件位置归并给出审查结果。

## 它会往你仓库里写什么

编排流程只碰这几处，全在你的仓库内：

- `openspec/states/` —— 流程进度；
- `.worktree/<变更号>/ws` —— 本次变更的独立工作副本；
- 一条 `change/<变更号>` 分支。

另外两处不在编排流程内：OpenCode 安装方式首次加载会在 `.opencode/agents/` 放三个代理定义文件；调用 `/openspec-standard` 会写 `openspec/config.yaml` 与 `openspec/schemas/spec-driven-standard/`。

变更的全部任务组完成后，才会把这条分支合并回基准分支，随后自动删掉工作副本和分支。合并前如果基准分支已经往前走了，插件先比对两边改动：只有文档、规划文件或版本号这类无害变化时直接合并；有实质冲突时退回做一次收尾回归，通过后才合并。

**中途想放弃**：删掉工作副本和 `change/<变更号>` 分支即可，基准分支上不会留下这个变更的任何代码。

## 适用场景与代价

| | |
|---|---|
| 适合 | 一个变更要真正落进代码库、有验收标准、要过几道检查、过程要能审计，可能跨天甚至跨工具的团队与项目 |
| 代价 | 比单个 AI 直接改更慢，Token 消耗更高 |

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

本项目基于 [OpenSpec](https://github.com/Fission-AI/OpenSpec)（[openspec.sh](https://openspec.sh)）构建 —— 感谢 OpenSpec 团队带来的规范驱动开发方法：先写规范、再写代码，让 AI 开发有据可依。

## 许可证

[MIT](LICENSE) © 2025 ifrankwang
