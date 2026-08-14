/**
 * 编排优化测试（M1e 新流单轨重写版）
 *
 * 旧流 B1-B12 场景语义全部迁移到新流（workItems 单轨，经 opx_agent_submit 驱动）：
 * B1   opx_status 阶段门禁视图（✅ 当前轮到你执行 / ⛔ 阶段门禁 / 当前预期角色）
 * B2   Recovery 阶段恢复（item.phase / currentStep / tags 断言）
 * B3   Recovery review_layer 子阶段参数（tool→task→quality 起始层 + 非法组合报错）
 * B4   boundary（analyze execution_boundary 必传/落盘 + verify_* boundary_expansion 合并/拦截）
 * B5   retryCount 语义（dev 修复提交不清 _retryCount；checkpoint continue 重置为 0 解除检查点）
 * B6   opx_status 视图（orchestrator 分派 / working / gate 三态）
 * B7/B9 verify_quality 维度 gate（5 维全推荐、提交后不再分派、全提交→done 终态）
 * B8   taskNumber 数字 ID 归一化（normalizeTaskIds）+ init base_branch
 * B10  dev 提交后 review 层按 issue sourcePhase 精化重置（resetReviewTagsOnFix 集成路径）；blocked 豁免补交闭环视图（待裁定清单 + 补交指引）
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
import { init, status, agent_submit, complete_task_group } from "../src/adapters/opencode/tools"
import { loadWorkflowFile, TASK_WORKFLOW_PATH } from "../src/core/workflow/loader"
import { checkpointTriggered, recommendForItem } from "../src/core/workflow/engine"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWithFakeGit, teardown } from "./helpers"
import {
  setupToAnalyze, driveToImplement, driveToVerifyTool, driveToVerifyTask, driveToQuality, submitQualityPassed,
  taskListOf, metaOf, readItem, taskIdsOf, DIMENSION_AGENTS, rollbackQuality,
} from "./helpers-workflow"

const CID = "test-optimize"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string): string {
  return join(wt, "openspec", "states", `${CID}.json`)
}

/** 直接改写活跃 task WorkItem（手动构造前置状态用）。 */
function rewriteItem(wt: string, mutate: (item: any) => void): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 注入 issue child（metadata 承载归因字段），返回 externalId。source 按 sourcePhase 映射为报源 agent，
 *  对齐 buildIssueChild 的落盘形态（supplement 补交推导依赖 metadata.source）。 */
function injectIssue(wt: string, overrides: Record<string, unknown>): string {
  const id = `inj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const sp = (overrides.sourcePhase as string) ?? "tool"
  const dim = overrides.dimension as string | undefined
  const source =
    sp === "tool" ? "openspec-reviewer-tool"
    : sp === "task" ? "openspec-reviewer-task"
    : `openspec-reviewer-${dim ?? "style"}`
  rewriteItem(wt, (item) => {
    item.children.push({
      id: `issue:${id}`,
      source: source,
      externalId: id,
      type: "issue",
      title: "注入 issue",
      description: "注入 issue 描述",
      phase: "todo",
      suspended: false,
      currentStep: null,
      tags: {},
      metadata: {
        source,
        source_phase: sp,
        ...(dim !== undefined && dim !== null ? { dimension: dim as string } : {}),
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

  test("recovery review → review/verify_tool，analyze+implement passed tag；残留 _retryCount 被清除", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      // 注入残留重试计数：recovery 须清除，防止恢复后下一次回退立即再次触发检查点
      rewriteItem(wt, (item) => { item.metadata["_retryCount"] = 5 })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_tool")
      expect(item.tags["analyze:openspec-architect"]).toBe("passed")
      expect(item.tags["implement:openspec-developer"]).toBe("passed")
      expect(metaOf(item, "_retryCount")).toBe(0)
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

describe("B3.1. Recovery review 增量合并（保留 passed / 重置 failed / 前移跳层 / 全 passed 收口）", () => {
  test("已 passed 的 verify_tool 保留且跳过：recovery review → currentStep 直达 verify_task", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "verify_tool"
        item.tags["verify_tool:openspec-reviewer-tool"] = "passed"
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_task")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("部分维度 passed 保留：quality 层 style passed 不变，其余维度保持 pending", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "verify_quality"
        item.tags["verify_quality:openspec-reviewer-style"] = "passed"
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "quality" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_quality")
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      // 其余维度无 passed 残留（保持 pending）
      for (const d of DIMENSION_AGENTS) {
        if (d !== "style") expect(item.tags[`verify_quality:openspec-reviewer-${d}`]).toBeUndefined()
      }
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("failed 重置为 pending：performance 维度 failed 恢复后 tag 清除", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "verify_quality"
        item.tags["verify_quality:openspec-reviewer-performance"] = "failed"
        item.tags["verify_quality:openspec-reviewer-security"] = "passed"
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "quality" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.tags["verify_quality:openspec-reviewer-performance"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-security"]).toBe("passed")
      expect(item.currentStep).toBe("verify_quality")
    } finally { teardown(root) }
  })

  test("四个 review step 全 passed 且 task children 终态 → 收口 done，currentStep 置 null", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "verify_quality"
        item.tags = {
          "analyze:openspec-architect": "passed",
          "implement:openspec-developer": "passed",
          "verify_tool:openspec-reviewer-tool": "passed",
          "verify_task:openspec-reviewer-task": "passed",
          "verify_cleanup:openspec-developer": "passed",
        }
        for (const d of DIMENSION_AGENTS) {
          item.tags[`verify_quality:openspec-reviewer-${d}`] = "passed"
        }
        for (const c of item.children) {
          if (c.type === "task") c.phase = "done"
        }
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
    } finally { teardown(root) }
  })

  test("全 passed（含 verify_cleanup）但存在未终态 task child → 停在 verify_quality（不收口 done）", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "verify_quality"
        item.tags = {
          "verify_tool:openspec-reviewer-tool": "passed",
          "verify_task:openspec-reviewer-task": "passed",
          "verify_cleanup:openspec-developer": "passed",
        }
        for (const d of DIMENSION_AGENTS) {
          item.tags[`verify_quality:openspec-reviewer-${d}`] = "passed"
        }
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_quality")
    } finally { teardown(root) }
  })

  test("重复提交守卫仍生效：recovery 保留 passed 后 reviewer-tool 再提交 verify_tool 被拒绝", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "verify_tool"
        item.tags["verify_tool:openspec-reviewer-tool"] = "passed"
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      const item = readItem(wt, CID)
      // 恢复后 verify_tool 全 passed 被跳过，currentStep 已前移到 verify_task
      expect(item.currentStep).toBe("verify_task")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      // reviewer-tool 以 passed 再提交 verify_tool → submit 路由守卫（currentStep 不一致）拒绝，零状态变更
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR),
        /submit 校验失败|重复提交守卫/
      )
    } finally { teardown(root) }
  })

  test("正向续跑：部分维度 passed 恢复后剩余维度提交推进到 done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 模拟会话中断前 style/architecture 两维已通过：置 passed 后其余 3 维仍 pending
      rewriteItem(wt, (item) => {
        item.tags["verify_quality:openspec-reviewer-style"] = "passed"
        item.tags["verify_quality:openspec-reviewer-architecture"] = "passed"
      })
      await init.execute(
        { change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "quality" } },
        ctx.orch
      )
      let item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_quality")
      // 已 passed 维度 tag 保留
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      // pending 维度无 passed 残留
      for (const d of ["performance", "security", "maintainability"]) {
        expect(item.tags[`verify_quality:openspec-reviewer-${d}`]).toBeUndefined()
      }
      // review_layer=quality 强制前置 tool/task
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")

      // 剩余 3 个 pending 维度 reviewer 依次提交 passed：聚合等待期停在 verify_quality
      for (const d of ["performance", "security"]) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
        expect(readItem(wt, CID).currentStep).toBe("verify_quality")
      }
      // 最后一维提交 → 全部维度已 passed → 聚合推进 verify_cleanup（task children 经 driveToQuality 已终态）
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed" },
        ctx.dims["maintainability"]
      )
      item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_cleanup")
      // developer 收尾验证通过 → done
      await agent_submit.execute({ change_id: CID, step_id: "verify_cleanup", verdict: "passed" }, ctx.dev)
      item = readItem(wt, CID)
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
      // 全程保留已 passed 维度 tag，无 pending 残留
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      for (const d of ["performance", "security", "maintainability"]) {
        expect(item.tags[`verify_quality:openspec-reviewer-${d}`]).toBe("passed")
      }
    } finally { teardown(root) }
  })

  test("review_layer=task 强制覆盖 prior failed 的 verify_tool", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      // 模拟 tool 层 failed 残留：verify_tool 曾以 failed 提交后会话中断
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "verify_tool"
        item.tags["verify_tool:openspec-reviewer-tool"] = "failed"
      })
      await init.execute(
        { change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "task" } },
        ctx.orch
      )
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      // review_layer=task 强制前置：failed 被覆盖为 passed
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      // currentStep 前移到第一个未全 passed 的子层
      expect(item.currentStep).toBe("verify_task")
      // verify_task 未被强制前置，保持 pending（无 passed 残留）
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
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
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          boundary_expansion: { allowed_directories: ["src/extra"] },
          new_children: [{ id: "7", title: "Tool issue", description: "工具层问题", severity: "Low", dimension: "style" }],
        },
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

describe("B5. checkpoint continue 重置 retryCount", () => {
  test("quality failed 回 implement（_retryCount=1）→ dev 修复提交后 _retryCount 保持 1", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await rollbackQuality(ctx, CID, {
        failedDim: "style",
        newChildren: [{ id: "7", title: "命名问题", description: "命名不规范", severity: "Low", dimension: "style" }],
      })
      expect(metaOf(readItem(wt, CID), "_retryCount")).toBe(1)

      const item0 = readItem(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["7"], completed_task_ids: taskIdsOf(item0) },
        ctx.dev
      )
      expect(metaOf(readItem(wt, CID), "_retryCount")).toBe(1)
    } finally { teardown(root) }
  })

  test("checkpoint continue 后 _retryCount 重置为 0，检查点解除、分派视图恢复", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      // 真实触发路径：_retryCount=10（max_retries 10 的倍数）+ 无 _checkpoint 标记 + 未终态 child（task issue 遗留）
      rewriteItem(wt, (item) => {
        item.metadata["_retryCount"] = 10
        delete item.metadata["_checkpoint"]
        item.tags["verify_tool:openspec-reviewer-tool"] = "failed"
      })
      const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
      const step = workflow.stepMap.get("verify_tool")!.step
      const item0 = readItem(wt, CID)
      expect(checkpointTriggered(item0, workflow, step)).toBe(true)
      expect(recommendForItem(item0, workflow).status).toBe("checkpoint")

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "continue" },
        ctx.toolR
      )
      expect(r).toContain("continue")
      const item = readItem(wt, CID)
      expect(metaOf(item, "_retryCount")).toBe(0)
      expect(item.metadata["_checkpoint"]).toBe(false)
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      const rec = recommendForItem(item, workflow)
      expect(rec.status).not.toBe("checkpoint")
      expect(rec.agents.length).toBeGreaterThan(0)
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

  test("全部 5 维提交 → verify_cleanup；developer 收尾验证通过后 done 终态；之后任意维度不再被分派", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      for (const d of DIMENSION_AGENTS) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
      }
      const atCleanup = readItem(wt, CID)
      expect(atCleanup.phase).toBe("review")
      expect(atCleanup.currentStep).toBe("verify_cleanup")
      await agent_submit.execute({ change_id: CID, step_id: "verify_cleanup", verdict: "passed" }, ctx.dev)
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
      // done 终态：quality reviewer 拿到终态视图而非 ✅ 执行视图
      const styleView = await status.execute({ change_id: CID }, ctx.dims["style"])
      expect(styleView).toContain("任务组已完成，待收尾")
    } finally { teardown(root) }
  })
})

describe("B7.5. verify_quality 聚合判定", () => {
  test("一维 failed 后其余维度仍可提交（不报 currentStep 校验错误），全部提交后才回退 implement", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // style 维 failed（带 Low 新报理由）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "7", title: "风格问题", description: "d", severity: "Low", dimension: "style" }],
        },
        ctx.dims["style"]
      )
      // 聚合等待：单维 failed 不触发回退，其余维度仍可提交
      expect(readItem(wt, CID).currentStep).toBe("verify_quality")
      for (const d of ["architecture", "performance", "security"]) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
        expect(readItem(wt, CID).currentStep).toBe("verify_quality")
      }
      // 最后一个维度提交 → 全部已裁决 → 聚合回退 implement
      await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims["maintainability"])
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("全部 5 维 passed 才推进 verify_cleanup（多 agent 聚合通过），收尾验证后 done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      for (const d of ["style", "architecture", "performance"]) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
        expect(readItem(wt, CID).currentStep).toBe("verify_quality")
      }
      await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims["security"])
      await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims["maintainability"])
      expect(readItem(wt, CID).currentStep).toBe("verify_cleanup")
      await agent_submit.execute({ change_id: CID, step_id: "verify_cleanup", verdict: "passed" }, ctx.dev)
      expect(readItem(wt, CID).phase).toBe("done")
    } finally { teardown(root) }
  })

  test("review failed 后已 passed 层/维度 tag 保留，下次只重审失败维度", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "7", title: "风格问题", description: "d", severity: "Low", dimension: "style" }],
        },
        ctx.dims["style"]
      )
      for (const d of DIMENSION_AGENTS.filter((x) => x !== "style")) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
      }
      const back = readItem(wt, CID)
      expect(back.phase).toBe("in_progress")
      expect(back.currentStep).toBe("implement")
      // review failed 不再全清：已 passed 的 verify_tool/verify_task 与其余维度 tag 保留，失败维度保留 failed
      expect(back.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(back.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(back.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      expect(back.tags["verify_quality:openspec-reviewer-style"]).toBe("failed")

      // dev 仅豁免 style 层 issue（不改代码）→ exempt 不清维度 tag（style 已 failed 残留待重审），verify_tool/verify_task 保留
      const item0 = readItem(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["7"], completed_task_ids: taskIdsOf(item0) },
        ctx.dev
      )
      // 模拟编排将任务移回 verify_quality 恢复重审
      rewriteItem(wt, (item) => { item.phase = "review"; item.currentStep = "verify_quality" })
      const item = readItem(wt, CID)
      // exempt 不触发维度 tag 清除：style 残留 failed（本维仍待重审），其余已 passed 维度保留
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("failed")
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      // 只重审失败维度：仅 style（failed）可过 gate，其余已 passed 维度不可分派
      const styleView = await status.execute({ change_id: CID }, ctx.dims["style"])
      expect(styleView).toContain("# ✅ 当前轮到你执行")
      const archView = await status.execute({ change_id: CID }, ctx.dims["architecture"])
      expect(archView).toContain("# ⛔ 阶段门禁")
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
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", base_branch: "develop" }, o)
      const state = JSON.parse(readFileSync(statePath(wt), "utf-8"))
      expect(state.baseBranch).toBe("develop")
    } finally { teardown(root) }
  })
})

describe("B10. dev 提交后 review 层按报源层精化重置", () => {
  test("dev 仅修 tool 报源层 issue（无 dimension）→ 清 verify_tool；verify_task/verify_quality 保留", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      setReviewAllPassed(wt)
      const id = injectIssue(wt, { sourcePhase: "tool", severity: "Low" })
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

  test("dev 修 task 报源层 issue → 清 verify_tool + verify_task", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      setReviewAllPassed(wt)
      const id = injectIssue(wt, { sourcePhase: "task", severity: "Low" })
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: [id], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      const tags = readItem(wt, CID).tags
      expect(tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("dev 仅豁免 quality 层 issue → verify_tool/verify_task 与 quality 维度 tag 均保留；豁免裁定经补交路径派报源 reviewer", async () => {
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
      // 豁免不清 quality 维度 tag：已 passed 的 style 维度保留（不再触发无实际待办的维度重复调度）
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      // 豁免申请标记落盘
      expect(item.children.find((c: any) => c.externalId === id).metadata["exempt_request"]).toBeDefined()

      // 豁免裁定经补交路径派报源 reviewer（blockedSupplementAgents 基于 child 状态推导，不依赖维度 tag）；
      // 维度 tag 已 passed，不触发「轮到你执行」的全量重审
      rewriteItem(wt, (it) => { it.phase = "review"; it.currentStep = "verify_quality" })
      const orchView = await status.execute({ change_id: CID }, ctx.orch)
      expect(orchView).toContain("分派子代理")
      expect(orchView).toContain("openspec-reviewer-style")
      const styleView = await status.execute({ change_id: CID }, ctx.dims["style"])
      expect(styleView).not.toContain("# ✅ 当前轮到你执行")
      const archView = await status.execute({ change_id: CID }, ctx.dims["architecture"])
      expect(archView).not.toContain("# ✅ 当前轮到你执行")
    } finally { teardown(root) }
  })

  test("B10 豁免补交闭环：blocked 被分派 reviewer 视图含待裁定豁免清单与补交指引；补交 dismissed+passed 解除推进", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 注入 style 报源豁免申请（todo + exempt_request 标记），报源 reviewer 应裁定
      rewriteItem(wt, (item) => {
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "不可修 issue", description: "第三方限制", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: {
            source: "openspec-reviewer-style", source_phase: "quality", dimension: "style",
            exempt_request: { requestedBy: "openspec-developer" },
          },
          children: [], labels: [], severity: "Low",
        })
      })
      // 5 维全 passed + 豁免申请未裁定 → 引擎 blocked → orchestrator 分派报源 style reviewer 补交裁定
      await submitQualityPassed(ctx, CID)
      const orchView = await status.execute({ change_id: CID }, ctx.orch)
      expect(orchView).toContain("分派子代理：`openspec-reviewer-style`")

      // 被分派 reviewer 的 blocked 视图渲染待裁定豁免清单 + 补交指引（修复前缺失 → reviewer 无据可依空转）
      const styleView = await status.execute({ change_id: CID }, ctx.dims["style"])
      expect(styleView).toContain("# ⛔ 当前 step 阻塞中，等待编排处理")
      expect(styleView).toContain("本层待裁定豁免申请")
      expect(styleView).toContain("Issue #7")
      expect(styleView).toContain("exempt_adjudications")
      expect(styleView).toContain('action: "dismissed"')
      expect(styleView).toContain("自助恢复")
      // 非报源维度 reviewer 不渲染他人豁免申请（谁提谁裁定）
      const archView = await status.execute({ change_id: CID }, ctx.dims["architecture"])
      expect(archView).toContain("# ⛔ 当前 step 阻塞中，等待编排处理")
      expect(archView).not.toContain("本层待裁定豁免申请")

      // 补交 dismissed + verdict=passed → 豁免解除 → 阻塞解除 → 正常推进 verify_cleanup
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
        ctx.dims["style"]
      )
      const after = readItem(wt, CID)
      expect(after.children.find((c: any) => c.externalId === "7").phase).toBe("cancelled")
      expect(after.currentStep).toBe("verify_cleanup")
      // developer 收尾验证通过 → done
      await agent_submit.execute({ change_id: CID, step_id: "verify_cleanup", verdict: "passed" }, ctx.dev)
      expect(readItem(wt, CID).phase).toBe("done")
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

  test("developer 视图会话摘要按角色隔离：只渲染 dev 自己的摘要，不跨 agent 传递", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      rewriteItem(wt, (item) => {
        item.metadata["agent_summaries"] = {
          "openspec-architect": "预检通过，已输出执行边界",
          "openspec-developer": "完成 task 2 个",
        }
      })
      const view = await status.execute({ change_id: CID }, ctx.dev)
      expect(view).toContain("## 上轮会话摘要")
      expect(view).toContain("**openspec-developer**：完成 task 2 个")
      expect(view).not.toContain("预检通过，已输出执行边界")
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
          new_children: [{ id: "7", title: "Magic number", description: "魔法数字", severity: "Low", dimension: "style", rule: "PMD.AvoidLiteralsInIfCondition" }],
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

describe("D2. failed 维度 issue 全终态且无在途豁免 → 自动翻 passed（verify_quality 聚合通过）", () => {
  test("style 维 failed 名下 blocking issue 已终态、其余 4 维 pending → 全部提交后聚合通过进入 done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 构造死状态：style 维 failed（其报源 blocking issue 已被裁定为 done），其余 4 维 pending
      rewriteItem(wt, (item) => {
        item.tags["verify_quality:openspec-reviewer-style"] = "failed"
        item.children.push({
          id: "issue:7", source: "openspec-reviewer-style", externalId: "7", type: "issue",
          title: "遗留 issue", description: "d", phase: "done", suspended: false,
          currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-style", dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
      })
      // 其余 4 维提交 passed → 聚合判定时 style 翻盘为 passed，全部非 pending → 推进 verify_cleanup
      for (const d of DIMENSION_AGENTS) {
        if (d === "style") continue
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
      }
      const atCleanup = readItem(wt, CID)
      expect(atCleanup.currentStep).toBe("verify_cleanup")
      // developer 收尾验证通过 → done
      await agent_submit.execute({ change_id: CID, step_id: "verify_cleanup", verdict: "passed" }, ctx.dev)
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
    } finally { teardown(root) }
  })

  test("failed 维度 issue 已终态 + retry 达上限 + 存在非本层未终态 issue → D2 翻盘 + A1 短路，不触发检查点", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 5 维全部非 pending（style failed 但其 issue 已终态、其余 passed）+ 一个 tool 报源未终态 issue
      rewriteItem(wt, (item) => {
        item.tags = {
          ...item.tags,
          "verify_quality:openspec-reviewer-style": "failed",
        }
        for (const d of DIMENSION_AGENTS) {
          if (d === "style") continue
          item.tags[`verify_quality:openspec-reviewer-${d}`] = "passed"
        }
        item.children.push({
          id: "issue:7", source: "openspec-reviewer-style", externalId: "7", type: "issue",
          title: "遗留 issue", description: "d", phase: "done", suspended: false,
          currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-style", dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
        // tool 报源未终态 issue：不阻塞 verify_quality 门禁，但会让 hasUnresolvedChildren 成立
        item.children.push({
          id: "issue:8", source: "openspec-reviewer-tool", externalId: "8", type: "issue",
          title: "tool issue", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-tool", dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
        item.metadata["_retryCount"] = 10
      })
      const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
      const step = workflow.stepMap.get("verify_quality")!.step
      const item0 = readItem(wt, CID)
      // D2 翻盘使 step 全部 passed → A1 窄短路：即使 _retryCount=10 且有未终态 issue 也不触发检查点
      expect(checkpointTriggered(item0, workflow, step)).toBe(false)
      const rec = recommendForItem(item0, workflow)
      expect(rec.status).toBe("terminal")
      expect(rec.agents).toEqual([])
    } finally { teardown(root) }
  })
})

describe("D1. 维度名下有在途豁免申请 → 聚合等待期重新唤起报源 reviewer（豁免裁定通道不被守卫误拦）", () => {
  test("style 维 failed + 在途豁免申请 → orchestrator 分派视图含 style；style 补交豁免裁定不被重复提交守卫误拦", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 构造：style 维 failed，其报源 issue 带在途豁免申请（review 态 + exempt_request 标记），其余 4 维 pending
      rewriteItem(wt, (item) => {
        item.tags["verify_quality:openspec-reviewer-style"] = "failed"
        item.children.push({
          id: "issue:7", source: "openspec-reviewer-style", externalId: "7", type: "issue",
          title: "豁免申请 issue", description: "d", phase: "review", suspended: false,
          currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-style", dimension: "style", exempt_request: { requestedBy: "developer" } },
          children: [], labels: [], severity: "Low",
        })
      })
      // D1：聚合等待期（其余 4 维 pending）仍唤起 style 履行裁定权
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("分派子代理：")
      expect(out).toContain("`openspec-reviewer-style`")
      // style 补交豁免裁定（verdict passed + exempt_adjudications）：不被重复提交守卫误拦，
      // dismissed → issue 置 cancelled + style 维度翻 passed
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "passed",
          exempt_adjudications: [{ issue_id: "7", action: "dismissed" }],
        },
        ctx.dims["style"]
      )
      const item = readItem(wt, CID)
      expect(item.children.find((c: any) => c.id === "issue:7").phase).toBe("cancelled")
      expect(item.children.find((c: any) => c.id === "issue:7").metadata["exempt_request"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("D1+D2 混合：豁免维被唤起裁定、failed 全终态维翻盘、pending 维提交后整体聚合推进 done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 构造混合态：
      // - style 维 failed + 报源 issue 在途豁免申请（review 态 + exempt_request）→ 走 D1 唤起裁定
      // - architecture 维 failed + 报源 blocking issue 已终态（done）→ 走 D2 翻盘
      // - performance 维 pending；security/maintainability 已 passed
      rewriteItem(wt, (item) => {
        item.tags = {
          ...item.tags,
          "verify_quality:openspec-reviewer-style": "failed",
          "verify_quality:openspec-reviewer-architecture": "failed",
          "verify_quality:openspec-reviewer-security": "passed",
          "verify_quality:openspec-reviewer-maintainability": "passed",
        }
        item.children.push({
          id: "issue:7", source: "openspec-reviewer-style", externalId: "7", type: "issue",
          title: "豁免 issue", description: "d", phase: "review", suspended: false,
          currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-style", dimension: "style", exempt_request: { requestedBy: "developer" } },
          children: [], labels: [], severity: "Low",
        })
        item.children.push({
          id: "issue:8", source: "openspec-reviewer-architecture", externalId: "8", type: "issue",
          title: "已裁定 issue", description: "d", phase: "done", suspended: false,
          currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-architecture", dimension: "architecture" },
          children: [], labels: [], severity: "Low",
        })
      })
      // 聚合等待期分派：pending(performance) + 在途豁免维(style)；architecture 不派（D2 翻盘无需动作）
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("`openspec-reviewer-performance`")
      expect(out).toContain("`openspec-reviewer-style`")
      // style 裁定豁免（dismissed）→ 置 passed
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "passed",
          exempt_adjudications: [{ issue_id: "7", action: "dismissed" }],
        },
        ctx.dims["style"]
      )
      // performance 提交 → 全部非 pending，聚合判定含 architecture 翻盘 → 整体推进 verify_cleanup
      await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims["performance"])
      const atCleanup = readItem(wt, CID)
      expect(atCleanup.currentStep).toBe("verify_cleanup")
      expect(atCleanup.children.find((c: any) => c.id === "issue:7").phase).toBe("cancelled")
      expect(atCleanup.children.find((c: any) => c.id === "issue:8").phase).toBe("done")
      // developer 收尾验证通过 → done
      await agent_submit.execute({ change_id: CID, step_id: "verify_cleanup", verdict: "passed" }, ctx.dev)
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
    } finally { teardown(root) }
  })
})

describe("B1/B3. giveup 自动推进与 blockers 处理", () => {
  test("末位 step（verify_cleanup）giveup → 自动推进 done 可收尾 + blockers 置 resolved", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 5 维全 passed → 推进到末位 step verify_cleanup
      await submitQualityPassed(ctx, CID)
      expect(readItem(wt, CID).currentStep).toBe("verify_cleanup")
      rewriteItem(wt, (item) => {
        item.metadata["_checkpoint"] = true
        item.metadata["_retryCount"] = 10
        item.metadata["blockers"] = [{ id: "b1", status: "awaiting_user", description: "外部依赖未就绪" }]
      })
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "passed", checkpoint_decision: "giveup" },
        ctx.orch
      )
      expect(r).toContain("giveup")
      const item = readItem(wt, CID)
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
      expect(item.metadata["_giveup"]).toBe(true)
      // B3：giveup 把未 resolved blockers 置 resolved（随放弃处理），与收尾门禁对齐
      expect(metaOf(item, "blockers")[0].status).toBe("resolved")
      // 末位 giveup 后 phase=done → 可直接收尾（此前 giveup 后停留原地无法收尾的死锁）
      const cr = await complete_task_group.execute({ change_id: CID }, ctx.orch)
      expect(cr).toContain("任务组已完成并合并到")
      expect(readItem(wt, CID).metadata["completed_at"]).toBeDefined()
    } finally { teardown(root) }
  })

  test("非末位 step（verify_tool）giveup → 自动推进到下一 step（verify_task），留痕 _giveup", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      rewriteItem(wt, (item) => {
        item.metadata["_checkpoint"] = true
      })
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "giveup" },
        ctx.orch
      )
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_task")
      expect(item.metadata["_giveup"]).toBe(true)
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
    } finally { teardown(root) }
  })

  test("giveup 纯重算路径：无 _checkpoint 标记，走 checkpointTriggered 重算判定 → 自动推进到下一 step", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      // 产线从不置 _checkpoint 标记：走 checkpointTriggered 重算路径（_retryCount=10 达上限 + 未终态 children）
      rewriteItem(wt, (item) => {
        item.metadata["_retryCount"] = 10
        delete item.metadata["_checkpoint"]
        item.tags["verify_tool:openspec-reviewer-tool"] = "failed"
      })
      const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
      const step = workflow.stepMap.get("verify_tool")!.step
      const item0 = readItem(wt, CID)
      expect(item0.metadata["_checkpoint"]).toBeUndefined()
      expect(checkpointTriggered(item0, workflow, step)).toBe(true)
      expect(recommendForItem(item0, workflow).status).toBe("checkpoint")
      // 不带 _checkpoint 标记：atCheckpoint 由 checkpointTriggered 重算成立，giveup 可执行
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "giveup" },
        ctx.toolR
      )
      expect(r).toContain("giveup")
      const item = readItem(wt, CID)
      expect(metaOf(item, "_retryCount")).toBe(0)
      expect(item.metadata["_giveup"]).toBe(true)
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.currentStep).toBe("verify_task")
    } finally { teardown(root) }
  })
})
