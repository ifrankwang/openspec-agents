import { existsSync } from "node:fs"
import { PROJECT_SKILL_ROOTS } from "./scan.js"

export function injectSkills(config: Record<string, unknown>): void {
  const skillsCfg = (config.skills ?? {}) as Record<string, unknown>
  const paths = (skillsCfg.paths ?? []) as string[]

  for (const root of PROJECT_SKILL_ROOTS) {
    if (!existsSync(root)) continue
    if (!paths.includes(root)) {
      paths.push(root)
    }
  }

  if (paths.length > 0) {
    skillsCfg.paths = paths
    config.skills = skillsCfg
  }
}
