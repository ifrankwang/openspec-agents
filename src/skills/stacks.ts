import { scanSkillTags, type SkillTagIndex } from "./resolve.ts"

/**
 * 项目栈过滤与值域模型。
 *
 * skill 的 SKILL.md frontmatter 分三个层次：
 * - capabilities：能力维度标签（quality-gate / style / api-testing …），step capability_tags 的匹配维度，
 *   不参与技术栈过滤；
 * - stacks：形态标签，声明 skill 适用的项目形态，未声明 = 通用（所有会话命中）；
 * - frameworks：框架标签，声明 skill 适用的框架，未声明 = 通用（所有会话命中）。
 *
 * 过滤规则（交集语义）：skill 声明某通道的标签（非空）时，要求该通道与会话同通道取值存在交集
 * （声明多值表示「支持其中任一」，不要求全部命中）；未声明该通道标签 = 通用，始终命中。
 *
 * 词汇表（当前存在哪些形态/框架）不作为代码常量维护：过滤与 init 值域校验全部来自 skill 索引的
 * 动态声明，新增/删除 skill 或新增框架只改 skill frontmatter，工具代码无需修改。
 */

/**
 * 会话侧过滤基准：opx_orch_init 两入口必传、随会话状态持久化的项目形态栈与框架栈
 * （与 init 参数同名，避免状态字段与过滤入参两套词汇）。
 */
export interface SessionStacks {
  project_stacks: string[]
  project_frameworks: string[]
}

/**
 * skill 命中规则（过滤层，交集语义）：skill 声明的形态标签与会话 project_stacks 有交集、且声明的
 * 框架标签与会话 project_frameworks 有交集才命中；声明多值表示「支持其中任一」形态/框架。
 * 未声明形态/框架标签的 skill（通用）始终命中。会话未传时由调用方跳过过滤，不进入本函数。
 */
export function matchesSessionStacks(
  stacks: string[],
  frameworks: string[],
  session: SessionStacks,
): boolean {
  if (stacks.length > 0 && !stacks.some((t) => session.project_stacks.includes(t))) return false
  if (frameworks.length > 0 && !frameworks.some((t) => session.project_frameworks.includes(t))) return false
  return true
}

// ─── 标签存在性词汇（opx_orch_init 分字段动态校验用） ───

/** 测试注入的形态/框架值域（与 init 两参数分字段校验对应，结构保持可读）。 */
export interface KnownStackTags {
  stacks: string[]
  frameworks: string[]
}

let knownTagsOverride: KnownStackTags | null = null

/**
 * 测试注入：覆盖形态/框架标签存在性词汇（setupWorkspace 注入测试词汇，避免用例依赖真实 skill
 * 文件的声明进度）。null=无注入，词汇取真实 skill 索引的动态并集。
 */
export function __setKnownStackTags(tags: KnownStackTags | null): void {
  knownTagsOverride = tags ? { stacks: [...tags.stacks], frameworks: [...tags.frameworks] } : null
}

/**
 * 当前 skill 索引中所有 skill 声明过的形态标签（stacks）并集（opx_orch_init 中 project_stacks
 * 的动态值域，代码内无硬编码清单）。索引来自 skill frontmatter，新增形态只需在 skill 中声明。
 */
export function knownStacks(index: SkillTagIndex = scanSkillTags()): Set<string> {
  if (knownTagsOverride) return new Set(knownTagsOverride.stacks)
  const tags = new Set<string>()
  for (const list of index.skillStacks.values()) for (const tag of list) tags.add(tag)
  return tags
}

/**
 * 当前 skill 索引中所有 skill 声明过的框架标签（frameworks）并集（opx_orch_init 中
 * project_frameworks 的动态值域，代码内无硬编码清单）。与形态值域分字段、不混用。
 */
export function knownFrameworks(index: SkillTagIndex = scanSkillTags()): Set<string> {
  if (knownTagsOverride) return new Set(knownTagsOverride.frameworks)
  const tags = new Set<string>()
  for (const list of index.skillFrameworks.values()) for (const tag of list) tags.add(tag)
  return tags
}
