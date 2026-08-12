import { existsSync } from "node:fs"
import { DISTRIBUTED_SKILL_ROOTS } from "../../skills/scan.ts"

export function injectSkills(config: Record<string, unknown>): void {
  const skillsCfg = (config.skills ?? {}) as Record<string, unknown>
  const paths = (skillsCfg.paths ?? []) as string[]

  for (const root of DISTRIBUTED_SKILL_ROOTS) {
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
