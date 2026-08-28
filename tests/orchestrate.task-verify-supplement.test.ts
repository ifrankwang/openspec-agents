/**
 * 任务验证门禁兜底与补交通道回归（状态机死锁修复）：
 * - A 门禁兜底：任务验证归属 step（quality_review/verify_task）以 passed 提交时，submitted task
 *   必须被 verified_tasks/failed_tasks 全覆盖（两个数组都缺省也必查）；verify_tool 与 failed 不强制。
 * - B 补交通道：quality_review 已 passed + 存在 review 态 task child 时，仅带 verified_tasks 的
 *   重提被重复提交守卫放行并收口 done；携带其他实质参数 / 无待验证任务仍拒绝；
 *   engine gateBlock 补交推导返回该 step 全部 agents（simple 与 full 两形态）。
 * - C 恢复面按模式生效：见 orchestrate.mode-lifecycle.test.ts（simple 生效/跨模式报错/警告）
 *   与 orchestrate.blocked_dispatch.test.ts（full 值域 + 跨模式报错）。
 * - D implement blocker 消费闭环：blocker_updates 置 resolved；未 resolved 时 passed 拒绝；
 *   blocker reset 保留 done 态 task；遗漏 completed_task_ids 的错误文案不误导虚报。
 * - E 端到端死锁复刻：reviewer passed 漏带 verified_tasks 被门禁拦截 → 带全量补交 → done。
 * - F 独立复核返工回归：quality_review failed_tasks 为合法 failed 理由（无 issue 亦可驳回）；
 *   developer 视图渲染 blocker 留痕；必做门禁跳过绑定 passed+待验证任务（首次提交不豁免）；
 *   同轮 blocker + blocker_updates 组合拒绝（分两轮指引）。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { __setMustDoIndex } from "../src/core/tools/gate"
import type { SkillTagIndex } from "../src/skills/resolve"
import { init, agent_submit, set_worktree, status } from "../src/adapters/opencode/tools"
import { recommendForItem } from "../src/core/workflow/engine"
import { loadWorkflowFile, SIMPLE_WORKFLOW_PATH, TASK_WORKFLOW_PATH } from "../src/core/workflow/loader"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWorkspace, teardown, initSimpleWorktree } from "./helpers"

const CID = "task-verify-fix"
const DEV = "openspec-developer"
const REVIEWER = "openspec-reviewer"
const SIMPLE_WF = loadWorkflowFile(SIMPLE_WORKFLOW_PATH)
const FULL_WF = loadWorkflowFile(TASK_WORKFLOW_PATH)
const EB = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

afterAll(() => { __setGitRunner(null) })

function fresh(): { root: string; wt: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/tvfix-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  return { root, wt, fakeGit }
}

function stateOf(wt: string): any {
  return JSON.parse(readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8"))
}

function taskItemOf(wt: string): any {
  return stateOf(wt).workItems.find((w: any) => w.id === "task:1")
}

function rewriteItem(wt: string, fn: (item: any) => void): void {
  const state = stateOf(wt)
  fn(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(join(wt, "openspec", "states", `${CID}.json`), JSON.stringify(state, null, 2))
}

function taskPhasesOf(wt: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const c of taskItemOf(wt).children.filter((c: any) => c.type === "task")) map[c.id] = c.phase
  return map
}

/** full 模式 init + set_worktree 一次到位。 */
async function initFullWorktree(wt: string): Promise<void> {
  const orch = makeOrchCtx(wt)
  await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, orch)
  await set_worktree.execute({ change_id: CID }, orch)
}

/** 构造 simple 死锁残留态：dev 全量申报 + quality_review 已 passed（tag 注入模拟历史漏带提交）、
 *  task children 卡 review 态、item 停留 review/quality_review。 */
async function buildSimpleDeadlock(wt: string): Promise<void> {
  await agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
    makeCtx(DEV, wt),
  )
  rewriteItem(wt, (item) => {
    item.phase = "review"
    item.currentStep = "quality_review"
    item.tags["quality_review:openspec-reviewer"] = "passed"
  })
}

// ════════════════════════════════════════════════════════════════
//  A. 任务验证门禁兜底（源头拦截）
// ════════════════════════════════════════════════════════════════

describe("A. 任务验证门禁兜底", () => {
  test("quality_review passed 缺 verified_tasks 且存在 submitted task → 抛错（含指引文案）；带全量 → 通过收口 done", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      // passed 缺 verified_tasks：submitted task 未覆盖 → 拒绝，错误含人工任务协议指引
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed" },
        makeCtx(REVIEWER, wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未被 verified_tasks 或 failed_tasks 覆盖/)
      expect(err.message).toMatch(/verified_tasks 用于逐项确认已完成的任务/)
      expect(err.message).toMatch(/blocker/)
      // 抛错零状态变更：tag 未写、task 仍 review、item 未收口
      const mid = taskItemOf(wt)
      expect(mid.tags["quality_review:openspec-reviewer"]).toBeUndefined()
      expect(mid.phase).toBe("review")
      // 带全量 verified_tasks → 通过并收口 done
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx(REVIEWER, wt),
      )
      expect(taskItemOf(wt).phase).toBe("done")
      expect(taskPhasesOf(wt)).toEqual({ "1": "done", "2": "done", "3": "done" })
    } finally { teardown(root) }
  })

  test("verify_tool passed 缺 verified_tasks（有 submitted task）→ 不拦（非任务验证层）", async () => {
    const { root, wt } = fresh()
    try {
      await initFullWorktree(wt)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, makeCtx("openspec-architect", wt))
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt),
      )
      // verify_tool 不做任务验证覆盖强制：正常推进 verify_task
      expect(taskItemOf(wt).currentStep).toBe("verify_task")
    } finally { teardown(root) }
  })

  test("failed 提交缺 verified_tasks/failed_tasks 数组 → 不拦（报 issue 回退无须给全部任务表态）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "质量缺陷", description: "d", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      )
      // failed 缺数组不触发覆盖门禁：回退 implement，review 态 task child 保持（等待重新申报验证）
      const item = taskItemOf(wt)
      expect(item.currentStep).toBe("implement")
      expect(taskPhasesOf(wt)["1"]).toBe("review")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  B. 任务验证补交通道（存量自愈）
// ════════════════════════════════════════════════════════════════

describe("B. 重复提交守卫补交放行 + engine gateBlock 推导", () => {
  test("quality_review 已 passed + submitted task 存在：仅带 verified_tasks 重提 → 放行、任务置 done、item 收口 done", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await buildSimpleDeadlock(wt)
      // 引擎推导：step 全 passed 但 done 收口被 review 态 task child 拦截 → blocked + 分派该 step agents
      const out = await status.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(out).toContain("分派子代理：`openspec-reviewer`")
      // 仅带 verified_tasks 的补交：守卫放行 → 覆盖校验通过 → task 置 done → done 收口
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx(REVIEWER, wt),
      )
      const item = taskItemOf(wt)
      expect(item.phase).toBe("done")
      expect(item.tags["quality_review:openspec-reviewer"]).toBe("passed")
      expect(taskPhasesOf(wt)).toEqual({ "1": "done", "2": "done", "3": "done" })
    } finally { teardown(root) }
  })

  test("同状态下 verified_tasks 携带 new_children / recheck_adjudications 重提 → 守卫拒绝（非严格补交形态）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await buildSimpleDeadlock(wt)
      // 注入一个 review 态 quality 报源 issue（供 recheck_adjudications 引用有效 id）
      rewriteItem(wt, (item) => {
        item.children.push({
          id: "issue:i3", source: REVIEWER, externalId: "i3", type: "issue",
          title: "待复核", description: "d", phase: "review", suspended: false, currentStep: null,
          tags: {}, metadata: { source: REVIEWER, dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
      })
      const err1 = await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"],
          new_children: [{ id: "i2", title: "t", description: "d", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      ).catch((e: Error) => e)
      expect(err1).toBeInstanceOf(Error)
      expect(err1.message).toMatch(/重复提交守卫/)
      const err2 = await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"],
          recheck_adjudications: [{ issue_id: "i3", verdict: "passed" }],
        },
        makeCtx(REVIEWER, wt),
      ).catch((e: Error) => e)
      expect(err2).toBeInstanceOf(Error)
      expect(err2.message).toMatch(/重复提交守卫/)
      // 拒绝零状态变更：item 仍停留死锁态（未收口、tag 未被清）
      expect(taskItemOf(wt).phase).toBe("review")
      expect(taskItemOf(wt).tags["quality_review:openspec-reviewer"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("无 submitted task 时 verified_tasks 重提 → 拒绝（补交放行绑定待验证任务存在）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      // quality_review 已 passed 且 tasks 全 done（无 review 态 task child）：补交无意义，守卫拒绝
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "quality_review"
        item.tags["quality_review:openspec-reviewer"] = "passed"
        for (const c of item.children.filter((c: any) => c.type === "task")) c.phase = "done"
      })
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1"] },
        makeCtx(REVIEWER, wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/重复提交守卫/)
    } finally { teardown(root) }
  })

  test("engine 单元：step 全 passed + review 态 task child → gateBlock 返回该 step 全部 agents（simple/full）；无待验证任务保持 terminal", () => {
    // simple：quality_review 全 passed + review 态 task child → blocked + 分派 openspec-reviewer
    const simple = {
      id: "task:1", source: "openspec", type: "task" as const, title: "t", description: "d",
      phase: "review" as const, suspended: false, currentStep: "quality_review",
      tags: { "implement:openspec-developer": "passed", "quality_review:openspec-reviewer": "passed" },
      metadata: {}, labels: [],
      children: [
        { id: "1", source: "openspec", type: "task" as const, title: "a", description: "a", phase: "review" as const, suspended: false, currentStep: null, tags: {}, metadata: {}, labels: [], children: [] },
      ],
    }
    const simpleRec = recommendForItem(simple as any, SIMPLE_WF)
    expect(simpleRec.status).toBe("blocked")
    expect(simpleRec.agents).toEqual(["openspec-reviewer"])
    expect(simpleRec.blockedReason).toContain("补交 verified_tasks")

    // full：verify_cleanup 全 passed + review 态 task child → done 收口拦截 → blocked + 分派 developer
    const full = {
      id: "task:1", source: "openspec", type: "task" as const, title: "t", description: "d",
      phase: "review" as const, suspended: false, currentStep: "verify_cleanup",
      tags: {
        "analyze:openspec-architect": "passed",
        "implement:openspec-developer": "passed",
        "verify_tool:openspec-reviewer-tool": "passed",
        "verify_task:openspec-reviewer-task": "passed",
        "verify_quality:openspec-reviewer-style": "passed",
        "verify_quality:openspec-reviewer-architecture": "passed",
        "verify_quality:openspec-reviewer-performance": "passed",
        "verify_quality:openspec-reviewer-security": "passed",
        "verify_quality:openspec-reviewer-maintainability": "passed",
        "verify_cleanup:openspec-developer": "passed",
      },
      metadata: {}, labels: [],
      children: [
        { id: "1", source: "openspec", type: "task" as const, title: "a", description: "a", phase: "review" as const, suspended: false, currentStep: null, tags: {}, metadata: {}, labels: [], children: [] },
      ],
    }
    const fullRec = recommendForItem(full as any, FULL_WF)
    expect(fullRec.status).toBe("blocked")
    expect(fullRec.agents).toEqual(["openspec-developer"])
    expect(fullRec.blockedReason).toContain("补交 verified_tasks")

    // 反例：task children 全终态 → 无 gateBlock 拦截，保持 terminal（不触发补交推导）
    const settled = JSON.parse(JSON.stringify(full))
    settled.children[0].phase = "done"
    const settledRec = recommendForItem(settled as any, FULL_WF)
    expect(settledRec.status).toBe("terminal")
    expect(settledRec.agents).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════
//  D. implement blocker 消费闭环 + 文案修正
// ════════════════════════════════════════════════════════════════

describe("D. implement blocker 消费闭环", () => {
  test("blocker 上报 → 未 resolved 时 passed 拒绝 → blocker_updates 置 resolved + 凭留痕重新申报 → 推进 quality_review", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "3"] },
        makeCtx(DEV, wt),
      ).catch(() => {})
      // 任务 2 人工执行不可自动完成 → blocker 上报（verdict=failed）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: {
            source_role: DEV, task_id: "2", category: "manual_operation",
            description: "任务 2 需人工在生产环境执行", evidence: "无生产凭据",
            attempted_actions: "尝试本地模拟执行失败", options: ["人工执行", "跳过"],
          },
        },
        makeCtx(DEV, wt),
      )
      let item = taskItemOf(wt)
      expect(item.metadata["blockers"]).toHaveLength(1)
      expect(item.metadata["blockers"][0].status).toBe("awaiting_user")

      // 未 resolved 时 passed → 拒绝
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/存在未解决的 blocker/)

      // blocker_updates 引用不存在 id / 已 resolved 条目 → 抛错
      const errNotFound = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"],
          blocker_updates: [{ blocker_id: "b99", user_response: "x" }],
        },
        makeCtx(DEV, wt),
      ).catch((e: Error) => e)
      expect(errNotFound).toBeInstanceOf(Error)
      expect(errNotFound.message).toMatch(/b99/)

      // 用户确认留痕 → blocker_updates 置 resolved → 凭留痕重新申报全部任务 → 通过
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"],
          blocker_updates: [{ blocker_id: "b1", user_response: "用户确认已人工执行任务 2" }],
        },
        makeCtx(DEV, wt),
      )
      item = taskItemOf(wt)
      expect(item.metadata["blockers"][0].status).toBe("resolved")
      expect(item.metadata["blockers"][0].userResponse).toBe("用户确认已人工执行任务 2")
      expect(item.currentStep).toBe("quality_review")

      // 已 resolved 后再 update → 状态不符抛错（先手工拉回 implement，路由校验在参数处理之前）
      rewriteItem(wt, (item) => {
        item.phase = "in_progress"
        item.currentStep = "implement"
      })
      const errResolved = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker_updates: [{ blocker_id: "b1", user_response: "再次确认" }],
        },
        makeCtx(DEV, wt),
      ).catch((e: Error) => e)
      expect(errResolved).toBeInstanceOf(Error)
      expect(errResolved.message).toMatch(/状态不是 awaiting_user/)
    } finally { teardown(root) }
  })

  test("blocker 提交后 resetTasksForBlocker：done 态 task 保留，todo/review 回 todo", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // 构造混合进度：1 已验证 done、2 待验证 review、3 未开始 todo
      rewriteItem(wt, (item) => {
        item.children.find((c: any) => c.id === "1").phase = "done"
        item.children.find((c: any) => c.id === "2").phase = "review"
      })
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: {
            source_role: DEV, category: "env", description: "d", evidence: "e", attempted_actions: "a",
          },
        },
        makeCtx(DEV, wt),
      )
      const phases = taskPhasesOf(wt)
      expect(phases["1"]).toBe("done")   // done 已验证不得降级
      expect(phases["2"]).toBe("todo")   // review 回 todo
      expect(phases["3"]).toBe("todo")
    } finally { teardown(root) }
  })

  test("遗漏 completed_task_ids 的错误文案：含「不得虚报」指引，不含旧误导句", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1"] },
        makeCtx(DEV, wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/以下 task 处于 open\/rejected 状态且未在 completed_task_ids 中/)
      expect(err.message).toMatch(/不得虚报/)
      expect(err.message).toMatch(/blocker/)
      expect(err.message).not.toMatch(/请将未完成的 task 列在 completed_task_ids 中/)
    } finally { teardown(root) }
  })

  test("blocker 留痕在 quality_review 视图渲染（审查者核验申报依据）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      rewriteItem(wt, (item) => {
        item.metadata["blockers"] = [{
          id: "b1", sourceRole: DEV, taskId: "2", category: "manual_operation",
          description: "任务 2 需人工执行", evidence: "e", attemptedActions: "a", options: [],
          status: "resolved", userResponse: "用户确认已人工执行", architectConclusion: null,
        }]
      })
      const out = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      expect(out).toContain("Blocker 留痕")
      expect(out).toContain("Task #2")
      expect(out).toContain("用户确认已人工执行")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  E. 端到端死锁复刻：拦截 → 补交 → 收口
// ════════════════════════════════════════════════════════════════

describe("E. 端到端回归", () => {
  test("dev 全量申报 → reviewer passed 漏带 verified_tasks 被 A 拦截 → 带全量补交 → done", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // dev 全量申报：3 个 task 全部进入待验证（review/submitted）
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      expect(taskItemOf(wt).currentStep).toBe("quality_review")

      // reviewer passed 漏带 verified_tasks → 门禁兜底拦截（死锁源头堵住）
      const blocked = await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed" },
        makeCtx(REVIEWER, wt),
      ).catch((e: Error) => e)
      expect(blocked).toBeInstanceOf(Error)
      expect(blocked.message).toMatch(/未被 verified_tasks 或 failed_tasks 覆盖/)

      // 带全量 verified_tasks 重新提交 → 任务全 done、item 收口 done
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx(REVIEWER, wt),
      )
      const item = taskItemOf(wt)
      expect(item.phase).toBe("done")
      expect(taskPhasesOf(wt)).toEqual({ "1": "done", "2": "done", "3": "done" })
    } finally { teardown(root) }
  })

  test("存量死锁自愈：历史漏带已落 tag → engine 推导补交 → 仅带 verified_tasks 重提收口 done", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await buildSimpleDeadlock(wt)
      // 死锁态确认：reviewer 已 passed（重复提交守卫会拦常规重提），task children 卡 review
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed" },
        makeCtx(REVIEWER, wt),
      ).catch((e: Error) => e)
      expect(err.message).toMatch(/重复提交守卫/)
      // 补交通道：仅带 verified_tasks → 放行收口
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx(REVIEWER, wt),
      )
      expect(taskItemOf(wt).phase).toBe("done")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  F. 独立复核返工回归
// ════════════════════════════════════════════════════════════════

/** 构造声明 must_do 的 quality-gate skill 索引（必做清单 3 项），供必做门禁用例显式注入。 */
function makeQualityGateIndex(items = ["compile", "static_analysis", "deep_scan"]): SkillTagIndex {
  return {
    tagMap: new Map([["quality-gate", ["quality-gate"]]]),
    skillTags: new Map([["quality-gate", ["quality-gate"]]]),
    skillMustDo: new Map([["quality-gate", items]]),
  }
}

describe("F. 独立复核返工回归", () => {
  test("quality_review failed + verified_tasks 部分覆盖 + failed_tasks（无任何 issue）→ 提交成功，任务回 todo 带 reject_reason", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      // 无 issue 仅以 failed_tasks 驳回：assertFailedHasReason 的 quality_review 分支须认
      // failed_tasks 为合法 failed 理由（与 verify_task 分支对齐），不得抛「不存在未解决的阻塞 issue」
      const res = await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          verified_tasks: ["1", "3"],
          failed_tasks: [{ task_id: "2", reason: "抽验未通过：任务 2 产出字段为空" }],
        },
        makeCtx(REVIEWER, wt),
      )
      expect(res).toContain("提交成功")
      const item = taskItemOf(wt)
      expect(item.currentStep).toBe("implement")
      expect(item.children.filter((c: any) => c.type === "issue")).toHaveLength(0)
      expect(taskPhasesOf(wt)).toEqual({ "1": "done", "2": "todo", "3": "done" })
      const task2 = item.children.find((c: any) => c.id === "2")
      expect(task2.metadata["reject_reason"]).toBe("抽验未通过：任务 2 产出字段为空")
    } finally { teardown(root) }
  })

  test("developer implement 视图渲染已处理 blocker 留痕（architect 代为 resolve 后 dev 可见用户确认）", async () => {
    const { root, wt } = fresh()
    try {
      await initFullWorktree(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        makeCtx("openspec-architect", wt),
      )
      // 任务 2 人工执行 → dev blocker 上报（on_fail 回退 analyze）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: {
            source_role: DEV, task_id: "2", category: "manual_operation",
            description: "任务 2 需人工在生产环境执行", evidence: "无生产凭据",
            attempted_actions: "尝试本地模拟执行失败", options: ["人工执行", "跳过"],
          },
        },
        makeCtx(DEV, wt),
      )
      // architect 代为 resolve：blocker_updates 置 resolved 后 analyze passed → 回到 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB,
          blocker_updates: [{ blocker_id: "b1", user_response: "用户确认已人工执行任务 2" }],
        },
        makeCtx("openspec-architect", wt),
      )
      expect(taskItemOf(wt).currentStep).toBe("implement")
      // dev 视图须渲染留痕（凭记录申报的依据链）：含标题、task 指向与用户确认内容
      const out = await status.execute({ change_id: CID }, makeCtx(DEV, wt))
      expect(out).toContain("Blocker 留痕")
      expect(out).toContain("凭记录申报完成")
      expect(out).toContain("Task #2")
      expect(out).toContain("用户确认已人工执行任务 2")
    } finally { teardown(root) }
  })

  test("必做门禁跳过绑定补交条件：首次提交（未 passed）仅带 verified_tasks 仍被必做门禁拦截", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      // 注入必做清单索引（quality-gate 声明 must_do）后，首次提交仅带 verified_tasks、缺
      // validation_steps → 补交形态不得跳过必做门禁（完整审查首次尚未做过）
      __setMustDoIndex(makeQualityGateIndex())
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx(REVIEWER, wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未覆盖质量门 skill 必做清单/)
      expect(err.message).toContain("compile")
      // 拒绝零状态变更：tag 未写、task 仍 review、step 未推进
      const item = taskItemOf(wt)
      expect(item.tags["quality_review:openspec-reviewer"]).toBeUndefined()
      expect(item.currentStep).toBe("quality_review")
      expect(taskPhasesOf(wt)).toEqual({ "1": "review", "2": "review", "3": "review" })
    } finally { teardown(root) }
  })

  test("必做门禁跳过绑定补交条件：已 passed + 存在 review 态 task 的补交 → 跳过必做门禁收口 done", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await buildSimpleDeadlock(wt)
      // 同一必做清单索引下，严格补交形态（已 passed + 待验证任务存在）仍免必做清单校验
      __setMustDoIndex(makeQualityGateIndex())
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx(REVIEWER, wt),
      )
      const item = taskItemOf(wt)
      expect(item.phase).toBe("done")
      expect(taskPhasesOf(wt)).toEqual({ "1": "done", "2": "done", "3": "done" })
    } finally { teardown(root) }
  })

  test("同轮 blocker + blocker_updates 组合 → 抛错并指引分两轮，零状态变更", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: {
            source_role: DEV, task_id: "2", category: "manual_operation",
            description: "任务 2 需人工执行", evidence: "e", attempted_actions: "a",
          },
          blocker_updates: [{ blocker_id: "b1", user_response: "x" }],
        },
        makeCtx(DEV, wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/不可在同一轮提交中同时上报新 blocker/)
      expect(err.message).toMatch(/分两轮/)
      expect(err.message).toMatch(/下一轮再携带 blocker_updates/)
      // 抛错在一切写入之前：blocker 清单未落盘
      expect(taskItemOf(wt).metadata["blockers"]).toBeUndefined()
    } finally { teardown(root) }
  })
})
