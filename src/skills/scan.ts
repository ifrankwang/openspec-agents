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

// 仅随插件分发注入 opencode 的 skill 根目录。.agents/skills 靠 opencode 标准发现对本仓库自用生效，非插件注入职责。
export const DISTRIBUTED_SKILL_ROOTS: string[] = [
  resolve(projectRoot, "assets", "skills"),
]

export function findSkillPath(name: string): string | null {
  for (const root of SKILL_SCAN_ROOTS) {
    const p = resolve(root, name, "SKILL.md")
    if (existsSync(p)) return p
  }
  return null
}


