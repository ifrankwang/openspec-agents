import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const SKILL_SCAN_ROOTS: string[] = [
  resolve(projectRoot, "assets", "skills"),
  resolve(projectRoot, ".agents", "skills"),
  resolve(projectRoot, ".opencode", "skills"),
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".config", "opencode", "skills"),
]

export const PROJECT_SKILL_ROOTS: string[] = [
  resolve(projectRoot, "assets", "skills"),
  resolve(projectRoot, ".agents", "skills"),
  resolve(projectRoot, ".opencode", "skills"),
]

export function findSkillPath(name: string): string | null {
  for (const root of SKILL_SCAN_ROOTS) {
    const p = resolve(root, name, "SKILL.md")
    if (existsSync(p)) return p
  }
  return null
}

export function projectSkillNames(): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const root of PROJECT_SKILL_ROOTS) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (seen.has(entry.name)) continue
      const mdPath = resolve(root, entry.name, "SKILL.md")
      if (!existsSync(mdPath)) continue
      seen.add(entry.name)
      result.push(entry.name)
    }
  }
  return result.sort()
}
