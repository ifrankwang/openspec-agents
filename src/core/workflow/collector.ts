import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { WorkItem } from "./types.js"
import { createInitialWorkItem } from "./engine.js"

/**
 * 收集器统一接入接口（spec workflow-collectors）。
 * 生命周期：pull 拉取外部原始项 → transform 产出初始 WorkItem（phase=todo、
 * suspended=false、children 为空、tags 为空）→ writeback 将处理结果回写外部源。
 */
export interface CollectorAdapter {
  readonly name: string
  pollIntervalMs: number
  pull(): Promise<unknown[]>
  transform(raw: unknown[]): WorkItem[]
  writeback(item: WorkItem, payload: unknown): Promise<{ success: boolean; error?: string }>
}

export interface OpenSpecCollectorOptions {
  openspecDir: string
  pollIntervalMs?: number
}

/** OpenSpec change 原始扫描项：change 目录名 + proposal.md 全文。 */
export interface OpenSpecChangeRef {
  changeName: string
  proposalText: string
}

const DEFAULT_POLL_INTERVAL_MS = 30_000
const SOURCE = "openspec"
const CHANGE_LABEL = "openspec-change"

/** 提取 proposal.md 一级标题作为 title；无一级标题时回退到 change 目录名。 */
function extractTitle(proposalText: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(proposalText)
  const title = heading?.[1]?.trim()
  return title ? title : fallback
}

/** 提取 proposal.md 的 Why 段正文作为摘要；无 Why 段时返回空串。 */
function extractSummary(proposalText: string): string {
  const lines = proposalText.split(/\r?\n/)
  const whyIndex = lines.findIndex((line) => /^##\s+Why\s*$/.test(line.trim()))
  if (whyIndex === -1) return ""
  const body: string[] = []
  for (let i = whyIndex + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break
    const trimmed = lines[i].trim()
    if (trimmed !== "") body.push(trimmed)
  }
  return body.join(" ")
}

/**
 * OpenSpec 收集器：pull 扫描 {openspecDir}/changes 下含 proposal.md 的 change 子目录
 * 返回原始 ref，transform 将其转为 task WorkItem。每次 pull 重新扫描磁盘，幂等且不抛错。
 */
export class OpenSpecCollector implements CollectorAdapter {
  readonly name = SOURCE
  readonly openspecDir: string
  readonly pollIntervalMs: number

  constructor(options: OpenSpecCollectorOptions) {
    this.openspecDir = options.openspecDir
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  async pull(): Promise<OpenSpecChangeRef[]> {
    const changesDir = join(this.openspecDir, "changes")
    let entries
    try {
      entries = readdirSync(changesDir, { withFileTypes: true })
    } catch {
      return []
    }

    const refs: OpenSpecChangeRef[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const proposalText = readFileSync(join(changesDir, entry.name, "proposal.md"), "utf8")
        refs.push({ changeName: entry.name, proposalText })
      } catch {
        continue
      }
    }
    return refs
  }

  transform(raw: unknown[]): WorkItem[] {
    return raw.map((ref) => {
      const { changeName, proposalText } = ref as OpenSpecChangeRef
      return createInitialWorkItem({
        id: `${SOURCE}:${changeName}`,
        source: SOURCE,
        externalId: changeName,
        type: "task",
        title: extractTitle(proposalText, changeName),
        description: extractSummary(proposalText) || changeName,
        labels: [CHANGE_LABEL],
      })
    })
  }

  async writeback(_item: WorkItem, _payload: unknown): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }
}

/**
 * ADO 收集器占位实现（spec workflow-collectors：占位拉取不报错）。
 * pull/transform 返回空，为后续接入真实 ADO 预留接口，引擎调度不受影响。
 */
export class AdoCollector implements CollectorAdapter {
  readonly name = "ado"
  readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS

  async pull(): Promise<unknown[]> {
    return []
  }

  transform(_raw: unknown[]): WorkItem[] {
    return []
  }

  async writeback(_item: WorkItem, _payload: unknown): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }
}

// ─── 自定义 adapter 注册表（静态注册，spec 设计决策取静态而非目录扫描）───

const registry: CollectorAdapter[] = []

/** 注册自定义收集器；同名 adapter 重复注册幂等跳过。 */
export function registerCollector(adapter: CollectorAdapter): void {
  if (registry.some((a) => a.name === adapter.name)) return
  registry.push(adapter)
}

/** 返回已注册收集器副本（含内置 openspec/ado 占位）。 */
export function getCollectors(): CollectorAdapter[] {
  return [...registry]
}

/** 清空注册表（测试隔离用，非编排业务接口）。 */
export function __resetCollectors(): void {
  registry.length = 0
}
