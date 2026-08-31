/**
 * mergeBranchToTarget 真实 git 集成测试（不注入 FakeGitRunner，直接操作临时真仓库）：
 * - 主仓库检出 base 且干净 → 真实 `git merge --no-ff`：base 指向双父合并提交，工作区为合并后内容且 status 干净；
 * - 主仓库检出 base 但有未提交改动 → blockedMessage 非空，base 引用未动，本地改动原样保留；
 * - base 被另一个 linked worktree 检出 → blockedMessage 非空，base 引用未动。
 *
 * 运行：bun test tests/git.merge-real.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { __setGitRunner, mergeBranchToTarget } from "../src/core/git"

const tempDirs: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" })
}

function commitFile(repo: string, file: string, content: string, message: string): void {
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
  return dir
}

/** 建 feature 分支（领先 main 一个提交）后回到 main。 */
function makeFeatureBranch(repo: string): void {
  git(repo, "checkout", "-b", "feature")
  commitFile(repo, "feature.txt", "feature content\n", "add feature")
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
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  test("主仓库检出 base 但有未提交改动 → blockedMessage、base 引用未动、改动原样保留", async () => {
    const repo = initRepo()
    makeFeatureBranch(repo)
    writeFileSync(join(repo, "base.txt"), "local uncommitted\n")

    const before = mainOid(repo)
    const r = await mergeBranchToTarget(repo, "feature", "main")

    expect(r.success).toBe(false)
    expect(r.conflict).toBe(false)
    expect(r.blockedMessage).toBeTruthy()
    expect(r.blockedMessage).toContain("`git merge feature`")
    // 零副作用：base 引用未动，本地未提交改动原样保留
    expect(mainOid(repo)).toBe(before)
    expect(readFileSync(join(repo, "base.txt"), "utf-8")).toBe("local uncommitted\n")
    expect(git(repo, "status", "--porcelain")).toContain("base.txt")
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
