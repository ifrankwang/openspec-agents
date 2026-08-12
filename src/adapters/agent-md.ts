/**
 * 多适配器共享的 agent 定义解析工具（DRY）：agent.md frontmatter/body 解析、项目根路径解析、
 * 非主代理形态注入排除清单。opencode / claude-code / codex / zcode 适配器统一引用。
 */
import { dirname, resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as yaml from "js-yaml"

export interface ParsedAgent {
  frontmatter: Record<string, unknown>
  body: string
}

export function parseAgentMd(content: string): ParsedAgent {
  const result: ParsedAgent = { frontmatter: {}, body: content }
  if (!content.startsWith("---")) return result
  const end = content.indexOf("---", 3)
  if (end === -1) return result
  const fmText = content.slice(3, end).trim()
  result.body = content.slice(end + 3).trim()
  try {
    result.frontmatter = (yaml.load(fmText) as Record<string, unknown>) ?? {}
  } catch {
    result.body = content
  }
  return result
}

/** 项目根（assets/ 等资源所在目录）。 */
export const PROJECT_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

export function resolve(...p: string[]): string {
  return pathResolve(PROJECT_ROOT, ...p)
}

/** 主代理模板（opencode 用）不在 claude code / codex / zcode 注入：主代理即本体，子代理定义全部注入。 */
export const EXCLUDED_AGENTS = new Set(["openspec-main.md"])
