/**
 * 本地开发同步脚本：把当前最新开发版本同步到各 harness 的插件缓存目录。
 * 供 `bun run sync` 使用，非用户安装途径。
 *
 * 支持：
 * - opencode：重建包根产物（.mcp-server/cli.mjs 为其 MCP 入口）后，直接同步源码到 npm 插件缓存
 *   （~/.cache/opencode/npm/<scope>/<name>@<tag>/<ts>/node_modules/@ifrankwang/openspec-agents）
 * - claude-code / codex / zcode：构建官方插件包后同步到对应插件缓存
 * - deepseek-harness：构建 DSH bundle 包后同步到 ~/.dsh/profiles/<name>/node_modules
 *
 * 所有写入目标都经过同步安全守卫（本文件 checkSyncDestination / assertSafeSyncPair）：
 * 目标解析后若落在任何源码仓库内（git 工作树根，或工作树根的子路径），或与源 realpath 相等/互为祖先，
 * 一律跳过并 WARN 或直接中止。rsync -a --delete 会跟随软链写入，绝不能落到源码仓库上
 * （事故路径：worktree 里同步时，profile 中「指向主仓库的软链」的 realpath 与当前 PROJECT_ROOT 不等，
 * 只排除当前 checkout 的旧判定会放行，随后整套包产物覆写主仓库并删除大量已跟踪文件）。
 *
 * 新增 harness 时请扩展 scripts/sync-targets.ts。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, basename, dirname, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { SYNC_TARGETS, type SyncTarget } from "./sync-targets.ts"
import { buildClaudeCodePlugin, CLAUDE_CODE_PLUGIN_DIR } from "../src/adapters/claude-code/index.ts"
import { buildCodexPlugin, CODEX_PLUGIN_DIR } from "../src/adapters/codex/index.ts"
import { buildZcodePlugin, ZCODE_PLUGIN_DIR } from "../src/adapters/zcode/index.ts"
import { buildDeepSeekHarnessPlugin, DEEP_SEEK_HARNESS_PLUGIN_DIR } from "../src/adapters/deepseek-harness/index.ts"
import { buildRootArtifacts } from "./build-dsh-root.ts"

const PROJECT_ROOT = resolve(import.meta.dir, "..")
const PLUGIN_DIRS: Record<string, string> = {
  claude: CLAUDE_CODE_PLUGIN_DIR,
  codex: CODEX_PLUGIN_DIR,
  zcode: ZCODE_PLUGIN_DIR,
  "deepseek-harness": DEEP_SEEK_HARNESS_PLUGIN_DIR,
  dsh: DEEP_SEEK_HARNESS_PLUGIN_DIR,
}

// rsync 排除清单只放「任何 harness 都不该收到」的目录（版本库/编辑器/索引/状态）。
// 刻意不排除 .mcp-server 与 .dsh-plugin：前者是 OpenCode 的 MCP 入口（包根 .mcp-server/cli.mjs），
// 后者是 DSH profile 同步的必需产物（rsync 源 dist/deepseek-harness-plugin 内），
// 加入排除清单会让对应 harness 直接不可用。
export const RSYNC_EXCLUDES = [
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

/**
 * 判断目标目录是否就是「当前这一份 checkout」（含软链指向它）——即 link 安装形态，
 * 走「只重建根产物、不 rsync」路径，静默排除。注意这不能替代下面的通用守卫：
 * 它只认得当前 checkout 自己，认不出「指向别的 checkout」的软链。
 */
function isOwnCheckoutDir(p: string): boolean {
  try {
    return realpathSync(p) === realpathSync(PROJECT_ROOT)
  } catch {
    return false
  }
}

/** 路径自身是否为 git 工作树根：.git 目录或 .git 文件（git worktree 的 .git 是文件）。 */
export function isSourceCheckoutRoot(p: string): boolean {
  try {
    const st = lstatSync(join(p, ".git"))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/** child 是否等于 parent 或位于 parent 之内（按路径分段比较，避免 /a/bc 被误判为 /a/b 的子路径）。 */
function isSameOrInside(child: string, parent: string): boolean {
  const c = resolve(child)
  const p = resolve(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`)
}

/**
 * 从 p 向上找最近的源码仓库根。boundary 给出时，「位于 boundary 之内」的祖先链走到 boundary 即止、
 * 不再上溯——否则「home 本身是 dotfiles 仓库」这类与本次同步无关的祖先会把所有目标误判为不安全；
 * 目标解析后落在 boundary 之外（软链指向别处）时继续上溯，才能发现「别的 checkout」。
 */
function findEnclosingSourceCheckout(p: string, boundary?: string): string | null {
  const boundaryReal = boundary && existsSync(boundary) ? realpathSync(boundary) : undefined
  let cur = p
  for (;;) {
    if (boundaryReal && cur === boundaryReal) return null
    if (isSourceCheckoutRoot(cur)) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export interface SyncDestinationVerdict {
  safe: boolean
  /** 解析软链后的真实路径；解析失败时为空串。 */
  realPath: string
  /** 不安全的原因（人话，供 WARN 输出）。 */
  reason?: string
}

/**
 * 判断一个「即将被 rsync 写入」的目录是否安全。boundary 为本次扫描的缓存根。
 * 拒绝三类：解析后是源码仓库根、位于某个源码仓库之内、本身是软链（写入会落到链接目标）。
 */
export function checkSyncDestination(dest: string, boundary?: string): SyncDestinationVerdict {
  let realPath: string
  try {
    realPath = realpathSync(dest)
  } catch {
    return { safe: false, realPath: "", reason: "路径不存在或无法解析" }
  }
  if (!isDir(realPath)) {
    return { safe: false, realPath, reason: "解析后不是目录" }
  }
  const enclosing = findEnclosingSourceCheckout(realPath, boundary)
  if (enclosing) {
    const reason =
      enclosing === realPath
        ? `该路径解析后是源码仓库（含 .git）：${realPath}`
        : `该路径解析后位于源码仓库 ${enclosing} 之内`
    return { safe: false, realPath, reason }
  }
  if (isSymlink(dest)) {
    return { safe: false, realPath, reason: `该路径是软链安装（指向 ${realPath}），写入会落到链接目标` }
  }
  return { safe: true, realPath }
}

/**
 * 候选目标统一过滤：当前 checkout 自己静默排除（link 安装由 findDshLinkedInstalls 处理）；
 * 其余不安全的候选打印 WARN 后跳过，绝不静默放行到 rsync。
 */
function selectSyncDestinations(candidates: string[], boundary: string, label: string): string[] {
  const out: string[] = []
  for (const dir of candidates) {
    if (isOwnCheckoutDir(dir)) continue
    const verdict = checkSyncDestination(dir, boundary)
    if (!verdict.safe) {
      console.warn(
        `WARN: [${label}] 跳过同步目标 ${dir}：${verdict.reason}，跳过以免 rsync --delete 覆写源码。`,
      )
      continue
    }
    out.push(dir)
  }
  return out
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

export function findOpenCodeTargets(roots: string[]): string[] {
  const targets: string[] = []
  for (const root of roots.map(expandHome)) {
    if (!isDir(root)) continue
    const candidates = findDirs(
      root,
      6,
      (d) => basename(d) === "openspec-agents" && existsSync(join(d, "package.json")),
    )
    targets.push(...selectSyncDestinations(candidates, root, "opencode"))
  }
  return [...new Set(targets)]
}

function findPluginCacheTargets(roots: string[], manifestDir: string): string[] {
  const targets: string[] = []
  for (const root of roots.map(expandHome)) {
    if (!isDir(root)) continue
    const candidates: string[] = []
    for (const pluginDir of findDirs(root, 5, (d) => basename(d) === "openspec-agents")) {
      if (existsSync(join(pluginDir, manifestDir, "plugin.json"))) {
        candidates.push(pluginDir)
      }
      for (const child of readdirSync(pluginDir)) {
        const versionDir = join(pluginDir, child)
        if (isDir(versionDir) && existsSync(join(versionDir, manifestDir, "plugin.json"))) {
          candidates.push(versionDir)
        }
      }
    }
    targets.push(...selectSyncDestinations(candidates, root, "plugin-cache"))
  }
  return [...new Set(targets)]
}

/** 查找 DSH profile 中已安装的 openspec-agents bundle 包目录（过滤掉源码仓库，见 checkSyncDestination）。 */
export function findDshProfileTargets(roots: string[], packageName: string): string[] {
  const targets: string[] = []
  for (const root of roots.map(expandHome)) {
    if (!isDir(root)) continue
    const candidates = findDirs(root, 6, (d) => {
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
    targets.push(...selectSyncDestinations(candidates, root, "deepseek-harness"))
  }
  return [...new Set(targets)]
}

/** 查找 DSH profile 中以 link 方式安装（符号链接指向本仓库）的 openspec-agents 包目录。 */
export function findDshLinkedInstalls(roots: string[], packageName: string): string[] {
  const out: string[] = []
  for (const root of roots.map(expandHome)) {
    if (!isDir(root)) continue
    const dirs = findDirs(root, 6, (d) => {
      if (basename(d) !== basename(packageName)) return false
      try {
        return lstatSync(d).isSymbolicLink() && realpathSync(d) === realpathSync(PROJECT_ROOT)
      } catch {
        return false
      }
    })
    out.push(...dirs)
  }
  return [...new Set(out)]
}

/**
 * 源/目标关系守卫（rsync 前必经）：realpath 相等、目标位于源之内、源位于目标之内，一律中止。
 * 分别对应：自毁同步、把包产物写进源码仓库子目录、rsync --delete 删掉源文件。
 */
export function assertSafeSyncPair(src: string, dest: string): void {
  const srcReal = realpathSync(src)
  const destReal = realpathSync(dest)
  if (srcReal === destReal) {
    throw new Error(`拒绝同步：源与目标是同一目录 ${srcReal}，rsync --delete 会自毁`)
  }
  if (isSameOrInside(destReal, srcReal)) {
    throw new Error(`拒绝同步：目标位于源之内（${destReal} ⊂ ${srcReal}），rsync --delete 会写进源码仓库子目录`)
  }
  if (isSameOrInside(srcReal, destReal)) {
    throw new Error(`拒绝同步：源位于目标之内（${srcReal} ⊂ ${destReal}），rsync --delete 会删除源文件`)
  }
}

/**
 * rsync 是全部写入路径的唯一收口：先做源/目标关系守卫，再拒绝「目标解析后是源码仓库根」。
 * 发现阶段的 checkSyncDestination 已跳过这类目标，这里作为最后一道闸兜底。导出供测试用临时目录验证。
 */
export function rsync(src: string, dest: string): void {
  assertSafeSyncPair(src, dest)
  if (isSourceCheckoutRoot(dest)) {
    throw new Error(`拒绝同步：目标 ${dest} 是源码仓库（含 .git），rsync --delete 会覆写源码`)
  }
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

/** 执行单个同步目标；返回实际写入的目录个数。导出供测试在临时目录上直接调用（不触碰真实缓存）。 */
export function syncTarget(target: SyncTarget): number {
  const roots = target.cacheRoots.map(expandHome)
  let found = 0

  if (target.kind === "source-cache") {
    const targets = findOpenCodeTargets(roots)
    if (targets.length > 0) {
      // OpenCode 的 MCP 入口是包根 .mcp-server/cli.mjs（src/adapters/opencode/index.ts），属构建产物
      // （.gitignore 忽略，仓库内不存在）。若不同步重建而直接 rsync --delete，源码根缺失该目录会把
      // 缓存里现存的入口删掉，本来可用的 OpenCode 立刻坏掉；重建后再镜像，缓存内容与发布包一致。
      console.log(`[${target.harness}] rebuilding root artifacts (MCP entry + DSH bundle)`)
      buildRootArtifacts(PROJECT_ROOT)
    }
    for (const dest of targets) {
      console.log(`[${target.harness}] syncing workspace -> ${dest}`)
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
    // link 安装形态：node_modules 中的包是符号链接直接指向本仓库，DSH 运行时读的是本仓库
    // 根产物（.dsh-plugin/opx-tools.mjs + dsh/cordis.patch.yml，同一次构建亦产出 OpenCode 入口
    // .mcp-server/cli.mjs），重建根产物即完成同步；
    // 不做 rsync 复制（复制会污染源码仓库）：link 目标被 selectSyncDestinations 静默排除，
    // 且任何解析后落在源码仓库里的目标都会被守卫拦住。
    const linkedInstalls = findDshLinkedInstalls(roots, target.packageName)
    if (linkedInstalls.length > 0) {
      console.log(`[${target.harness}] rebuilding root DSH bundle for ${linkedInstalls.length} linked install(s)`)
      buildRootArtifacts(PROJECT_ROOT)
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
      // DSH bundle 依赖 DSH 安装目录提供的 @deepseek-ai/*（schemastery / dsh-tools / skill-filesystem
      // / tool-subagent），无需在 profile 内额外安装。
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

/** 同步全部目标，返回实际同步的 harness 个数（0 表示未发现任何可同步缓存）。 */
export function runSync(): number {
  let total = 0
  for (const target of SYNC_TARGETS) {
    total += syncTarget(target)
  }
  return total
}

// 仅作为 CLI 入口（bun run sync / bun scripts/sync.ts）时执行；被 import 时不产生副作用
// （测试据此断言排除清单等纯数据，不会触碰本地插件缓存）。
if (import.meta.main) {
  const total = runSync()
  if (total === 0) {
    console.error("ERROR: 未发现任何可同步的 harness 插件缓存。")
    console.error("请先以插件形式运行一次对应 agent（或安装目标包）以创建缓存目录。")
    process.exit(1)
  }
  console.log(`Synced ${total} target(s). Restart the agent for changes to take effect.`)
}
