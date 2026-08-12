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
 * 痛点背景：worktree 模式下每个新 change 是全新状态账本 + 全新 Sonar 项目，tool review 全量扫描
 * 会把存量已裁定豁免的安全问题重新报为阻塞 issue，dev 每轮重新豁免。此模块把「裁定认可（dismissed）」
 * 的豁免结论落为 (rule+file+line) 清单，后续 change 的 tool review 提报命中清单时降为 Info 级，
 * 不阻塞、无需重复豁免。
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
/** 命中项目级豁免清单的标记键（写入 child.metadata，供视图统计与标注；不参与匹配）。 */
export const EXEMPTED_HIT_KEY = "exempted_hit"

export interface ExemptionRecord {
  key: string
  rule?: string
  file?: string
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

/** 豁免 key 单一事实源：rule+file+line 拼接。rule 缺失时返回 null（宁漏勿误：不匹配、不写清单）。 */
export function exemptionKeyOf(rule: string | undefined, file: string, line: number): string | null {
  if (rule === undefined || rule === "") return null
  return [rule, file, line].join("\u0000")
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

/** 由被裁定（dismissed）的 issue child 组装豁免记录；rule 缺失时返回 null（不参与匹配）。 */
export function buildExemptionRecord(
  child: WorkItem,
  opts: { changeId: string; exemptedBy: string },
): ExemptionRecord | null {
  const rule = typeof child.metadata["rule"] === "string" ? child.metadata["rule"] : undefined
  const f = resolveChildIssueFields(child)
  const key = exemptionKeyOf(rule, f.file, f.line)
  if (!key) return null
  return {
    key,
    rule,
    file: f.file,
    line: f.line,
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

/**
 * 命中降级：new_children 中 (rule+file+line) 命中清单的 issue 降为 Info 级并追加中性描述，
 * 返回降级条数。必须在 assertFailedHasReason 之前调用——否则仅含存量豁免问题的 change 里
 * reviewer 能 failed 却无真实待办，形成死锁。
 */
export function applyExemptionDowngrade(children: WorkItem[], store: ExemptionStore): number {
  const keys = new Set(store.items.map((i) => i.key))
  let downgraded = 0
  for (const c of children) {
    const rule = typeof c.metadata["rule"] === "string" ? c.metadata["rule"] : undefined
    const file = typeof c.metadata["file"] === "string" ? c.metadata["file"] : ""
    const line = typeof c.metadata["line"] === "number" ? c.metadata["line"] : 0
    const key = exemptionKeyOf(rule, file, line)
    if (key && keys.has(key)) {
      c.severity = "Info"
      c.metadata[EXEMPTED_HIT_KEY] = rule ?? true
      c.description = `${c.description}\n\n> 命中项目级豁免清单${rule ? `（rule=${rule}）` : ""}，保持现状。`
      downgraded++
    }
  }
  return downgraded
}
