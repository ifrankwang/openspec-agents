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
      // 文档类脏改动（openspec/ 下 md）：机制层预检放行，由自动提交兜底
      fakeGit.statusPorcelainOutput.set(wtPath, "M  openspec/changes/cid/design.md")
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

  test("openspec-developer implement 提交：脏 worktree + verdict=failed(blocker) → 放行且不触发自动提交", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      // full 模式 implement 仅 passed 校验工作区（failed 报 blocker 时脏属正常）
      fakeGit.dirtyPaths.add(wtPath)
      fakeGit.callLog.length = 0

      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: {
            source_role: "openspec-developer", category: "env_unavailable",
            description: "外部依赖不可用", evidence: "启动失败日志", attempted_actions: "重试 3 次",
          },
        },
        ctx.dev,
      )

      expect(fakeGit.callLog.some((l) => l.includes("add -u"))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
      // 脏状态保留（开发者须自行 commit 后提交）
      expect(fakeGit.dirtyPaths.has(wtPath)).toBe(true)
      expect(readItem(wt, CID).tags["implement:openspec-developer"]).toBe("failed")
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

  test("status 仅含未跟踪的非文档类文件 → 不纳入自动提交，返回体告警（架构师 todo 阶段路径）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "?? notes/tmp.txt")
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: DEFAULT_EXECUTION_BOUNDARY },
        ctx.arch,
      )

      expect(fakeGit.callLog.some((l) => l.includes("add -u"))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
      expect(out).toContain("未跟踪的非文档类文件未纳入自动提交")
      expect(out).toContain("notes/tmp.txt")
    } finally { teardown(root) }
  })

  test("add 失败 → 提交不被阻塞（verdict 写入），返回体含失败提示", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1"]
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "M  openspec/changes/cid/design.md")
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
      // 失败不产生 commit
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
    } finally { teardown(root) }
  })

  test("commit 失败 → 提交不被阻塞（verdict 写入），返回体含失败提示", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1"]
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "M  openspec/changes/cid/design.md")
      fakeGit.failCommit = true
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      expect(readItem(wt, CID).tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(out).toContain("自动提交失败")
      expect(out).toContain("fatal: commit 失败")
    } finally { teardown(root) }
  })

  test("simple 模式 quality_review（openspec-reviewer）文档类脏 worktree → 触发自动提交", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // simple implement 提交须工作区干净（FakeGit 默认干净）
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt),
      )
      const wtPath = join(wt, ".worktree", CID, "ws")
      fakeGit.statusPorcelainOutput.set(wtPath, "M  openspec/changes/autocommit/proposal.md")
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx("openspec-reviewer", wt),
      )

      expect(fakeGit.callLog).toContain(ADD_LINE)
      expect(fakeGit.callLog.some((l) => l === commitLineOf("openspec-reviewer", "quality_review"))).toBe(true)
      expect(out).toContain("已自动提交")
    } finally { teardown(root) }
  })
})

describe("机制层拦截脏工作区提交（非文档类）", () => {
  const codeDirty = (fakeGit: FakeGitRunner, wtPath: string, output: string) =>
    fakeGit.statusPorcelainOutput.set(wtPath, output)

  test("reviewer passed + 代码类未提交改动 → 被拒、错误含文件与还原指引、零状态变更", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      codeDirty(fakeGit, wtPath, " M src/main.ts\n?? src/tmp-probe.ts")
      fakeGit.callLog.length = 0

      const err = await agent_submit
        .execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
        .catch((e: Error) => e)

      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("工作区存在未提交的代码类改动")
      expect(err.message).toContain("src/main.ts")
      expect(err.message).toContain("src/tmp-probe.ts")
      expect(err.message).toContain("git checkout --")
      expect(err.message).toContain("新增的临时文件")
      expect(err.message).toContain("openspec/")
      // 文案边界：代码类改动必须还原、不得以 commit 绕过；只有注释与文档类可提交
      expect(err.message).toContain("不得以 commit 方式提交掉")
      expect(err.message).toContain("只含注释改动")
      expect(err.message).toContain("审查者不应修改代码逻辑")
      // 反向断言：不得再出现「自行 commit 后提交」这类绕过暗示
      expect(err.message).not.toContain("请自行 commit 后再提交")
      expect(err.message).not.toContain("确属必要的代码修正")
      // 零状态变更：step 未推进、无 verdict tag、自动提交未触发
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
      expect(readItem(wt, CID).tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(fakeGit.callLog.some((l) => l.includes("add -u") || l.startsWith("checked:commit"))).toBe(false)
    } finally { teardown(root) }
  })

  test("reviewer passed + 仅 .md 改动 → 放行并自动 commit", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      codeDirty(fakeGit, wtPath, "M  docs/notes.md")
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      expect(out).toContain("已自动提交")
      expect(fakeGit.callLog).toContain(ADD_LINE)
      expect(fakeGit.callLog).toContain(commitLineOf("openspec-reviewer-tool", "verify_tool"))
      expect(readItem(wt, CID).tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("reviewer passed + 仅 openspec/ 下改动 → 放行并自动 commit", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      codeDirty(fakeGit, wtPath, "M  openspec/changes/autocommit/proposal.md")
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      expect(out).toContain("已自动提交")
      expect(fakeGit.callLog).toContain(ADD_LINE)
      expect(fakeGit.callLog).toContain(commitLineOf("openspec-reviewer-tool", "verify_tool"))
      expect(readItem(wt, CID).tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("reviewer failed + 代码类未提交改动 → 同样被拒（failed 也会自动 commit）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      codeDirty(fakeGit, wtPath, "M  src/reverted-probe.ts")
      fakeGit.callLog.length = 0

      const err = await agent_submit
        .execute({ change_id: CID, step_id: "verify_tool", verdict: "failed" }, ctx.toolR)
        .catch((e: Error) => e)

      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("src/reverted-probe.ts")
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
      expect(readItem(wt, CID).tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(fakeGit.callLog.some((l) => l.includes("add -u") || l.startsWith("checked:commit"))).toBe(false)
    } finally { teardown(root) }
  })

  test("full 模式 implement passed + 脏工作区 → 被拒（错误文案按模式区分）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.dirtyPaths.add(wtPath)
      fakeGit.callLog.length = 0

      const err = await agent_submit
        .execute(
          { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(readItem(wt, CID)) },
          ctx.dev,
        )
        .catch((e: Error) => e)

      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("full 模式 implement 提交被拒绝")
      expect(err.message).toContain("工作区存在未提交内容")
      // 零状态变更：step 未推进、无 verdict tag
      expect(readItem(wt, CID).currentStep).toBe("implement")
      expect(readItem(wt, CID).tags["implement:openspec-developer"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("full 模式 implement failed + 脏工作区 → 放行（不堵 dev 报 blocker 路径）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.dirtyPaths.add(wtPath)

      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: {
            source_role: "openspec-developer", category: "env_unavailable",
            description: "外部依赖不可用", evidence: "启动失败日志", attempted_actions: "重试 3 次",
          },
        },
        ctx.dev,
      )

      expect(readItem(wt, CID).tags["implement:openspec-developer"]).toBe("failed")
      expect(fakeGit.dirtyPaths.has(wtPath)).toBe(true)
    } finally { teardown(root) }
  })

  test("simple 模式 implement 行为不变：脏工作区无条件拒绝，清理后放行", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const wsPath = join(wt, ".worktree", CID, "ws")

      fakeGit.dirtyPaths.add(wsPath)
      const err = await agent_submit
        .execute(
          { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
          makeCtx("openspec-developer", wt),
        )
        .catch((e: Error) => e)

      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("simple 模式 implement 提交被拒绝")

      // 清理后放行（回归：simple 既有行为不因本次扩展改变）
      fakeGit.dirtyPaths.delete(wsPath)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt),
      )
      expect(readItem(wt, CID).currentStep).toBe("quality_review")
    } finally { teardown(root) }
  })
})

describe("脏工作区拦截回环 2（rename 双向解析 / 未跟踪文档）", () => {
  test("代码文件重命名为 .md（R old -> new）→ 被拦，错误含被改名的代码路径", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "R  src/b.ts -> docs/b-renamed.md")
      fakeGit.callLog.length = 0

      const err = await agent_submit
        .execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
        .catch((e: Error) => e)

      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("工作区存在未提交的代码类改动")
      // 旧路径（代码文件）必须被识别；只取 rename 新路径会误判为文档类而放行
      expect(err.message).toContain("src/b.ts")
      expect(err.message).not.toContain("docs/b-renamed.md")
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
      expect(fakeGit.callLog.some((l) => l.includes("add -u") || l.startsWith("checked:commit"))).toBe(false)
    } finally { teardown(root) }
  })

  test("未跟踪的文档类文件（openspec/ 下新建 md）→ 放行并纳入自动 commit", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "?? openspec/changes/x/new.md")
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      expect(out).toContain("已自动提交")
      // 未跟踪文档类显式 add，与 add -u 同批纳入同一次 commit
      expect(fakeGit.callLog).toContain(ADD_LINE)
      expect(fakeGit.callLog).toContain("checked:add -- openspec/changes/x/new.md")
      expect(fakeGit.callLog).toContain(commitLineOf("openspec-reviewer-tool", "verify_tool"))
    } finally { teardown(root) }
  })

  test("未跟踪的非文档类文件（?? src/tmp.ts）→ 被预检拦下", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "?? src/tmp.ts")
      fakeGit.callLog.length = 0

      const err = await agent_submit
        .execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
        .catch((e: Error) => e)

      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("src/tmp.ts")
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
      expect(fakeGit.callLog.some((l) => l.includes("add -u") || l.startsWith("checked:commit"))).toBe(false)
    } finally { teardown(root) }
  })

  test("simple 模式 implement + verdict=failed + 脏工作区 → 仍被拒（无条件干净校验）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const wsPath = join(wt, ".worktree", CID, "ws")
      fakeGit.dirtyPaths.add(wsPath)

      const err = await agent_submit
        .execute(
          { change_id: CID, step_id: "implement", verdict: "failed" },
          makeCtx("openspec-developer", wt),
        )
        .catch((e: Error) => e)

      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("simple 模式 implement 提交被拒绝")
      expect(err.message).toContain("工作区存在未提交内容")
      // 拒绝发生在状态写入前：step 未推进、无 verdict tag
      expect(readItem(wt, CID).currentStep).toBe("implement")
      expect(readItem(wt, CID).tags["implement:openspec-developer"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("文档类重命名（R docs/a.md -> docs/b.md）→ 放行，提交计数为 1 个文件（不双计）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const wtPath = readItem(wt, CID).metadata["worktree_path"]
      fakeGit.statusPorcelainOutput.set(wtPath, "R  docs/a.md -> docs/b.md")
      fakeGit.callLog.length = 0

      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR,
      )

      // rename 只记新路径：同一重命名不应在提示里计成 2 个文件
      expect(out).toContain("已自动提交（1 个文件")
      expect(out).not.toContain("已自动提交（2 个文件")
      expect(fakeGit.callLog).toContain(ADD_LINE)
      expect(fakeGit.callLog).toContain(commitLineOf("openspec-reviewer-tool", "verify_tool"))
    } finally { teardown(root) }
  })
})
