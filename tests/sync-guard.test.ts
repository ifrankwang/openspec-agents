/**
 * scripts/sync.ts 写入守卫测试。
 *
 * 复现的事故：在 git worktree 中运行时，profile 里「指向主仓库的软链」realpath 与当前 PROJECT_ROOT 不等，
 * 旧的「只排除当前 checkout」判定放行，rsync -a --delete 跟随软链覆写主仓库工作区并删除大量已跟踪文件。
 *
 * 本文件全部在临时目录（os.tmpdir 下自建目录树）里造样本，只调用导出的守卫/发现函数，
 * 不触碰真实 profile（不读 HOME，不写 ~/.dsh、~/.cache、~/.claude 等），不依赖本机 DSH 安装。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  assertSafeSyncPair,
  checkSyncDestination,
  findDshLinkedInstalls,
  findDshProfileTargets,
  findOpenCodeTargets,
  isSourceCheckoutRoot,
  rsync,
  syncTarget,
} from "../scripts/sync"
import type { SyncTarget } from "../scripts/sync-targets"

const PKG_NAME = "@ifrankwang/openspec-agents"
const PROJECT_ROOT = resolve(import.meta.dir, "..")
const SENTINEL = "SENTINEL-tracked-file"

let tmpRoot = ""

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sync-guard-"))
})

afterEach(() => {
  // rmSync 对软链只删链接本身，不会递归进 PROJECT_ROOT 等链接目标
  rmSync(tmpRoot, { recursive: true, force: true })
})

function writePackageJson(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: PKG_NAME, version: "0.0.0", dsh: { bundle: { patch: "./dsh/cordis.patch.yml" } } }, null, 2)}\n`,
  )
}

/** 造一个「源码 checkout」样本：带 .git（目录形态或 worktree 的文件形态）+ 包清单 + 哨兵文件。 */
function makeCheckout(dir: string, gitEntry: "dir" | "file" = "dir"): void {
  writePackageJson(dir)
  if (gitEntry === "dir") {
    mkdirSync(join(dir, ".git"), { recursive: true })
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n")
  } else {
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/sample\n")
  }
  writeFileSync(join(dir, SENTINEL), "keep me\n")
}

/** 造一个「真实实体安装目录」样本：无 .git，只有包清单与安装内容。 */
function makeEntityInstall(dir: string): void {
  writePackageJson(dir)
  writeFileSync(join(dir, "installed-bundle.mjs"), "// installed\n")
}

/** 在 node_modules/<pkg> 位置放软链，返回该路径。 */
function linkInstallAt(profilesRoot: string, profile: string, target: string): string {
  const installPath = join(profilesRoot, profile, "node_modules", PKG_NAME)
  mkdirSync(dirname(installPath), { recursive: true })
  symlinkSync(target, installPath, "dir")
  return installPath
}

/** 在 node_modules/<pkg> 位置放真实实体安装目录，返回该路径。 */
function entityInstallAt(profilesRoot: string, profile: string): string {
  const installPath = join(profilesRoot, profile, "node_modules", PKG_NAME)
  makeEntityInstall(installPath)
  return installPath
}

function captureWarn(fn: () => void): string[] {
  const warns: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(" "))
  }
  try {
    fn()
  } finally {
    console.warn = orig
  }
  return warns
}

describe("同步守卫：源码仓库识别", () => {
  test(".git 为目录的 checkout 被识别", () => {
    const victim = join(tmpRoot, "victim-repo")
    makeCheckout(victim, "dir")
    expect(isSourceCheckoutRoot(victim)).toBe(true)
    expect(checkSyncDestination(victim).safe).toBe(false)
  })

  test(".git 为文件的 checkout（git worktree 形态）被识别", () => {
    const victim = join(tmpRoot, "victim-worktree")
    makeCheckout(victim, "file")
    expect(isSourceCheckoutRoot(victim)).toBe(true)
    expect(checkSyncDestination(victim).safe).toBe(false)
  })

  test("真实实体安装目录不是 checkout，判定安全", () => {
    const install = join(tmpRoot, "profiles", "desktop", "node_modules", PKG_NAME)
    makeEntityInstall(install)
    expect(isSourceCheckoutRoot(install)).toBe(false)
    const verdict = checkSyncDestination(install, join(tmpRoot, "profiles"))
    expect(verdict.safe).toBe(true)
    expect(verdict.realPath).toBe(realpathSync(install))
  })

  test("指向别的 checkout 的软链 → 不安全，原因是源码仓库", () => {
    const victim = join(tmpRoot, "victim-repo")
    makeCheckout(victim)
    const profilesRoot = join(tmpRoot, "profiles")
    const link = linkInstallAt(profilesRoot, "web", victim)
    const verdict = checkSyncDestination(link, profilesRoot)
    expect(verdict.safe).toBe(false)
    expect(verdict.reason).toContain("源码仓库")
    expect(verdict.realPath).toBe(realpathSync(victim))
  })

  test("位于别的 checkout 之内的目录 → 不安全", () => {
    const victim = join(tmpRoot, "victim-repo")
    makeCheckout(victim)
    const inside = join(victim, "packages", "openspec-agents")
    makeEntityInstall(inside)
    const verdict = checkSyncDestination(inside)
    expect(verdict.safe).toBe(false)
    expect(verdict.reason).toContain("位于源码仓库")
  })

  test("指向普通目录（非 checkout）的软链 → 不安全（写入会落到链接目标）", () => {
    const store = join(tmpRoot, "store-pkg")
    makeEntityInstall(store)
    const profilesRoot = join(tmpRoot, "profiles")
    const link = linkInstallAt(profilesRoot, "web", store)
    const verdict = checkSyncDestination(link, profilesRoot)
    expect(verdict.safe).toBe(false)
    expect(verdict.reason).toContain("软链")
  })

  test("扫描根之上的 .git（如 home 是 dotfiles 仓库）不会误伤根内的实体安装目录", () => {
    const homeLike = join(tmpRoot, "homelike")
    mkdirSync(join(homeLike, ".git"), { recursive: true })
    const profilesRoot = join(homeLike, "profiles")
    const install = join(profilesRoot, "desktop", "node_modules", PKG_NAME)
    makeEntityInstall(install)
    expect(checkSyncDestination(install, profilesRoot).safe).toBe(true)
  })
})

describe("同步守卫：源/目标关系", () => {
  test("源与目标相同 → 中止", () => {
    const src = join(tmpRoot, "src")
    mkdirSync(src, { recursive: true })
    expect(() => assertSafeSyncPair(src, src)).toThrow(/同一目录/)
  })

  test("目标位于源之内 → 中止", () => {
    const src = join(tmpRoot, "src")
    const dest = join(src, "dist", "bundle")
    mkdirSync(dest, { recursive: true })
    expect(() => assertSafeSyncPair(src, dest)).toThrow(/目标位于源之内/)
  })

  test("源位于目标之内 → 中止", () => {
    const dest = join(tmpRoot, "dest")
    const src = join(dest, "dist", "bundle")
    mkdirSync(src, { recursive: true })
    expect(() => assertSafeSyncPair(src, dest)).toThrow(/源位于目标之内/)
  })

  test("互不相干的同级目录 → 放行", () => {
    const src = join(tmpRoot, "src")
    const dest = join(tmpRoot, "dest")
    mkdirSync(src, { recursive: true })
    mkdirSync(dest, { recursive: true })
    expect(() => assertSafeSyncPair(src, dest)).not.toThrow()
  })
})

describe("同步守卫：写入收口 rsync", () => {
  test("目标是源码仓库 → 中止且不执行 rsync（spawnSync 之前就抛错）", () => {
    const victim = join(tmpRoot, "victim-repo")
    makeCheckout(victim)
    const src = join(tmpRoot, "fake-plugin-src")
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, "bundle.mjs"), "// bundle\n")

    expect(() => rsync(src, victim)).toThrow(/源码仓库/)
    // 中止发生在真正执行 rsync 之前：victim 内容原样未改
    expect(readFileSync(join(victim, SENTINEL), "utf8")).toBe("keep me\n")
    expect(existsSync(join(victim, "bundle.mjs"))).toBe(false)
  })
})

describe("同步守卫：发现阶段过滤 dsh-profile", () => {
  test("指向别的 checkout 的软链被 WARN 跳过，实体安装目录保留", () => {
    const victim = join(tmpRoot, "victim-repo")
    makeCheckout(victim)
    const profilesRoot = join(tmpRoot, "profiles")
    const foreignLink = linkInstallAt(profilesRoot, "web", victim)
    const entityInstall = entityInstallAt(profilesRoot, "desktop")

    let targets: string[] = []
    const warns = captureWarn(() => {
      targets = findDshProfileTargets([profilesRoot], PKG_NAME)
    })

    expect(targets).toEqual([entityInstall])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("WARN")
    expect(warns[0]).toContain(foreignLink)
    expect(warns[0]).toContain("源码仓库")
    expect(warns[0]).toContain("跳过以免")
  })

  test("指向本 checkout 自己的软链走 link 安装路径：不进 rsync 目标、不 WARN", () => {
    const profilesRoot = join(tmpRoot, "profiles")
    const ownLink = linkInstallAt(profilesRoot, "cli", PROJECT_ROOT)

    expect(findDshLinkedInstalls([profilesRoot], PKG_NAME)).toEqual([ownLink])
    let targets: string[] = []
    const warns = captureWarn(() => {
      targets = findDshProfileTargets([profilesRoot], PKG_NAME)
    })
    expect(targets).toEqual([])
    expect(warns).toEqual([])
  })

  test("syncTarget：只有「指向别的 checkout 的软链」时同步数为 0，victim 未被覆写", () => {
    const victim = join(tmpRoot, "victim-repo")
    makeCheckout(victim)
    const profilesRoot = join(tmpRoot, "profiles")
    linkInstallAt(profilesRoot, "web", victim)

    const target: SyncTarget = {
      harness: "deepseek-harness",
      kind: "dsh-profile",
      build: "deepseek-harness",
      packageName: PKG_NAME,
      cacheRoots: [profilesRoot],
    }
    let found = -1
    const warns = captureWarn(() => {
      found = syncTarget(target)
    })

    expect(found).toBe(0)
    expect(warns.some((w) => w.includes("源码仓库"))).toBe(true)
    expect(readFileSync(join(victim, SENTINEL), "utf8")).toBe("keep me\n")
    expect(existsSync(join(victim, "installed-bundle.mjs"))).toBe(false)
  })
})

describe("同步守卫：发现阶段过滤 source-cache", () => {
  test("source-cache 分支同样拒绝「指向别的 checkout 的软链」", () => {
    const victim = join(tmpRoot, "victim-repo")
    makeCheckout(victim)
    const cacheRoot = join(tmpRoot, "opencode", "npm")
    const installPath = join(cacheRoot, "@ifrankwang", "openspec-agents@0.0.0", "1700000000000", "node_modules", PKG_NAME)
    mkdirSync(dirname(installPath), { recursive: true })
    symlinkSync(victim, installPath, "dir")

    let targets: string[] = []
    const warns = captureWarn(() => {
      targets = findOpenCodeTargets([cacheRoot])
    })
    expect(targets).toEqual([])
    expect(warns.some((w) => w.includes("源码仓库"))).toBe(true)

    const target: SyncTarget = { harness: "opencode", kind: "source-cache", cacheRoots: [cacheRoot] }
    let found = -1
    const warns2 = captureWarn(() => {
      found = syncTarget(target)
    })
    expect(found).toBe(0)
    expect(warns2.some((w) => w.includes("源码仓库"))).toBe(true)
    expect(readFileSync(join(victim, SENTINEL), "utf8")).toBe("keep me\n")
  })

  test("source-cache：实体安装目录仍被发现（正常行为不变）", () => {
    const cacheRoot = join(tmpRoot, "opencode", "npm")
    const installPath = join(cacheRoot, "@ifrankwang", "openspec-agents@0.0.0", "1700000000000", "node_modules", PKG_NAME)
    makeEntityInstall(installPath)
    let targets: string[] = []
    const warns = captureWarn(() => {
      targets = findOpenCodeTargets([cacheRoot])
    })
    expect(targets).toEqual([installPath])
    expect(warns).toEqual([])
  })
})

