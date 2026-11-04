import { scanSkillTags } from "./resolve.ts"

/**
 * 项目栈识别标签模型（形态/框架标签分类与过滤）。
 *
 * skill 的 capabilities 标签分三类：
 * - 能力维度标签（quality-gate / style / api-testing / …）：step capability_tags 的匹配维度，
 *   不参与技术栈过滤；
 * - 形态标签（FORM_TAGS）：声明 skill 适用的项目形态（backend / frontend），
 *   会话 project_stacks 必须覆盖；
 * - 框架标签（FRAMEWORK_TAGS）：声明 skill 适用的框架（java / vue / react），
 *   会话 project_frameworks 必须覆盖。
 *
 * 兼容约定：skill 未声明形态/框架标签（含旧 tech-stack-* 前缀标签）视为通用，始终命中——
 * 标签迁移到 skill 文件前（tech-stack-java 仍存在于 frontmatter），过滤逻辑对旧标签按
 * 通用处理，保证迁移期行为不回归。
 *
 * FORM_TAGS / FRAMEWORK_TAGS 是标签模型的分类词汇表（新增形态/框架时在此扩展），
 * 与「工具产出不得硬编码技术栈」不冲突：工具产出文本不含技术栈名，具体栈值由
 * opx_orch_init 入参与 skill frontmatter 动态声明，本清单只负责把标签归类到正确过滤通道。
 */

/** 形态标签词汇表：声明 skill 适用的项目形态。 */
export const FORM_TAGS = ["backend", "frontend"] as const

/** 框架标签词汇表：声明 skill 适用的框架。 */
export const FRAMEWORK_TAGS = ["java", "vue", "react"] as const

const FORM_TAG_SET = new Set<string>(FORM_TAGS)
const FRAMEWORK_TAG_SET = new Set<string>(FRAMEWORK_TAGS)

/** skill 标签按过滤通道拆分：形态标签 / 框架标签（能力维度标签与其余历史标签不在其中，按通用处理）。 */
export function splitSessionTags(tags: string[]): { formTags: string[]; frameworkTags: string[] } {
  return {
    formTags: tags.filter((t) => FORM_TAG_SET.has(t)),
    frameworkTags: tags.filter((t) => FRAMEWORK_TAG_SET.has(t)),
  }
}

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
 * project_frameworks；未声明形态/框架标签的 skill（通用）始终命中。会话未传（旧会话无固化
 * 项目栈）时由调用方跳过过滤，不进入本函数。
 */
export function matchesSessionStacks(tags: string[], session: SessionStacks): boolean {
  const { formTags, frameworkTags } = splitSessionTags(tags)
  if (formTags.length > 0 && !formTags.every((t) => session.project_stacks.includes(t))) return false
  if (frameworkTags.length > 0 && !frameworkTags.every((t) => session.project_frameworks.includes(t))) return false
  return true
}

// ─── 标签存在性词汇（opx_orch_init 动态校验用） ───

let knownTagsOverride: Set<string> | null = null

/**
 * 测试注入：覆盖标签存在性词汇（setupWorkspace 注入测试标准栈/框架集合，避免依赖真实
 * skill 文件的标签迁移进度）。null=无注入，词汇取真实 skill 索引的 capabilities 全集。
 */
export function __setKnownSkillTags(tags: string[] | null): void {
  knownTagsOverride = tags ? new Set(tags) : null
}

/** 当前 skill 索引中实际存在的标签全集（动态校验值域，无硬编码清单）。 */
export function knownSkillTags(): Set<string> {
  if (knownTagsOverride) return knownTagsOverride
  const tags = new Set<string>()
  for (const list of scanSkillTags().tagMap.keys()) tags.add(list)
  return tags
}
