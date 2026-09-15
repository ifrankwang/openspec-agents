/**
 * mergeBranchToTarget 真实 git 集成测试（不注入 FakeGitRunner，直接操作临时真仓库）：
 * - 主仓库检出 base 且干净 → 真实 `git merge --no-ff`：base 指向双父合并提交，工作区为合并后内容且 status 干净；
 * - 拟合合并分流（主仓库检出目标分支）：先 merge-tree 内存试算，无冲突时按「合并将写入文件 ↔ 脏文件」重合判定：
 *   - 无重合未暂存改动 / 无重合未跟踪文件 → 真实合并成功且脏内容原样保留；
 *   - 无重合完整暂存 → restore --staged → merge → add 无损还原（暂存态与内容均保留）；
 *   - 重合（未暂存改写入文件 / 未跟踪占位写入文件 / 未跟踪目录覆盖写入路径 / 目录与文件同名）→
 *     blockedMessage 列重合文件、base 引用未动、本地内容原样保留；
 *   - 部分暂存 → blockedMessage、零副作用；
 * - base 被另一个 linked worktree 检出 → blockedMessage 非空，base 引用未动。
 *
 * 运行：bun test tests/git.merge-real.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

import { __setGitRunner, mergeBranchToTarget } from "../src/core/git"

const tempDirs: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim()
}

function commitFile(repo: string, file: string, content: string, message: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
  git(repo, "add", file)
  git(repo, "commit", "-m", message)
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "opx-merge-real-"))
  tempDirs.push(dir)
  git(dir, "init", "-b", "main")
  git(dir, "config", "user.email", "opx-test@example.com")
  git(dir, "config", "user.name", "opx-test")
  commitFile(dir, "base.txt", "base\n", "init")
  commitFile(dir, "notes.md", "notes\n", "add notes")
  return dir
}

/** 建 feature 分支（新增 feature.txt、修改 base.txt，可附带更多新增文件）后回到 main。 */
function makeFeatureBranch(repo: string, extraFiles: string[] = []): void {
  git(repo, "checkout", "-b", "feature")
  commitFile(repo, "feature.txt", "feature content\n", "add feature")
  commitFile(repo, "base.txt", "base+feature\n", "touch base")
  for (const f of extraFiles) commitFile(repo, f, `content of ${f}\n`, `add ${f}`)
  git(repo, "checkout", "main")
}

function mainOid(repo: string): string {
  return git(repo, "rev-parse", "refs/heads/main").trim()
}

afterEach(() => {
  // 复位 runner 注入：防其它用例的 FakeGitRunner 泄漏进本文件，也防本文件影响后续用例
  __setGitRunner(null)
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

describe("mergeBranchToTarget 真实 git 集成", () => {

  test("主仓库检出 base 且干净 → 真实合并：base 双父推进、工作区为合并后内容且干净", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r.success).toBe(true)
    expect(r.conflict).toBe(false)
    expect(r.blockedMessage).toBeUndefined()
    // base 指向新的双父合并提交
    expect(mainOid(repo)).not.toBe(before)
    const parents = git(repo, "rev-list", "--parents", "-n", "1", "main").trim().split(" ")
    expect(parents.length).toBe(3)
    expect(parents.slice(1)).toContain(before)
    // 检出方同步：工作区文件为合并后内容，暂存区/工作区干净
    expect(readFileSync(join(repo, "feature.txt"), "utf-8")).toBe("feature content\n")
    expect(readFileSync(join(repo, "base.txt"), "utf-8")).toBe("base+feature\n")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  test("未暂存改动与合并写入无重合 → 真实合并成功，脏文件原样保留", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)
    writeFileSync(join(repo, "notes.md"), "local uncommitted\n")

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r).toEqual({ success: true, conflict: false })
    expect(mainOid(repo)).not.toBe(before)
    // 合并内容落位 + 无关脏文件保留
    expect(readFileSync(join(repo, "base.txt"), "utf-8")).toBe("base+feature\n")
    expect(readFileSync(join(repo, "notes.md"), "utf-8")).toBe("local uncommitted\n")
    // helper 已 trim：未暂存修改条目 " M notes.md" 的断言形态
    expect(git(repo, "status", "--porcelain")).toBe("M notes.md")
  })

  test("未跟踪文件与合并写入无重合 → 真实合并成功，未跟踪文件保留", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)
    writeFileSync(join(repo, "scratch.txt"), "scratch\n")

    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r).toEqual({ success: true, conflict: false })
    expect(readFileSync(join(repo, "scratch.txt"), "utf-8")).toBe("scratch\n")
    expect(git(repo, "status", "--porcelain")).toBe("?? scratch.txt")
  })

  test("未暂存改动与合并写入重合 → blockedMessage 列重合文件、零副作用", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)
    // 合并写入 base.txt（feature 侧修改），本地也有 base.txt 未暂存改动
    writeFileSync(join(repo, "base.txt"), "local conflict\n")
    writeFileSync(join(repo, "notes.md"), "local uncommitted\n")

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r.success).toBe(false)
    expect(r.conflict).toBe(false)
    expect(r.blockedMessage).toBeTruthy()
    expect(r.blockedMessage).toContain("base.txt")
    // 未重合脏文件不进重合清单
    expect(r.blockedMessage).not.toContain("notes.md")
    expect(r.blockedMessage).toContain("`git merge feature`")
    // 零副作用：base 引用未动，本地改动原样保留
    expect(mainOid(repo)).toBe(before)
    expect(readFileSync(join(repo, "base.txt"), "utf-8")).toBe("local conflict\n")
    expect(git(repo, "status", "--porcelain")).toContain("base.txt")
  })

  test("未跟踪文件占位合并新增文件 → blockedMessage、占位内容保留", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)
    // feature 将新增 feature.txt，本地未跟踪同名文件占位
    writeFileSync(join(repo, "feature.txt"), "untracked placeholder\n")

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r.success).toBe(false)
    expect(r.conflict).toBe(false)
    expect(r.blockedMessage).toContain("feature.txt")
    expect(mainOid(repo)).toBe(before)
    expect(readFileSync(join(repo, "feature.txt"), "utf-8")).toBe("untracked placeholder\n")
  })

  test("未跟踪目录覆盖合并写入路径 → blockedMessage（前缀匹配）", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo, ["out/report.txt"])
    // 本地未跟踪目录 out/ 与合并将写入的 out/report.txt 重合
    mkdirSync(join(repo, "out"))
    writeFileSync(join(repo, "out", "local.txt"), "local\n")

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r.success).toBe(false)
    expect(r.conflict).toBe(false)
    expect(r.blockedMessage).toContain("out/report.txt")
    expect(mainOid(repo)).toBe(before)
    expect(readFileSync(join(repo, "out", "local.txt"), "utf-8")).toBe("local\n")
  })

  test("未跟踪目录与写入文件同名 → blockedMessage（双向判定）", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo, ["gen"])
    // feature 将新增文件 gen，本地存在未跟踪目录 gen/（目录/文件同名冲突）
    mkdirSync(join(repo, "gen"))
    writeFileSync(join(repo, "gen", "seed.txt"), "seed\n")

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r.success).toBe(false)
    expect(r.conflict).toBe(false)
    expect(r.blockedMessage).toContain("gen")
    expect(mainOid(repo)).toBe(before)
    expect(readFileSync(join(repo, "gen", "seed.txt"), "utf-8")).toBe("seed\n")
  })

  test("完整暂存且与合并写入无重合 → 合并成功且暂存态无损还原", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)
    writeFileSync(join(repo, "notes.md"), "local staged\n")
    git(repo, "add", "notes.md")
    expect(git(repo, "status", "--porcelain")).toBe("M  notes.md")

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r).toEqual({ success: true, conflict: false })
    expect(mainOid(repo)).not.toBe(before)
    // 暂存态还原：notes.md 仍为已暂存修改，内容为用户本地编辑；合并内容照常落位
    expect(git(repo, "status", "--porcelain")).toBe("M  notes.md")
    expect(readFileSync(join(repo, "notes.md"), "utf-8")).toBe("local staged\n")
    expect(readFileSync(join(repo, "base.txt"), "utf-8")).toBe("base+feature\n")
  })

  test("部分暂存（同文件既有已暂存又有未暂存改动）→ blockedMessage、零副作用", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)
    writeFileSync(join(repo, "notes.md"), "step1\n")
    git(repo, "add", "notes.md")
    writeFileSync(join(repo, "notes.md"), "step1+step2\n")
    expect(git(repo, "status", "--porcelain")).toBe("MM notes.md")

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r.success).toBe(false)
    expect(r.conflict).toBe(false)
    expect(r.blockedMessage).toBeTruthy()
    expect(r.blockedMessage).toContain("部分暂存")
    // 零副作用：引用未动，暂存/未暂存内容原样保留
    expect(mainOid(repo)).toBe(before)
    expect(git(repo, "status", "--porcelain")).toBe("MM notes.md")
    expect(readFileSync(join(repo, "notes.md"), "utf-8")).toBe("step1+step2\n")
  })

  test("base 被另一个 linked worktree 检出 → blockedMessage、base 引用未动", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)
    // 主仓库让出 main，改检出自建分支；再以 linked worktree 检出 main
    git(repo, "checkout", "-b", "dev")
    const linkedWt = `${repo}-linked`
    git(repo, "worktree", "add", linkedWt, "main")
    tempDirs.push(linkedWt)

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r.success).toBe(false)
    expect(r.conflict).toBe(false)
    expect(r.blockedMessage).toBeTruthy()
    expect(r.blockedMessage).toContain(realpathSync(linkedWt))
    expect(r.blockedMessage).toContain("`git merge feature`")
    expect(mainOid(repo)).toBe(before)
  })
})
