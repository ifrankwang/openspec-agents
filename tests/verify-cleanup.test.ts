/**
 * verify_cleanup 收尾检查点场景测试（A1/A2 实施验证）。
 *
 * 覆盖：
 * 1. 全流程：verify_quality 全 passed 后 currentStep/分派推荐落 verify_cleanup；
 *    verify_cleanup passed 后落 done；verify_cleanup failed 自指重试（不回 implement）；
 *    failed 后自报 issue 在本 step 内修复 + 自复核收敛后 done
 * 2. assertFailedHasReason 特判（收尾层）：failed 无理由被拒；带 Low+ 新报可通过；
 *    他层遗留未终态阻塞 child 亦构成不通过理由（不按维度/报源层过滤）
 * 3. 视图：verify_cleanup 的 review_cleanup 上下文渲染——待修复 todo 态 issue、
 *    自报 review 态 issue 复核清单（developer 自报自裁）、自报豁免待裁定区块
 * 4. 恢复场景：recovery=review 时 verify_cleanup 未 passed → currentStep 前移；
 *    已 passed → 保留（收口 done）
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { setupWithFakeGit, teardown, makeCtx } from "./helpers"
import { init, agent_submit, status } from "../src/adapters/opencode/tools"
import {
  setupToAnalyze, driveToQuality, submitQualityPassed, submitCleanupPassed,
  readItem, renderWorkingView, taskItemOf,
} from "./helpers-workflow"

const CID = "verify-cleanup"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string } {
  const root = `/tmp/vcleanup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree } = setupWithFakeGit(root, CID)
  return { wt: worktree, root }
}

/** 直接改写活跃 task WorkItem（手工构造前置状态用）。 */
function rewriteItem(wt: string, mutate: (item: any) => void): void {
  const p = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 构造 developer 报源的 Low issue child（verify_cleanup 自报 issue 形态）。 */
function devIssueChild(overrides: Record<string, unknown> = {}): any {
  return {
    id: `issue:${overrides.id ?? "7"}`,
    source: "openspec",
    externalId: String(overrides.id ?? "7"),
    type: "issue",
    title: String(overrides.title ?? "收尾 issue"),
    description: String(overrides.description ?? "合并冲突残留"),
    phase: "todo",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: { source: "openspec-developer", dimension: "style", ...((overrides.metadata as object) ?? {}) },
    children: [],
    labels: [],
    severity: "Low",
  }
}

describe("verify_cleanup 全流程", () => {
  test("verify_quality 全 passed → 推进 verify_cleanup；developer 收尾验证 passed → done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx, item } = await driveToQuality(wt, CID)
      expect(item.currentStep).toBe("verify_quality")

      await submitQualityPassed(ctx, CID)
      const atCleanup = readItem(wt, CID)
      expect(atCleanup.phase).toBe("review")
      expect(atCleanup.currentStep).toBe("verify_cleanup")

      // 分派推荐：verify_cleanup 属 developer
      const orchView = await status.execute({ change_id: CID }, ctx.orch)
      expect(orchView).toContain("分派子代理：`openspec-developer`")
      // developer 执行视图：step 落 verify_cleanup
      const devView = await status.execute({ change_id: CID }, ctx.dev)
      expect(devView).toContain("# ✅ 当前轮到你执行")
      expect(devView).toContain("**阶段**: review | **step**: `verify_cleanup`")

      await submitCleanupPassed(ctx, CID)
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
    } finally { teardown(root) }
  })

  test("verify_cleanup failed（带 Low+ 新报）→ 自指重试不回 implement；修复 + 自复核收敛后 done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await submitQualityPassed(ctx, CID)
      expect(readItem(wt, CID).currentStep).toBe("verify_cleanup")

      // developer 报收尾 issue 并 failed → on_fail 自指 verify_cleanup（不回 implement）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_cleanup", verdict: "failed",
          new_children: [{ id: "7", title: "回归失败残留", description: "基准合并后接口测试失败", severity: "Low", dimension: "style" }],
        },
        ctx.dev
      )
      let item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_cleanup")
      expect(item.children.find((c: any) => c.externalId === "7").phase).toBe("todo")

      // 修复自报 issue → fixed 进入 review 待复核（自报自裁）
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "passed", fixed_issue_ids: ["7"] },
        ctx.dev
      )
      item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_cleanup")
      expect(item.children.find((c: any) => c.externalId === "7").phase).toBe("review")

      // 自行复核通过（recheck 补交为仅裁定参数，重复提交守卫放行）→ 终态收敛 → done
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "passed", recheck_adjudications: [{ issue_id: "7", verdict: "passed" }] },
        ctx.dev
      )
      item = readItem(wt, CID)
      expect(item.children.find((c: any) => c.externalId === "7").phase).toBe("done")
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
    } finally { teardown(root) }
  })

  test("verify_cleanup 自报 issue 走豁免路径：申请豁免 → 自行裁定 dismissed → cancelled → done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await submitQualityPassed(ctx, CID)

      // dev 报 issue + failed
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_cleanup", verdict: "failed",
          new_children: [{ id: "7", title: "无法消除的残留", description: "第三方限制", severity: "Low", dimension: "security" }],
        },
        ctx.dev
      )
      // 申请豁免 → review + exempt_request 标记（自报自裁）
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "passed", exempt_issue_ids: ["7"] },
        ctx.dev
      )
      let item = readItem(wt, CID)
      expect(item.children.find((c: any) => c.externalId === "7").phase).toBe("review")
      expect(item.children.find((c: any) => c.externalId === "7").metadata["exempt_request"]).toBeDefined()

      // 自行裁定 dismissed → cancelled → 全部阻塞终态 → done
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
        ctx.dev
      )
      item = readItem(wt, CID)
      expect(item.children.find((c: any) => c.externalId === "7").phase).toBe("cancelled")
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
    } finally { teardown(root) }
  })
})

describe("assertFailedHasReason 收尾层特判", () => {
  test("verify_cleanup failed 不带任何 Low+ 理由 → 拒绝且零状态变更", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await submitQualityPassed(ctx, CID)
      const before = JSON.stringify(readItem(wt, CID).tags)

      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "failed" },
        ctx.dev
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/收尾层 审核声称 passed=false/)
      // 零状态变更：tag 未写入、currentStep 未变
      expect(JSON.stringify(readItem(wt, CID).tags)).toBe(before)
      expect(readItem(wt, CID).currentStep).toBe("verify_cleanup")
    } finally { teardown(root) }
  })

  test("verify_cleanup failed 带 Low+ 新报 → 合法（构成收尾层不通过理由）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await submitQualityPassed(ctx, CID)
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_cleanup", verdict: "failed",
          new_children: [{ id: "7", title: "回归失败", description: "合并后构建失败", severity: "Low", dimension: "style" }],
        },
        ctx.dev
      )
      expect(r).toContain("提交成功")
      expect(readItem(wt, CID).currentStep).toBe("verify_cleanup")
      expect(readItem(wt, CID).children.find((c: any) => c.externalId === "7").phase).toBe("todo")
    } finally { teardown(root) }
  })

  test("他层遗留未终态阻塞 child 亦构成理由（不按维度/报源层过滤）→ failed 合法", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await submitQualityPassed(ctx, CID)
      // 注入 tool 报源遗留 todo 阻塞 child（非 developer 自报，不按报源层过滤仍构成理由）
      rewriteItem(wt, (item) => {
        item.children.push(devIssueChild({ id: "8", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" } }))
      })
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "failed" },
        ctx.dev
      )
      expect(r).toContain("提交成功")
      expect(readItem(wt, CID).currentStep).toBe("verify_cleanup")
    } finally { teardown(root) }
  })
})

describe("verify_cleanup 视图（review_cleanup 上下文渲染）", () => {
  test("待修复 todo 态 + 自报 review 态复核清单 + 自报豁免待裁定区块均渲染", () => {
    const item = taskItemOf({
      workItems: [{
        id: "task:1", source: "openspec", type: "task", title: "T", description: "d",
        phase: "review", suspended: false, currentStep: "verify_cleanup",
        tags: {}, metadata: {}, labels: [],
        children: [
          devIssueChild({ id: "1", title: "待修复 issue", description: "待修复的合并残留" }),
          devIssueChild({ id: "2", title: "自报待复核 issue", description: "自报已修复待自行复核" }),
          devIssueChild({
            id: "3", title: "自报豁免 issue", description: "自报豁免申请待自行裁定",
            metadata: { exempt_request: { requestedBy: "openspec-developer" } },
          }),
        ],
      }],
    })
    // 注入 review 态（自报待复核 / 自报豁免申请）
    item.children.find((c: any) => c.externalId === "2")!.phase = "review"
    item.children.find((c: any) => c.externalId === "3")!.phase = "review"

    const view = renderWorkingView(item, "verify_cleanup", "openspec-developer")
    expect(view).toContain("Issue (待修复 · Low 及以上，必办)")
    expect(view).toContain("待修复的合并残留")
    expect(view).toContain("Issue (自报待复核 · 本 step 自行复核裁定)")
    expect(view).toContain("自报已修复待自行复核")
    expect(view).toContain("Issue (自报豁免申请 · 待自行裁定)")
    expect(view).toContain("自报豁免申请待自行裁定")
    // 操作指引含收尾职责与自报收敛语义（{{base_branch}} 占位符已插值为 state.baseBranch=main）
    expect(view).toContain("git merge 基准分支")
    expect(view).toContain("将基准分支（main）最新代码合并进当前工作分支")
    expect(view).toContain("自报 issue 必须在本 step 内收敛至终态")
  })

  test("空清单不渲染区块（无待修复/待复核/待裁定项）", () => {
    const item = taskItemOf({
      workItems: [{
        id: "task:1", source: "openspec", type: "task", title: "T", description: "d",
        phase: "review", suspended: false, currentStep: "verify_cleanup",
        tags: {}, metadata: {}, children: [], labels: [],
      }],
    })
    const view = renderWorkingView(item, "verify_cleanup", "openspec-developer")
    expect(view).not.toContain("Issue (待修复 · Low 及以上，必办)")
    expect(view).not.toContain("Issue (自报待复核")
    expect(view).not.toContain("Issue (自报豁免申请")
  })
})

describe("recovery=review 与 verify_cleanup", () => {
  test("verify_cleanup 未 passed → recovery=review 时 currentStep 前移到 verify_cleanup", async () => {
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
        }
        for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
          item.tags[`verify_quality:openspec-reviewer-${d}`] = "passed"
        }
        // 前置层已验证：task children 达终态（与正常流转到收尾前的状态一致）
        for (const c of item.children) {
          if (c.type === "task") c.phase = "done"
        }
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_cleanup")
      // developer 重新收尾验证通过 → done
      await agent_submit.execute({ change_id: CID, step_id: "verify_cleanup", verdict: "passed" }, ctx.dev)
      expect(readItem(wt, CID).phase).toBe("done")
    } finally { teardown(root) }
  })

  test("verify_cleanup 已 passed → recovery=review 保留，task children 终态时收口 done", async () => {
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
        for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
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
})
