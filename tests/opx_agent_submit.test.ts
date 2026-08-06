/**
 * opx_agent_submit 通用 step 提交测试
 *
 * 原生 WorkItem 持久化：agentSubmitExecute 直接操作 state.workItems（定位活跃 task
 * WorkItem → submitForStep 推进状态机）。单轨下 workItems 为唯一事实源，
 * issue 落盘在 item.children（child.metadata 承载归因字段）。
 * 覆盖：越权拒绝、完整 happy path、review 多步不卡死、fixed/exempt/new 落盘、
 * Info child 正向 gate 语义、旧格式自动升级。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, agent_submit, set_worktree, complete_task_group } from "../src/adapters/opencode/tools"
import { loadWorkflow } from "../src/core/workflow"
import { checkpointTriggered, recommendForItem } from "../src/core/workflow/engine"
import { resolveChildIssueFields } from "../src/core/workflow/reset"
import { FakeGitRunner, makeCtx, setupWorkspace } from "./helpers"
import type { WorkItem } from "../src/core/workflow/types"

const CID = "agent-submit"

const EB = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

afterAll(() => { __setGitRunner(null) })

function readStateSync(wt: string, cid: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${cid}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

/** 读活跃 task WorkItem（task:{taskGroupId}）。 */
function taskItemOf(wt: string): any {
  const state = readStateSync(wt, CID)
  return state?.workItems?.find((w: any) => w.id === "task:1")
}

/** 取 WorkItem 的 task children（子任务），用于 task 状态断言。 */
function taskChildrenOf(wt: string): any[] {
  return (taskItemOf(wt)?.children ?? []).filter((c: any) => c.type === "task")
}

/** 把旧 issue 记录转为 WorkItem issue child（phase 按 status 映射，metadata 承载归因字段）。 */
function issueToChild(issue: Record<string, unknown>): any {
  const status = (issue.status as string) ?? "open"
  const phase = status === "verified" ? "done"
    : status === "exempted" ? "cancelled"
    : "todo"
  const child: any = {
    id: `issue:${issue.id}`,
    source: "openspec",
    externalId: String(issue.id),
    type: "issue",
    title: (issue.description as string) ?? "",
    description: (issue.description as string) ?? "",
    phase,
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: {
      source_phase: (issue.sourcePhase as string) ?? "quality",
      dimension: (issue.dimension as string) ?? "style",
      file: issue.file ?? "",
      line: issue.line ?? 0,
      suggestion: issue.suggestion ?? "",
    },
    children: [],
    labels: [],
    severity: (issue.severity as string) ?? "Low",
  }
  if (status === "exemption_requested") {
    child.metadata["exempt_request"] = {
      requestedBy: "openspec-developer",
      reason: issue.exemptReason ?? null,
    }
  }
  if (status === "rejected") {
    child.metadata["reject_reason"] = (issue.rejectReason as string) ?? "修复不达标"
  }
  return child
}

/** 直接向 state 注入一个 issue child（push 到活跃 task WorkItem 的 children）。 */
function injectIssue(wt: string, issue: any): void {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  const state = readStateSync(wt, CID)
  const item = state.workItems.find((w: any) => w.id === "task:1")
  item.children.push(issueToChild(issue))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 直接改写已有 issue child 的状态（模拟旧工具裁定结果：verified→done、exempted→cancelled、其余→todo）。 */
function setIssueStatus(wt: string, issueId: string, status: string): void {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  const state = readStateSync(wt, CID)
  const item = state.workItems.find((w: any) => w.id === "task:1")
  const child = item.children.find((c: any) => c.externalId === issueId || c.id === `issue:${issueId}`)
  if (child) {
    if (status === "verified") child.phase = "done"
    else if (status === "exempted") child.phase = "cancelled"
    else if (status === "rejected") {
      child.phase = "todo"
      child.metadata["reject_reason"] = "修复不达标"
    }
    else child.phase = "todo"
  }
  writeFileSync(p, JSON.stringify(state, null, 2))
}

function freshSetup(root: string): { wt: string; fakeGit: FakeGitRunner } {
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  return { wt, fakeGit }
}

/** init + set_worktree 一次到位：worktree 就绪硬门禁要求提交前 worktree 就绪（opx_orch_set_worktree 后提交）。 */
async function initWorktree(wt: string): Promise<void> {
  const orch = makeCtx("openspec-orchestrator", wt)
  await init.execute({ change_id: CID, task_group_id: "1" }, orch)
  await set_worktree.execute({ change_id: CID }, orch)
}

function makeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    dimension: "style",
    sourcePhase: "quality",
    severity: "Low",
    file: "src/x.java",
    line: 1,
    description: "测试 issue",
    suggestion: "修复",
    status: "open",
    refixCount: 0,
    rootCauseGuess: null,
    exemptReason: null,
    rejectReason: null,
    ...overrides,
  }
}

describe("opx_agent_submit 通用 step 提交", () => {
  test("1. 完整 happy path：analyze→implement→verify_tool→verify_task→verify_quality→done", async () => {
    const root = `/tmp/opxsub-1-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)

      // analyze：architect
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      expect(taskItemOf(wt).phase).toBe("in_progress")
      expect(taskItemOf(wt).currentStep).toBe("implement")

      // implement：developer
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(taskItemOf(wt).phase).toBe("review")
      expect(taskItemOf(wt).currentStep).toBe("verify_tool")

      // verify_tool：reviewer-tool
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(taskItemOf(wt).phase).toBe("review")
      expect(taskItemOf(wt).currentStep).toBe("verify_task")

      // verify_task：reviewer-task（任务全部验证通过，task children 置 done 才能进 done 收尾）
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(taskItemOf(wt).currentStep).toBe("verify_quality")

      // verify_quality：5 维 quality reviewer 逐一提交，末位触发推进
      const dimAgents = [
        "openspec-reviewer-style",
        "openspec-reviewer-architecture",
        "openspec-reviewer-performance",
        "openspec-reviewer-security",
        "openspec-reviewer-maintainability",
      ]
      for (const agent of dimAgents) {
        await agent_submit.execute(
          { change_id: CID, step_id: "verify_quality", verdict: "passed" },
          makeCtx(agent, wt)
        )
      }
      expect(taskItemOf(wt).phase).toBe("done")
      expect(taskItemOf(wt).currentStep).toBeNull()
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("2. review 多步不卡死：verify_tool 后 currentStep 持久化，verify_task 可继续提交", async () => {
    const root = `/tmp/opxsub-2-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )

      const r1 = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(r1).toContain("- **推进**: 是 → verify_task")
      // currentStep 持久化在 workItems，跨提交不重置
      expect(taskItemOf(wt).currentStep).toBe("verify_task")

      const r2 = await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed" },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(r2).toContain("- **推进**: 是 → verify_quality")
      expect(taskItemOf(wt).currentStep).toBe("verify_quality")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("3. fixed 落盘：dev 提交 fixed_issue_ids → child phase=done", async () => {
    const root = `/tmp/opxsub-3-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      injectIssue(wt, makeIssue())

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["1"], completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(r).toContain("1 → done")
      expect(r).toContain("- **推进**: 是 → verify_tool")
      expect(taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "1")?.phase).toBe("done")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("4. exempt：metadata.exempt_request 标记落盘，step 不推进", async () => {
    const root = `/tmp/opxsub-4-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      injectIssue(wt, makeIssue())

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["1"], completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      const child = taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "1")
      expect(child.metadata["exempt_request"]).toBeDefined()
      // 豁免申请未裁定前 child 未终态，step 不推进
      expect(child.phase).toBe("todo")
      expect(r).toContain("- **推进**: 否")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("5. new_children → 写回 item.children 新增 todo child", async () => {
    const root = `/tmp/opxsub-5-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )

      // review 阶段 step 才可提报新 issue；Low+ 新报必须 verdict=failed
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "7", title: "新发现问题", description: "reviewer 提交时新增 issue", severity: "Low" }],
        },
        makeCtx("openspec-reviewer-tool", wt)
      )
      const child = taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "7")
      expect(child).toBeDefined()
      expect(child.phase).toBe("todo")
      expect(child.description).toBe("reviewer 提交时新增 issue")
      // failed → 沿 on_fail 回退 implement
      expect(taskItemOf(wt).phase).toBe("in_progress")
      expect(taskItemOf(wt).currentStep).toBe("implement")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("6. Info 级 issue：未到终态不阻塞 step 推进（D1：仅 Low+ children 阻塞），fixed 后 child done", async () => {
    const root = `/tmp/opxsub-6-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      injectIssue(wt, makeIssue({ severity: "Info" }))

      // Info child 未终态不阻塞 stepCanPass → implement passed 仍沿 on:pass 推进
      const r1 = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(r1).toContain("- **stepAdjudication**: passed")
      expect(r1).toContain("- **推进**: 是 → verify_tool")
      expect(taskItemOf(wt).phase).toBe("review")

      // Info child 声明解决后 → child 置 done
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.phase = "in_progress"
      item.currentStep = "implement"
      writeFileSync(statePath, JSON.stringify(state, null, 2))
      const r2 = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["1"], completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(r2).toContain("- **推进**: 是 → verify_tool")
      expect(taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "1")?.phase).toBe("done")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("7. 越权：非 step.agents 的 agent 提交 → 抛错且 state 不变", async () => {
    const root = `/tmp/opxsub-7-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)

      const before = taskItemOf(wt).phase
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/越权/)
      expect(taskItemOf(wt).phase).toBe(before)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("8. 升级兼容：无 workItems 的旧格式 state → opx_agent_submit 正常（自动升级）", async () => {
    const root = `/tmp/opxsub-8-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const state = {
        changeId: CID,
        isolationNamespace: "ns-legacy",
        taskGroupId: "1",
        baseBranch: "main",
        taskGroups: [{
          id: "1", name: "First Task Group", taskCount: 3,
          worktreePath: join(wt, ".worktree", CID, "task-group-1"), branchName: `task-group/${CID}/1`, baseRef: "base000000000000000000000000000000000001", executionBoundary: null,
          relevantSpecs: [], status: "task_analysis",
          phases: {
            architect_review: { completed: false },
            review: {
              retryCount: 0, lastResolvedRetryCount: 0,
              tool: { completed: false }, task: { completed: false },
              quality: { progress: { style: "pending", architecture: "pending", performance: "pending", security: "pending", maintainability: "pending" } },
            },
          },
          tasks: [], issues: [], blockers: [],
        }],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }
      const stateDir = join(wt, ".opencode", ".orchestrate_state")
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, `${CID}.json`), JSON.stringify(state, null, 2))

      // 首次读取触发 readStateByChangeId 自动升级并落盘
      expect(taskItemOf(wt)).toBeUndefined()
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      expect(r).toContain("- **stepAdjudication**: passed")
      expect(taskItemOf(wt)).toBeDefined()
      expect(taskItemOf(wt).id).toBe("task:1")
      expect(taskItemOf(wt).phase).toBe("in_progress")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("9. ctx.agent 与 task.yaml step.agents 一致（含 review 阶段 reviewer 提交）", async () => {
    const root = `/tmp/opxsub-9-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      // YAML agents 与编排真实 agent 名一致
      const wf = loadWorkflow(readFileSync(join(import.meta.dir, "../assets/workflows/task.yaml"), "utf8"))
      expect(wf.stepMap.get("analyze")!.step.agents).toEqual(["openspec-architect"])
      expect(wf.stepMap.get("implement")!.step.agents).toEqual(["openspec-developer"])
      expect(wf.stepMap.get("verify_tool")!.step.agents).toEqual(["openspec-reviewer-tool"])
      expect(wf.stepMap.get("verify_task")!.step.agents).toEqual(["openspec-reviewer-task"])
      expect(wf.stepMap.get("verify_quality")!.step.agents).toContain("openspec-reviewer-style")

      // 推进到 review 阶段后，tool reviewer 按 verify_tool step 提交
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(taskItemOf(wt).phase).toBe("review")

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(r).toContain("- **stepAdjudication**: passed")
      expect(r).toContain("- **推进**: 是 → verify_task")
      expect(taskItemOf(wt).phase).toBe("review")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("10. done 终态：全部 task verified + children 全终态，complete_task_group 收尾置 completed 并 merge", async () => {
    const root = `/tmp/opxsub-10-${Date.now()}`
    const { wt, fakeGit } = freshSetup(root)
    try {
      await initWorktree(wt)
      for (const [step, agent] of [
        ["analyze", "openspec-architect"],
        ["implement", "openspec-developer"],
        ["verify_tool", "openspec-reviewer-tool"],
        ["verify_task", "openspec-reviewer-task"],
      ] as const) {
        const extra = step === "analyze"
          ? { execution_boundary: EB }
          : step === "implement" ? { completed_task_ids: ["1", "2", "3"] }
          : step === "verify_task" ? { verified_tasks: ["1", "2", "3"] } : {}
        await agent_submit.execute({ change_id: CID, step_id: step, verdict: "passed", ...extra }, makeCtx(agent, wt))
      }
      for (const a of [
        "openspec-reviewer-style", "openspec-reviewer-architecture",
        "openspec-reviewer-performance", "openspec-reviewer-security",
        "openspec-reviewer-maintainability",
      ]) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, makeCtx(a, wt))
      }

      const item = taskItemOf(wt)
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
      // task children 全部终态（verified 语义）
      expect(taskChildrenOf(wt).every((t: any) => t.phase === "done")).toBe(true)
      // children 全部终态（无遗留未解决 issue）
      expect(item.children.every((c: WorkItem) => c.phase === "done" || c.phase === "cancelled")).toBe(true)

      const r = await complete_task_group.execute({ change_id: CID }, makeCtx("openspec-orchestrator", wt))
      expect(r).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(fakeGit.mergedBranches).toContain("task-group/agent-submit/1")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("11. exemption_requested issue 迁移后保留：child 带 exempt_request，后续提交不丢失豁免申请", async () => {
    const root = `/tmp/opxsub-11-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      injectIssue(wt, makeIssue({ status: "exemption_requested", exemptReason: "第三方库限制" }))

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      const child = taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "1")
      expect(child.metadata["exempt_request"]).toBeDefined()
      expect(child.metadata["exempt_request"].reason).toBe("第三方库限制")
      // 豁免申请未裁定 → child 未终态，step 不推进
      expect(child.phase).toBe("todo")
      expect(r).toContain("- **推进**: 否")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("12. 终态保护：已裁定 verified/rejected 的 child 不被后续 submit 覆写", async () => {
    const root = `/tmp/opxsub-12-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      // 先注入 open issue 并经 submit 建立 todo child
      injectIssue(wt, makeIssue())
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "1").phase).toBe("todo")

      // 旧工具裁定 verified → child done；重置回 implement 后重提，不被覆写回 todo
      setIssueStatus(wt, "1", "verified")
      const p1 = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const s1 = JSON.parse(readFileSync(p1, "utf-8"))
      const it1 = s1.workItems.find((w: any) => w.id === "task:1")
      it1.phase = "in_progress"
      it1.currentStep = "implement"
      writeFileSync(p1, JSON.stringify(s1, null, 2))
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "1").phase).toBe("done")

      // 旧工具裁定 rejected（不可二次申请豁免）→ child 保持 todo 带 reject_reason，不被覆写为 open
      setIssueStatus(wt, "1", "rejected")
      const p2 = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const s2 = JSON.parse(readFileSync(p2, "utf-8"))
      const it2 = s2.workItems.find((w: any) => w.id === "task:1")
      it2.phase = "in_progress"
      it2.currentStep = "implement"
      writeFileSync(p2, JSON.stringify(s2, null, 2))
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      const c12 = taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "1")
      expect(c12.phase).toBe("todo")
      expect(c12.metadata["reject_reason"]).toBe("修复不达标")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("13. new_children 透传 source_phase/dimension 到 child.metadata，缺省 tool/style", async () => {
    const root = `/tmp/opxsub-13-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      // review 阶段 tool reviewer 提报：Low+ 新报必须 verdict=failed
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [
            { id: "7", title: "注入风险", description: "安全问题", severity: "Low", source_phase: "quality", dimension: "security" },
            { id: "8", title: "缺省归因", description: "不传 source_phase/dimension", severity: "Info" },
          ],
        },
        makeCtx("openspec-reviewer-tool", wt)
      )

      const c7 = taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "7")
      expect(c7.metadata["source"]).toBe("openspec-reviewer-tool")
      expect(c7.metadata["source_phase"]).toBe("quality")
      expect(c7.metadata["dimension"]).toBe("security")
      // 缺省归因：未传 source_phase/dimension → resolveChildIssueFields 回退 tool/style
      const c8 = taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "8")
      expect(resolveChildIssueFields(c8).sourcePhase).toBe("tool")
      expect(resolveChildIssueFields(c8).dimension).toBe("style")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("14. 重复 complete 被拦截：第一次成功置 completed 并 merge，第二次命中门禁抛错", async () => {
    const root = `/tmp/opxsub-14-${Date.now()}`
    const { wt, fakeGit } = freshSetup(root)
    try {
      await initWorktree(wt)
      // 直接构造「done 终态、待收尾」状态（等价于 opx_agent_submit 推进到 done 后的落盘）
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = {
        id: "task:1", source: "openspec", externalId: "1", type: "task",
        title: "First Task Group", description: "First Task Group",
        phase: "done", suspended: false, currentStep: null,
        tags: {},
        metadata: {
          tasks: [
            { id: "1", status: "verified" }, { id: "2", status: "verified" }, { id: "3", status: "verified" },
          ],
          worktree_path: join(wt, ".worktree", CID, "task-group-1"),
          branch_name: "task-group/agent-submit/1",
        },
        children: [],
        labels: [],
      }
      state.workItems = [item]
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      const orch = makeCtx("openspec-orchestrator", wt)
      const r1 = await complete_task_group.execute({ change_id: CID }, orch)
      expect(r1).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(fakeGit.mergedBranches).toContain("task-group/agent-submit/1")

      // 第二次调用：completed_at 已写 → 命中门禁抛错而非 merge 失败
      const err = await complete_task_group.execute({ change_id: CID }, orch).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/阶段顺序错误/)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("15. 豁免裁定 dismissed：dev 申请豁免后，报 issue 的 quality reviewer（verify_quality.agents 成员）用 exempt_adjudications 裁定 → child cancelled", async () => {
    const root = `/tmp/opxsub-15-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      // 推进到 review/verify_quality
        await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed" }, makeCtx("openspec-reviewer-task", wt))

      // style reviewer 报 issue（metadata.source=openspec-reviewer-style）并 failed
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "7", title: "豁免候选", description: "不可修 issue", severity: "Low", source_phase: "quality", dimension: "style" }],
        },
        makeCtx("openspec-reviewer-style", wt)
      )
      expect(taskItemOf(wt).children.find((c: any) => c.id === "7").metadata["source"]).toBe("openspec-reviewer-style")
      // verify_quality 为多 agent step：单维 failed 触发聚合等待，不立即回退
      expect(taskItemOf(wt).phase).toBe("review")
      expect(taskItemOf(wt).currentStep).toBe("verify_quality")

      // 其余 4 维 passed → 全部已裁决 → 聚合回退 implement
      for (const d of ["architecture", "performance", "security", "maintainability"]) {
        await agent_submit.execute(
          { change_id: CID, step_id: "verify_quality", verdict: "passed" },
          makeCtx(`openspec-reviewer-${d}`, wt)
        )
      }
      expect(taskItemOf(wt).phase).toBe("in_progress")
      expect(taskItemOf(wt).currentStep).toBe("implement")

      // dev 提交豁免申请 → child.exempt_request
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["7"], completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      const child = taskItemOf(wt).children.find((c: any) => c.externalId === "7")
      expect(child.metadata["exempt_request"]).toBeDefined()

      // 模拟编排将任务移回 review/verify_quality 供豁免复核（真实编排由 orchestrator 调度）
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.phase = "review"
      item.currentStep = "verify_quality"
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      // quality reviewer（style，属于 verify_quality.agents，按报源匹配）用 exempt_adjudications 裁定 dismissed
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "passed",
          exempt_adjudications: [{ issue_id: "7", action: "dismissed" }],
        },
        makeCtx("openspec-reviewer-style", wt)
      )
      expect(taskItemOf(wt).children.find((c: any) => c.externalId === "7").phase).toBe("cancelled")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("16. 越权裁定：非报 issue 维度的 agent 裁定 quality 豁免 → 抛错且 state 不变", async () => {
    const root = `/tmp/opxsub-16-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      // 构造前置：task 在 verify_quality，child 带 exempt_request + source=style reviewer
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = {
        id: "task:1", source: "openspec", externalId: "1", type: "task",
        title: "First Task Group", description: "First Task Group",
        phase: "review", suspended: false, currentStep: "verify_quality",
        tags: {}, metadata: {
          worktree_path: join(wt, ".worktree", CID, "task-group-1"),
          branch_name: `task-group/${CID}/1`,
          base_ref: "base000000000000000000000000000000000001",
        },
        children: [{
          id: "issue:9", source: "openspec", externalId: "9", type: "issue",
          title: "不可修", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: {
            source: "openspec-reviewer-style",
            source_phase: "quality",
            dimension: "style",
            exempt_request: { requestedBy: "openspec-developer" },
          },
          children: [], labels: [],
        }],
        labels: [],
      }
      state.workItems = [item]
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "passed",
          exempt_adjudications: [{ issue_id: "9", action: "dismissed" }],
        },
        makeCtx("openspec-reviewer-tool", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      // 越权：非报 issue 维度的 agent 裁定 quality issue → 谁提谁裁定拦截（白名单前置路径之外的新流维度校验）
      expect(err.message).toMatch(/裁定者必须为报 issue 的/)
      // 裁定在 submitForStep 之前执行，越权抛错零变更
      expect(taskItemOf(wt).children.find((c: any) => c.externalId === "9").phase).toBe("todo")
      expect(taskItemOf(wt).children.find((c: any) => c.externalId === "9").metadata["exempt_request"]).toBeDefined()
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("17. checkpoint_decision=continue：重置 step tag + 清 _checkpoint，落盘后该 step 可重提", async () => {
    const root = `/tmp/opxsub-17-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = {
        id: "task:1", source: "openspec", externalId: "1", type: "task",
        title: "First Task Group", description: "First Task Group",
        phase: "review", suspended: false, currentStep: "verify_tool",
        tags: { "verify_tool:openspec-reviewer-tool": "failed" },
        metadata: { _retryCount: 3, _checkpoint: true },
        children: [{
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "遗留 issue", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low",
        }],
        labels: [],
      }
      state.workItems = [item]
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "continue" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(r).toContain("continue")
      const saved = taskItemOf(wt)
      expect(saved.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(saved.metadata["_checkpoint"]).toBe(false)
      // 未解决 children 保持原状（continue 不清 children）
      expect(saved.children.find((c: WorkItem) => c.id === "issue:7").phase).toBe("todo")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("17b. checkpoint_decision=continue 真实触发路径：_retryCount 达上限+未终态 child → continue 后检查点解除、分派恢复", async () => {
    const root = `/tmp/opxsub-17b-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = {
        id: "task:1", source: "openspec", externalId: "1", type: "task",
        title: "First Task Group", description: "First Task Group",
        phase: "review", suspended: false, currentStep: "verify_tool",
        tags: { "verify_tool:openspec-reviewer-tool": "failed" },
        // 真实触发：_retryCount=5（max_retries 5 的倍数）、无 _checkpoint 标记、未终态 child
        metadata: { _retryCount: 5 },
        children: [{
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "遗留 issue", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low",
        }],
        labels: [],
      }
      state.workItems = [item]
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      const wf = loadWorkflow(readFileSync(join(import.meta.dir, "../assets/workflows/task.yaml"), "utf8"))
      const step = wf.stepMap.get("verify_tool")!.step
      expect(checkpointTriggered(taskItemOf(wt), wf, step)).toBe(true)
      expect(recommendForItem(taskItemOf(wt), wf).status).toBe("checkpoint")

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "continue" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(r).toContain("continue")
      const saved = taskItemOf(wt)
      expect(saved.metadata["_retryCount"]).toBe(0)
      expect(saved.metadata["_checkpoint"]).toBe(false)
      expect(checkpointTriggered(saved, wf, step)).toBe(false)
      const rec = recommendForItem(saved, wf)
      expect(rec.status).not.toBe("checkpoint")
      expect(rec.agents).toContain("openspec-reviewer-tool")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("18. checkpoint_decision=giveup：未解决 children 置 cancelled + step 标记 passed", async () => {
    const root = `/tmp/opxsub-18-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = {
        id: "task:1", source: "openspec", externalId: "1", type: "task",
        title: "First Task Group", description: "First Task Group",
        phase: "review", suspended: false, currentStep: "verify_tool",
        tags: {}, metadata: { _retryCount: 3, _checkpoint: true },
        children: [{
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "遗留 issue", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low",
        }],
        labels: [],
      }
      state.workItems = [item]
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "giveup" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(r).toContain("giveup")
      const saved = taskItemOf(wt)
      expect(saved.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(saved.children.find((c: WorkItem) => c.id === "issue:7").phase).toBe("cancelled")
      expect(saved.metadata["_checkpoint"]).toBe(false)
      expect(saved.metadata["_retryCount"]).toBe(0)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("19. 非检查点态传 checkpoint_decision → 抛错且 state 不变", async () => {
    const root = `/tmp/opxsub-19-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      // implement 阶段 _retryCount=0 且无 _checkpoint 标记 → 非检查点态
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", checkpoint_decision: "continue" },
        makeCtx("openspec-developer", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/不在检查点状态/)
      // state 不变：仍停留在 implement
      expect(taskItemOf(wt).phase).toBe("in_progress")
      expect(taskItemOf(wt).currentStep).toBe("implement")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("20. analyze passed 必须提供 execution_boundary；缺省抛错且 state 不变", async () => {
    const root = `/tmp/opxsub-20-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed" },
        makeCtx("openspec-architect", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/execution_boundary/)
      expect(taskItemOf(wt).phase).toBe("todo")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("21. analyze blockers 写入 metadata.blockers；存在未解决 blocker 时 passed 被拦截", async () => {
    const root = `/tmp/opxsub-21-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)

      // 先以 failed 上报 blocker 落盘（awaiting_user），EB 校验仅在 passed 生效
      const r0 = await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "failed",
          blockers: [{ source_role: "architect", category: "external", description: "第三方接口未定", evidence: "API 文档缺失", attempted_actions: "已尝试联系" }],
        },
        makeCtx("openspec-architect", wt)
      )
      expect(r0).toBeDefined()
      expect(taskItemOf(wt).metadata["blockers"]).toHaveLength(1)
      expect(taskItemOf(wt).metadata["blockers"][0].status).toBe("awaiting_user")

      // 存在未解决 blocker 时 passed → 拦截
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB,
        },
        makeCtx("openspec-architect", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未解决的 blocker/)

      // blocker_updates 置 resolved → 可 passed
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB,
          blocker_updates: [{ blocker_id: "b1", user_response: "已确认新接口" }],
        },
        makeCtx("openspec-architect", wt)
      )
      expect(r).toContain("- **推进**: 是 → implement")
      expect(taskItemOf(wt).metadata["blockers"][0].status).toBe("resolved")
      expect(taskItemOf(wt).metadata["blockers"][0].userResponse).toBe("已确认新接口")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("22. blocker_updates 引用不存在的 blocker_id → 抛错", async () => {
    const root = `/tmp/opxsub-22-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB, blocker_updates: [{ blocker_id: "b99", user_response: "x" }] },
        makeCtx("openspec-architect", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/b99/)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("23. implement 覆盖门禁：open/rejected task 必须全部在 completed_task_ids", async () => {
    const root = `/tmp/opxsub-23-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))

      // 只覆盖部分 task → 抛错
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1"] },
        makeCtx("openspec-developer", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未在 completed_task_ids 中/)

      // 非法 task id → 抛错
      const err2 = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3", "999"] },
        makeCtx("openspec-developer", wt)
      ).catch((e: Error) => e)
      expect(err2).toBeInstanceOf(Error)
      expect(err2.message).toMatch(/无效 task id/)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("24. implement completed_task_ids 迁移 open→submitted，metadata.self_check_results 落盘", async () => {
    const root = `/tmp/opxsub-24-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))

      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed",
          completed_task_ids: ["1", "2", "3"],
          self_check_results: "全部用例通过",
        },
        makeCtx("openspec-developer", wt)
      )
      expect(r).toContain("- **推进**: 是 → verify_tool")
      const tasks = taskChildrenOf(wt)
      expect(tasks.find((t: any) => t.id === "1").phase).toBe("review")
      expect(tasks.find((t: any) => t.id === "3").phase).toBe("review")
      expect(taskItemOf(wt).metadata["self_check_results"]).toBe("全部用例通过")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("25. implement blocker 参数：verdict=failed + blocker → on_fail 回 analyze，tasks 全置 open", async () => {
    const root = `/tmp/opxsub-25-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      // 先提交部分完成，制造 submitted 态
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      expect(taskChildrenOf(wt).every((t: any) => t.phase === "review")).toBe(true)

      // 模拟回 implement（当前在 review，blocker 仅 failed 提交回退 analyze 路径）
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.phase = "in_progress"
      item.currentStep = "implement"
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      // blocker 参数在 verdict=passed 时抛错（先负例）
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", blocker: { source_role: "developer", category: "x", description: "d", evidence: "e", attempted_actions: "a" } },
        makeCtx("openspec-developer", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/仅支持 verdict=failed/)

      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "infra", description: "构建环境异常", evidence: "CI 日志", attempted_actions: "已重试" },
        },
        makeCtx("openspec-developer", wt)
      )
      expect(r).toContain("- **推进**: 是")
      expect(taskItemOf(wt).phase).toBe("todo")
      expect(taskItemOf(wt).currentStep).toBe("analyze")
      // resetTasksForBlocker：task children 全 todo，review 验证标记清空
      expect(taskChildrenOf(wt).every((t: any) => t.phase === "todo")).toBe(true)
      expect(taskItemOf(wt).metadata["blockers"]).toHaveLength(1)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("26. verify_task verified_tasks/failed_tasks：submitted task 全覆盖校验 + 状态迁移", async () => {
    const root = `/tmp/opxsub-26-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))
      expect(taskItemOf(wt).currentStep).toBe("verify_task")

      // 未全覆盖 submitted task → 抛错
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2"] },
        makeCtx("openspec-reviewer-task", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未被 verified_tasks 或 failed_tasks 覆盖/)

      // passed=true 不允许 failed_tasks
      const err2 = await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"], failed_tasks: [{ task_id: "1", reason: "x" }] },
        makeCtx("openspec-reviewer-task", wt)
      ).catch((e: Error) => e)
      expect(err2).toBeInstanceOf(Error)
      expect(err2.message).toMatch(/passed=true 时不允许提供 failed_tasks/)

      // 全覆盖：verified 2 个 + failed 1 个 → 状态迁移，verdict=failed 回 implement
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: ["1", "2"],
          failed_tasks: [{ task_id: "3", reason: "验收未过" }],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(r).toContain("- **推进**: 是")
      expect(taskItemOf(wt).phase).toBe("in_progress")
      const tasks = taskChildrenOf(wt)
      expect(tasks.find((t: any) => t.id === "1").phase).toBe("done")
      expect(tasks.find((t: any) => t.id === "3").phase).toBe("todo")
      expect(tasks.find((t: any) => t.id === "3").metadata["reject_reason"]).toBe("验收未过")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("27. verify_task validation_steps：completed=false 必须带 skip_reason", async () => {
    const root = `/tmp/opxsub-27-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))

      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "passed",
          verified_tasks: ["1", "2", "3"],
          validation_steps: [{ step: "构建", completed: false }],
        },
        makeCtx("openspec-reviewer-task", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/skip_reason/)

      // completed=true + evidence 正常落盘
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "passed",
          verified_tasks: ["1", "2", "3"],
          validation_steps: [{ step: "构建", completed: true, evidence: "BUILD SUCCESS" }, { step: "冒烟", completed: false, skip_reason: "无 UI 变更" }],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(r).toContain("- **推进**: 是 → verify_quality")
      const steps = taskItemOf(wt).metadata["validation_steps"] as any[]
      expect(steps).toHaveLength(2)
      expect(steps[0].evidence).toBe("BUILD SUCCESS")
      expect(steps[1].skip_reason).toBe("无 UI 变更")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("28. boundary_expansion 仅 verdict=failed 有效；passed=true 抛错", async () => {
    const root = `/tmp/opxsub-28-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))

      // passed=true + boundary_expansion → 抛错
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "passed",
          boundary_expansion: { allowed_directories: ["src/extra"] },
        },
        makeCtx("openspec-reviewer-tool", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/passed=true 时不允许边界扩展/)

      // failed + boundary_expansion → 合并进执行边界并回 implement
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          boundary_expansion: { allowed_directories: ["src/extra"], allowed_packages: ["com.extra"] },
          new_children: [{ id: "7", title: "范围外代码", description: "需要扩展边界", severity: "Low" }],
        },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(r).toContain("- **推进**: 是")
      expect(taskItemOf(wt).phase).toBe("in_progress")
      const boundary = taskItemOf(wt).metadata["execution_boundary"] as any
      expect(boundary.allowed_directories).toContain("src/extra")
      expect(boundary.allowed_packages).toContain("com.extra")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("29. 重复提交守卫：同 step 同 agent 二次提交抛错且 state 不变", async () => {
    const root = `/tmp/opxsub-29-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] }, makeCtx("openspec-reviewer-task", wt))
      expect(taskItemOf(wt).currentStep).toBe("verify_quality")

      // style reviewer 首次提交 verify_quality
      await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, makeCtx("openspec-reviewer-style", wt))
      const snapshot = JSON.stringify(taskItemOf(wt).tags)
      // 同 agent 同 step 二次提交 → 重复提交守卫
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "failed" },
        makeCtx("openspec-reviewer-style", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/重复提交守卫/)
      expect(JSON.stringify(taskItemOf(wt).tags)).toBe(snapshot)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("30. verify_tool passed=true 携带 Low+ new_children → 抛错；Info 新报放行", async () => {
    const root = `/tmp/opxsub-30-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))

      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "passed",
          new_children: [{ id: "7", title: "阻塞问题", description: "Low 级新报", severity: "Low" }],
        },
        makeCtx("openspec-reviewer-tool", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/passed=true 只能带 Info 新报/)

      // Info 新报 + passed → 放行且落盘 child/issue
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "passed",
          new_children: [{ id: "7", title: "改进建议", description: "Info 级优化", severity: "Info" }],
        },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(r).toContain("- **推进**: 是 → verify_task")
      expect(taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "7").phase).toBe("todo")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("31. new_children 全字段透传：file/line/suggestion/rule/root_cause_guess → child.metadata", async () => {
    const root = `/tmp/opxsub-31-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))

      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{
            id: "7", title: "NPE 风险", description: "空指针",
            severity: "High", source_phase: "quality", dimension: "architecture",
            file: "src/Service.java", line: 42, suggestion: "加空判", rule: "PMD:NullDereference", root_cause_guess: "未初始化",
          }],
        },
        makeCtx("openspec-reviewer-tool", wt)
      )
      const child = taskItemOf(wt).children.find((c: WorkItem) => c.externalId === "7")
      expect(child.metadata["file"]).toBe("src/Service.java")
      expect(child.metadata["line"]).toBe(42)
      expect(child.metadata["suggestion"]).toBe("加空判")
      expect(child.metadata["rule"]).toBe("PMD:NullDereference")
      expect(child.metadata["root_cause_guess"]).toBe("未初始化")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
  test("32. 无豁免申请标记的 quality issue 被裁定 → 抛未申请豁免（标记校验先于谁提谁裁定）", async () => {
    const root = `/tmp/opxsub-32-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] }, makeCtx("openspec-reviewer-task", wt))

      // architecture reviewer 报 quality issue（dimension=architecture），未申请豁免（无 exempt_request 标记）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "7", title: "架构问题", description: "模块耦合", severity: "High", source_phase: "quality", dimension: "architecture" }],
        },
        makeCtx("openspec-reviewer-architecture", wt)
      )
      // style reviewer 尝试裁定该 issue → 标记校验先于谁提谁裁定：未申请豁免
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
        makeCtx("openspec-reviewer-style", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未申请豁免/)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("33. 门禁负向：非 review 阶段 step 提报 new_children 被拒，state 零变更", async () => {
    const root = `/tmp/opxsub-33-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt)
      )
      // analyze 通过后进入 implement（in_progress 阶段，非 review）
      expect(taskItemOf(wt).phase).toBe("in_progress")
      expect(taskItemOf(wt).currentStep).toBe("implement")
      const childrenBefore = taskItemOf(wt).children.length

      // developer 在 implement 提报 new_children → 命中门禁抛错
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed",
          completed_task_ids: ["1", "2", "3"],
          new_children: [{ id: "x1", title: "T", description: "d", severity: "Low" }],
        },
        makeCtx("openspec-developer", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/仅 review/)
      expect(err.message).toMatch(/new_children/)

      // state 零变更：children 未新增、无 x1、task 仍停留在 implement
      const item = taskItemOf(wt)
      expect(item.children).toHaveLength(childrenBefore)
      expect(item.children.find((c: WorkItem) => c.id === "x1")).toBeUndefined()
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("34. 跨维豁免：tool reviewer 报 quality 维度 issue → 对应维度 quality reviewer 裁定（谁提谁裁定）", async () => {
    const root = `/tmp/opxsub-34-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))

      // tool reviewer 在 verify_tool 报 quality 维度（style）issue → child 写入、failed 回退 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "X", title: "跨维豁免", description: "tool reviewer 报的 quality 维度 issue", severity: "Low", source_phase: "quality", dimension: "style" }],
        },
        makeCtx("openspec-reviewer-tool", wt)
      )
      let child = taskItemOf(wt).children.find((c: WorkItem) => c.id === "X")
      expect(child).toBeDefined()
      expect(child.metadata["source"]).toBe("openspec-reviewer-tool")
      expect(child.metadata["source_phase"]).toBe("quality")
      expect(child.metadata["dimension"]).toBe("style")
      expect(taskItemOf(wt).phase).toBe("in_progress")
      expect(taskItemOf(wt).currentStep).toBe("implement")

      // dev 提交豁免申请 → exempt_request 已标记，child 未终态不推进
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["X"], completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      child = taskItemOf(wt).children.find((c: WorkItem) => c.id === "X")
      expect(child.metadata["exempt_request"]).toBeDefined()
      expect(child.phase).toBe("todo")

      // 模拟编排把 item 移回 review/verify_quality 供豁免复核（真实编排由 orchestrator 调度）
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.phase = "review"
      item.currentStep = "verify_quality"
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      // 负向对照：非对应维度 agent（architecture）裁定 → 抛错（谁提谁裁定）且 state 不变
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "X", action: "dismissed" }] },
        makeCtx("openspec-reviewer-architecture", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/裁定者必须为报 issue 的/)
      child = taskItemOf(wt).children.find((c: WorkItem) => c.id === "X")
      expect(child.phase).toBe("todo")
      expect(child.metadata["exempt_request"]).toBeDefined()

      // 正向：对应维度 quality reviewer（style）裁定 dismissed → child cancelled
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "X", action: "dismissed" }] },
        makeCtx("openspec-reviewer-style", wt)
      )
      expect(taskItemOf(wt).children.find((c: WorkItem) => c.id === "X").phase).toBe("cancelled")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("35. review failed 回退 implement：verify_tool 已 passed tag 保留，仅按归因清 failed 层（可重提、可重新分派）", async () => {
    const root = `/tmp/opxsub-35-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))

      // verify_task 驳回 task 3 并报 task 层 Low issue → 单 agent step 提交即判定，回 implement
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: ["1", "2"],
          failed_tasks: [{ task_id: "3", reason: "验收未过" }],
          new_children: [{
            id: "tk9", title: "任务层问题", description: "任务实现不完整", severity: "Low",
            source_phase: "task", dimension: "style", file: "src/T.java", line: 3, suggestion: "补全",
          }],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(r).toContain("- **推进**: 是")
      let item = taskItemOf(wt)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      // fix1：implement 裁决重置 → developer 可重新分派
      expect(item.tags["implement:openspec-developer"]).toBeUndefined()
      // fix2 新语义：review failed 不再全清 → 已 passed 的 verify_tool tag 保留、verify_quality 未动
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("failed")
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()

      // dev 修复 task 层 issue（fixed_issue_ids）→ resetReviewTagsOnFix 按归因清 verify_tool + verify_task
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["tk9"], completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      item = taskItemOf(wt)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_tool")
      // verify_task failed tag 被清（可重提）；verify_tool 亦按归因清空（task 层代码修复 → tool 层确定性检查须重跑）
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()

      // verify_tool 可重提（重复提交守卫放行）→ 推进到 verify_task
      const rTool = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(rTool).toContain("- **推进**: 是 → verify_task")

      // verify_task 可重提（重复提交守卫放行）→ 通过
      const rTask = await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(rTask).toContain("passed")
      item = taskItemOf(wt)
      expect(item.currentStep).toBe("verify_quality")
      // task children 保留驳回语义：rejected task 在重提后已 done（verified）
      expect(taskChildrenOf(wt).find((t: any) => t.id === "3").phase).toBe("done")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("36. F1 端到端回归：verify_quality 失败 → 仅修 quality 层 → 链式穿越已 passed 的 verify_task → style 重审 → done", async () => {
    const root = `/tmp/opxsub-36-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] }, makeCtx("openspec-reviewer-task", wt))
      expect(taskItemOf(wt).currentStep).toBe("verify_quality")

      // style 报 quality 层 Low issue 并 failed，其余 4 维 passed → 聚合回退 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "7", title: "风格遗留", description: "命名不规范", severity: "Low", source_phase: "quality", dimension: "style", file: "src/A.java", line: 7, suggestion: "改名" }],
        },
        makeCtx("openspec-reviewer-style", wt)
      )
      for (const d of ["architecture", "performance", "security", "maintainability"]) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, makeCtx(`openspec-reviewer-${d}`, wt))
      }
      let item = taskItemOf(wt)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      // fix2 语义：verify_task 已 passed tag 保留（不触发全清）
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")

      // dev 仅修 quality 层 issue → reset 按归因清 verify_tool + verify_quality:style
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["7"], completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      item = taskItemOf(wt)
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(item.currentStep).toBe("verify_tool")

      // 工具层重审通过 → 链式穿越 verify_task（已 passed）直落 verify_quality，不再 terminal 卡死
      const rTool = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(rTool).toContain("- **推进**: 是 → verify_quality")
      item = taskItemOf(wt)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_quality")

      // style 重审通过 → 全维 passed → done
      const rStyle = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed" },
        makeCtx("openspec-reviewer-style", wt)
      )
      expect(rStyle).toContain("- **推进**: 是")
      item = taskItemOf(wt)
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("37. F1 回归：verify_task 仅 failed_tasks 失败 → dev 重提 → 链式穿越 verify_tool → task 重审 → done", async () => {
    const root = `/tmp/opxsub-37-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))

      // verify_task 仅 failed_tasks 驳回（无 issue child）→ 回 implement；verify_tool passed tag 保留
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: ["1", "2"], failed_tasks: [{ task_id: "3", reason: "验收未过" }],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      let item = taskItemOf(wt)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("failed")

      // dev 重提（无 issue 归因，reset 不触发）→ 提交即链式穿越 verify_tool（passed 保留）直落 verify_task
      const rDev = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(rDev).toContain("- **推进**: 是 → verify_task")
      item = taskItemOf(wt)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_task")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")

      // task reviewer 可重提（failed 非 passed，守卫放行）→ 通过
      const rTask = await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(rTask).toContain("- **推进**: 是")
      expect(taskItemOf(wt).currentStep).toBe("verify_quality")

      // 5 维通过 → done
      for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, makeCtx(`openspec-reviewer-${d}`, wt))
      }
      item = taskItemOf(wt)
      expect(item.phase).toBe("done")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("38. F3 回归：verify_quality failed 新报理由按当前 agent 维度过滤", async () => {
    const root = `/tmp/opxsub-38-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, makeCtx("openspec-reviewer-tool", wt))
      await agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] }, makeCtx("openspec-reviewer-task", wt))

      // style 用 security 维度新报作为 failed 理由 → 非本维理由，拒绝且零状态变更
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "7", title: "安全洞", description: "注入风险", severity: "High", source_phase: "quality", dimension: "security" }],
        },
        makeCtx("openspec-reviewer-style", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/AI 审查层\(style\) 审核声称 passed=false/)
      let item = taskItemOf(wt)
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()

      // 本维新报（dimension=style）→ 合法理由，聚合等待不立即回退
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "8", title: "风格问题", description: "命名不规范", severity: "Low", source_phase: "quality", dimension: "style" }],
        },
        makeCtx("openspec-reviewer-style", wt)
      )
      expect(r).toContain("- **推进**: 否")
      item = taskItemOf(wt)
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("failed")
      expect(item.children.find((c: WorkItem) => c.externalId === "8")).toBeDefined()
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("39. F4 回归：failed 理由判定在去重之后（同 key 新报被去重 → 零新增 → 拒绝）", async () => {
    const root = `/tmp/opxsub-39-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx("openspec-developer", wt))
      // 注入既存非终态 Info child（与待报 Low issue 同 key，dedupe key 不含 severity）
      injectIssue(wt, {
        id: "9", dimension: "style", sourcePhase: "tool", severity: "Info",
        file: "src/B.java", line: 1, description: "构建告警",
      })
      // tool reviewer 以同 key Low 新报作为 failed 理由 → 去重后零新增 → 拒绝且零状态变更
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "8", title: "工具问题", description: "构建告警", severity: "Low", source_phase: "tool", dimension: "style", file: "src/B.java", line: 1, suggestion: "修复" }],
        },
        makeCtx("openspec-reviewer-tool", wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/不存在未解决的阻塞 issue/)
      const item = taskItemOf(wt)
      expect(item.children.find((c: WorkItem) => c.externalId === "8")).toBeUndefined()
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.currentStep).toBe("verify_tool")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("40. 撞车修复：task child 与 issue externalId 同 id → fixed_issue_ids 命中 issue child，分层重置按 issue 归因", async () => {
    const root = `/tmp/opxsub-40-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      await initWorktree(wt)
      // init 后 children 为 task child "1"/"2"/"3"（tasks.md 1.1/1.2/1.3）
      expect(taskItemOf(wt).children.filter((c: WorkItem) => c.type === "task").map((c: WorkItem) => c.id)).toEqual(["1", "2", "3"])
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))

      // 注入 issue：id/externalId "1" 与 task child 短数字 id "1" 撞车；归因 quality/architecture
      injectIssue(wt, makeIssue({
        id: "1", dimension: "architecture", sourcePhase: "quality",
        file: "src/A.java", line: 7, description: "架构 issue（与 task 1 撞 id）",
      }))

      // 预置分层验证 tag：verify_tool + verify_quality:architecture 均 passed，verify_task passed 留作对照
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.tags["verify_tool:openspec-reviewer-tool"] = "passed"
      item.tags["verify_task:openspec-reviewer-task"] = "passed"
      item.tags["verify_quality:openspec-reviewer-architecture"] = "passed"
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      // dev 提交 fixed_issue_ids=["1"]：必须命中 issue child（而非 task child）
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["1"], completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt)
      )
      expect(r).toContain("- **推进**: 是")

      const children = taskItemOf(wt).children
      const issueChild = children.find((c: WorkItem) => c.type === "issue" && c.externalId === "1")
      const taskChild = children.find((c: WorkItem) => c.type === "task" && c.id === "1")
      // issue child 置 done；task child 保持 submitted（review）不受 fixed 影响
      expect(issueChild.phase).toBe("done")
      expect(taskChild.phase).toBe("review")

      // 分层重置按 issue 归因（quality/architecture）：verify_quality:architecture 被清、verify_task 保留。
      // 若误命中 task child（缺省 tool/style）则 architecture 维度 tag 不会被清——即修复前的静默错位。
      const saved = taskItemOf(wt)
      expect(saved.tags["verify_quality:openspec-reviewer-architecture"]).toBeUndefined()
      expect(saved.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(saved.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})
