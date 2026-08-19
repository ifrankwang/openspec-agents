/**
 * simple 模式提交工具测试（变更组 2.5）：
 * - implement 提交工作区干净强检查（2.2）：不干净拒绝且零状态变更 / 干净放行进入 quality_review
 * - quality_review failed 理由判定不按维度过滤（2.3）：新报 Low+ 或存在 quality 报源未终态阻塞即构成理由，
 *   无理由拒绝；full 模式 verify_quality 各维度分支不受影响（维度过滤回归）
 * - 谁提谁裁定按 quality_review step agents 反推天然命中：openspec-reviewer 复核自己报的 issue；
 *   非报源 reviewer 裁定被拒
 * - simple 审查者未声明 dimension 上报被拒（spec:agent-identity#simple 审查者 issue 显式声明 dimension）
 * - 重复提交守卫按 tag passed 判定：failed 可重提、passed 非补交拒绝、仅裁定参数补交放行
 * - resetReviewTagsOnFix / clearReviewVerificationTags 对 verify_* tag 在 simple 下空操作无副作用
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, setupWorkspace, teardown, initSimpleWorktree } from "./helpers"

const CID = "mode-submit"
const DEV = "openspec-developer"
const REVIEWER = "openspec-reviewer"

afterAll(() => { __setGitRunner(null) })

function taskItemOf(wt: string): any {
  const p = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8")) as { workItems: any[] }
  return state.workItems.find((w: any) => w.id === "task:1")
}

/** 直接向 state 注入一个 issue child（push 到活跃 task WorkItem 的 children）。 */
function injectIssue(wt: string, child: any): void {
  const p = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8")) as { workItems: any[] }
  state.workItems.find((w: any) => w.id === "task:1").children.push(child)
  writeFileSync(p, JSON.stringify(state, null, 2))
}

function fresh(): { root: string; wt: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/modesub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  return { root, wt, fakeGit }
}

/** simple 初始态（initSimpleWorktree 已置 in_progress/implement）→ implement passed 进入 quality_review。 */
async function enterQualityReview(wt: string): Promise<void> {
  await agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
    makeCtx(DEV, wt),
  )
}

describe("2.2 implement 提交工作区干净强检查", () => {
  test("simple 模式工作区不干净：拒绝提交、提示先 commit、零状态变更", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // 2.2 强检查针对 worktree（item.metadata.worktree_path = <repo>/.worktree/<cid>/task-group-1）
      fakeGit.dirtyPaths.add(join(wt, ".worktree", CID, "task-group-1"))
      const err = await agent_submit
        .execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx(DEV, wt))
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未提交内容/)
      expect(err.message).toMatch(/git commit/)
      // 零状态变更：tag 未写入、phase/currentStep 未动、task children 未置 review
      const item = taskItemOf(wt)
      expect(item.tags["implement:openspec-developer"]).toBeUndefined()
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(item.children.every((c: any) => c.type !== "task" || c.phase === "todo")).toBe(true)
    } finally { teardown(root) }
  })

  test("simple 模式工作区干净：放行并推进 quality_review", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      const item = taskItemOf(wt)
      expect(item.tags["implement:openspec-developer"]).toBe("passed")
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("quality_review")
    } finally { teardown(root) }
  })
})

describe("2.3 quality_review failed 理由判定不按维度过滤", () => {
  test("openspec-reviewer 新报 Low+ issue（显式 dimension）即构成理由，failed 提交成功", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      // agentToReviewDimension("openspec-reviewer") === undefined：按旧逻辑维度过滤会导致
      // 任何 failed 提交都报「不存在未解决的阻塞 issue」死锁；2.3 分支修复后新报 Low+ 即理由。
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      )
      const item = taskItemOf(wt)
      expect(item.tags["quality_review:openspec-reviewer"]).toBe("failed")
      // 单 agent step failed 提交后立即回退 implement（整步重审），issue 入库 todo 待修复
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      const issue = item.children.find((c: any) => c.externalId === "i1")
      expect(issue).toBeDefined()
      expect(issue.phase).toBe("todo")
      expect(issue.metadata.source).toBe("openspec-reviewer")
    } finally { teardown(root) }
  })

  test("存在 quality 报源未终态阻塞 issue（无新报）也构成理由", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      injectIssue(wt, {
        id: "issue:i0", source: "openspec-reviewer", externalId: "i0", type: "issue",
        title: "存量问题", description: "存量", phase: "todo", suspended: false, currentStep: null,
        tags: {}, metadata: { source: "openspec-reviewer", dimension: "architecture" },
        children: [], labels: [], severity: "High",
      })
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "failed" },
        makeCtx(REVIEWER, wt),
      )
      expect(taskItemOf(wt).tags["quality_review:openspec-reviewer"]).toBe("failed")
    } finally { teardown(root) }
  })

  test("无任何理由（无新报、无 quality 层阻塞）failed 提交被拒", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      const err = await agent_submit
        .execute({ change_id: CID, step_id: "quality_review", verdict: "failed" }, makeCtx(REVIEWER, wt))
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/不存在未解决的阻塞 issue/)
      expect(taskItemOf(wt).tags["quality_review:openspec-reviewer"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("full 模式 verify_quality 维度过滤回归：非本维 issue 不构成该维 failed 理由", async () => {
    const { root, wt } = fresh()
    try {
      // full 模式（不写 workflow.yaml，init 兜底 full）：quality 层遗留阻塞维度为 architecture
      const { init, set_worktree } = await import("../src/adapters/opencode/tools")
      const orch = makeCtx("primary", wt, { orchestrator: true })
      await init.execute({ change_id: CID, task_group_id: "1" }, orch)
      await set_worktree.execute({ change_id: CID }, orch)
      const p = join(wt, "openspec", "states", `${CID}.json`)
      const state = JSON.parse(readFileSync(p, "utf-8")) as { workItems: any[] }
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.phase = "review"
      item.currentStep = "verify_quality"
      writeFileSync(p, JSON.stringify(state, null, 2))

      // 注入 architecture 维报源的未终态阻塞 issue
      injectIssue(wt, {
        id: "issue:a1", source: "openspec-reviewer-architecture", externalId: "a1", type: "issue",
        title: "架构问题", description: "arch", phase: "todo", suspended: false, currentStep: null,
        tags: {}, metadata: { source: "openspec-reviewer-architecture", dimension: "architecture" },
        children: [], labels: [], severity: "High",
      })
      // style 维 failed：遗留阻塞归属 architecture 维，不构成 style 维理由 → 拒绝
      const err = await agent_submit
        .execute({ change_id: CID, step_id: "verify_quality", verdict: "failed" }, makeCtx("openspec-reviewer-style", wt))
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/不存在未解决的阻塞 issue/)
      // architecture 维 failed：本维遗留阻塞构成理由 → 放行
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "failed" },
        makeCtx("openspec-reviewer-architecture", wt),
      )
      expect(taskItemOf(wt).tags["verify_quality:openspec-reviewer-architecture"]).toBe("failed")
    } finally { teardown(root) }
  })
})

describe("谁提谁裁定：quality_review step agents 反推天然命中", () => {
  test("openspec-reviewer 复核自己报的 issue（recheck passed）→ done，整链路收口 done", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // ① implement → quality_review
      await enterQualityReview(wt)
      // ② reviewer failed 报 issue → 回 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      )
      // ③ dev 修复 → 回 quality_review
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["i1"], completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      expect(taskItemOf(wt).currentStep).toBe("quality_review")
      // ④ 报源 reviewer 复核通过 + 任务全验证 → done
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "passed",
          recheck_adjudications: [{ issue_id: "i1", verdict: "passed" }],
          verified_tasks: ["1", "2", "3"],
        },
        makeCtx(REVIEWER, wt),
      )
      const item = taskItemOf(wt)
      expect(item.phase).toBe("done")
      expect(item.children.find((c: any) => c.externalId === "i1").phase).toBe("done")
    } finally { teardown(root) }
  })

  test("非报源 reviewer（openspec-reviewer-tool）裁定被拒（谁提谁裁定）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["i1"], completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      // 越权：openspec-reviewer-tool 不是报源（报源 openspec-reviewer 属 quality_review.agents）→ 拒绝
      const err = await agent_submit
        .execute(
          { change_id: CID, step_id: "quality_review", verdict: "passed", recheck_adjudications: [{ issue_id: "i1", verdict: "passed" }] },
          makeCtx("openspec-reviewer-tool", wt),
        )
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/谁提谁裁定/)
    } finally { teardown(root) }
  })
})

describe("simple 审查者上报未声明 dimension 被拒", () => {
  test("new_children 缺 dimension → 拒绝且零状态变更", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      const err = await agent_submit
        .execute(
          {
            change_id: CID, step_id: "quality_review", verdict: "failed",
            new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low" }],
          },
          makeCtx(REVIEWER, wt),
        )
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/dimension/)
      expect(taskItemOf(wt).tags["quality_review:openspec-reviewer"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("重复提交守卫：按 tag passed 判定，兼容失败重提", () => {
  test("failed 可重提：两次 failed 提交均成功（守卫只看 passed）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // ① implement → quality_review
      await enterQualityReview(wt)
      // ② reviewer failed 报 issue（new_children Low+ 即理由）→ 回 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      )
      expect(taskItemOf(wt).tags["quality_review:openspec-reviewer"]).toBe("failed")
      // ③ dev 修复 i1 → 重进 quality_review（i1 进入 review 态，implement carve-out 放行）
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["i1"], completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      expect(taskItemOf(wt).currentStep).toBe("quality_review")
      // ④ 第二次 failed（失败重提：守卫按 tag passed 判定不拦截；review 态 i1 构成 quality 层阻塞理由）
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "failed" },
        makeCtx(REVIEWER, wt),
      )
      expect(taskItemOf(wt).tags["quality_review:openspec-reviewer"]).toBe("failed")
    } finally { teardown(root) }
  })

  test("passed 后非补交重复提交被拒；仅裁定参数补交放行并推进 done", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      // 注入本层 review 态阻塞 issue（模拟已修复待复核）
      injectIssue(wt, {
        id: "issue:i0", source: "openspec-reviewer", externalId: "i0", type: "issue",
        title: "已修复问题", description: "fixed", phase: "review", suspended: false, currentStep: null,
        tags: {}, metadata: { source: "openspec-reviewer", dimension: "style" },
        children: [], labels: [], severity: "Low",
      })
      // 第一次 passed（漏带复核裁定）→ tag=passed 但本层 blocking 未终态，stepCanPass=false 停在 quality_review
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx(REVIEWER, wt),
      )
      const stuck = taskItemOf(wt)
      expect(stuck.tags["quality_review:openspec-reviewer"]).toBe("passed")
      expect(stuck.currentStep).toBe("quality_review")
      // 非补交重复提交 → 守卫拒绝
      const err = await agent_submit
        .execute(
          { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
          makeCtx(REVIEWER, wt),
        )
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/重复提交守卫/)
      // 仅裁定参数（recheck_adjudications）补交 → 守卫豁免放行：复核 i0 通过后本层 blocking 全终态 → done
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "passed",
          recheck_adjudications: [{ issue_id: "i0", verdict: "passed" }],
        },
        makeCtx(REVIEWER, wt),
      )
      const item = taskItemOf(wt)
      expect(item.phase).toBe("done")
      expect(item.children.find((c: any) => c.externalId === "i0").phase).toBe("done")
    } finally { teardown(root) }
  })
})

describe("simple 下 verify_* tag 重置空操作无副作用", () => {
  test("resetReviewTagsOnFix：fixed 提交不清 quality_review failed tag，且不产生 verify_* tag 条目", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      )
      expect(taskItemOf(wt).tags["quality_review:openspec-reviewer"]).toBe("failed")
      // dev 修复：resetReviewTagsOnFix 只清 verify_tool/verify_task/verify_quality 维 tag——
      // simple 无这些 step，空操作；quality_review failed tag 不因 dev 修复被清除（回 implement 后
      // 重进 quality_review 时审查者必然被重派，与 full 模式 failed 维重派语义一致）
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["i1"], completed_task_ids: ["1", "2", "3"] },
        makeCtx(DEV, wt),
      )
      const tags = taskItemOf(wt).tags
      expect(tags["quality_review:openspec-reviewer"]).toBe("failed")
      expect(Object.keys(tags).some((k) => k.startsWith("verify_tool") || k.startsWith("verify_task") || k.startsWith("verify_quality"))).toBe(false)
      expect(taskItemOf(wt).currentStep).toBe("quality_review")
    } finally { teardown(root) }
  })

  test("clearReviewVerificationTags：simple implement blocker 提交（resetTasksForBlocker）无 verify_* tag 副作用", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: {
            source_role: "openspec-developer", task_id: "1", category: "外部依赖",
            description: "需要人工运维", evidence: "e", attempted_actions: "a",
          },
        },
        makeCtx(DEV, wt),
      )
      const item = taskItemOf(wt)
      // blocker 提交成功、回退自循环停在 implement
      expect(item.currentStep).toBe("implement")
      expect(item.tags["implement:openspec-developer"]).toBe("failed")
      // clearReviewVerificationTags（verify_tool/verify_task/verify_quality）在 simple 下空操作
      expect(Object.keys(item.tags).some((k) => k.startsWith("verify_tool") || k.startsWith("verify_task") || k.startsWith("verify_quality"))).toBe(false)
    } finally { teardown(root) }
  })
})
