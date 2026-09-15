# OpenSpec Schema: spec-driven-standard

通用 spec-driven 工作流模板：clarify → proposal → specs → design → tasks，
增强三点：
1. **clarify 前置门槛 + 关联场景清点**：每次变更先做需求澄清与关联场景清点
   （枚举变更触及能力的全部消费方——功能入口 / 共享处理逻辑 / 数据流下游，
   附代码证据；共享处理逻辑变更须与其全部消费入口同一 change 统一适配）；
   访谈结束后、写任何文档之前，主代理必须先向用户简单直接汇报方案（一句话
   讲清做什么 + 是否动契约 + 取舍 + 影响面）并取得用户明确确认（HARD-GATE，
   访谈中的问答不视为确认），确认记录落在 clarify.md，后续文档不得偏离。
2. **主代理访谈直录 + 分级撰写 + 独立复核循环**：主代理亲自访谈，问答
   直接记入 clarify.md（访谈阶段唯一落笔的文档，不设独立访谈文件）；
   架构方向经用户确认后，按复杂度分级产出其余文档（proposal → specs →
   design → tasks，不逐文档分派）——简单变更由主代理本人按依赖顺序撰写
   （省 token），复杂变更派发唯一一个独立生成子代理在同一会话内撰写（保
   主代理上下文精简），分级判定与理由记入 clarify.md；无论哪级，主代理
   必须派发独立复核子代理全量检查（结构校验 + 规则核对 + 与主 spec 交叉
   核对），发现问题由主代理本人修复后再次复核，循环最多 3 轮，复核干净
   通过（PASS）才算完成。完整三阶段编排契约写在 clarify 的 instruction
   里——这是主代理必读的一份，复核派发由此可达；复杂变更的生成子代理
   最终汇报必须提示主代理进入复核阶段，双保险防契约断链。
3. **自包含方法论**：决策树逐轮访谈（frontier 机制）全文内联在 clarify
   instruction 的 Methodology 节，不依赖任何外部 skill。

## 目录

```
openspec/schemas/<schema-name>/
├── schema.yaml    # 流程与文档结构定义（纯通用，无项目内容）
├── templates/     # 各文档模板（纯通用）
└── README.md      # 本说明
```

配套文件（一并安装）：项目根 `openspec/config.yaml`（通用流程规则）。

## 接入新项目

**方式一（推荐，插件一键初始化）**：安装了 openspec-agents 插件的 AI 编码
工具中，在目标项目的常规主代理会话里说一句「初始化 openspec 提案标准」，
即自动写入本 schema 目录与配套 `openspec/config.yaml`；已初始化的项目重跑
即升级到最新标准（项目自定义 rules 条目与 context 保留）。

**方式二（手动回退，无插件环境）**：
1. 把本目录整体 copy 到新项目 `openspec/schemas/spec-driven-standard/`。
2. 把通用版 `openspec/config.yaml` copy 到新项目，确认 `schema:` 指向
   `spec-driven-standard`。
3. 在新项目 `AGENTS.md` 中写清项目特化约束（见下节），并确认每次变更的
   `.openspec.yaml` 的 `schema:` 字段指向正确。

> 生成子代理（复杂变更时）与复核子代理会被指示读取项目 `AGENTS.md` 与
> `openspec/config.yaml`，因此项目特化约束写在 `AGENTS.md` 即可自动生效，
> schema 本身无需改动。

## 项目特化约束清单（写进 AGENTS.md 的内容）

| 类别 | 示例 |
|---|---|
| 技术栈 | 语言/框架/版本、构建工具、依赖管理 |
| 分层架构 | 分层/包组织、依赖方向、层间规则 |
| 领域约定 | 确定性 vs 不确定性分工、领域模型规范 |
| 数据库约定 | 表前缀、主键策略、审计字段、逻辑删除、迁移方式 |
| 质量门 | 格式/静态检查工具、测试策略、覆盖率门槛 |
| 方法论 | 澄清/评审/开发流程约定（如 TDD） |

## 三层分工（不重复原则）

| 位置 | 承载内容 | 例子 |
|---|---|---|
| `schema.yaml` instruction | 生成方法论与文档格式要求（官方方法论为底） | 场景标题 4 个 #、SHALL/MUST、ADDED/MODIFIED/REMOVED、任务组格式、每组自带测试与质量门、关联场景清点维度 |
| `openspec/config.yaml` rules | **仅** schema 未覆盖的项目补充规则 | MODIFIED 终态契约表述、同语义一条需求、前置 change 标注格式、契约变更详列、访谈门与用户确认门 |
| 项目 `AGENTS.md` | 项目特化约束 | 技术栈、分层架构、数据库约定、质量门工具、方法论 |

同一规则只写一处：config.yaml rules 不重复 schema instruction 已有内容；
schema 不写项目专属内容。新增规则时先查上一层的 instruction 是否已覆盖。

官方升级 `openspec update` 会覆盖 `.agents/skills/` 下的 skill，本 schema
与 config.yaml 不受影响；CLI 升级后可重新对齐官方 `spec-driven`
（`openspec schema fork`）再叠加本模板的增强段落。
