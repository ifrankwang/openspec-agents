import yaml from "js-yaml"
import type { ExecutionBoundary } from "./types.ts"

/**
 * 提案阶段产出的执行边界数据，与 metadata.execution_boundary / ExecutionBoundary 同构。
 * 边界由提案流程写入 clarify.md 的「执行边界」小节，opx_orch_init 解析后落 metadata（不新增 init 参数）。
 */
export type ExecutionBoundaryData = ExecutionBoundary

/** 标题文本归一：去前后空白、去尾部冒号、去前导编号（1. / 1、/ 一、等变体）。 */
function normalizeHeading(text: string): string {
  return text
    .trim()
    .replace(/[:：]\s*$/, "")
    .replace(/^\d+\s*[.、)）]\s*/, "")
    .replace(/^[一二三四五六七八九十]+\s*[、.]\s*/, "")
    .trim()
}

/** 定位「执行边界」小节（允许标题级别/编号/前后空白变体，按标题前缀匹配）；未命中返回 null。 */
function findBoundarySection(lines: string[]): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (!m) continue
    if (!normalizeHeading(m[2]).startsWith("执行边界")) continue
    const level = m[1].length
    // 小节范围：下一个同级或更高级标题之前（无则到文件末尾）
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].match(/^\s{0,3}(#{1,6})\s+/)
      if (next && next[1].length <= level) {
        end = j
        break
      }
    }
    return { start: i + 1, end }
  }
  return null
}

/** 取小节内第一个 ```yaml / ```yml 围栏的正文；无围栏或围栏未闭合返回 null。 */
function firstYamlFence(lines: string[], start: number, end: number): string | null {
  let bodyStart = -1
  for (let i = start; i < end; i++) {
    const line = lines[i]
    if (bodyStart < 0) {
      if (/^\s*```\s*ya?ml\s*$/i.test(line)) bodyStart = i + 1
      continue
    }
    if (/^\s*```\s*$/.test(line)) return lines.slice(bodyStart, i).join("\n")
  }
  return null
}

/** 非空字符串数组（元素去空白后不得为空）。 */
function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.trim() !== "")
}

/**
 * 从 clarify.md 内容解析指定任务组的执行边界（纯函数，不读文件）。
 *
 * 结构（`## 执行边界` 小节内第一个 yaml 围栏）：
 * ```yaml
 * task_groups:
 *   "1":
 *     allowed_directories: ["src/core"]
 *     allowed_packages: ["src/core/x"]
 *     notes: "可选实施建议"
 * ```
 * 取 task_groups[taskGroupId]。allowed_directories / allowed_packages 须为非空字符串数组，
 * notes 可缺省（按空串）。任何缺失/结构非法/解析异常一律返回 null（不抛错），由调用方按
 * 「实施视图按整个 worktree 处理」降级。
 */
export function parseExecutionBoundary(content: string, taskGroupId: string): ExecutionBoundaryData | null {
  if (typeof content !== "string" || content.trim() === "") return null
  try {
    const lines = content.split(/\r?\n/)
    const section = findBoundarySection(lines)
    if (!section) return null
    const yamlText = firstYamlFence(lines, section.start, section.end)
    if (yamlText === null) return null

    const raw: unknown = yaml.load(yamlText)
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
    const groups = (raw as Record<string, unknown>)["task_groups"]
    if (typeof groups !== "object" || groups === null || Array.isArray(groups)) return null
    const entry = (groups as Record<string, unknown>)[taskGroupId]
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null

    const rec = entry as Record<string, unknown>
    const dirs = rec["allowed_directories"]
    const pkgs = rec["allowed_packages"]
    if (!isNonEmptyStringArray(dirs) || !isNonEmptyStringArray(pkgs)) return null
    const rawNotes = rec["notes"]
    if (rawNotes !== undefined && typeof rawNotes !== "string") return null

    return {
      allowed_directories: dirs.map((s) => s.trim()),
      allowed_packages: pkgs.map((s) => s.trim()),
      notes: typeof rawNotes === "string" ? rawNotes : "",
    }
  } catch {
    return null
  }
}
