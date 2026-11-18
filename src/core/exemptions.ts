import path from "path"
import { mkdirSync, writeFileSync, renameSync } from "node:fs"
import { readFile } from "node:fs/promises"
import type { WorkItem } from "./workflow/types.ts"
import { resolveChildIssueFields } from "./workflow/reset.ts"
import { getStateDir, resolveStateRoot, acquireLock, releaseLock } from "./state.ts"
import type { Dimension, ReviewLayer } from "./types.ts"

/**
 * 项目级跨 change 豁免清单（跨 change 共享，写主仓库根的状态目录）。
 *
 * 痛点背景：worktree 模式下每个新 change 是全新状态账本 + 全新扫描平台项目，tool review 全量扫描
 * 会把存量已裁定豁免的安全问题重新报为阻塞 issue，dev 每轮重新豁免。此模块把「裁定认可（dismissed）」
 * 的豁免结论落为 (rule+file+line) 清单，后续 change 的 review 提报命中清单时直接抑制（丢弃、不入库），
 * 不再重复打扰。
 *
 * 设计约束（AGENTS.md）：
 * - 持久化归属工具/状态层，匹配语义归属 skill 层，展示归属视图层；
 * - 并发安全：专用锁（exemptions.lock 目录锁）包住读-改-写，不能用 per-change 的 review 锁；
 * - 原子写：临时文件 + rename 覆盖，防崩溃损坏共享清单；
 * - key 构造只在此定义（DRY），rule 缺失时宁漏勿误（不匹配、不写清单）。
 */

export const EXEMPTIONS_FILE = "exemptions.json"
export const EXEMPTIONS_LOCK = "exemptions.lock"
export const EXEMPTIONS_SCHEMA_VERSION = 1
/** 历史存量 issue 的命中标记键（旧降级逻辑写入 child.metadata，供视图统计与标注；新报不再写入，不参与匹配）。 */
export const EXEMPTED_HIT_KEY = "exempted_hit"

export interface ExemptionRecord {
  key: string
  rule?: string
  file?: string
  /** 路径 glob（如 `src/generated/**`）：豁免覆盖「这一类路径」，与 file 精确匹配互补。 */
  pathPattern?: string
  /** 一组规则键：豁免覆盖「这一组规则」，与 rule 单条规则互补。 */
  ruleKeys?: string[]
  line?: number
  sourcePhase: ReviewLayer
  dimension: Dimension
  severity: string
  description: string
  exemptedAt: string
  exemptedBy: string
  changeId: string
}

export interface ExemptionStore {
  version: number
  items: ExemptionRecord[]
}

/** 豁免匹配用的问题字段（issue child metadata 或其投影）。 */
export interface ExemptionTarget {
  rule?: string
  file?: string
  line?: number
  pathPattern?: string
  ruleKeys?: string[]
}

/** 豁免 key 单一事实源：rule+file+line 拼接。rule 缺失时返回 null（宁漏勿误：不匹配、不写清单）。 */
export function exemptionKeyOf(rule: string | undefined, file: string, line: number): string | null {
  if (rule === undefined || rule === "") return null
  return [rule, file, line].join("\u0000")
}

/** 规则键归一：去重、去空、排序（key 与匹配都基于同一份归一结果）。 */
function normalizeRuleKeys(keys: readonly string[] | undefined): string[] {
  if (!keys) return []
  return [...new Set(keys.map((k) => k.trim()).filter((k) => k !== ""))].sort()
}

/**
 * 豁免记录 key：无 path_pattern / rule_keys 时沿用旧三元组 key（存量记录零迁移）；
 * 带路径模式或规则键时使用独立 key 空间，由各匹配维度内容拼成。
 */
export function exemptionRecordKeyOf(target: ExemptionTarget): string | null {
  const pathPattern = target.pathPattern?.trim() ?? ""
  const ruleKeys = normalizeRuleKeys(target.ruleKeys)
  if (pathPattern === "" && ruleKeys.length === 0) {
    return exemptionKeyOf(target.rule, target.file ?? "", target.line ?? 0)
  }
  const rule = target.rule ?? ""
  return ["pattern", pathPattern, ruleKeys.join(","), rule, target.file ?? "", target.line ?? 0].join("\u0000")
}

/**
 * 仓库相对路径 glob 匹配：支持 `**`（跨目录）、`*`（单段内）、`?`（单字符），
 * 双星号后接斜杠可匹配零层目录（如 `src/**` + `/*.ts` 匹配 `src/a.ts`）。反斜杠统一按 `/` 归一。
 */
export function pathMatchesGlob(pattern: string, target: string): boolean {
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "")
  const t = target.replace(/\\/g, "/").replace(/^\.\//, "")
  return globToRegExp(p).test(t)
}

function globToRegExp(pattern: string): RegExp {
  let out = "^"
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++
        if (pattern[i + 1] === "/") {
          i++
          out += "(?:.*/)?"
        } else {
          out += ".*"
        }
      } else {
        out += "[^/]*"
      }
    } else if (ch === "?") {
      out += "[^/]"
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`${out}$`)
}

/** 是否声明了「配置抑制」意图：带路径模式或规则键（用于配置↔豁免双向核对）。 */
export function isSuppressionIntent(record: ExemptionRecord): boolean {
  return (record.pathPattern ?? "") !== "" || normalizeRuleKeys(record.ruleKeys).length > 0
}

/**
 * 豁免匹配单一事实源（降级、视图提示、配置核对共用，禁止各处另写一份判断）：
 * - 路径维度：记录带 path_pattern 时按 glob 匹配 issue.file；否则按 file 精确相等；
 * - 规则维度：记录 rule 等于 issue.rule，或落在 issue.rule_keys；issue.rule 落在记录 rule_keys；两组规则键有交集；
 * - 行号：记录带 line（>0）时要求相等，路径模式豁免不带 line 视为整文件/整类命中；
 * - 记录声明了哪个维度就要求该维度命中，多个维度同时声明时全部命中（AND）。
 */
export function matchesExemption(issue: ExemptionTarget, record: ExemptionRecord): boolean {
  const recordKeys = normalizeRuleKeys(record.ruleKeys)
  const hasPathDimension = (record.pathPattern ?? "") !== "" || record.file !== undefined
  const hasRuleDimension = (record.rule ?? "") !== "" || recordKeys.length > 0
  if (!hasPathDimension && !hasRuleDimension) return false

  // 旧精确三元组（无 path_pattern / rule_keys）保留原语义：line 一律要求相等（含 line=0）；
  // 路径模式 / 规则键记录才把 line=0 或缺省视为整文件、整类命中。
  const isPatternRecord = (record.pathPattern ?? "") !== "" || recordKeys.length > 0

  if (hasPathDimension) {
    const issueFile = issue.file ?? ""
    const recordPattern = record.pathPattern ?? ""
    if (recordPattern !== "") {
      if (issueFile === "" || !pathMatchesGlob(recordPattern, issueFile)) return false
    } else if (issueFile !== (record.file ?? "")) {
      return false
    }
    if (record.line !== undefined && (!isPatternRecord || record.line > 0) && issue.line !== record.line) return false
  }

  if (hasRuleDimension) {
    const issueRule = issue.rule ?? ""
    const issueKeys = normalizeRuleKeys(issue.ruleKeys)
    const recordRule = record.rule ?? ""
    const ruleHit =
      (issueRule !== "" && (issueRule === recordRule || recordKeys.includes(issueRule))) ||
      (recordRule !== "" && issueKeys.includes(recordRule)) ||
      recordKeys.some((k) => issueKeys.includes(k))
    if (!ruleHit) return false
  }
  return true
}

/** 从工作项 metadata 提取豁免匹配字段（与 buildExemptionRecord 读取同一组 metadata 键）。 */
export function exemptionTargetOfChild(child: WorkItem): ExemptionTarget {
  const f = resolveChildIssueFields(child)
  const rawKeys = child.metadata["rule_keys"]
  return {
    rule: typeof child.metadata["rule"] === "string" ? child.metadata["rule"] : undefined,
    file: f.file,
    line: f.line,
    pathPattern: typeof child.metadata["path_pattern"] === "string" ? child.metadata["path_pattern"] : undefined,
    ruleKeys: Array.isArray(rawKeys) ? rawKeys.filter((k): k is string => typeof k === "string") : undefined,
  }
}

function emptyStore(): ExemptionStore {
  return { version: EXEMPTIONS_SCHEMA_VERSION, items: [] }
}

async function exemptionsDir(worktree: string): Promise<string> {
  const root = await resolveStateRoot(worktree)
  return getStateDir(root)
}

/** 读取跨 change 豁免清单。文件缺失/损坏返回空清单；写侧原子写保证读到完整文件，读不持锁。 */
export async function readExemptions(worktree: string): Promise<ExemptionStore> {
  const fp = path.join(await exemptionsDir(worktree), EXEMPTIONS_FILE)
  try {
    const parsed = JSON.parse(await readFile(fp, "utf-8")) as Partial<ExemptionStore>
    if (parsed && Array.isArray(parsed.items)) {
      return { version: parsed.version ?? EXEMPTIONS_SCHEMA_VERSION, items: parsed.items }
    }
    return emptyStore()
  } catch {
    return emptyStore()
  }
}

/** 原子写豁免清单：临时文件 + rename 覆盖（不能裸 writeFile 整文件覆盖，防崩溃损坏共享清单）。 */
export async function writeExemptions(worktree: string, store: ExemptionStore): Promise<void> {
  const dir = await exemptionsDir(worktree)
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, EXEMPTIONS_FILE)
  const tmp = path.join(dir, `${EXEMPTIONS_FILE}.tmp`)
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, target)
}

/** 幂等 upsert：同 key 命中即整体刷新（不重复累积）；专用锁包住读-改-写，多 change 并行写不丢更新。 */
export async function upsertExemption(worktree: string, record: ExemptionRecord): Promise<void> {
  const dir = await exemptionsDir(worktree)
  mkdirSync(dir, { recursive: true })
  const lockPath = path.join(dir, EXEMPTIONS_LOCK)
  await acquireLock(lockPath)
  try {
    const store = await readExemptions(worktree)
    const idx = store.items.findIndex((i) => i.key === record.key)
    if (idx >= 0) {
      store.items[idx] = record
    } else {
      store.items.push(record)
    }
    await writeExemptions(worktree, store)
  } finally {
    releaseLock(lockPath)
  }
}

/** 由被裁定（dismissed）的 issue child 组装豁免记录；既无规则也无路径维度时返回 null（不参与匹配）。 */
export function buildExemptionRecord(
  child: WorkItem,
  opts: { changeId: string; exemptedBy: string },
): ExemptionRecord | null {
  const target = exemptionTargetOfChild(child)
  const ruleKeys = normalizeRuleKeys(target.ruleKeys)
  const key = exemptionRecordKeyOf(target)
  if (!key) return null
  const f = resolveChildIssueFields(child)
  return {
    key,
    rule: target.rule,
    file: target.file,
    pathPattern: target.pathPattern,
    ruleKeys: ruleKeys.length > 0 ? ruleKeys : undefined,
    line: target.line,
    sourcePhase: f.sourcePhase,
    dimension: f.dimension,
    severity: child.severity ?? "",
    description: child.description,
    exemptedAt: new Date().toISOString(),
    exemptedBy: opts.exemptedBy,
    changeId: opts.changeId,
  }
}

/** dismissed 裁定落库容错入口：清单写入失败仅告警，不阻断裁定主流程。 */
export async function writeDismissedExemption(
  worktree: string,
  child: WorkItem,
  opts: { changeId: string; exemptedBy: string },
): Promise<void> {
  const record = buildExemptionRecord(child, opts)
  if (!record) return
  try {
    await upsertExemption(worktree, record)
  } catch (err) {
    console.warn(`[exemptions] 项目级豁免清单写入失败（不影响裁定主流程）：${(err as Error).message}`)
  }
}

export interface ExemptionSuppression {
  kept: WorkItem[]
  suppressed: WorkItem[]
}

/**
 * 命中抑制：new_children 中匹配项目级豁免清单（精确三元组或路径模式/规则键）的 issue 直接丢弃，
 * 不入库、不改级别。必须在 handleReviewParams 之前调用——否则 review 的「passed 只能带 Info 新报」
 * 校验会先拒绝一次，抑制形同虚设。
 */
export function applyExemptionSuppression(children: WorkItem[], store: ExemptionStore): ExemptionSuppression {
  const kept: WorkItem[] = []
  const suppressed: WorkItem[] = []
  for (const c of children) {
    const target = exemptionTargetOfChild(c)
    const hit = store.items.find((record) => matchesExemption(target, record))
    if (hit) suppressed.push(c)
    else kept.push(c)
  }
  return { kept, suppressed }
}
