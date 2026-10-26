# openspec-agents

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Built for OpenSpec](https://img.shields.io/badge/built%20for-OpenSpec-6b46c1.svg)

`openspec-agents` 是 [OpenSpec](https://openspec.sh) 的配套插件，兼容 Claude Code / Codex / ZCode / DeepSeek Harness / OpenCode：提案阶段把标准钉得更死（澄清在前、改动范围与契约变更逐条确认），实施阶段由多 Agent 分工——写、查、验收、质量审查各由不同 Agent 担任，按生产级标准把控到收口。

前提：项目正在使用 OpenSpec 管理需求。

| | |
|---|---|
| 适合 | 变更需要真正落进代码库、有验收标准、需通过检查、过程可追溯的团队与项目 |
| 不适合 | 希望快速产出 demo、不走检查与验收的场景 |
| 代价 | 比单个 AI 直接修改更慢，Token 消耗更高 |
| 模型选型 | 实施用 flash 类模型，提案用旗舰模型 |

## 常见痛点

- AI 一次改一大片，改完声称「完成了」——能编译、测试也通过，但其中夹带的空实现与伪成功未被发现。
- 共用逻辑被改动后，其他调用入口仍在使用旧写法，无人察觉。
- 出了问题想复盘，只能翻到大量对话记录，看不出当时按什么标准放行。

## 与工具自带工作流的区别

Claude Code 和 DeepSeek Harness 自带的工作流能力擅长**并行完成大量独立任务**。这个插件解决的是另一件事，两者可以叠加使用。

| | 工具自带的工作流 | 本插件 |
|---|---|---|
| 擅长 | 并行完成大量独立任务 | 单个变更按阶段推进，逐层把关 |
| 如何放行 | 由脚本中的判断决定 | 由程序强制：检查未完成、问题未闭环时无法以「通过」提交 |
| 跨工具 | 各家私有 | 同一套流程跨工具通用 |
| 中断之后 | 进度依附于对话或单次运行 | 进度记录在仓库中，换会话、换工具均可继续 |

一句话：原生工作流负责把任务做完，这个插件负责判定产出是否达到生产级。

## 局限

使用前请先确认以下三条边界。

**存量项目需要一次收敛成本。** 判据按理想状态定义（方法不超过 50 行、类职责单一、核心域不依赖框架、构建产物需忽略、覆盖率需达标），且工具检查覆盖全量代码——存量违规同样按原级别上报并阻塞。存量项目首次运行会暴露大量存量问题，只能逐个修复，或逐个走豁免裁定；裁定通过的会沉淀进项目级清单，后续变更不再重复阻塞。

**Java 之外只有通用规范。** 23 份 skill 中 10 份技术栈无关、11 份为 Java 后端配套（含具体构建与检查命令、ArchUnit 规则、Spotless / PMD / SonarQube 配置）。非 Java 项目审查照常执行，但编译、格式、静态分析、覆盖率这几项确定性检查没有现成命令，需自行补充一份技术栈 skill，否则只能按降级申报跳过。

**架构规范只有 DDD 一套。** 包组织有两种等价的合法风格——四层分层（domain / application / infrastructure / interfaces）与六边形（内核 + 入站 / 出站适配器），采用哪种由项目声明，未声明时按四层认定。不按 DDD 组织的项目（例如 MVC + Service + DAO 直写）没有对应规范，会被判定为偏离规范并报出问题；项目已有自己的架构规范时以项目规范为准，但该规范需自行写入。

## 快速开始

项目还没用 OpenSpec 的话，先装 CLI（初始化由插件代做）：

```bash
npm install -g @fission-ai/openspec
```

在项目里调用 `/openspec-standard` 时，项目还没有 `openspec/` 就会先以 Core Profile 初始化，项目根随即出现 `openspec/` 目录。

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

要求 DSH 0.2.1 及以上。子代理的角色提示词与工具集由 Agent Preset 承载，profile 需包含 web 应用 bundle（`desktop` / `web` 模板都满足）。子代理委派为异步：分派后等完成通知，再继续下一步。

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

### 第二步：确认安装成功

重启后查看可用 skill 列表：`openspec-standard`、`orchestrator` 是插件自带的两个入口，它们和一批规范类 skill 一起出现在列表里，就说明插件已经生效。这些 skill 可以像命令一样唤起（DSH 里输入 `/` 即可看到并调用）。

### 第三步：开始使用

- 项目里还没提变更时，调用 `/openspec-standard`，把提案标准装进项目。
- 提变更用 OpenSpec 官方命令：`/openspec-propose {具体需求描述}`，生成 `openspec/changes/<变更名>/` 下的文档；装过提案标准后，这些文档会按更严的标准产出。
- 然后调用 `/orchestrator {change-id}` 开始编排。`{change-id}` 就是那个目录名，`openspec list` 能看到当前有哪些变更。

> 不同工具里 skill 的呈现形式可能不同，以各工具实际显示为准。

### 默认无人值守

各安装方式**默认都开启无人值守**：流程里需要人拍板的环节（方案怎么选、无法自动验证的部分）由编排 AI 自行决断，不会停下来问你——**审查和门禁照常跑，变的只是「要不要来问你」**。希望它在这些地方先问你，让它关掉无人值守模式即可。

### 将以下两行加入 `.gitignore`

```
.worktree/
openspec/states/
```

两者都不该进版本库：前者是变更（以及独立审查）的独立工作副本，后者是流程进度。

## 提案标准化

OpenSpec 官方默认的流程是 `proposal → specs → design → tasks`，给出文档骨架与写作要求。这套标准在它前面加一道澄清与确认关，并把改动范围、契约变更、文档语言钉得更死。

| | OpenSpec 官方 `spec-driven` | 插件提供的 `spec-driven-standard` |
|---|---|---|
| 阶段 | proposal → specs → design → tasks | 最前面多一个 **clarify**（澄清） |
| 需求澄清 | 澄清不强制，靠 explore 用法自行把握 | 决策树逐轮提问，每题附推荐答案；事实类疑问自己查代码，不抛给你 |
| 动笔门禁 | 无 | 疑点问完 + 你确认方案，才允许开始写文档；确认必须文字回复，点选项不算 |
| 改动范围 | proposal 里一句 Impact 描述 | 关联场景清点：把用到这块逻辑的入口、复用链路、数据上下游全列出来，每条附代码位置，逐条跟你确认纳入还是排除；共用逻辑的所有入口必须同一变更里一起改 |
| 规则边界推演 | 无 | 新增或改动规则、校验、拦截逻辑时，先推演这条规则本身站不站得住：该拦的条件与例外、功能上合法却会被误伤的合法反例（各对应 spec 一条「应当放行」场景）、同一业务意图的等价执行路径与判定挂载点（挂在业务意图层的动作上，不落在被别的流程复用的底层动作上）；变更新增或改了执行路径时，逐条核对既有规则在新路径上是否仍该生效 |
| 契约变更 | 无专门要求 | 逐条列：建表到列（名/类型/可空/默认值/用途）、接口到字段与方法路径、兼容性影响 |
| 文档语言 | 要求 spec 避免类名、函数名 | 方案摘要与实施逻辑也必须用人话，禁止类名、方法名这类代码黑话（契约事实与技术设计文档除外） |
| 任务划分 | 分组 + 每条带验证方式 | 追加：每组必须有真实代码改动（禁止「收尾组」凑数）、测试跟着实现同组、只覆盖本仓库 |
| 归档 | 官方归档命令本身会同步主规格 | 追加写作纪律：主规格只写终态，不留「原 X 改为 Y」；废弃项显式删除并补 REMOVED；同语义合并去重 |

**用法**：在目标项目的普通会话里调用 `/openspec-standard`（不要在被编排流程占用的会话里调用，那种会话不能改文件）。项目还没有 `openspec/` 时，它先以 Core Profile 执行 `openspec init --profile core --tools agents`：建 `openspec/` 骨架，并在 `.agents/skills/` 下生成 propose、explore、apply、update、sync、archive 六个 workflow skill；随后写入 `openspec/config.yaml`（指定 `spec-driven-standard` schema）与 `openspec/schemas/spec-driven-standard/`。

装好之后提变更不必换命令，仍走 OpenSpec 官方用法：调用 `/openspec-propose {具体需求描述}`，生成的 proposal / specs / design / tasks 就会按这套标准产出，再由 `/orchestrator {change-id}` 接手实施与把关。

已经装过标准的项目重跑就是升级：标准更新到插件当前版本，你自己加的规则条目和项目背景会保留。

## 质量把关机制

「生产级」不是靠提示词要求的，而是逐层校验出来的。

**审查分工**

```
完整模式  方案预检 → 实现 → 工具检查 → 独立验收 → 五维质量审查 → 收口
精简模式  实现 → 合并审查 → 收口
```

最终判定不由实现者自己作出。完整模式下，检查、验收、质量审查由彼此独立的角色承担；精简模式由开发者执行确定性检查，再由一名审查者独立复核。

**工具与 AI 的分工**

确定性检查全部交给工具执行：编译、代码格式、架构约束、静态分析、单元测试与覆盖率、深度扫描，以及质量工具配置有没有被弱化。AI 审查只负责工具覆盖不到的部分——业务行为是否真实生效、关键数据是否真的落库、测试断言有没有放水、设计与规则边界是否站得住，并把其中可工具化的发现反过来沉淀成规则。判据锚在 skill 上，不是让模型现场发挥，所以非旗舰模型（flash 类）的产出下限同样有保障。

**通过标准**

- **五级定级**：Critical / High / Medium / Low / Info，各级判例锚定规范 skill；Info 仅为建议，Low 及以上未修复不得推进。
- **问题闭环**：审查报出的问题挂在变更上，修复后由报出该问题的审查者复核通过方为终结；确实无法修复的提交豁免申请，由同一审查者裁定，被驳回则退回重修。
- **程序强制**：检查未完成、问题未闭环时，无法以「通过」提交——由工具拦截，而非依赖提示词约束。
- **禁止规避**：压制注解、关闭规则、修改扫描平台状态一律视为豁免申请，须写明理由并接受裁定；同一问题修复未过两次，须先完成根因分析再修改。
- **规则沉淀**：可由工具检出的问题，要求同时提交业务问题与规则草案，将本次判定口径沉淀为后续的自动拦截规则。

**其他特性**

- **变更隔离**：变更在独立分支与独立工作副本中进行，收口前基准分支上看不到这些改动。
- **可续跑**：进度记录在仓库中，查询当前状态即可恢复；关闭工具、跨天、更换工具都能从上次位置继续。
- **规范驱动**：直接消费 OpenSpec 的提案、规格、设计与任务清单，流程与规范一一对应。

初始化编排时选择流程模式，**默认为精简模式**：精简模式下小改动不必走全套流程；完整模式在开头增加一道方案预检，验收也拆得更细。

## 内置的规范库

插件自带 23 份 skill（含两个流程入口），安装后即可使用，无需自行编写提示词；审查 AI 会按当前任务自动加载对应的一组，作为判据的**最低基准**——审查者还需结合自身领域知识扩展覆盖，不限于清单所列条目。

**两个入口**

- `orchestrator` —— 编排准则，主代理按它分派子代理、推进流程。
- `openspec-standard` —— 提案标准初始化。

**10 份通用规范**：DDD 分层与六边形、REST 接口约定、数据库设计约定、安全审查基线、确定性质量门、测试设计、技术债识别、架构演进审查、API 自动化测试、隔离环境清理。

**11 份 Java 后端配套**：在通用规范之上补齐 Java / Spring 的实现细节 —— Lombok、日志与命名约定、REST 接口的 Java 实现、MyBatisPlus 与 Flyway、DDD 的 Java 实现与 ArchUnit 规则、Maven / Spotless / PMD / SonarQube 质量门、工具规则改进、Java 开发实践、Java 安全实现、Java 性能与可维护性、Java 技术债形态。

Java 后端项目会自动带上配套那套；其它语言目前只有通用规范生效，具体的构建与检查命令由你项目的规范补充。

## 独立审查会话

除了绑定变更的编排，插件也支持不绑定任何变更的独立代码审查：对一个 PR 的改动区间、或整个代码库做一次完整审查。

初始化时说明三件事：

- **审查范围**：`pr`（两个**本地**分支之间的改动区间，远端分支名会被拒）或 `full`（全量代码库）。
- **颗粒度**：`thorough`（工具检查 → 回归验证 → 风格 / 架构 / 性能 / 安全 / 可维护性五个维度的质量审查）或 `simple`（一个审查者合并完成全部检查）。
- **修复策略**：`fix`（发现问题自动修复再重审）或 `none`（只审不修，问题报告本身即交付物）。

审查在独立工作副本里进行。`fix` 模式全部通过后把工作分支合并回目标分支并清理环境；`none` 模式不合并，直接销毁工作环境并按严重级别、维度、文件位置归并给出审查结果。

## 对仓库的写入范围

编排流程只碰这几处，全在你的仓库内：

- `openspec/states/` —— 流程进度；
- `.worktree/<变更号>/ws` —— 本次变更的独立工作副本；
- 一条 `change/<变更号>` 分支。

另外两处不在编排流程内：OpenCode 安装方式首次加载会在 `.opencode/agents/` 放三个代理定义文件；调用 `/openspec-standard` 在项目尚未初始化时先以 Core Profile 建 `openspec/` 骨架并生成 `.agents/skills/` 下六个 workflow skill，再写 `openspec/config.yaml` 与 `openspec/schemas/spec-driven-standard/`。

变更的全部任务组完成后，才会把这条分支合并回基准分支，随后自动删掉工作副本和分支。合并前如果基准分支已经往前走了，插件先比对两边改动：只有文档、规划文件或版本号这类无害变化时直接合并；有实质冲突时退回做一次收尾回归，通过后才合并。

**中途放弃**：删除工作副本与 `change/<变更号>` 分支即可，基准分支不会留下该变更的任何代码。

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
