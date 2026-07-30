# openspec-orchestrate

## 快速命令

| 命令 | 用途 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查（tsc --noEmit） |

tsconfig.json 已在项目根，typecheck 经 tsc 按其配置严格检查 `src/`。

## 项目目录结构

操作此项目前明确以下目录的职责边界：

| 目录 | 内容 |
|------|------|
| `assets/agents/` | 子代理定义文件（`openspec-*.md`）。技能加载、权限声明、行为约束在此修改。 |
| `assets/skills/` | 项目分发的 skill（供子代理加载），如 `ddd-architecture/SKILL.md`、`api-test/SKILL.md`。扫描遵循 OpenCode 标准发现路径（多个优先级目录），同名 skill 优先取自先扫到的目录。 |
| `.agents/skills/` | 项目内部分析用 skill，如 `openspec-orchestrate-optimizer`。非子代理加载目标。 |
| `src/tools/` | 编排工具实现（`orchestrate.ts` 等）。行为以源码为准。 |
| `tests/` | 测试文件。`bun test` 执行。 |

## 治理原则

### 流程文档职责

AGENTS.md 只记录设计准则、职责边界和协作约束，不记录阶段、工具参数、状态或其他实施细节。README.md 是当前编排流程、角色、工具和状态语义的阅读入口。流程实现、agent 定义与 README 发生冲突时，以工具实现为准，并同步 README。

### 编排流转单一事实源

编排的 next-step（下一步分派谁 / 调用什么工具）由 `opx_status` 工具权威产出。orchestrator agent 定义不得重复描述具体阶段流转顺序，仅描述原则与角色职责边界。工具产出与文档描述之间的冲突以工具为准。

- `openspec-orchestrator.md` 中禁止记录任何具体流程流转相关描述，统一以 `opx_status` 指引为准。
- 除 `opx_status` 外，其他工具返回体不得包含流转方向提示（如"请分派 X"、"进入 Y 阶段"），流转决策一律由 `opx_status` 产出。

### 编排改动须评估全流程连锁影响

编排流转是耦合状态机：阶段状态、各层 completed 标志、issue 状态机、blocking 口径相互依赖。分析、设计、实施任何单点改动（工具参数校验/状态转移/门禁判定/层跳过优化）时，必须沿状态机推演该改动对下游全流程的连锁影响，禁止只验证改动点本身是否自洽。

典型联动链：某层 passed 判定 ↔ 回退 dev 后该层是否被重新唤起 ↔ 遗留 issue 归哪一层裁定 ↔ 各门禁处 blocking issue 的状态集合口径是否一致。局部放宽一处校验若未同步下游判定，常在收尾/复裁环节制造状态机死锁。

### 工具/Agent 二者逻辑必须统一一致

工具与 agent 定义描述的是同一套编排逻辑。修改其中任意一个，必须同步更新另一个。术语、参数名、流程描述、角色职责等必须完全一致。

### 实现先改工具，再同步 agent

所有编排行为以工具实现为准。agent 文档是对工具的说明和指令化封装，不得包含工具未实现的逻辑。

### Agent 定义不含实现细节

agent.md 只描述角色的职责边界和可调用工具，不描述编排流程细节（状态机、状态持久化、重试策略等）。当前编排流程见 README.md。

### Agent 不赘述工具已实现的逻辑

工具代码实现了参数校验、状态转换、维度推导、涉敏逻辑等。agent.md 中不得重复描述这些工具内部行为——子代理调用工具后按工具返回的错误消息处理即可。提示词仅需告知"调用 xxx 工具提交"或"按工具提示实施"，不需要解释工具内部做了什么。

agent doc 禁止枚举/赘述 `opx_status` 的返回内容（字段清单、"返回了 X"、"不会返回 Y"等）。子代理一律"调用 `opx_status` 自取上下文"，文档中不描述返回项。操作指引由 `opx_status` 按角色和阶段动态渲染，agent.md 不得记录操作步骤。

### 子代理上下文不得转述

编排者不得向子代理转述 worktree 路径、执行边界、issue 清单等动态上下文。分派 prompt 仅含分派指令 + 轮次/阶段标识。子代理通过 `opx_status` 按角色自取。

编排者 agent 的调度循环必须包含分派前 prompt 校验作为分派前置条件，确保不转述禁止的动态内容。

注：`change_id`（会话标识）不属于动态上下文，可在分派 prompt 中传递。

### 命名规范

- 所有工具以 `opx_` 前缀注册
- Agent 命名模式：`openspec-{role}`（orchestrator / architect / developer / reviewer-tool / reviewer-task / reviewer-{dim}）
- `opx_status` 按 `context.agent` 路由视图
- orchestrator agent mode=primary，其余 mode=subagent
- orchestrator 权限：`edit/write=deny`，仅允许 `opx_*` 工具和 `git`/`ls`/`find`/`grep` 命令

### review 维度由调用者身份自动推导

`opx_tool_review_submit` / `opx_task_review_submit` / `opx_quality_review_submit` 不接受 `dimension` 参数，维度通过 `DIMENSION_AGENT_MAP` 从 `context.agent` 反查。不允许调用者自行传入维度。`opx_quality_review_submit` 的 5 维 quality reviewer 按调用者身份自动推导，`opx_tool_review_submit` 跨维提交时由工具 reviewer 自行指定 issue 的 `dimension` 字段。

### 豁免按"谁提谁裁定"原则

提出 issue 的角色负责裁定该 issue 的豁免申请。tool review 由 openspec-reviewer-tool 裁定，task review 由 openspec-reviewer-task 裁定，quality review 由对应维度 quality reviewer 裁定。架构师仅以 architecture reviewer 身份通过 `opx_quality_review_submit(exempt_issue_ids=[...])` 裁定自己报的 issue。

### 编排层不涉及被编排 agent 的内部逻辑

orchestrator agent 定义仅描述编排逻辑（分派原则、门禁诊断），不涉及被编排 agent 的审查内容、审查范围、严重级别认定等内部逻辑。这些内容属于各 agent 自身提示词范畴，出现偏差在各 agent 层面修正。

### agent 与技术栈 skill 解耦（单向依赖）

agent 与编排 skill 保持技术栈无关。agent 定义中不得硬编码技术栈名称、构建命令、框架约定、技术栈工具（如 Maven/PMD/ArchUnit）或任何 skill 名；所有 skill 引用须通过 capability tag 动态解析，禁止直接引用 skill 目录名。

agent 只按"能力类别"发起查找：读 available_skills，靠 skill 的 description 语义匹配。找到必加载，找不到则优雅降级并在报告标注。

依赖方向单向为技术栈 skill → agent：反向映射由 skill 的 description/frontmatter 声明（面向哪些 agent、哪个 Phase 生效）。禁止 agent → 具体 skill 的引用。

### 工具产出不得硬编码技术栈

opx_status 视图等工具产出的上下文文本不得硬编码技术栈名称、构建命令、框架约定、技术栈工具（如 Maven/PMD/ArchUnit）或任何 skill 名；skill 引用须通过 capability tag 动态解析。工具产出与 agent.md 内容准则一致，只用"能力类别"语言提示分流优先级与职责；具体技术栈实现方式由 agent 加载的技术栈 skill 指导。

### agent 职责边界清晰，禁止重复职责

agent 之间职责边界必须清晰明确，禁止不同 agent 负责同一职责。发现职责重叠时，合并到单一 agent 或重新划分边界。

### 工具返回体须为 markdown 格式

opx_* 工具返回体必须是 markdown 格式（列表、段落），不得使用 JSON.stringify() 返回纯 JSON。

### 全局避免重复（DRY）

此原则适用于整个项目：相同语义的代码段在 3 个及以上位置复用时必须提炼为共享函数，禁止复制粘贴。agent 文档（`assets/agents/*.md`）等非结构化文本除外。视图渲染（`src/tools/orchestrate/views.ts`）中因各 agent 视图高度同构，阈值降至 2 个及以上，worktree 路径展示、issue 列表渲染等已按此原则抽取。

### Skill 间不得相互引用

Skill 文件中不得引用其他 skill 的名称或目录路径。唯一例外：技术栈 skill 可单向引用其抽象基础 skill（如 `java-quality-gate` 可引用 `quality-gate`，`java-ddd-architecture` 可引用 `ddd-architecture`）。

### Skill 仅为最低基准，非穷举清单

Skill 定义的是该维度的最低审查基线，不限于所列维度。reviewer agent 在加载 skill 后，必须结合 agent 自身领域知识做拓展覆盖，禁止仅检查 skill 中明确列举的规则项。同一维度的未见问题同样须按统一严重级别报 issue。

### Agent 定义职责与约束一致性

同一 `agent.md` 中角色职责描述与行为约束不得矛盾。修改职责或约束任一端时，必须同步审查另一端是否存在冲突。

### Skill 不含编排流程概念

Skill 定义只描述技术/领域规范（格式、目录结构、覆盖标准、认证方式等），不得包含编排流程概念（如"提交 issue"、"等待审批"、"进入下一阶段"）。流程指引由 `opx_status` 视图操作步骤和 agent 职责描述承载。

### 三层职责分离

agent.md 定义角色、工具边界与行为约束，不包含具体执行流程。
opx_status 视图提供动态上下文、skill 加载建议、验证类别清单（不含具体 how）以及步骤顺序（流程控制）。
skill 定义纯领域/技术规范——在不同场景下（新功能开发、Bug 修复、API 测试等）应完成哪些事、遵循什么格式与质量标准。skill 不定义步骤顺序。

三者严禁重叠：同一概念只在一处权威定义。

### Skill 可插拔设计

工具和 agent 对 skill 透明——不硬依赖特定 skill，不引用 skill 目录名或内部具体内容。
Skill 通过 frontmatter 声明 capability 与适用范围；agent 和工具通过 capability tag 匹配。

agent 核心行为约束统一为：遵循所有已加载 skill 的全部规范与约束。新增/删除/替换 skill 后，agent 定义和工具代码无需修改——行为变化仅取决于哪些 skill 被匹配和加载。

Skill 对编排概念无感知——描述中不含 Phase 编号、agent 名、工具名、编排动作（submit/issue/exempt 等）。
Skill 之间的职责边界由各自规范定义。

## 测试

```bash
bun test                    # 全部测试
bun test tests/orchestrate.flow.test.ts  # 单一文件
```

测试通过 `FakeGitRunner`（`tests/helpers.ts`）伪造 Git，零外部依赖。`__setGitRunner()` 注入。

## 同步本地改动到缓存

发布新版本或改完插件代码后，将本地源码同步到 opencode 缓存以生效：

```bash
bun run sync
```

否则 OpenCode 仍加载旧版缓存，导致修改不生效。
