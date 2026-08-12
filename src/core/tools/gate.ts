/**
 * 质量门必做清单（must_do）覆盖度门禁与降级理由（skip_reason）结构化解析。
 *
 * 语义：skill 在 frontmatter 声明机器可读的 must_do 必做清单后，review 提交（verify_tool）的
 * validation_steps 必须逐项覆盖（completed=true，或 completed=false 且 skip_reason 为合法结构化
 * JSON）。未声明 must_do 的 skill 与解析不到质量门 skill 的 step 优雅跳过（不误伤非质量门 step）。
 * giveup 决策复用同一套未覆盖项推导，要求对未覆盖必做项补充结构化降级理由（checkpoint_skip_reasons），
 * 杜绝「放弃审查 → 直接推进收尾」的无痕绕过通道。
 *
 * skip_reason 结构化格式（JSON 字符串）：
 *   {"item":"<对应必做项>","category":"<降级类别>","adjudication":"user_response|unattended_auto|env_unavailable","note":"<说明>"}
 * adjudication 裁定方式枚举：user_response=用户答复、unattended_auto=无人值守自动降级、
 * env_unavailable=环境不可用（note 须记录尝试）。
 */
import {
  scanSkillTags,
  resolveSkillsForCapabilities,
  getSkillMustDo,
  type SkillTagIndex,
} from "../../skills/resolve.ts"

/** 裁定方式枚举：用户答复 / 无人值守自动降级 / 环境不可用（须附尝试记录）。 */
export const SKIP_REASON_ADJUDICATIONS = ["user_response", "unattended_auto", "env_unavailable"] as const
export type SkipAdjudication = (typeof SKIP_REASON_ADJUDICATIONS)[number]

/**
 * 结构化降级声明的标准格式（skip_reason / checkpoint_skip_reasons 共用）。
 * 全链路（schema 描述 / 视图指引 / 错误提示）以本常量保证术语与格式一致。
 */
export const SKIP_REASON_FORMAT =
  '{"item":"<对应必做项>","category":"<降级类别>","adjudication":"user_response|unattended_auto|env_unavailable","note":"<说明>"}'

/** 结构化降级声明：item 对应必做项，category 为降级类别，adjudication 为裁定方式。 */
export interface SkipReasonData {
  item: string
  category: string
  adjudication: string
  note?: string
}

/**
 * 测试注入：覆盖门禁使用的 skill 索引。
 * 存量测试基建（tests/helpers.ts setupWorkspace）默认注入空索引以豁免门禁（解析不到质量门 skill），
 * 新增门禁用例显式注入构造索引或真实索引（scanSkillTags()）验证。null=无注入，走真实文件扫描。
 */
let overrideIndex: SkillTagIndex | null = null
export function __setMustDoIndex(index: SkillTagIndex | null): void {
  overrideIndex = index
}

/** 空 skill 索引：任何 capability 都解析不到 skill（门禁豁免用）。 */
export const EMPTY_MUST_DO_INDEX: SkillTagIndex = {
  tagMap: new Map(),
  skillTags: new Map(),
  skillMustDo: new Map(),
}

function currentIndex(): SkillTagIndex {
  return overrideIndex ?? scanSkillTags()
}

/** 判断对象是否为合法结构化降级声明（item/category/adjudication 三要素齐全）。 */
export function isValidSkipData(data: unknown): data is SkipReasonData {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false
  const d = data as Record<string, unknown>
  if (typeof d.item !== "string" || d.item.trim().length === 0) return false
  if (typeof d.category !== "string" || d.category.trim().length === 0) return false
  if (
    typeof d.adjudication !== "string" ||
    !(SKIP_REASON_ADJUDICATIONS as readonly string[]).includes(d.adjudication)
  ) return false
  return true
}

/** 解析结构化 skip_reason 文本（JSON 字符串）；格式不合法返回错误说明。 */
export function parseSkipReason(
  reason: string,
): { ok: true; data: SkipReasonData } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(reason)
  } catch {
    return {
      ok: false,
      error:
        `skip_reason 必须为结构化 JSON 字符串：${SKIP_REASON_FORMAT}。当前值无法解析为 JSON：${reason}`,
    }
  }
  if (!isValidSkipData(parsed)) {
    return {
      ok: false,
      error:
        `skip_reason 结构化字段缺失或不合法：必须包含非空 item（对应必做项）、category（降级类别）、` +
        `adjudication（裁定方式，取值 ${SKIP_REASON_ADJUDICATIONS.join(" / ")}）。当前值：${reason}`,
    }
  }
  return { ok: true, data: parsed }
}

/** validation_steps 的 step 名称归一化：按冒号/括号/空白切出首段，与 must_do 枚举比对。 */
function stepToken(name: string): string {
  return name.trim().split(/[:：（(]/)[0].trim()
}

/** 按 capability_tags 解析出所有命中 skill 声明 must_do 的合并集合（去重、保持声明顺序）。 */
export function resolveMustDoForCaps(caps: string[] | undefined, index?: SkillTagIndex): string[] {
  const idx = index ?? currentIndex()
  const { skillNames } = resolveSkillsForCapabilities(caps, idx)
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of skillNames) {
    for (const item of getSkillMustDo(name, idx) ?? []) {
      if (seen.has(item)) continue
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/** 返回 validation_steps 未覆盖的必做项（step 名称首段命中即视为覆盖；无必做清单返回空数组）。 */
export function uncoveredMustDo(
  caps: string[] | undefined,
  validationSteps: Array<{ step: string; completed: boolean; skip_reason?: string }> | undefined,
  index?: SkillTagIndex,
): string[] {
  const must = resolveMustDoForCaps(caps, index)
  if (must.length === 0) return []
  const steps = validationSteps ?? []
  // 全量豁免声明：无代码/配置变更直提、或经审查确认仅注释/文档性变更免全量时，
  // review 以一条 step 名首段为该 token 的条目声明整体豁免必做清单（completed=false +
  // 合法结构化 skip_reason，说明判定依据）；其余场景仍逐项申报。
  if (steps.some((s) => stepToken(s.step) === NO_CHANGE_TOKEN)) return []
  const covered = new Set<string>()
  for (const s of steps) {
    const token = stepToken(s.step)
    if (must.includes(token)) covered.add(token)
  }
  return must.filter((m) => !covered.has(m))
}

/**
 * 全量豁免声明 token：step 名首段为该 token 的 validation_steps 条目声明本轮整体豁免必做清单。
 * 与 task.yaml verify_tool 无变更直提 / 注释性变更免全量分支对应（避免免全量直提被门禁误伤）。
 */
export const NO_CHANGE_TOKEN = "no_change"

/**
 * 校验 validation_steps 中每条未完成项必须携带合法结构化 skip_reason（升级既有「非空即可」校验）。
 * 不合法即抛错（中文，指明步骤与原因）。
 */
export function assertStructuredSkipReasons(
  validationSteps: Array<{ step: string; completed: boolean; skip_reason?: string }>,
): void {
  for (const s of validationSteps) {
    if (s.completed) continue
    if (!s.skip_reason) {
      throw new Error(`验证步骤 "${s.step}" 标记为未完成但未提供跳过原因（skip_reason）。`)
    }
    const parsed = parseSkipReason(s.skip_reason)
    if (!parsed.ok) {
      throw new Error(`验证步骤 "${s.step}" 的 skip_reason 格式不合法：${parsed.error}`)
    }
  }
}
