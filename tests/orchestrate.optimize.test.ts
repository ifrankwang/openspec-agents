/**
 * 编排优化测试（M1e 新流单轨重写版）
 *
 * 旧流 B1-B12 场景语义全部迁移到新流（workItems 单轨，经 opx_agent_submit 驱动）：
 * B1   opx_status 阶段门禁视图（✅ 当前轮到你执行 / ⛔ 阶段门禁 / 当前预期角色）
 * B2   Recovery 阶段恢复（item.phase / currentStep / tags 断言）
 * B3   Recovery review_layer 子阶段参数（tool→task→quality 起始层 + 非法组合报错）
 * B4   boundary（analyze execution_boundary 必传/落盘 + verify_* boundary_expansion 合并/拦截）
 * B5   retryCount 不重置（dev 修复提交 / checkpoint continue 均不清 _retryCount）
 * B6   opx_status 视图（orchestrator 分派 / working / gate 三态）
 * B7/B9 verify_quality 维度 gate（5 维全推荐、提交后不再分派、全提交→done 终态）
 * B8   taskNumber 数字 ID 归一化（normalizeTaskIds）+ init base_branch
 * B10  dev 提交后 review 层按 issue sourcePhase 精化重置（resetReviewTagsOnFix 集成路径）
 * B11  agentSummaries 会话摘要（metaOf 断言 + 视图渲染 + recovery 保留）
 * B12  new_children rule 透传（child.metadata.rule）
 *
 * 状态断言映射：taskGroups → taskItemOf/readItem；tg.status → item.phase；
 * tg.tasks → metaOf(item,"tasks")；tg.agentSummaries → metaOf(item,"agent_summaries")。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, status, agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, setupWithFakeGit, teardown } from "./helpers"
import {
  setupToAnalyze, driveToImplement, driveToVerifyTool, driveToVerifyTask, driveToQuality,
  taskListOf, metaOf, readItem, taskIdsOf, DIMENSION_AGENTS,
} from "./helpers-workflow"

const CID = "test-optimize"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string): string {
  return join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
}

/** 直接改写活跃 task WorkItem（手动构造前置状态用）。 */
function rewriteItem(wt: string, mutate: (item: any) => void): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 注入 issue child（metadata 承载归因字段），返回 externalId。 */
function injectIssue(wt: string, overrides: Record<string, unknown>): string {
  const id = `inj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  rewriteItem(wt, (item) => {
    item.children.push({
      id: `issue:${id}`,
      source: "openspec",
      externalId: id,
      type: "issue",
      title: "注入 issue",
      description: "注入 issue 描述",
      phase: "todo",
      suspended: false,
      currentStep: null,
      tags: {},
      metadata: {
        source_phase: (overrides.sourcePhase as string) ?? "tool",
        dimension: (overrides.dimension as string) ?? "style",
        file: overrides.file ?? "",
        line: overrides.line ?? 0,
        suggestion: overrides.suggestion ?? "",
        rule: overrides.rule ?? "",
      },
      children: [],
      labels: [],
      severity: (overrides.severity as string) ?? "Low",
    })
  })
  return id
}

/** 把所有 review 层验证 tag 置为 passed（模拟 review 已全量通过），并把 item 移回 implement 供 dev 提交。 */
function setReviewAllPassed(wt: string): void {
  rewriteItem(wt, (item) => {
    item.phase = "in_progress"
    item.currentStep = "implement"
    item.tags = {
      "analyze:openspec-architect": "passed",
      "implement:openspec-developer": "passed",
      "verify_tool:openspec-reviewer-tool": "passed",
      "verify_task:openspec-reviewer-task": "passed",
    }
    for (const d of DIMENSION_AGENTS) {
      item.tags[`verify_quality:openspec-reviewer-${d}`] = "passed"
    }
  })
}

/** 捕获抛错并断言错误文案。 */
async function expectError(p: Promise<unknown>, pattern: RegExp): Promise<Error> {
  const err = await p.catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toMatch(pattern)
  return err
}

describe("B1. opx_status 阶段门禁", () => {
  test("todo/analyze：architect 可过 gate，developer 被门禁且预期角色为 architect", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const archView = await status.execute({ change_id: CID }, ctx.arch)
      expect(archView).toContain("# ✅ 当前轮到你执行")
      const devView = await status.execute({ change_id: CID }, ctx.dev)
      expect(devView).toContain("# ⛔ 阶段门禁")
      expect(devView).toContain("当前预期角色为：`openspec-architect`")
    } finally { teardown(root) }
  })

  test("in_progress/implement：developer 可过 gate，reviewer-tool 被门禁", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      const devView = await status.execute({ change_id: CID }, ctx.dev)
      expect(devView).toContain("# ✅ 当前轮到你执行")
      const toolView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(toolView).toContain("# ⛔ 阶段门禁")
      expect(toolView).toContain("当前预期角色为：`openspec-developer`")
    } finally { teardown(root) }
  })

  test("review/verify_tool：reviewer-tool 可过 gate，reviewer-task 被门禁", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const toolView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(toolView).toContain("# ✅ 当前轮到你执行")
      const taskView = await status.execute({ change_id: CID }, ctx.taskR)
      expect(taskView).toContain("# ⛔ 阶段门禁")
      expect(taskView).toContain("当前预期角色为：`openspec-reviewer-tool`")
    } finally { teardown(root) }
  })

  test("review/verify_task：reviewer-task 可过 gate，quality reviewer 被门禁", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTask(wt, CID)
      const taskView = await status.execute({ change_id: CID }, ctx.taskR)
      expect(taskView).toContain("# ✅ 当前轮到你执行")
      const styleView = await status.execute({ change_id: CID }, ctx.dims["style"])
      expect(styleView).toContain("# ⛔ 阶段门禁")
      expect(styleView).toContain("当前预期角色为：`openspec-reviewer-task`")
    } finally { teardown(root) }
  })

  test("review/verify_quality：5 维 quality reviewer 均可过 gate", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      for (const d of DIMENSION_AGENTS) {
        const view = await status.execute({ change_id: CID }, ctx.dims[d])
        expect(view).toContain("# ✅ 当前轮到你执行")
      }
    } finally { teardown(root) }
  })

  test("orchestrator 不受 gate 影响：todo/implement 阶段均正常渲染", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const view1 = await status.execute({ change_id: CID }, ctx.orch)
      expect(view1).toContain("# 编排进度")
      await driveToImplement(wt, CID)
      const view2 = await status.execute({ change_id: CID }, ctx.orch)
      expect(view2).toContain("# 编排进度")
    } finally { teardown(root) }
  })
})

describe("B2. Recovery 阶段恢复", () => {
  test("recovery dev_impl → in_progress/implement，analyze passed tag", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(item.tags["analyze:openspec-architect"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("recovery review → review/verify_tool，analyze+implement passed tag", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_tool")
      expect(item.tags["analyze:openspec-architect"]).toBe("passed")
      expect(item.tags["implement:openspec-developer"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("无 recovery 重复 init 保留既有阶段", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await driveToImplement(wt, CID)
      const r = await init.execute({ change_id: CID, task_group_id: "1" }, ctx.orch)
      expect(r).toBe("编排会话已初始化。")
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })
})

describe("B3. Recovery review_layer 子阶段参数", () => {
  test("recovery review + review_layer=task → verify_task 起始，tool passed tag", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "task" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_task")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("recovery review + review_layer=quality → verify_quality 起始，tool+task passed tag", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "quality" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_quality")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("recovery review + review_layer=tool → 同默认 verify_tool 起始", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "tool" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_tool")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("recovery dev_impl + review_layer=task 非法组合 → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl", review_layer: "task" } }, ctx.orch),
        /review_layer 参数仅当 recovery.phase 为 review/
      )
    } finally { teardown(root) }
  })
})

describe("B4. boundary 参数", () => {
  test("analyze passed 必须携带 execution_boundary；缺省抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed" }, ctx.arch),
        /execution_boundary/
      )
      expect(readItem(wt, CID).phase).toBe("todo")
    } finally { teardown(root) }
  })

  test("analyze passed 携带 execution_boundary → metadata 落盘", async () => {
    const { wt, root } = fresh()
    try {
      const { item } = await driveToImplement(wt, CID)
      expect(metaOf(item, "execution_boundary")).toEqual({ allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" })
    } finally { teardown(root) }
  })

  test("verify_tool failed + boundary_expansion → 合并进执行边界并回 implement", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "failed", boundary_expansion: { allowed_directories: ["src/extra"] } },
        ctx.toolR
      )
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(metaOf(item, "execution_boundary").allowed_directories).toContain("src/extra")
    } finally { teardown(root) }
  })

  test("verify_tool passed + boundary_expansion → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_tool", verdict: "passed", boundary_expansion: { allowed_directories: ["src/extra"] } },
          ctx.toolR
        ),
        /passed=true 时不允许边界扩展/
      )
    } finally { teardown(root) }
  })
})

describe("B5. retryCount 不重置", () => {
  test("quality failed 回 implement（_retryCount=1）→ dev 修复提交后 _retryCount 保持 1", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "7", title: "命名问题", description: "命名不规范", severity: "Low", source_phase: "quality", dimension: "style" }],
        },
        ctx.dims["style"]
      )
      expect(metaOf(readItem(wt, CID), "_retryCount")).toBe(1)

      const item0 = readItem(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["7"], completed_task_ids: taskIdsOf(item0) },
        ctx.dev
      )
      expect(metaOf(readItem(wt, CID), "_retryCount")).toBe(1)
    } finally { teardown(root) }
  })

  test("checkpoint continue 后 _retryCount 保持且该 step tag 重置", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      rewriteItem(wt, (item) => {
        item.metadata["_retryCount"] = 3
        item.metadata["_checkpoint"] = true
        item.tags["verify_tool:openspec-reviewer-tool"] = "failed"
      })
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "continue" },
        ctx.toolR
      )
      expect(r).toContain("continue")
      const item = readItem(wt, CID)
      expect(metaOf(item, "_retryCount")).toBe(3)
      expect(item.metadata["_checkpoint"]).toBe(false)
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("B6. opx_status 视图", () => {
  test("orchestrator 分派视图：编排进度 + 下一步分派", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const view = await status.execute({ change_id: CID }, ctx.orch)
      expect(view).toContain("# 编排进度")
      expect(view).toContain("## 下一步")
      expect(view).toContain("分派子代理：`openspec-architect`")
    } finally { teardown(root) }
  })

  test("architect working 视图：✅ 当前轮到你执行 + 操作指引", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const view = await status.execute({ change_id: CID }, ctx.arch)
      expect(view).toContain("# ✅ 当前轮到你执行")
      expect(view).toContain("## 操作指引")
      expect(view).toContain("opx_agent_submit")
    } finally { teardown(root) }
  })

  test("developer gate 视图：⛔ 阶段门禁 + 当前预期角色", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const view = await status.execute({ change_id: CID }, ctx.dev)
      expect(view).toContain("# ⛔ 阶段门禁")
      expect(view).toContain("当前预期角色为：`openspec-architect`")
    } finally { teardown(root) }
  })
})

describe("B7. verify_quality 维度 gate", () => {
  test("verify_quality 起始：5 维全部可过 gate（pending 全推荐）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      for (const d of DIMENSION_AGENTS) {
        const view = await status.execute({ change_id: CID }, ctx.dims[d])
        expect(view).toContain("# ✅ 当前轮到你执行")
      }
    } finally { teardown(root) }
  })

  test("style 提交 passed 后不再分派；其余 4 维仍可过 gate", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims["style"])
      const styleView = await status.execute({ change_id: CID }, ctx.dims["style"])
      expect(styleView).toContain("# ⛔ 阶段门禁")
      for (const d of DIMENSION_AGENTS.filter((x) => x !== "style")) {
        const view = await status.execute({ change_id: CID }, ctx.dims[d])
        expect(view).toContain("# ✅ 当前轮到你执行")
      }
    } finally { teardown(root) }
  })

  test("全部 5 维提交 → done 终态；之后任意维度不再被分派", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      for (const d of DIMENSION_AGENTS) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
      }
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
      // done 终态：quality reviewer 拿到终态视图而非 ✅ 执行视图
      const styleView = await status.execute({ change_id: CID }, ctx.dims["style"])
      expect(styleView).toContain("任务组已完成，待收尾")
    } finally { teardown(root) }
  })
})

describe("B8. taskNumber 数字 ID 归一化 + init base_branch", () => {
  test("completed_task_ids 用 taskNumber（1.1/1.2/1.3）→ normalizeTaskIds → 全 submitted", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1.1", "1.2", "1.3"] },
        ctx.dev
      )
      expect(taskListOf(readItem(wt, CID)).every((t: any) => t.status === "submitted")).toBe(true)
    } finally { teardown(root) }
  })

  test("verified_tasks 用 taskNumber → 全 verified", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTask(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1.1", "1.2", "1.3"] },
        ctx.taskR
      )
      expect(taskListOf(readItem(wt, CID)).every((t: any) => t.status === "verified")).toBe(true)
      expect(readItem(wt, CID).currentStep).toBe("verify_quality")
    } finally { teardown(root) }
  })

  test("init 显式传 base_branch → state.baseBranch 正确", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeCtx("openspec-orchestrator", wt)
      await init.execute({ change_id: CID, task_group_id: "1", base_branch: "develop" }, o)
      const state = JSON.parse(readFileSync(statePath(wt), "utf-8"))
      expect(state.baseBranch).toBe("develop")
    } finally { teardown(root) }
  })
})

describe("B10. dev 提交后 review 层按 sourcePhase 精化重置", () => {
  test("dev 仅修 tool 层 issue → 清 verify_tool；verify_task/verify_quality 保留", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      setReviewAllPassed(wt)
      const id = injectIssue(wt, { sourcePhase: "tool", dimension: "style", severity: "Low" })
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: [id], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      const tags = readItem(wt, CID).tags
      expect(tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("dev 仅修 quality 层 issue（style）→ 清 verify_tool + quality style 维度；verify_task 保留", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      setReviewAllPassed(wt)
      const id = injectIssue(wt, { sourcePhase: "quality", dimension: "style", severity: "Low" })
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: [id], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      const tags = readItem(wt, CID).tags
      expect(tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
      expect(tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("dev 修 task 层 issue → 清 verify_tool + verify_task", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      setReviewAllPassed(wt)
      const id = injectIssue(wt, { sourcePhase: "task", dimension: "style", severity: "Low" })
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: [id], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      const tags = readItem(wt, CID).tags
      expect(tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("dev 仅豁免 quality 层 issue → verify_tool/verify_task 保留；style 维度清空且可被分派", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      setReviewAllPassed(wt)
      const id = injectIssue(wt, { sourcePhase: "quality", dimension: "style", severity: "Low" })
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: [id], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      const item = readItem(wt, CID)
      // 豁免不改代码：tool/task 层不重置
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      // 仅重置对应 quality 维度
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      // 豁免申请标记落盘
      expect(item.children.find((c: any) => c.externalId === id).metadata["exempt_request"]).toBeDefined()

      // 豁免裁定者（style reviewer）仍被分派；architecture 已 passed 不再分派
      rewriteItem(wt, (it) => { it.phase = "review"; it.currentStep = "verify_quality" })
      const styleView = await status.execute({ change_id: CID }, ctx.dims["style"])
      expect(styleView).toContain("# ✅ 当前轮到你执行")
      const archView = await status.execute({ change_id: CID }, ctx.dims["architecture"])
      expect(archView).toContain("# ⛔ 阶段门禁")
    } finally { teardown(root) }
  })
})

describe("B11. agentSummaries 会话摘要", () => {
  test("metadata.agent_summaries 落盘 → metaOf 断言存在", async () => {
    const { wt, root } = fresh()
    try {
      await driveToImplement(wt, CID)
      rewriteItem(wt, (item) => {
        item.metadata["agent_summaries"] = { "openspec-architect": "预检通过，已输出执行边界" }
      })
      expect(metaOf(readItem(wt, CID), "agent_summaries")["openspec-architect"]).toBe("预检通过，已输出执行边界")
    } finally { teardown(root) }
  })

  test("developer 视图包含「上轮会话摘要」区块", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      rewriteItem(wt, (item) => {
        item.metadata["agent_summaries"] = { "openspec-architect": "预检通过，已输出执行边界" }
      })
      const view = await status.execute({ change_id: CID }, ctx.dev)
      expect(view).toContain("## 上轮会话摘要")
      expect(view).toContain("**openspec-architect**：预检通过，已输出执行边界")
    } finally { teardown(root) }
  })

  test("agent_summaries 在 init(recovery) 后保留（跨会话续接）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      rewriteItem(wt, (item) => {
        item.metadata["agent_summaries"] = { "openspec-architect": "预检通过，已输出执行边界" }
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl" } }, ctx.orch)
      expect(metaOf(readItem(wt, CID), "agent_summaries")["openspec-architect"]).toBe("预检通过，已输出执行边界")
    } finally { teardown(root) }
  })
})

describe("B12. new_children rule 透传", () => {
  test("verify_tool failed + new_children 带 rule → child.metadata.rule 保存", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "7", title: "Magic number", description: "魔法数字", severity: "Low", rule: "PMD.AvoidLiteralsInIfCondition" }],
        },
        ctx.toolR
      )
      const child = readItem(wt, CID).children.find((c: any) => c.externalId === "7")
      expect(child.metadata["rule"]).toBe("PMD.AvoidLiteralsInIfCondition")
      expect(readItem(wt, CID).phase).toBe("in_progress")
    } finally { teardown(root) }
  })

  test("developer 视图渲染带 rule 的 issue child", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      rewriteItem(wt, (item) => {
        item.children.push({
          id: "issue:r1",
          source: "openspec",
          externalId: "r1",
          type: "issue",
          title: "Magic number",
          description: "魔法数字",
          phase: "todo",
          suspended: false,
          currentStep: null,
          tags: {},
          metadata: { source_phase: "tool", dimension: "style", rule: "PMD.AvoidLiteralsInIfCondition" },
          children: [],
          labels: [],
          severity: "Low",
        })
      })
      const view = await status.execute({ change_id: CID }, ctx.dev)
      expect(view).toContain("PMD.AvoidLiteralsInIfCondition")
      expect(view).toContain("魔法数字")
    } finally { teardown(root) }
  })
})
