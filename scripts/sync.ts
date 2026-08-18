/**
 * 本地开发同步脚本：把当前最新开发版本同步到各 harness 的插件缓存目录。
 * 供 `bun run sync` 使用，非用户安装途径。
 *
 * 支持：
 * - opencode：直接同步源码到 npm 插件缓存（node_modules/@ifrankwang/openspec-agents）
 * - claude-code / codex / zcode：构建官方插件包后同步到对应插件缓存
 * - deepseek-harness：构建 DSH bundle 包后同步到 ~/.dsh/profiles/<name>/node_modules
 *
 * 新增 harness 时请扩展 scripts/sync-targets.ts。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, basename } from "node:path"
import { spawnSync } from "node:child_process"
import { SYNC_TARGETS, type SyncTarget } from "./sync-targets.ts"
import { buildClaudeCodePlugin, CLAUDE_CODE_PLUGIN_DIR } from "../src/adapters/claude-code/index.ts"
import { buildCodexPlugin, CODEX_PLUGIN_DIR } from "../src/adapters/codex/index.ts"
import { buildZcodePlugin, ZCODE_PLUGIN_DIR } from "../src/adapters/zcode/index.ts"
import { buildDeepSeekHarnessPlugin, DEEP_SEEK_HARNESS_PLUGIN_DIR } from "../src/adapters/deepseek-harness/index.ts"

const PROJECT_ROOT = resolve(import.meta.dir, "..")
const PLUGIN_DIRS: Record<string, string> = {
  claude: CLAUDE_CODE_PLUGIN_DIR,
  codex: CODEX_PLUGIN_DIR,
  zcode: ZCODE_PLUGIN_DIR,
  "deepseek-harness": DEEP_SEEK_HARNESS_PLUGIN_DIR,
  dsh: DEEP_SEEK_HARNESS_PLUGIN_DIR,
}

const RSYNC_EXCLUDES = [
  "--exclude=node_modules",
  "--exclude=.git",
  "--exclude=.DS_Store",
  "--exclude=.codegraph",
  "--exclude=.worktree",
  "--exclude=.worktrees",
  "--exclude=.opencode",
  "--exclude=openspec/states/",
]

function expandHome(p: string): string {
  // DSH 支持 DSH_HOME 自定义根目录；target 中写的是默认 ~/.dsh，需按环境变量解析。
  if (p.startsWith("~/.dsh/") && process.env.DSH_HOME) {
    return join(process.env.DSH_HOME, p.slice("~/.dsh".length))
  }
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 判断目标目录是否就是项目根（含 symlink 指向项目根），避免 sync 时 rsync --delete 清空源码仓库。 */
function isProjectRootDir(p: string): boolean {
  try {
    return realpathSync(p) === realpathSync(PROJECT_ROOT)
  } catch {
    return false
  }
}

function findDirs(root: string, maxDepth: number, predicate: (dir: string) => boolean): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || !isDir(dir)) return
    if (predicate(dir)) out.push(dir)
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === ".git") continue
      walk(join(dir, entry), depth + 1)
    }
  }
  walk(root, 0)
  return out
}

function findOpenCodeTargets(roots: string[]): string[] {
  const targets: string[] = []
  for (const root of roots.map(expandHome)) {
    if (!isDir(root)) continue
    for (const dir of findDirs(root, 6, (d) => basename(d) === "openspec-agents" && existsSync(join(d, "package.json")))) {
      if (isProjectRootDir(dir)) continue
      targets.push(dir)
    }
  }
  return [...new Set(targets)]
}

function findPluginCacheTargets(roots: string[], manifestDir: string): string[] {
  const targets: string[] = []
  for (const root of roots.map(expandHome)) {
    if (!isDir(root)) continue
    const pluginDirs = findDirs(root, 5, (d) => basename(d) === "openspec-agents")
    for (const pluginDir of pluginDirs) {
      if (isProjectRootDir(pluginDir)) continue
      if (existsSync(join(pluginDir, manifestDir, "plugin.json"))) {
        targets.push(pluginDir)
      }
      for (const child of readdirSync(pluginDir)) {
        const versionDir = join(pluginDir, child)
        if (isDir(versionDir) && !isProjectRootDir(versionDir) && existsSync(join(versionDir, manifestDir, "plugin.json"))) {
          targets.push(versionDir)
        }
      }
    }
  }
  return [...new Set(targets)]
}

/** 查找 DSH profile 中已安装的 openspec-agents bundle 包目录。 */
function findDshProfileTargets(roots: string[], packageName: string): string[] {
  const targets: string[] = []
  for (const root of roots.map(expandHome)) {
    if (!isDir(root)) continue
    const packageDirs = findDirs(root, 6, (d) => {
      if (basename(d) !== basename(packageName)) return false
      const pkgFile = join(d, "package.json")
      if (!existsSync(pkgFile)) return false
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as {
          name?: string
          dsh?: { bundle?: { patch?: unknown } }
        }
        return pkg.name === packageName && pkg.dsh?.bundle?.patch !== undefined
      } catch {
        return false
      }
    })
    targets.push(...packageDirs.filter((dir) => !isProjectRootDir(dir)))
  }
  return [...new Set(targets)]
}

function rsync(src: string, dest: string): void {
  const args = ["-a", "--delete", ...RSYNC_EXCLUDES, `${src}/`, `${dest}/`]
  const r = spawnSync("rsync", args, { stdio: "inherit" })
  if (r.status !== 0) {
    throw new Error(`rsync failed: ${src} -> ${dest}`)
  }
}

function installDependencies(pkgDir: string): void {
  console.log(`[opencode] installing dependencies -> ${pkgDir}`)
  const r = spawnSync("bun", ["install", "--production"], { cwd: pkgDir, stdio: "inherit" })
  if (r.status !== 0) {
    throw new Error(`bun install failed: ${pkgDir}`)
  }
}

function buildFor(harness: string): void {
  if (harness === "claude") {
    buildClaudeCodePlugin(CLAUDE_CODE_PLUGIN_DIR)
  } else if (harness === "codex") {
    buildCodexPlugin(CODEX_PLUGIN_DIR)
  } else if (harness === "zcode") {
    buildZcodePlugin(ZCODE_PLUGIN_DIR)
  } else if (harness === "deepseek-harness" || harness === "dsh") {
    buildDeepSeekHarnessPlugin(DEEP_SEEK_HARNESS_PLUGIN_DIR)
  } else {
    throw new Error(`unknown build harness: ${harness}`)
  }
}

function syncTarget(target: SyncTarget): number {
  const roots = target.cacheRoots.map(expandHome)
  let found = 0

  if (target.kind === "source-cache") {
    const targets = findOpenCodeTargets(roots)
    for (const dest of targets) {
      console.log(`[opencode] syncing workspace -> ${dest}`)
      rsync(PROJECT_ROOT, dest)
      installDependencies(dest)
      found++
    }
    return found
  }

  if (target.kind === "dsh-profile") {
    if (!target.packageName || !target.build) {
      throw new Error(`invalid dsh-profile target: ${target.harness}`)
    }
    const targets = findDshProfileTargets(roots, target.packageName)
    if (targets.length > 0) {
      console.log(`[${target.harness}] building plugin package (${target.build})`)
      buildFor(target.build)
    }
    const srcDir = PLUGIN_DIRS[target.build]
    if (!srcDir) throw new Error(`unknown plugin dir for ${target.build}`)

    for (const dest of targets) {
      console.log(`[${target.harness}] syncing ${srcDir} -> ${dest}`)
      rsync(srcDir, dest)
      // DSH bundle 依赖 DSH 内置的 mcp-client/skill-filesystem，无需在 profile 内额外安装。
      found++
    }
    return found
  }

  if (!target.manifestDir || !target.build) {
    throw new Error(`invalid plugin-cache target: ${target.harness}`)
  }

  const targets = findPluginCacheTargets(roots, target.manifestDir)
  if (targets.length > 0) {
    console.log(`[${target.harness}] building plugin package (${target.build})`)
    buildFor(target.build)
  }
  const srcDir = PLUGIN_DIRS[target.build]
  if (!srcDir) throw new Error(`unknown plugin dir for ${target.build}`)

  for (const dest of targets) {
    console.log(`[${target.harness}] syncing ${srcDir} -> ${dest}`)
    rsync(srcDir, dest)
    found++
  }
  return found
}

let total = 0
for (const target of SYNC_TARGETS) {
  total += syncTarget(target)
}

if (total === 0) {
  console.error("ERROR: 未发现任何可同步的 harness 插件缓存。")
  console.error("请先以插件形式运行一次对应 agent（或安装目标包）以创建缓存目录。")
  process.exit(1)
}

console.log(`Synced ${total} target(s). Restart the agent for changes to take effect.`)
