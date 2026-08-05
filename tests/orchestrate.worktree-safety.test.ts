/**
 * 编排 worktree 安全测试：
 * - set_worktree 分支安全守卫（merge 失败 + 有本地提交 → 复用，无本地提交 → 清理重建）
 * - init recovery 条件清空 worktree 引用（仅 task_analysis 清空，dev_impl 保留）
 * - quality_review_submit 并发写锁（并行 reviewer 各自 issue/verdict 均保留）
 *
 * 运行：bun test
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner, detectMainRepoPollution, type GitRunner } from "../src/core/git"
import { acquireLock, releaseLock, getLockPath, writeState } from "../src/core/state"
import type { OrchestrateState } from "../src/core/types"
import {
  init, set_worktree, arch_submit, dev_submit, status,
  tool_review_submit, task_review_submit, quality_review_submit
} from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-wtsafe"
afterAll(() => { __setGitRunner(null) })

function freshWt(root: string): string {
  const id = `wts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = join(root, id, "w")
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n\n## 2. G2\n\n- [ ] 2.1 T3\n`,
    "utf-8"
  )
  return wt
}

function readStateSync(wt: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

function findTg(wt: string): any {
  return readStateSync(wt).taskGroups.find((g: any) => g.id === "1")
}

/** init → arch_submit → set_worktree → dev_submit → recovery review → tool/task 通过（review 就绪）。
 *  注：真实推荐时序为 init → set_worktree → arch_submit → dev_submit（set_worktree 无阶段守卫，G1 已验证）；
 *  本 helper 中 arch_submit 先于 set_worktree 属兼容路径验证。 */
async function setupThroughReviewReady(wt: string, fakeGit: FakeGitRunner): Promise<void> {
  const o = makeCtx("openspec-orchestrator", wt)
  const a = makeCtx("openspec-architect", wt)
  const d = makeCtx("openspec-developer", wt)
  const toolR = makeCtx("openspec-reviewer-tool", wt)
  const taskR = makeCtx("openspec-reviewer-task", wt)

  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await arch_submit.execute({ change_id: CID, outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, a)
  await set_worktree.execute({ change_id: CID }, o)
  const devWt = findTg(wt).worktreePath
  await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

  await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, o)
  await set_worktree.execute({ change_id: CID }, o)
  await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
  await task_review_submit.execute({ change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
}

// ════════════════════════════════════════════════════════════════
//  Behavior 1: set_worktree 分支安全守卫
// ════════════════════════════════════════════════════════════════

describe("W1. set_worktree 分支安全守卫", () => {

  // W1.1 merge 失败 + 分支有本地提交 → 复用不删分支，baseRef 重算
  test("已有 worktree 分叉 + revListCount>0 → 复用不删分支", async () => {
    const root = `/tmp/wts-w1a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const first = await set_worktree.execute({ change_id: CID }, o)
    expect(first).toContain("已创建 worktree")

    const existingPath = findTg(wt).worktreePath
    fakeGit.forceMergeFailure = true
    fakeGit.revListCount = 5

    const second = await set_worktree.execute({ change_id: CID }, o)
    expect(second).toContain("复用已有 worktree")

    expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)

    const tg = findTg(wt)
    expect(tg.worktreePath).toBe(existingPath)
    expect(tg.branchName).toBe(`task-group/${CID}/1`)
    expect(tg.baseRef).toBe(fakeGit.baseRef)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // W1.2 merge 失败 + 分支无本地提交 → 删除重建
  test("已有 worktree 分叉 + revListCount=0 → 删除重建", async () => {
    const root = `/tmp/wts-w1b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const first = await set_worktree.execute({ change_id: CID }, o)
    expect(first).toContain("已创建 worktree")

    const existingPath = findTg(wt).worktreePath
    fakeGit.forceMergeFailure = true
    fakeGit.revListCount = 0

    const second = await set_worktree.execute({ change_id: CID }, o)
    expect(second).toContain("已创建 worktree")

    expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(true)

    const tg = findTg(wt)
    expect(tg.worktreePath).toBe(existingPath)
    expect(tg.baseRef).toBe(fakeGit.baseRef)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 2: init recovery 条件清空 worktree 引用
// ════════════════════════════════════════════════════════════════

describe("W2. init recovery 条件清空 worktree 引用", () => {

  // W2.1 recovery 到 dev_impl → 保留原 worktree 引用
  test("recovery dev_impl → worktreePath/branchName/baseRef 保留", async () => {
    const root = `/tmp/wts-w2a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
      makeCtx("openspec-architect", wt))
    await set_worktree.execute({ change_id: CID }, o)

    const orig = findTg(wt)
    expect(orig.worktreePath).not.toBeNull()
    expect(orig.baseRef).not.toBeNull()

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "dev_impl" } }, o)

    const tg = findTg(wt)
    expect(tg.worktreePath).toBe(orig.worktreePath)
    expect(tg.branchName).toBe(orig.branchName)
    expect(tg.baseRef).toBe(orig.baseRef)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // W2.2 recovery 到 task_analysis → 仍清空 worktree 引用
  test("recovery task_analysis → worktreePath/branchName/baseRef 清空", async () => {
    const root = `/tmp/wts-w2b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
      makeCtx("openspec-architect", wt))
    await set_worktree.execute({ change_id: CID }, o)

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "task_analysis" } }, o)

    const tg = findTg(wt)
    expect(tg.worktreePath).toBeNull()
    expect(tg.branchName).toBeNull()
    expect(tg.baseRef).toBeNull()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 3: quality_review_submit 并发写锁
// ════════════════════════════════════════════════════════════════

describe("W3. quality_review_submit 并发写锁", () => {

  // W3.1 两个 quality reviewer 并行提交 → 各自维度 verdict 和 issue 均保留
  test("两个 quality reviewer 并行提交 → verdict 与 issue 均保留", async () => {
    const root = `/tmp/wts-w3a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupThroughReviewReady(wt, fakeGit)

    const styleCtx = makeCtx("openspec-reviewer-style", wt)
    const archCtx = makeCtx("openspec-reviewer-architecture", wt)

    const [r1, r2] = await Promise.all([
      quality_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "src/style.java", line: 1, description: "Style 并发 issue", suggestion: "修 style" }],
        fixed_issue_ids: [] }, styleCtx),
      quality_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "src/arch.java", line: 1, description: "Arch 并发 issue", suggestion: "修 arch" }],
        fixed_issue_ids: [] }, archCtx),
    ])

    expect(r1).toContain("已提交")
    expect(r2).toContain("已提交")

    const tg = findTg(wt)
    expect(tg.phases.review.quality.progress.style).toBe("failed")
    expect(tg.phases.review.quality.progress.architecture).toBe("failed")
    const descs = tg.issues.map((i: any) => i.description)
    expect(descs).toContain("Style 并发 issue")
    expect(descs).toContain("Arch 并发 issue")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // W3.2 持锁期间重复提交同一维度 → 抛错
  test("同一维度重复提交 → 抛错", async () => {
    const root = `/tmp/wts-w3b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupThroughReviewReady(wt, fakeGit)

    const styleCtx = makeCtx("openspec-reviewer-style", wt)
    const first = await quality_review_submit.execute({ change_id: CID, passed: true, issues: [] }, styleCtx)
    expect(first).toContain("已提交")

    await expect(
      quality_review_submit.execute({ change_id: CID, passed: true, issues: [] }, styleCtx)
    ).rejects.toThrow(/不允许重复提交/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 4: 锁函数 acquire/release
// ════════════════════════════════════════════════════════════════

describe("W4. 锁函数 acquire/release", () => {
  test("acquire → 并发 acquire 超时 → release 后可重新 acquire", async () => {
    const lockPath = join("/tmp", `wts-lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)

    await acquireLock(lockPath)
    await expect(acquireLock(lockPath, 200)).rejects.toThrow(/超时/)
    releaseLock(lockPath)

    await acquireLock(lockPath)
    releaseLock(lockPath)

    try { rmSync(lockPath, { recursive: true, force: true }) } catch {}
  })

  // W4.2 存活锁（age < stale 阈值）不被清理，仍按超时拒绝
  test("存活锁不被 stale 清理 → 按超时拒绝", async () => {
    const lockPath = join("/tmp", `wts-alive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)

    await acquireLock(lockPath)
    await expect(acquireLock(lockPath, 200)).rejects.toThrow(/超时/)

    const meta = JSON.parse(readFileSync(join(lockPath, "meta.json"), "utf-8"))
    expect(meta.pid).toBe(process.pid)
    releaseLock(lockPath)

    try { rmSync(lockPath, { recursive: true, force: true }) } catch {}
  })

  // W4.3 stale 锁（age ≥ stale 阈值）被自动清理并重新获取，meta 更新为当前持有者
  test("stale 锁超时后自动清理并可重新获取", async () => {
    const lockPath = join("/tmp", `wts-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(
      join(lockPath, "meta.json"),
      JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 60000 })
    )

    await acquireLock(lockPath, 200)

    const meta = JSON.parse(readFileSync(join(lockPath, "meta.json"), "utf-8"))
    expect(meta.pid).toBe(process.pid)
    releaseLock(lockPath)

    try { rmSync(lockPath, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 5: 锁路径与 state 写入目录归一化一致
// ════════════════════════════════════════════════════════════════

describe("W5. 锁路径 worktree 归一化", () => {
  test("getLockPath 对 worktree 与非 worktree 返回同一目录，且与 writeState 目标一致", async () => {
    const base = join("/tmp", `wts-lockpath-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    const mainRepo = join(base, "main")
    const worktreeDir = join(base, "worktree")
    mkdirSync(join(mainRepo, ".git", "worktrees", "wt"), { recursive: true })
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${join(mainRepo, ".git", "worktrees", "wt")}`)

    const fromMain = await getLockPath(mainRepo, CID)
    const fromWorktree = await getLockPath(worktreeDir, CID)
    expect(fromWorktree).toBe(fromMain)
    expect(fromMain).toBe(join(mainRepo, ".opencode", ".orchestrate_state", `${CID}.review.lock`))

    const sampleState: OrchestrateState = {
      changeId: CID,
      isolationNamespace: "a1b2c3",
      taskGroupId: "1",
      baseBranch: "main",
      taskGroups: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeState(worktreeDir, sampleState)
    expect(existsSync(join(mainRepo, ".opencode", ".orchestrate_state", `${CID}.json`))).toBe(true)
    expect(existsSync(join(worktreeDir, ".opencode", ".orchestrate_state", `${CID}.json`))).toBe(false)

    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 6: 工具层 worktree 路径校验
// ════════════════════════════════════════════════════════════════

/** init → arch_submit → set_worktree → dev_submit，停在 review 阶段且 tool 层未提交 */
async function setupToToolReview(wt: string, fakeGit: FakeGitRunner): Promise<void> {
  const o = makeCtx("openspec-orchestrator", wt)
  const a = makeCtx("openspec-architect", wt)
  const d = makeCtx("openspec-developer", wt)
  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await arch_submit.execute({ change_id: CID, outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, a)
  await set_worktree.execute({ change_id: CID }, o)
  await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
}

describe("W6. 工具层 worktree 路径校验", () => {

  test("tool_review_submit：issue 文件绝对路径逃逸到 worktree 外 → 拒绝", async () => {
    const root = `/tmp/wts-w6a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToToolReview(wt, fakeGit)
    expect(findTg(wt).worktreePath).not.toBeNull()

    await expect(
      tool_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ dimension: "style", severity: "Low", file: "/etc/passwd", line: 1, description: "越界", suggestion: "x" }],
        fixed_issue_ids: [] }, makeCtx("openspec-reviewer-tool", wt))
    ).rejects.toThrow(/超出/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("tool_review_submit：issue 文件用 .. 逃逸到 worktree 外 → 拒绝", async () => {
    const root = `/tmp/wts-w6b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToToolReview(wt, fakeGit)

    await expect(
      tool_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ dimension: "style", severity: "Low", file: "../../main.java", line: 1, description: "越界", suggestion: "x" }],
        fixed_issue_ids: [] }, makeCtx("openspec-reviewer-tool", wt))
    ).rejects.toThrow(/超出/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("tool_review_submit：issue 文件在 worktree 内 → 正常接受", async () => {
    const root = `/tmp/wts-w6c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToToolReview(wt, fakeGit)
    const wtPath = findTg(wt).worktreePath
    const result = await tool_review_submit.execute({ change_id: CID, passed: false,
      issues: [{ dimension: "style", severity: "Low", file: "src/ok.java", line: 1, description: "界内", suggestion: "x" }],
      fixed_issue_ids: [] }, makeCtx("openspec-reviewer-tool", wt))
    expect(result).not.toContain("超出")
    expect(findTg(wt).worktreePath).toBe(wtPath)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("task_review_submit：issue 文件路径在 worktree 外 → 拒绝", async () => {
    const root = `/tmp/wts-w6d-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToToolReview(wt, fakeGit)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] },
      makeCtx("openspec-reviewer-tool", wt))

    await expect(
      task_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "/opt/evil.java", line: 1, description: "越界", suggestion: "x" }],
        verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] },
        makeCtx("openspec-reviewer-task", wt))
    ).rejects.toThrow(/超出/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("quality_review_submit：issue 文件路径在 worktree 外 → 拒绝", async () => {
    const root = `/tmp/wts-w6e-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupThroughReviewReady(wt, fakeGit)

    await expect(
      quality_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "/etc/evil.java", line: 1, description: "越界", suggestion: "x" }],
        fixed_issue_ids: [] }, makeCtx("openspec-reviewer-style", wt))
    ).rejects.toThrow(/超出/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 7: set_worktree 自定义路径准入
// ════════════════════════════════════════════════════════════════

describe("W7. set_worktree 自定义路径准入", () => {

  test("worktree_path 在 ctx.worktree 之外 → 拒绝", async () => {
    const root = `/tmp/wts-w7a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await expect(
      set_worktree.execute({ change_id: CID, worktree_path: "/tmp/outside-worktree" }, o)
    ).rejects.toThrow(/超出/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("worktree_path 用 .. 逃逸到 ctx.worktree 之外 → 拒绝", async () => {
    const root = `/tmp/wts-w7b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await expect(
      set_worktree.execute({ change_id: CID, worktree_path: join(wt, "..", "evil") }, o)
    ).rejects.toThrow(/超出/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("worktree_path 在 ctx.worktree 内 → 正常创建", async () => {
    const root = `/tmp/wts-w7c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const custom = join(wt, ".worktree", "custom")
    const result = await set_worktree.execute({ change_id: CID, worktree_path: custom }, o)
    expect(result).toContain("已创建 worktree")
    expect(findTg(wt).worktreePath).toBe(custom)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 8: 主仓库 openspec 污染诊断
// ════════════════════════════════════════════════════════════════

function fakeWorktreePointingToMain(base: string): { mainRepo: string; wt: string } {
  const mainRepo = join(base, "main")
  const wt = join(base, "wt")
  mkdirSync(join(mainRepo, ".git", "worktrees", "wt"), { recursive: true })
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(join(wt, ".git"), `gitdir: ${join(mainRepo, ".git", "worktrees", "wt")}`)
  return { mainRepo, wt }
}

describe("W8. 主仓库 openspec 污染诊断", () => {

  test("主仓库 openspec 有未提交变更 → 返回 repoRoot 与文件清单", async () => {
    const base = join("/tmp", `wts-w8a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    const { mainRepo, wt } = fakeWorktreePointingToMain(base)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    fakeGit.dirtyPaths.add(`${mainRepo}-openspec`)

    const result = await detectMainRepoPollution(wt)
    expect(result).not.toBeNull()
    expect(result!.repoRoot).toBe(mainRepo)
    expect(result!.files).toContain("openspec/changes/foo/tasks.md")

    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })

  test("主仓库 openspec 干净 → null", async () => {
    const base = join("/tmp", `wts-w8b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    const { wt } = fakeWorktreePointingToMain(base)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const result = await detectMainRepoPollution(wt)
    expect(result).toBeNull()

    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })

  test("主仓库干净（.git 为目录）→ null", async () => {
    const base = join("/tmp", `wts-w8c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    const mainRepo = join(base, "main")
    mkdirSync(join(mainRepo, ".git"), { recursive: true })
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const result = await detectMainRepoPollution(mainRepo)
    expect(result).toBeNull()

    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })

  test("主仓库（.git 为目录）污染检测：repoRoot 取自身", async () => {
    const base = join("/tmp", `wts-w8d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    const mainRepo = join(base, "main")
    mkdirSync(join(mainRepo, ".git"), { recursive: true })
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    fakeGit.dirtyPaths.add(`${mainRepo}-openspec`)

    const result = await detectMainRepoPollution(mainRepo)
    expect(result).not.toBeNull()
    expect(result!.repoRoot).toBe(mainRepo)
    expect(result!.files).toContain("openspec/changes/foo/tasks.md")

    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })

  test("rename 条目渲染为完整新文件名", async () => {
    const base = join("/tmp", `wts-w8e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    const { wt } = fakeWorktreePointingToMain(base)
    const runner: GitRunner = {
      async run(_w, args) {
        if (args[0] === "status") return "R  openspec/changes/foo/old.md -> openspec/changes/foo/new.md"
        return ""
      },
      async runChecked() { return { success: true, stdout: "", stderr: "" } },
    }
    __setGitRunner(runner)

    const result = await detectMainRepoPollution(wt)
    expect(result).not.toBeNull()
    expect(result!.files).toEqual(["openspec/changes/foo/new.md"])

    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })

  test("statusExecute（主仓库 orchestrator 视角）渲染主仓库 openspec 污染", async () => {
    const root = `/tmp/wts-w8f-${Date.now()}`
    const mainRepo = join(root, "main")
    mkdirSync(join(mainRepo, ".git"), { recursive: true })
    mkdirSync(join(mainRepo, "openspec", "changes", CID), { recursive: true })
    writeFileSync(
      join(mainRepo, "openspec", "changes", CID, "tasks.md"),
      `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n\n## 2. G2\n\n- [ ] 2.1 T3\n`,
      "utf-8"
    )
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    fakeGit.dirtyPaths.add(`${mainRepo}-openspec`)

    const o = makeCtx("openspec-orchestrator", mainRepo)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const out = await status.execute({ change_id: CID }, o)

    expect(out).toContain("## ⚠️ 主仓库 openspec 污染")
    expect(out).toContain("openspec/changes/foo/tasks.md")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 9: opx_arch_submit 主仓库污染自动合并兜底
// ════════════════════════════════════════════════════════════════

const BOUNDARY = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

/** init → set_worktree，arch_submit 前 worktree 已就绪 */
async function setupToWorktreeReady(wt: string, fakeGit: FakeGitRunner): Promise<void> {
  const o = makeCtx("openspec-orchestrator", wt)
  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await set_worktree.execute({ change_id: CID }, o)
}

function archCtx(wt: string) {
  return makeCtx("openspec-architect", wt)
}

describe("W9. arch_submit 主仓库污染自动合并兜底", () => {

  test("refine 不被回退：worktree refine 文件 b + main 污染文件 a → merge 目标是 commit sha，a 并入", async () => {
    const root = `/tmp/wts-w9a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    const wtPath = findTg(wt).worktreePath
    fakeGit.worktreeOpenspecDirty.add(wtPath)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])

    const result = await arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))

    expect(result).toContain("已将主仓库污染文档并入 worktree 分支")
    expect(result).toContain("- `openspec/changes/cid/design.md`")
    expect(fakeGit.callLog.some((l) => l.includes("refine specs"))).toBe(true)
    expect(fakeGit.commitShas.length).toBe(1)
    const pollSha = fakeGit.commitShas[0]
    expect(fakeGit.callLog.some((l) => l.includes(`merge --no-ff ${pollSha}`))).toBe(true)
    expect(fakeGit.mergedBranches).toContain(pollSha)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("worktree 侧存在未提交变更 → 拒绝合并", async () => {
    const root = `/tmp/wts-w9b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    const wtPath = findTg(wt).worktreePath
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])
    fakeGit.dirtyPaths.add(wtPath)

    await expect(
      arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))
    ).rejects.toThrow(/存在未 commit 内容/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("污染路径在 worktree 分支中相对基准已分叉 → 拒绝且不覆盖", async () => {
    const root = `/tmp/wts-w9b2-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])
    fakeGit.diffOut = "openspec/changes/cid/design.md\n"

    await expect(
      arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))
    ).rejects.toThrow(/分叉/)
    expect(fakeGit.commitShas.length).toBe(0)
    expect(fakeGit.callLog.some((l) => l.includes("write-tree"))).toBe(false)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("未跟踪新文件污染 → 并入分支且 main restore 清理", async () => {
    const root = `/tmp/wts-w9c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/new.md"])

    const result = await arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))

    expect(result).toContain("- `openspec/changes/cid/new.md`")
    expect(fakeGit.commitShas.length).toBe(1)
    expect(fakeGit.mergedBranches).toContain(fakeGit.commitShas[0])
    expect(fakeGit.callLog.some((l) => l.includes("restore --staged --worktree"))).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("多 change 隔离：其它 changeId 目录污染不触发兜底", async () => {
    const root = `/tmp/wts-w9d-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    fakeGit.pollutionFiles.set(`${wt}-othercid`, ["openspec/changes/othercid/x.md"])

    const result = await arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))

    expect(result).not.toContain("已将主仓库污染文档")
    expect(fakeGit.callLog.some((l) => l.includes("write-tree"))).toBe(false)
    expect(fakeGit.commitShas.length).toBe(0)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("main index 含其它 staged 内容 → abort", async () => {
    const root = `/tmp/wts-w9e-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])
    fakeGit.cachedDiffOut = "src/foo.java"

    await expect(
      arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))
    ).rejects.toThrow(/其它已暂存内容/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("成功路径：worktree HEAD 前进、main 分支 ref 不变、main 工作树恢复、返回体含 markdown 列表", async () => {
    const root = `/tmp/wts-w9f-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])

    const result = await arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))

    expect(fakeGit.mergedBranches).toContain(fakeGit.commitShas[0])
    expect(fakeGit.callLog.some((l) => l.startsWith("checked:update-ref") || l.startsWith("checked:branch -f"))).toBe(false)
    expect(fakeGit.callLog.some((l) => l.includes(`restore --staged --worktree -- openspec/changes/${CID}`))).toBe(true)
    expect(result).toContain("- `openspec/changes/cid/design.md`")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("tg.worktreePath=null → 不触发任何 plumbing", async () => {
    const root = `/tmp/wts-w9g-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])

    const result = await arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))

    expect(result).not.toContain("已将主仓库污染文档")
    expect(fakeGit.callLog.some((l) => l.includes("write-tree"))).toBe(false)
    expect(fakeGit.callLog.some((l) => l.includes("commit-tree"))).toBe(false)
    expect(fakeGit.commitShas.length).toBe(0)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("merge 失败 → 抛错、state 未写盘（仍为 task_analysis）", async () => {
    const root = `/tmp/wts-w9h-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])
    fakeGit.mergeConflictOnNext = true

    await expect(
      arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))
    ).rejects.toThrow(/合并主仓库污染文档失败/)
    expect(findTg(wt).status).toBe("task_analysis")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("baseRef=null 降级路径：跳过分叉预检仍完成合并", async () => {
    const root = `/tmp/wts-w9i-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    const state = readStateSync(wt)
    state.taskGroups.find((g: any) => g.id === "1").baseRef = null
    writeFileSync(join(wt, ".opencode", ".orchestrate_state", `${CID}.json`), JSON.stringify(state))
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])

    const result = await arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))

    expect(result).toContain("已将主仓库污染文档并入 worktree 分支")
    expect(fakeGit.commitShas.length).toBe(1)
    expect(fakeGit.mergedBranches).toContain(fakeGit.commitShas[0])

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("预检失败（stagedOutside）→ 主仓库工作树污染内容保留，不执行任何 restore", async () => {
    const root = `/tmp/wts-w9j-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])
    fakeGit.cachedDiffOut = "src/foo.java"

    await expect(
      arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))
    ).rejects.toThrow(/其它已暂存内容/)
    // 未进入 add 流程 → 绝不执行 restore（尤其 --worktree），主仓库工作树污染内容原样保留
    expect(fakeGit.callLog.some((l) => l.includes("restore"))).toBe(false)
    expect(fakeGit.callLog.some((l) => l.includes("add -- openspec/changes"))).toBe(false)
    expect(fakeGit.callLog.some((l) => l.includes("write-tree"))).toBe(false)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("main 相对 worktree 前进（含其它 change 提交）→ 拒绝合并，worktree 分支不被夹带", async () => {
    const root = `/tmp/wts-w9k-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupToWorktreeReady(wt, fakeGit)
    fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])
    fakeGit.mainAheadCount = 2

    await expect(
      arch_submit.execute({ change_id: CID, outcome: "ready", execution_boundary: BOUNDARY }, archCtx(wt))
    ).rejects.toThrow(/主仓库分支已相对 worktree 分支前进/)
    // 未进入 merge 流程 → 无 write-tree/commit-tree/merge，worktree 分支不含其它 change 内容
    expect(fakeGit.callLog.some((l) => l.includes("write-tree"))).toBe(false)
    expect(fakeGit.commitShas.length).toBe(0)
    expect(fakeGit.mergedBranches.length).toBe(0)
    expect(fakeGit.callLog.some((l) => l.includes("restore"))).toBe(false)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})
