import { existsSync, readdirSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * 定位随包分发的 skill 根目录：源码（src/skills/ 上溯 2 级=仓库根 assets/skills）、插件包 dist 形态
 * （<插件根>/.mcp-server/ 上溯 1 级=插件根 skills/，plugin-common buildSkills 输出）与 ZCode 缓存嵌套形态
 * （cache/<marketplace>/<plugin>/<version>/.mcp-server/ 上溯 1 级=版本目录 skills/）部署深度不同，
 * 故从模块所在目录逐级上溯探测（与 resolveWorkflowFilePath 同范式）。每级按固定顺序探测两个候选：
 * assets/skills 优先、skills 其次；命中要求目录下至少有一个子目录含 SKILL.md（防御空骨架目录，
 * 如仓库根遗留的空 skills/）。首个命中即采用（首中即用，不做多根收集——避免 npm 形态上溯越过
 * 包根误收消费方项目根）。bundle 单文件合并后 import.meta.url 指向部署位置（cli.mjs），源码形态
 * 指向本文件自身，两者自然成立。
 */
export function resolveSkillScanRoot(moduleUrl: string): string | null {
  const startDir = dirname(fileURLToPath(moduleUrl))
  let dir = startDir
  for (;;) {
    for (const candidate of [resolve(dir, "assets", "skills"), resolve(dir, "skills")]) {
      if (isSkillRoot(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break // 到达文件系统根
    dir = parent
  }
  return null
}

/** 目录存在且至少有一个子目录含 SKILL.md 才算 skill 根；空骨架目录（子目录无 SKILL.md）不命中。 */
function isSkillRoot(candidate: string): boolean {
  if (!existsSync(candidate)) return false
  try {
    return readdirSync(candidate, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(candidate, entry.name, "SKILL.md")),
    )
  } catch {
    return false // 不可读目录按未命中处理（优雅降级，不阻断扫描）
  }
}

// 随包分发 skill 缺失时优雅降级（返回 null）：只影响视图加载建议与门禁索引，不阻断 server 启动；
// 与 loader 的 workflow 缺失即抛错差异是有意为之——opx_* 工具全部依赖 workflow，缺失时 server 无可用性。
const scanRoot = resolveSkillScanRoot(import.meta.url)

export const SKILL_SCAN_ROOTS: string[] = [
  ...(scanRoot ? [scanRoot] : []),
  resolve(projectRoot, ".agents", "skills"),
  resolve(projectRoot, ".opencode", "skills"),
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".config", "opencode", "skills"),
]

// 仅随插件分发注入 opencode 的 skill 根目录。.agents/skills 靠 opencode 标准发现对本仓库自用生效，非插件注入职责。
// 源码形态探测根即仓库根 assets/skills（与改动前行为一致）；插件形态为插件根 skills/。
export const DISTRIBUTED_SKILL_ROOTS: string[] = scanRoot ? [scanRoot] : []

export function findSkillPath(name: string): string | null {
  for (const root of SKILL_SCAN_ROOTS) {
    const p = resolve(root, name, "SKILL.md")
    if (existsSync(p)) return p
  }
  return null
}
