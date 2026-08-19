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

export function injectAgents(config: Record<string, unknown>): void {
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
