---
name: openspec-standard
description: OpenSpec 提案标准初始化与升级——把标准版提案规则（openspec/config.yaml + spec-driven-standard schema 全套）安装到当前项目，统一后续提 change 的质量门槛（关联场景清点、契约变更详列、人话实施逻辑、结构化方案摘要、动笔前访谈与用户确认）。当用户要求初始化、升级或标准化 openspec 提案标准/提案规范时使用。
capabilities: ["openspec-standard"]
---

## 职责

把本 skill 目录 `templates/` 下的标准文件安装到当前项目的 `openspec/` 目录，使该项目此后用 openspec 提 change 时自动遵循统一标准：关联场景清点（共享处理逻辑的变更须与其全部消费入口同一 change 统一适配，同一数据多条落库路径的校验一致性为访谈必问分支）、契约变更详列、实施逻辑人话分步（proposal 单列实施逻辑小节，禁代码级名词）、结构化方案摘要（访谈穷尽后才给出、以普通消息确认）、动笔前访谈门与用户确认门、任务组实质变更主体等。幂等：重跑即把标准升级到插件当前版本，项目自定义内容按下方合并策略保留。

## 前置检查

- 当前项目根不存在 `openspec/` 目录 → 该项目尚未初始化 OpenSpec。提示用户先完成 openspec 初始化（建立 `openspec/` 目录与基础配置）后再执行本 skill，终止。

## 安装/升级流程

1. 读取本 skill 目录 `templates/` 下全部文件。
2. `openspec/config.yaml`：
   - 项目尚无该文件 → 直接写入模板内容；
   - 已存在 → 合并升级：`schema:` 一律改为 `spec-driven-standard`；`context:` 保留项目已有内容（无则用模板内容）；`rules.*` / `operations.*` 各小节中，与标准条目同源的条目替换为模板最新文本，项目自定义条目（模板中不存在的）原样保留并追加在同小节标准条目之后。
3. `openspec/schemas/spec-driven-standard/`：整目录写入（schema.yaml、README.md、`templates/` 下五个文档模板）；该目录为标准自有内容，已存在时直接覆盖。
4. 项目既有其它 schema 目录一律不动（既有 change 的 `.openspec.yaml` 可能引用）；在汇报中说明：确认没有 change 再引用旧 schema 后，可手动删除旧目录。
5. 汇报：本次新建/更新/保留的文件与 config.yaml 条目清单；如项目此前使用其它 schema，说明此后新 change 将使用 spec-driven-standard。

## 约束

- 只允许写 `openspec/config.yaml` 与 `openspec/schemas/spec-driven-standard/` 下的文件，不修改项目其它任何文件。
- 标准文本原样落盘，不自行改写；项目特化约束（技术栈、分层架构、质量门工具等）属于项目 AGENTS.md，不在本 skill 范围。
