import { readStateByWorktree, writeState } from "../state.ts"
import { getCollectors, type CollectorAdapter } from "./collector.ts"
import type { WorkItem } from "./types.ts"

const DEFAULT_TICK_MS = 1_000

export interface PollOnceResult {
  added: string[]
  skipped: string[]
  errors: string[]
}

export interface PollAdapterResult {
  added: string[]
  skipped: string[]
  error?: string
}

/** 去重键：source + externalId，跨 adapter 来源隔离。 */
function dedupeKey(item: WorkItem): string {
  return `${item.source}:${item.externalId ?? item.id}`
}

/**
 * 拉取单个 adapter：pull → transform → 按 source+externalId 去重写入 state.workItems，
 * 并对新增项执行 writeback（失败在 item.writeback 记录 lastAttempt/error，不阻塞调度）。
 */
export async function pollAdapter(
  worktree: string,
  adapter: CollectorAdapter,
  changeId?: string,
): Promise<PollAdapterResult> {
  let raw: unknown[]
  try {
    raw = await adapter.pull()
  } catch (err) {
    return { added: [], skipped: [], error: `[poller] adapter "${adapter.name}" pull 失败：${(err as Error).message}` }
  }

  let items: WorkItem[]
  try {
    items = adapter.transform(raw)
  } catch (err) {
    return { added: [], skipped: [], error: `[poller] adapter "${adapter.name}" transform 失败：${(err as Error).message}` }
  }

  let state
  try {
    state = await readStateByWorktree(worktree, changeId)
  } catch (err) {
    return { added: [], skipped: [], error: `[poller] adapter "${adapter.name}" 读取编排状态失败：${(err as Error).message}` }
  }
  if (!state) {
    // 无可用编排会话：静默跳过，不产生 error（避免 poller 每 tick 刷 console.error 噪音）
    return { added: [], skipped: [] }
  }
  state.workItems ??= []
  const existing = new Set<string>(state.workItems.map(dedupeKey))

  const added: string[] = []
  const skipped: string[] = []
  for (const item of items) {
    const key = dedupeKey(item)
    if (existing.has(key)) {
      skipped.push(item.id)
      continue
    }
    state.workItems.push(item)
    existing.add(key)
    added.push(item.id)

    try {
      const result = await adapter.writeback(item, item)
      if (result.success) {
        item.writeback = { ...item.writeback, lastAttempt: new Date().toISOString(), lastSuccess: new Date().toISOString() }
      } else {
        item.writeback = { ...item.writeback, lastAttempt: new Date().toISOString(), error: result.error ?? "writeback 失败" }
      }
    } catch (err) {
      item.writeback = { ...item.writeback, lastAttempt: new Date().toISOString(), error: (err as Error).message }
    }
  }

  // 仅在本次有新增项（added 会触发 writeback 状态变更）时才写盘，全量 skipped 时跳过
  // 避免无意义 I/O。read-modify-write 的无锁并发问题本阶段保持现状（单实例部署，
  // 多实例并发场景见后续设计，此处不引入锁）。
  if (added.length > 0) {
    await writeState(worktree, state)
  }
  return { added, skipped }
}

/**
 * 单次全量拉取：遍历所有已注册 adapter 执行 pollAdapter，聚合结果。
 * 单个 adapter 失败不阻塞其余 adapter。
 */
export async function pollOnce(worktree: string, changeId?: string): Promise<PollOnceResult> {
  const result: PollOnceResult = { added: [], skipped: [], errors: [] }
  for (const adapter of getCollectors()) {
    const r = await pollAdapter(worktree, adapter, changeId)
    result.added.push(...r.added)
    result.skipped.push(...r.skipped)
    if (r.error) {
      result.errors.push(r.error)
      console.error(r.error)
    }
  }
  return result
}

/** 活跃轮询器注册表（按 worktree 去重，插件热重载不累积定时器）。 */
const activePollers = new Map<string, { stop: () => void }>()

/**
 * 启动定时拉取：按全局 tick（intervalMs）轮询各已注册 collector，每个 adapter
 * 按自身 pollIntervalMs 到期后执行单次拉取（拉取失败仅记录不阻塞后续）。
 * worktree 为动态上下文，由插件启动时注入。
 * 同 worktree 重复调用幂等：复用已注册的轮询器，不新建定时器。
 */
export function startPolling(
  worktree: string,
  options?: { intervalMs?: number; changeId?: string },
): { stop(): void } {
  const existing = activePollers.get(worktree)
  if (existing) return existing

  const tickMs = options?.intervalMs ?? DEFAULT_TICK_MS
  const changeId = options?.changeId
  const lastRun = new Map<string, number>()

  const timer = setInterval(() => {
    const now = Date.now()
    for (const adapter of getCollectors()) {
      const last = lastRun.get(adapter.name) ?? 0
      if (now - last < adapter.pollIntervalMs) continue
      lastRun.set(adapter.name, now)
      // pollAdapter 不 reject（错误以 {error} 返回），此处消费并记录，避免调度错误静默。
      pollAdapter(worktree, adapter, changeId).then((r) => {
        if (r.error) console.error(r.error)
      })
    }
  }, tickMs)
  timer.unref?.()

  const handle: { stop(): void } = {
    stop: () => {
      clearInterval(timer)
      if (activePollers.get(worktree) === handle) activePollers.delete(worktree)
    },
  }
  activePollers.set(worktree, handle)
  return handle
}

/** 清理全部活跃轮询器（测试隔离用，非编排业务接口）。 */
export function __resetPoller(): void {
  for (const { stop } of activePollers.values()) stop()
  activePollers.clear()
}
