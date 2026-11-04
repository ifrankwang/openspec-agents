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
 * 过滤规则：skill 声明的 stacks ⊆ 会话 project_stacks 且 frameworks ⊆ 会话 project_frameworks。
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
 * skill 命中规则（过滤层）：skill 声明的形态标签 ⊆ 会话 project_stacks 且框架标签 ⊆ 会话
 * project_frameworks；未声明形态/框架标签的 skill（通用）始终命中。会话未传时由调用方跳过过滤，
 * 不进入本函数。
 */
export function matchesSessionStacks(
  stacks: string[],
  frameworks: string[],
  session: SessionStacks,
): boolean {
  if (stacks.length > 0 && !stacks.every((t) => session.project_stacks.includes(t))) return false
  if (frameworks.length > 0 && !frameworks.every((t) => session.project_frameworks.includes(t))) return false
  return true
}

// ─── 标签存在性词汇（opx_orch_init 动态校验用） ───

let knownTagsOverride: Set<string> | null = null

/**
 * 测试注入：覆盖形态/框架标签存在性词汇（setupWorkspace 注入测试词汇，避免用例依赖真实 skill
 * 文件的声明进度）。null=无注入，词汇取真实 skill 索引的动态并集。
 */
export function __setKnownStackTags(tags: string[] | null): void {
  knownTagsOverride = tags ? new Set(tags) : null
}

/**
 * 当前 skill 索引中所有 skill 声明过的 stacks + frameworks 并集（opx_orch_init 的动态值域，
 * 代码内无硬编码清单）。索引来自 skill frontmatter，新增框架只需在 skill 中声明。
 */
export function knownStackTags(index: SkillTagIndex = scanSkillTags()): Set<string> {
  if (knownTagsOverride) return knownTagsOverride
  const tags = new Set<string>()
  for (const list of index.skillStacks.values()) for (const tag of list) tags.add(tag)
  for (const list of index.skillFrameworks.values()) for (const tag of list) tags.add(tag)
  return tags
}
