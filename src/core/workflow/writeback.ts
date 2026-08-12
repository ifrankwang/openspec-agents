import type { WorkItem } from "./types.ts"

export type WritebackHandler = (item: WorkItem, action: string, payload: unknown) => Promise<void> | void

interface WritebackTask {
  item: WorkItem
  action: string
  payload: unknown
}

let handler: WritebackHandler = async () => {}
let queue: WritebackTask[] = []

/** 注册写回处理器（模拟外部源，默认直接成功） */
export function setWritebackHandler(next: WritebackHandler): void {
  handler = next
}

/** 非阻塞入队：仅推进队列并记录 lastAttempt，不等待外部 I/O */
export function enqueueWriteback(item: WorkItem, action: string, payload: unknown): void {
  queue.push({ item, action, payload })
  item.writeback = { ...item.writeback, lastAttempt: new Date().toISOString() }
}

/** 排空队列执行写回：成功记录 lastSuccess，失败记录 error（保留 lastAttempt） */
export async function flushWritebacks(): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = []
  const failed: string[] = []
  const pending = queue
  queue = []
  for (const task of pending) {
    try {
      await handler(task.item, task.action, task.payload)
      const { error: _staleError, ...writeback } = task.item.writeback ?? {}
      task.item.writeback = { ...writeback, lastSuccess: new Date().toISOString() }
      succeeded.push(task.item.id)
    } catch (err) {
      task.item.writeback = { ...task.item.writeback, error: (err as Error).message }
      failed.push(task.item.id)
    }
  }
  return { succeeded, failed }
}

/** 上次写回失败则返回 true，提示下次状态变更应重试（重试动作由后续 flush 承担） */
export function retryPendingWritebacks(item: WorkItem): boolean {
  return item.writeback?.error !== undefined
}
