/**
 * 必做清单（must_do）覆盖度门禁与降级理由（skip_reason）结构化解析。
 *
 * 语义：必做清单由 workflow step 声明（step.must_do，按项目形态栈分组），item id 的语义与证据口径由
 * must-do.yaml 词表定义。step 有必做清单时，提交的 must_do_checks 必须逐项覆盖（completed=true 且附
 * 非空 evidence，或 completed=false 且 skip_reason 为合法结构化 JSON）。无必做清单的 step 优雅跳过（不误伤）。
 * 门禁在 implement 与 review 两端生效：implement 只认本轮提交参数（不回落存档）、review 侧同口径。
 * giveup 决策复用同一套未覆盖项推导，要求对未覆盖必做项补充结构化降级理由（checkpoint_skip_reasons），
 * 杜绝「放弃审查 → 直接推进收尾」的无痕绕过通道。
 *
 * skip_reason 结构化格式（JSON 字符串）：
 *   {"item":"<对应必做项>","category":"<降级类别>","adjudication":"user_response|unattended_auto|env_unavailable","note":"<说明>"}
 * adjudication 裁定方式枚举：user_response=用户答复、unattended_auto=无人值守自动降级、
 * env_unavailable=环境不可用（note 须记录尝试）。
 *
 * 必做项申报口径分三类：
 *   ① 工具实跑申报（completed=true + 执行命令与结果摘要）——低成本必做项的默认口径，必须实跑后申报；
 *   ② 高成本核验申报（completed=true + evidence 描述核验方式与抽验样本）——仅限 workflow 指令白名单
 *      限定的高成本必做项（deep_scan），核验 dev 申报并抽验命中项，不重扫全量；
 *   ③ 人工核对申报（completed=true + evidence 记录核对对象与结论）——逐条核对类必做项
 *      （dimension_skill_review）的合法口径：无确定性工具可跑，以逐 skill/逐章节核对记录与
 *      命中/未命中结论作为证据。
 * 覆盖判定只认 step 名 token 命中，不区分三类形态（机制层不拦截口径误用，白名单约束由 workflow
 * 指令与门禁错误提示承载）。例外：词表项 dimension_skill_review 不被 no_change 整体豁免覆盖
 * （见 NO_CHANGE_EXEMPTED_ITEMS），声明整体豁免时仍须单独申报该项。
 */
import { MUST_DO_ALWAYS_KEY } from "../workflow/loader.ts"
import type { StepMustDoGroups } from "../workflow/types.ts"
import type { SessionStacks } from "../../skills/stacks.ts"

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

/** 必做项申报条目（must_do_checks 元素）：step 名首段与必做项 id 对齐。 */
export interface MustDoCheck {
  step: string
  completed: boolean
  evidence?: string
  skip_reason?: string
}

/**
 * 测试注入：按 step 覆盖必做清单分组（返回 undefined 表示不覆盖，仍走 workflow 声明）。
 * 存量测试基建（tests/helpers.ts setupWorkspace）默认注入整体豁免，避免用例逐个依赖真实 workflow 清单；
 * 门禁用例显式注入构造分组或放行真实声明验证。生产路径无注入，恒走 step.must_do。
 */
export type MustDoOverride = (step: { must_do?: StepMustDoGroups } | undefined) => StepMustDoGroups | undefined

let overrideMustDo: MustDoOverride | null = null
export function __setMustDoOverride(fn: MustDoOverride | null): void {
  overrideMustDo = fn
}

/** 测试用整体豁免：任何 step 的生效必做清单为空（等价旧「空索引」的存量用例豁免）。 */
export const EXEMPT_ALL_MUST_DO: MustDoOverride = () => ({ always: [] })

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

/** must_do_checks 的 step 名称归一化：按冒号/括号/空白切出首段，与必做项 id 比对。 */
export function stepToken(name: string): string {
  return name.trim().split(/[:：（(]/)[0].trim()
}

/**
 * step 的生效必做清单（唯一解析入口：门禁 / 视图 / checkpoint 全部复用，禁止各算一遍）。
 * 生效清单 = always 分组 + 会话 project_stacks 命中的栈分组并集（按声明顺序去重）。
 * session 三种取值与 skill 解析层同口径：
 * - 传对象：按会话 project_stacks 过滤，只并入命中的栈分组；
 * - 传 null：旧会话未固化项目栈——只取 always（技术栈分组一律不并入）；
 * - 不传（undefined）：无会话上下文（静态校验/单测），always + 全部分组。
 */
export function resolveStepMustDo(
  step: { must_do?: StepMustDoGroups } | undefined,
  session?: SessionStacks | null,
): string[] {
  const effective = overrideMustDo ? overrideMustDo(step) : step?.must_do
  const groups = effective
  if (!groups) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (ids: string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  push(groups[MUST_DO_ALWAYS_KEY] ?? [])
  for (const [key, ids] of Object.entries(groups)) {
    if (key === MUST_DO_ALWAYS_KEY) continue
    if (session === null) continue
    if (session && !session.project_stacks.includes(key)) continue
    push(ids ?? [])
  }
  return out
}

/**
 * 全量豁免声明 token：step 名首段为该 token 的 must_do_checks 条目声明本轮整体豁免必做清单。
 * 与 task.yaml verify_tool 无变更直提 / 注释性变更免全量分支对应（避免免全量直提被门禁误伤）。
 * review 侧凭声明豁免；implement 侧另有 no_code_change 事实核对（见 submit 的 diff 校验）。
 */
export const NO_CHANGE_TOKEN = "no_change"

/**
 * 不被 no_change 整体豁免覆盖的必做项：无代码变更直提（或注释/文档性变更免全量）时，
 * 这些项的核对对象依然存在（如已加载规范对既有代码的核对不依赖本轮 diff），声明整体豁免时
 * 仍须逐项单独申报（completed=true + 核对结论，或 completed=false + 合法结构化 skip_reason）。
 */
export const NO_CHANGE_EXEMPTED_ITEMS = ["dimension_skill_review"] as const

/** 申报是否含 no_change 整体豁免声明（覆盖度豁免 / implement 侧 diff 事实核对共用同一判定）。 */
export function hasNoChangeDeclaration(checks: MustDoCheck[] | undefined): boolean {
  return (checks ?? []).some((c) => stepToken(c.step) === NO_CHANGE_TOKEN)
}

/** 返回 must_do_checks 未覆盖的必做项（step 名称首段命中即视为覆盖；无必做清单返回空数组）。 */
export function uncoveredMustDo(
  step: { must_do?: StepMustDoGroups } | undefined,
  checks: MustDoCheck[] | undefined,
  session?: SessionStacks | null,
): string[] {
  const must = resolveStepMustDo(step, session)
  if (must.length === 0) return []
  const list = checks ?? []
  // 全量豁免声明：无代码/配置变更直提、或经审查确认仅注释/文档性变更免全量时，
  // 以一条 step 名首段为该 token 的条目声明整体豁免必做清单（completed=false +
  // 合法结构化 skip_reason，说明判定依据）；其余场景仍逐项申报。
  // 豁免不覆盖 NO_CHANGE_EXEMPTED_ITEMS 中的核对类项——这些项的核对对象不依赖本轮变更，
  // 声明整体豁免时仍须单独申报。
  if (hasNoChangeDeclaration(list)) return uncoveredUnderNoChange(must, list)
  const covered = new Set<string>()
  for (const c of list) {
    const token = stepToken(c.step)
    if (must.includes(token)) covered.add(token)
  }
  return must.filter((m) => !covered.has(m))
}

/** 某 step 的必做项申报存档读取（metadata.must_do_checks_by_step[stepId]）：
 *  门禁（giveup 侧）与视图（证据锚点）共用的唯一读取入口。 */
export function mustDoChecksOfStep(metadata: Record<string, unknown>, stepId: string): MustDoCheck[] {
  const raw = metadata["must_do_checks_by_step"]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return []
  const list = (raw as Record<string, unknown>)[stepId]
  return Array.isArray(list) ? (list as MustDoCheck[]) : []
}

/**
 * no_change 整体豁免下的剩余必做项：整体豁免不覆盖 NO_CHANGE_EXEMPTED_ITEMS 中的核对类项，
 * 这些项要么在 must_do_checks 中单独申报（step 名首段命中即视为覆盖），要么列入未覆盖返回。
 */
function uncoveredUnderNoChange(must: string[], list: MustDoCheck[]): string[] {
  const covered = new Set<string>()
  for (const c of list) {
    const token = stepToken(c.step)
    if (NO_CHANGE_EXEMPTED_ITEMS.includes(token as never)) covered.add(token)
  }
  return must.filter((m) => NO_CHANGE_EXEMPTED_ITEMS.includes(m as never) && !covered.has(m))
}

/**
 * 校验 must_do_checks 每条申报的完成口径：completed=true 必须附非空 evidence；
 * completed=false 必须带合法结构化 skip_reason。不合法即抛错（中文，指明条目与原因）。
 * 与是否有必做清单无关——显式申报即受格式约束，避免「申报了但无证据」的空转。
 */
export function assertMustDoChecksFormat(checks: MustDoCheck[]): void {
  for (const c of checks) {
    if (c.completed) {
      if (typeof c.evidence !== "string" || c.evidence.trim() === "") {
        throw new Error(
          `必做项 "${stepToken(c.step)}" 标记为已完成但未提供证据（evidence）。` +
          `completed=true 的申报必须附执行命令与结果摘要，未执行的项请置 completed=false 并附结构化 skip_reason。`
        )
      }
      continue
    }
    if (!c.skip_reason) {
      throw new Error(`必做项 "${stepToken(c.step)}" 标记为未完成但未提供跳过原因（skip_reason）。`)
    }
    const parsed = parseSkipReason(c.skip_reason)
    if (!parsed.ok) {
      throw new Error(`必做项 "${stepToken(c.step)}" 的 skip_reason 格式不合法：${parsed.error}`)
    }
  }
}

/**
 * 必做清单覆盖度门禁（implement / review 双端共用）：先校验申报格式，再校验生效必做项逐项覆盖。
 * - requiredItems 为当前 step 的生效清单（resolveStepMustDo 产出，调用方按会话项目栈传入）；
 * - requiredItems 为空 → 只校验申报格式（无清单的 step 不设覆盖门槛，不误伤）；
 * - 含 no_change 整体豁免声明 → 豁免清单内必做项（豁免事实核对由调用方按 diff 能力执行），
 *   但 NO_CHANGE_EXEMPTED_ITEMS 中的核对类项不被豁免，仍须单独申报。
 */
export function assertMustDoCoverage(requiredItems: string[], checks: MustDoCheck[] | undefined): void {
  const list = checks ?? []
  assertMustDoChecksFormat(list)
  if (requiredItems.length === 0) return
  if (hasNoChangeDeclaration(list)) {
    const missing = uncoveredUnderNoChange(requiredItems, list)
    if (missing.length === 0) return
    throw new Error(
      `no_change 整体豁免不覆盖以下核对类必做项（其核对对象不依赖本轮变更）：${missing.join("、")}。\n` +
      `请逐项单独申报：completed=true 附核对对象与结论记录，或 completed=false + 合法结构化 skip_reason ` +
      `（格式：${SKIP_REASON_FORMAT}）。`,
    )
  }
  const covered = new Set<string>()
  for (const c of list) {
    const token = stepToken(c.step)
    if (requiredItems.includes(token)) covered.add(token)
  }
  const missing = requiredItems.filter((m) => !covered.has(m))
  if (missing.length === 0) return
  throw new Error(
    `提交的必做项申报未覆盖本 step 的必做清单，缺少以下必做项：${missing.join("、")}。\n` +
    `请按本 step 必做清单逐项执行并逐项申报结果（completed=true + evidence）；` +
    `确实无法执行的必做项须以 completed=false + 结构化 skip_reason 申报降级理由` +
    `（格式：${SKIP_REASON_FORMAT}）。` +
    `申报口径分三类：工具实跑申报（低成本项必须实跑后申报）、核验申报（仅限 workflow 指令白名单限定的` +
    `高成本必做项，附核验方式与抽验样本）、人工核对申报（核对类必做项，附核对对象与结论记录）。`
  )
}
