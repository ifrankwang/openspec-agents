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

export async function parseTasksMdForGroup(
  worktree: string,
  changeId: string,
  taskGroupId: string
): Promise<ParsedTask[]> {
  const tasksPath = path.join(worktree, "openspec", "changes", changeId, "tasks.md")
  const tasks: ParsedTask[] = []
  try {
    const content = await readFile(tasksPath, "utf-8")
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
  } catch {
  }
  return tasks
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

export async function parseAllTaskGroupsFromMd(
  worktree: string,
  changeId: string
): Promise<{ id: string; name: string; taskCount: number }[]> {
  const tasksPath = path.join(worktree, "openspec", "changes", changeId, "tasks.md")
  const groups: { id: string; name: string; taskCount: number }[] = []
  try {
    const content = await readFile(tasksPath, "utf-8")
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
  } catch {
  }
  return groups
}
