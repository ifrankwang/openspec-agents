import path from "path"
import { readFile } from "node:fs/promises"

export interface ParsedTask {
  title: string
  specTrace: string
  taskNumber: string
}

export function parseSpecTrace(line: string): string {
  const m = line.match(/\[spec:([^\]]+)\]/)
  return m ? m[1].trim() : ""
}

/**
 * 解析 tasks.md 内容中指定任务组的子任务（纯函数，不读文件）。
 * 供 init 按来源回落取到内容后直接解析（来源可能是 worktree、主仓库工作树或基准分支版本库）。
 */
export function parseTasksForGroupFromContent(content: string, taskGroupId: string): ParsedTask[] {
  const tasks: ParsedTask[] = []
  const lines = content.split("\n")
  let currentGroup: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const groupMatch = line.match(/^##\s+(\d+)\./)
    if (groupMatch) {
      if (currentGroup === taskGroupId) break
      currentGroup = groupMatch[1]
      continue
    }
    if (currentGroup !== taskGroupId) continue
    const taskMatch = line.match(/^-\s+\[[\sx]\]\s+(.+)/)
    if (taskMatch) {
      const body = taskMatch[1]
      const taskNumberMatch = body.match(/^(\d+(?:\.\d+)+)\s+/)
      const taskNumber = taskNumberMatch ? taskNumberMatch[1] : ""
      const cleaned = (taskNumberMatch ? body.slice(taskNumberMatch[0].length) : body)
        .replace(/\s*\[spec:[^\]]+\]\s*$/, "")
        .trim()
      const specTrace = parseSpecTrace(body)
      tasks.push({ title: cleaned, specTrace, taskNumber })
    }
  }
  return tasks
}

/**
 * 既有公共 API 导出（经 src/core/index.ts 转发，保留供外部消费）：读 worktree 内 tasks.md 再解析。
 * init 内部已改为先按来源回落取到内容、再调用纯函数 parseTasksForGroupFromContent，不再走本包装。
 */
export async function parseTasksMdForGroup(
  worktree: string,
  changeId: string,
  taskGroupId: string
): Promise<ParsedTask[]> {
  const tasksPath = path.join(worktree, "openspec", "changes", changeId, "tasks.md")
  let content: string
  try {
    content = await readFile(tasksPath, "utf-8")
  } catch {
    return []
  }
  return parseTasksForGroupFromContent(content, taskGroupId)
}

export function extractRelevantSpecsFromTasks(tasks: ParsedTask[]): string[] {
  const set = new Set<string>()
  for (const t of tasks) {
    if (!t.specTrace) continue
    const parts = t.specTrace.split("#")[0]
    if (parts) set.add(parts)
  }
  return Array.from(set)
}

/** 解析 tasks.md 内容中的任务组清单（纯函数，不读文件）。 */
export function parseTaskGroupsFromContent(content: string): { id: string; name: string; taskCount: number }[] {
  const groups: { id: string; name: string; taskCount: number }[] = []
  const lines = content.split("\n")
  let currentGroup: { id: string; name: string } | null = null
  let currentTaskCount = 0
  for (const line of lines) {
    const groupMatch = line.match(/^##\s+(\d+)\./)
    if (groupMatch) {
      if (currentGroup) groups.push({ ...currentGroup, taskCount: currentTaskCount })
      currentGroup = { id: groupMatch[1], name: line.replace(/^##\s+\d+\.\s*/, "").trim() }
      currentTaskCount = 0
      continue
    }
    if (currentGroup) {
      if (/^-\s+\[[\sx]\]\s+/.test(line)) currentTaskCount++
    }
  }
  if (currentGroup) groups.push({ ...currentGroup, taskCount: currentTaskCount })
  return groups
}

/**
 * 既有公共 API 导出（经 src/core/index.ts 转发，保留供外部消费）：读 worktree 内 tasks.md 再解析。
 * init 内部已改为先按来源回落取到内容、再调用纯函数 parseTaskGroupsFromContent，不再走本包装。
 */
export async function parseAllTaskGroupsFromMd(
  worktree: string,
  changeId: string
): Promise<{ id: string; name: string; taskCount: number }[]> {
  const tasksPath = path.join(worktree, "openspec", "changes", changeId, "tasks.md")
  let content: string
  try {
    content = await readFile(tasksPath, "utf-8")
  } catch {
    return []
  }
  return parseTaskGroupsFromContent(content)
}
