/**
 * reviewer 家族 submit 自动提交（文档直改兜底）测试：
 * - reviewer-tool verify_tool 提交：脏 worktree → add -u + commit 自动触发，
 *   且先于 _tool_review_checkpoint 的 rev-parse HEAD（时序硬约束）
 * - openspec-architect analyze 提交：脏 worktree → 先自动提交再走 reconcile 干净树预检
 *   （消除架构师 worktree md 修正无人提交的预检死锁）
 * - openspec-developer implement 提交：脏 worktree → 不触发 add/commit
 * - status 仅含 openspec/states/ 路径 → 不触发提交
 * - status 仅含未跟踪新建文件 → 不触发提交但返回体提示未纳入
 * - add / commit 失败 → 提交不被阻塞（verdict 正常写入），返回体含失败提示
 * - simple 模式 quality_review（openspec-reviewer）脏 worktree → 触发
 */
import { describe, expect, test, afterAll } from "bun:test"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, setupWithFakeGit, teardown, initSimpleWorktree } from "./helpers"
import { driveToImplement, driveToVerifyTool, readItem, setupToAnalyze, taskIdsOf, DEFAULT_EXECUTION_BOUNDARY } from "./helpers-workflow"

const CID = "autocommit"
const SUBMIT_OK = "提交成功，请直接结束当前会话"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/ac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

const ADD_LINE = "checked:add -u -- . :(exclude)openspec/states"
const commitLineOf = (agent: string, stepId: string): string =>
  `checked:commit -m docs(opx): direct fixes by ${agent} (${stepId})`

describe("reviewer 家族 submit 自动提交（文档直改兜底）", () => {
  test("reviewer-tool verify_tool 提交：脏 worktree → add -u + commit 触发，且先于检查点 rev-parse HEAD", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1"]
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.dirtyPaths.add(wtPath)
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      const addIdx = fakeGit.callLog.indexOf(ADD_LINE)
      const commitIdx = fakeGit.callLog.indexOf(commitLineOf("openspec-reviewer-tool", "verify_tool"))
      const headIdx = fakeGit.callLog.indexOf("rev-parse HEAD")
      expect(addIdx).toBeGreaterThanOrEqual(0)
      expect(commitIdx).toBeGreaterThan(addIdx)
      // 时序硬约束：自动提交在 _tool_review_checkpoint 捕获之前，防止修正被下一轮增量检测误判
      expect(headIdx).toBeGreaterThan(commitIdx)
      // 返回体含自动提交说明
      expect(out).toContain("已自动提交")
      // FakeGitRunner 真实行为模拟：commit 成功清脏，worktree 恢复干净
      expect(fakeGit.dirtyPaths.has(wtPath)).toBe(false)
      expect(readItem(wt, CID).metadata["_tool_review_checkpoint"]).toBe("cp-1")
    } finally { teardown(root) }
  })

  test("openspec-architect analyze 提交：脏 worktree → 先自动提交再走 reconcile 干净树预检，污染文档并入", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      // 主仓库污染 + worktree 脏（架构师直改 md 未提交）：旧语义在 reconcile 干净树预检处死锁
      fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])
      fakeGit.dirtyPaths.add(wtPath)
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: DEFAULT_EXECUTION_BOUNDARY },
        ctx.arch,
      )

      // 自动提交先于 reconcile 的干净树预检（run() 侧 "status --porcelain"）
      const commitIdx = fakeGit.callLog.indexOf(commitLineOf("openspec-architect", "analyze"))
      const cleanCheckIdx = fakeGit.callLog.indexOf("status --porcelain")
      expect(commitIdx).toBeGreaterThanOrEqual(0)
      expect(cleanCheckIdx).toBeGreaterThan(commitIdx)
      expect(out).toContain("已自动提交")
      // 污染文档仍并入 worktree 分支（死锁消除）
      expect(fakeGit.commitShas.length).toBe(1)
      expect(fakeGit.mergedBranches).toContain(fakeGit.commitShas[0])
      expect(fakeGit.dirtyPaths.has(wtPath)).toBe(false)
    } finally { teardown(root) }
  })

  test("openspec-developer implement 提交：脏 worktree → 不触发自动提交", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.dirtyPaths.add(wtPath)
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev,
      )

      expect(fakeGit.callLog.some((l) => l.includes("add -u"))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
      // 脏状态保留（开发者须自行 commit 后提交）
      expect(fakeGit.dirtyPaths.has(wtPath)).toBe(true)
      expect(out).toBe(SUBMIT_OK)
    } finally { teardown(root) }
  })

  test("status 仅含 openspec/states/ 路径 → 不触发提交", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1"]
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "M  openspec/states/autocommit.json\nM  openspec/states/other.json")
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      expect(fakeGit.callLog.some((l) => l.includes("add -u"))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
      expect(out).toBe(SUBMIT_OK)
    } finally { teardown(root) }
  })

  test("status 仅含未跟踪新建文件 → 不触发提交，返回体提示未纳入", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1"]
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "?? notes/new.md")
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      expect(fakeGit.callLog.some((l) => l.includes("add -u"))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
      expect(out).toContain("未跟踪新建文件未纳入自动提交")
      expect(out).toContain("notes/new.md")
    } finally { teardown(root) }
  })

  test("add 失败 → 提交不被阻塞（verdict 写入），返回体含失败提示", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1"]
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.dirtyPaths.add(wtPath)
      fakeGit.failAdd = true
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      expect(readItem(wt, CID).tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(out).toContain("自动提交失败")
      expect(out).toContain("fatal: add 失败")
      expect(out).toContain("补提交")
      // 失败不清脏（无 commit 发生）
      expect(fakeGit.dirtyPaths.has(wtPath)).toBe(true)
    } finally { teardown(root) }
  })

  test("commit 失败 → 提交不被阻塞（verdict 写入），返回体含失败提示", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1"]
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.dirtyPaths.add(wtPath)
      fakeGit.failCommit = true
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      expect(readItem(wt, CID).tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(out).toContain("自动提交失败")
      expect(out).toContain("fatal: commit 失败")
      expect(fakeGit.dirtyPaths.has(wtPath)).toBe(true)
    } finally { teardown(root) }
  })

  test("simple 模式 quality_review（openspec-reviewer）脏 worktree → 触发自动提交", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // simple implement 提交须工作区干净（FakeGit 默认干净）
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt),
      )
      const wtPath = join(wt, ".worktree", CID, "task-group-1")
      fakeGit.dirtyPaths.add(wtPath)
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx("openspec-reviewer", wt),
      )

      expect(fakeGit.callLog.some((l) => l === commitLineOf("openspec-reviewer", "quality_review"))).toBe(true)
      expect(out).toContain("已自动提交")
      expect(fakeGit.dirtyPaths.has(wtPath)).toBe(false)
    } finally { teardown(root) }
  })
})
