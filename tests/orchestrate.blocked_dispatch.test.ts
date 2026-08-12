/**
 * blocked 分派链路集成测试（死锁修复验证）。
 *
 * 背景：reviewer 提交 passed 漏带 recheck/豁免裁定，遗留本层 review 态 blocking children → 当前 step
 * 全 passed 但 stepCanPass 不通过 → 引擎 blocked。修复前 blocked 恒 agents=[]，orchestrator 调 opx_status
 * 收不到"下一步分派谁"，形成静默死锁。
 *
 * 本文件按真实链路断言新行为：
 * - recheck 链路：submit 漏带 recheck → orchestrator 查 status 得到"分派子代理：<报源 reviewer>"
 *   → recheck-only 补交解除阻塞
 * - exempt 链路：verify_quality 全 passed 但本层豁免申请未裁定 → 分派报源 reviewer → exempt-only 补交解除
 * - recovery 兜底：reset_steps 重置指定 verify step tags → currentStep 落回第一个未通过 verify step → opx_status 分派对应 reviewer
 * - 报源缺失/非法：不派发 reviewer（谁提谁裁定硬性要求报源合法，派发出去提交即被拒），输出阻塞 children 诊断清单引导 recovery
 * - implement blocked：review 态 child 不阻塞（stepCanPass carve-out 镜像），todo 态 child 阻塞且不派发 developer
 * - reset_steps 值域校验：非法 phase 组合 / 与 review_layer 互斥 / 空数组 / 非法 step
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, status, agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, setupWithFakeGit, teardown, makeCtx } from "./helpers"
import {
  setupToAnalyze, driveToQuality, submitQualityPassed,
  taskIdsOf, readItem, DEFAULT_EXECUTION_BOUNDARY,
} from "./helpers-workflow"

const CID = "test-blocked-dispatch"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/bd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string): string {
  return join(wt, "openspec", "states", `${CID}.json`)
}

/** 直接改写活跃 task WorkItem（手工构造前置状态用）。 */
function rewriteItem(wt: string, mutate: (item: any) => void): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 捕获 agent_submit/init 抛错并断言错误文案。 */
async function expectError(p: Promise<unknown>, pattern: RegExp): Promise<Error> {
  const err = await p.catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toMatch(pattern)
  return err
}

// ════════════════════════════════════════════════════════════════
//  recheck 链路：reviewer 漏带 recheck → orchestrator 收到分派指令 → 补交解除
// ════════════════════════════════════════════════════════════════

describe("recheck 漏带链路：blocked 分派报源 reviewer 并补交解除", () => {
  test("verify_task 漏带 recheck → status 分派 openspec-reviewer-task → recheck-only 补交解除", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
        ctx.arch
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)

      // task 层报 Low issue → failed → 聚合回退 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          new_children: [{ id: "7", title: "任务层问题", description: "d", severity: "Low", dimension: "style" }],
        },
        ctx.taskR
      )
      expect(readItem(wt, CID).currentStep).toBe("implement")

      // dev 修复 issue 7 → child review，按归因重置 verify_* tags 并推进到 verify_tool
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(readItem(wt, CID)), fixed_issue_ids: ["7"] },
        ctx.dev
      )
      expect(readItem(wt, CID).children.find((c: any) => c.externalId === "7").phase).toBe("review")
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")

      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      expect(readItem(wt, CID).currentStep).toBe("verify_task")

      // task reviewer 通过但漏带 recheck（issue 7 仍 review）→ blocked 态
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: taskIdsOf(readItem(wt, CID)) },
        ctx.taskR
      )
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_task")
      expect(item.children.find((c: any) => c.externalId === "7").phase).toBe("review")

      // orchestrator 查 status → 「## 下一步」给出分派指令，指向报源 reviewer
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("## 下一步")
      expect(out).toContain("需报源 reviewer 补交复核/裁定")
      expect(out).toContain("分派子代理：`openspec-reviewer-task`")

      // recheck-only 补交 → issue done → 推进 verify_quality
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", recheck_adjudications: [{ issue_id: "7", verdict: "passed" }] },
        ctx.taskR
      )
      const after = readItem(wt, CID)
      expect(after.children.find((c: any) => c.externalId === "7").phase).toBe("done")
      expect(after.currentStep).toBe("verify_quality")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  exempt 链路：verify_quality 全 passed 但本层豁免申请未裁定 → 分派报源 reviewer → exempt-only 补交解除
// ════════════════════════════════════════════════════════════════

describe("exempt 漏带链路：blocked 分派报源 reviewer 并 exempt-only 补交解除", () => {
  test("verify_quality 全 passed + 本层豁免申请未裁定 → status 分派 style reviewer → exempt-only 补交解除", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 注入豁免申请 child（报源 style reviewer，phase todo + exempt_request）
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
      // 5 维全 passed → stepCanPass 不通过（exempt child 未终态）→ blocked 态
      await submitQualityPassed(ctx, CID)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_quality")

      // orchestrator 查 status → 分派报源 reviewer 补交豁免裁定
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("## 下一步")
      expect(out).toContain("豁免申请中 1")
      expect(out).toContain("分派子代理：`openspec-reviewer-style`")

      // exempt-only 补交（重复提交守卫放行）→ child cancelled → 推进 done
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
        ctx.dims["style"]
      )
      const after = readItem(wt, CID)
      expect(after.children.find((c: any) => c.externalId === "7").phase).toBe("cancelled")
      expect(after.phase).toBe("done")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  recovery 兜底：reset_steps 重置指定 verify step tags → currentStep 落回该 step → 分派对应 reviewer
// ════════════════════════════════════════════════════════════════

describe("recovery reset_steps 重置 review tag", () => {
  test("reset_steps=[verify_quality] → verify_quality tags 重置为 pending，currentStep 落回 verify_quality，分派 5 维 reviewer", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 模拟 verify_quality 已全 passed 但被遗漏复核/裁定阻塞的死锁态（tag 直接注入，未推进）
      rewriteItem(wt, (item) => {
        item.tags["verify_quality:openspec-reviewer-style"] = "passed"
        item.tags["verify_quality:openspec-reviewer-architecture"] = "passed"
        item.tags["verify_quality:openspec-reviewer-performance"] = "passed"
        item.tags["verify_quality:openspec-reviewer-security"] = "passed"
        item.tags["verify_quality:openspec-reviewer-maintainability"] = "passed"
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["verify_quality"] } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_quality")
      // verify_quality tags 已清（pending），tool/task 已 passed 保留
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBeUndefined()
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      // opx_status 分派对应 reviewer
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("分派子代理：`openspec-reviewer-style`")
      expect(out).toContain("`openspec-reviewer-security`")
    } finally { teardown(root) }
  })

  test("reset_steps=[verify_task] → verify_task 重置，currentStep 落回 verify_task，verify_quality 已 passed 保留，分派 task reviewer", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      rewriteItem(wt, (item) => {
        item.tags["verify_quality:openspec-reviewer-style"] = "passed"
        item.tags["verify_quality:openspec-reviewer-architecture"] = "passed"
        item.tags["verify_quality:openspec-reviewer-performance"] = "passed"
        item.tags["verify_quality:openspec-reviewer-security"] = "passed"
        item.tags["verify_quality:openspec-reviewer-maintainability"] = "passed"
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["verify_task"] } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_task")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("分派子代理：`openspec-reviewer-task`")
    } finally { teardown(root) }
  })

  test("reset_steps 值域校验：非 review phase / 与 review_layer 互斥 / 空数组 / 非法 step → 抛错零变更", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl", reset_steps: ["verify_tool"] } } as any, ctx.orch),
        /reset_steps 参数仅当 recovery.phase 为 review/
      )
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "task", reset_steps: ["verify_tool"] } } as any, ctx.orch),
        /reset_steps 与 review_layer 互斥/
      )
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: [] } } as any, ctx.orch),
        /reset_steps 不能为空数组/
      )
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["implement"] } } as any, ctx.orch),
        /reset_steps 中的 step "implement" 不合法/
      )
      // 抛错零变更：仍停留在 analyze
      expect(readItem(wt, CID).currentStep).toBe("analyze")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  blocked 且报源缺失（多 agent step）：不派发 reviewer，输出诊断
// ════════════════════════════════════════════════════════════════

describe("verify_quality blocked 报源缺失：不派发，输出诊断", () => {
  test("多 agent step 阻塞 child 报源缺失（仅显式 dimension 可推导）→ 不派发 reviewer，输出阻塞 children 诊断清单", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 报源缺失（无 source），仅有显式 dimension=architecture + source_phase=quality + review 态
      rewriteItem(wt, (item) => {
        item.tags["verify_quality:openspec-reviewer-style"] = "passed"
        item.tags["verify_quality:openspec-reviewer-architecture"] = "passed"
        item.tags["verify_quality:openspec-reviewer-performance"] = "passed"
        item.tags["verify_quality:openspec-reviewer-security"] = "passed"
        item.tags["verify_quality:openspec-reviewer-maintainability"] = "passed"
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "遗留 issue", description: "d", phase: "review", suspended: false,
          currentStep: null, tags: {}, metadata: { source_phase: "quality", dimension: "architecture" },
          children: [], labels: [], severity: "Low",
        })
      })
      const out = await status.execute({ change_id: CID }, ctx.orch)
      // 报源缺失 → 不再按 dimension 映射推导 reviewer（派发出去提交即被谁提谁裁定拦截，形成不闭合循环）
      expect(out).not.toContain("分派子代理：")
      // 落入诊断清单：列出阻塞 child、提示报源缺失与 recovery 恢复路径
      expect(out).toContain("当前 step 已全 passed 但存在阻塞 children，且无可补交裁定的 reviewer")
      expect(out).toContain("Issue #7")
      expect(out).toContain("报源:(报源缺失)")
      expect(out).not.toContain("（无待分派项，请检查状态）")
      expect(out).not.toContain("⚠️ 状态不一致")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  implement blocked：review 态 child 不阻塞（carve-out 镜像），todo 态 child 阻塞且不派发 developer
// ════════════════════════════════════════════════════════════════

describe("implement blocked：review 态 child 不阻塞，待修复 child 阻塞且不派发 developer", () => {
  test("implement step 全 passed + todo 态阻塞 child + review 态 child → agents 空、诊断提示待修复，不派发 developer", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 构造 implement 全 passed 但存在待修复阻塞 child 的死锁态（review 态 child 按 carve-out 不阻塞）
      rewriteItem(wt, (item) => {
        item.phase = "in_progress"
        item.currentStep = "implement"
        item.tags["implement:openspec-developer"] = "passed"
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "待修复 issue", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
        item.children.push({
          id: "issue:8", source: "openspec", externalId: "8", type: "issue",
          title: "待复核 issue", description: "d", phase: "review", suspended: false,
          currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
      })
      const out = await status.execute({ change_id: CID }, ctx.orch)
      // 非 review step：不派发 developer（blockingStepChildren 已排除 review 态 child，补交裁定无意义）
      expect(out).not.toContain("分派子代理：`openspec-developer`")
      // 诊断口径：待修复 blocking child 列出并提示 developer 修复；review 态 child 不计入阻塞清单
      expect(out).toContain("需 developer 修复后重新提交审查")
      expect(out).toContain("当前 step 已全 passed 但存在阻塞 children，且无可补交裁定的 reviewer")
      expect(out).toContain("Issue #7")
      expect(out).toContain("待处理(todo)")
      expect(out).not.toContain("Issue #8")
      expect(out).not.toContain("（无待分派项，请检查状态）")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  exempt 提交→推进链路：dev 申请豁免 → child 进 review（待裁定）→ implement 放行推进 verify_tool
//  → 漏带裁定 blocked → 分派报源 reviewer → exempt 补交解除；rejected 收敛回退 implement
// ════════════════════════════════════════════════════════════════

describe("exempt 提交→推进→裁定链路（exempt 子项进入 review 待裁定态）", () => {
  test("dev 提交 exempt_issue_ids → child 进 review 待裁定 + implement 放行推进 verify_tool → 漏带裁定 blocked 分派报源 reviewer → 补交 dismissed 解除", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: DEFAULT_EXECUTION_BOUNDARY },
        ctx.arch
      )
      // 注入 tool 层报源阻塞 issue（todo 态，待 dev 申请豁免）
      rewriteItem(wt, (item) => {
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "不可修 issue", description: "第三方限制", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
      })

      // dev 提交豁免申请：exempt 子项进入 review（待裁定），implement 门禁放行并推进
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["7"], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      const item1 = readItem(wt, CID)
      expect(item1.children.find((c: any) => c.externalId === "7").phase).toBe("review")
      expect(item1.children.find((c: any) => c.externalId === "7").metadata["exempt_request"]).toBeDefined()
      expect(item1.phase).toBe("review")
      expect(item1.currentStep).toBe("verify_tool")

      // tool reviewer 提交 passed 漏带豁免裁定 → verify_tool 被本层待裁定项阻塞（不推进）
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")

      // orchestrator 查 status → 分派报源 reviewer 补交豁免裁定
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("## 下一步")
      expect(out).toContain("豁免申请中 1")
      expect(out).toContain("分派子代理：`openspec-reviewer-tool`")

      // exempt-only 补交 dismissed → child cancelled → 推进 verify_task
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
        ctx.toolR
      )
      const after = readItem(wt, CID)
      expect(after.children.find((c: any) => c.externalId === "7").phase).toBe("cancelled")
      expect(after.currentStep).toBe("verify_task")
    } finally { teardown(root) }
  })

  test("exempt 裁定 rejected：reviewer 提交 verify_tool failed + rejected 裁定 → issue 回 todo，item 回退 implement 收敛", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: DEFAULT_EXECUTION_BOUNDARY },
        ctx.arch
      )
      rewriteItem(wt, (item) => {
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "可修但被申请豁免", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
      })
      // dev 提交豁免申请 → 推进 review/verify_tool
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["7"], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
      expect(readItem(wt, CID).children.find((c: any) => c.externalId === "7").phase).toBe("review")

      // tool reviewer 裁定 rejected + 提交 failed（遗留 todo 态阻塞 issue 构成理由）→ 回退 implement
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "failed", exempt_adjudications: [{ issue_id: "7", action: "rejected" }] },
        ctx.toolR
      )
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(item.children.find((c: any) => c.externalId === "7").phase).toBe("todo")
      expect(item.children.find((c: any) => c.externalId === "7").metadata["exempt_request"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("mixed：同层 fixed 待复核 + exempt 待裁定，补交不全仍持续分派报源 reviewer 直至解除（不二次死锁）", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: DEFAULT_EXECUTION_BOUNDARY },
        ctx.arch
      )
      // 注入 tool 层两个阻塞 issue：fixed 用（7）、exempt 用（8）
      rewriteItem(wt, (item) => {
        item.children.push(
          { id: "issue:7", source: "openspec", externalId: "7", type: "issue", title: "可修 issue", description: "d", phase: "todo", suspended: false, currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" }, children: [], labels: [], severity: "Low" },
          { id: "issue:8", source: "openspec", externalId: "8", type: "issue", title: "不可修 issue", description: "d", phase: "todo", suspended: false, currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" }, children: [], labels: [], severity: "Low" },
        )
      })
      // dev 同时提交 fixed_issue_ids + exempt_issue_ids → 均进入 review，implement 放行推进
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["7"], exempt_issue_ids: ["8"], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      const item1 = readItem(wt, CID)
      expect(item1.currentStep).toBe("verify_tool")
      expect(item1.children.find((c: any) => c.externalId === "7").phase).toBe("review")
      expect(item1.children.find((c: any) => c.externalId === "8").phase).toBe("review")
      expect(item1.children.find((c: any) => c.externalId === "8").metadata["exempt_request"]).toBeDefined()

      // tool reviewer passed 漏带 recheck + exempt 裁定 → blocked，分派报源 reviewer
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("分派子代理：`openspec-reviewer-tool`")

      // 只补交 exempt（dismissed）→ 8 解除但 7 仍待复核 → 继续 blocked 并继续分派 reviewer（不二次死锁）
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", exempt_adjudications: [{ issue_id: "8", action: "dismissed" }] },
        ctx.toolR
      )
      const item2 = readItem(wt, CID)
      expect(item2.currentStep).toBe("verify_tool")
      expect(item2.children.find((c: any) => c.externalId === "8").phase).toBe("cancelled")
      expect(item2.children.find((c: any) => c.externalId === "7").phase).toBe("review")
      const out2 = await status.execute({ change_id: CID }, ctx.orch)
      expect(out2).toContain("分派子代理：`openspec-reviewer-tool`")

      // 补交 recheck passed → 7 done → 解除阻塞推进 verify_task
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", recheck_adjudications: [{ issue_id: "7", verdict: "passed" }] },
        ctx.toolR
      )
      const after = readItem(wt, CID)
      expect(after.children.find((c: any) => c.externalId === "7").phase).toBe("done")
      expect(after.currentStep).toBe("verify_task")
    } finally { teardown(root) }
  })
})
