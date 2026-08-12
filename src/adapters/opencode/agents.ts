import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig } from "@opencode-ai/sdk"
import { parseAgentMd, resolve } from "../agent-md.ts"

function mapPermission(
  fm: Record<string, unknown>
): AgentConfig["permission"] | undefined {
  const raw = fm.permission as Record<string, unknown> | undefined
  if (!raw) return undefined
  const permission: AgentConfig["permission"] = {}
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === "string" && ["ask", "allow", "deny"].includes(val)) {
      ;(permission as any)[key] = val
    } else if (typeof val === "object" && val !== null) {
      ;(permission as any)[key] = val
    }
  }
  return permission
}

const AGENTS_ROOT = resolve("assets", "agents")

/** 已知主代理名集合：注入的 openspec-main + 用户既有 primary agent + opencode 默认主代理 "primary"。 */
const primaryAgents = new Set<string>(["primary"])

/** 编排视角角色判定：调用者是否为主代理（承担编排者职责），替代 agent 名硬编码。 */
export function isPrimaryAgent(agent: string): boolean {
  return primaryAgents.has(agent)
}

export function injectAgents(config: Record<string, unknown>): void {
  // 探测主代理名：config.agent 中 mode=primary 的条目（用户自定义 + 注入的主代理模板）
  const existingAgents = (config.agent as Record<string, unknown>) ?? {}
  for (const [name, cfg] of Object.entries(existingAgents)) {
    if (typeof cfg === "object" && cfg !== null && (cfg as Record<string, unknown>).mode === "primary") {
      primaryAgents.add(name)
    }
  }
  if (existsSync(AGENTS_ROOT)) {
    const files = readdirSync(AGENTS_ROOT).filter((f) => f.endsWith(".md"))
    for (const file of files) {
      const md = readFileSync(join(AGENTS_ROOT, file), "utf-8")
      const { frontmatter, body } = parseAgentMd(md)
      const name = pathToName(file) ?? (frontmatter.name as string)
      if (!name) continue

      const agentConfig: Record<string, unknown> = {
        description: frontmatter.description ?? "",
        mode: frontmatter.mode ?? "subagent",
        prompt: body,
      }
      if (frontmatter.hidden !== undefined) {
        agentConfig.hidden = frontmatter.hidden
      }
      const maxSteps = (frontmatter.maxSteps ?? frontmatter.steps) as number | undefined
      if (maxSteps !== undefined) {
        agentConfig.maxSteps = maxSteps
      }
      const perm = mapPermission(frontmatter)
      if (perm) agentConfig.permission = perm

      if (frontmatter.mode === "primary") {
        primaryAgents.add(name)
      }

      const existingAgentsMap = (config.agent as Record<string, unknown>) ?? {}
      const existingAgent = existingAgentsMap[name] as Record<string, unknown> | undefined
      config.agent = {
        ...existingAgentsMap,
        [name]: { ...agentConfig, ...existingAgent },
      }
    }
  }
}

function pathToName(filename: string): string | null {
  const base = filename.replace(/\.md$/i, "")
  return base || null
}
