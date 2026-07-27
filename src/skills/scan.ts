import { existsSync } from "node:fs"
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


