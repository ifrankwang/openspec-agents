/**
 * 独立审查会话（kind=review）测试：
 * - 入口：pr 初始化（id 推导 / origin/* 拒绝 / base 推导 / 幂等与参数变更拒绝 / 互斥校验）
 * - 流转矩阵：{pr,full} × {none,fix} × {simple,thorough} 核心路径（通过收口 / 失败 fix 进 implement 修复重审 /
 *   fix=none 失败直达 done 不死循环）
 * - 回归验证：修复引入新失败被 verify_task 驳回、存量失败按 issue 上报
 * - 收尾：fix=none 门禁放宽 + 销毁不合并；fix+pr 合回 head_ref；fix+full 合回当前分支；review-and-fix 门禁保留
 * - 恢复：review 会话恢复到 review 各层、reset_steps 值域按形态、task_analysis 拒绝
 * - 视图：全量锚点渲染、fix=none 报告视图、review_merged 无 dev 申报区块
 */
import { describe, expect, test, afterAll } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, set_worktree, status, complete_task_group, agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWithFakeGit, teardown, readState } from "./helpers"
import type { ToolContext } from "../src/core/tools/types"

afterAll(() => { __setGitRunner(null) })

const PR_SESSION = "review-pr-main-feature-x"

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/review-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, "unused")
  fakeGit.localBranches = new Set(["main", "master", "feature-x"])
  fakeGit.currentBranch = "main"
  return { wt: worktree, root, fakeGit }
}

function itemOf(wt: string, sessionId: string): any {
  const s = readState(wt, sessionId)!
  return s.workItems.find((w: any) => w.id === "task:review")
}

describe("独立审查入口（pr 初始化 / 校验 / 幂等）", () => {
  test("pr init：id 推导（base 缺省推导 main）、初始落点 verify_tool、无 mode 字段", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      const out = await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "none" } }, o)
      expect(out).toContain("`review-pr-main-feature-x`")
      const s = readState(wt, PR_SESSION)!
      expect(s.kind).toBe("review")
      expect(s.mode).toBeUndefined()
      expect(s.reviewScope).toEqual({ scopeType: "pr", baseRef: "main", headRef: "feature-x", granularity: "thorough", fix: "none" })
      expect(s.taskGroupId).toBe("review")
      expect(s.baseBranch).toBe("feature-x")
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_tool")
      expect(item.metadata["review_fix_policy"]).toBe("none")
    } finally { teardown(root) }
  })

  test("simple 颗粒度初始落点 quality_review；full 形态 id 含当前分支与日期", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.currentBranch = "develop"
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "fix" } }, o)
      expect(itemOf(wt, PR_SESSION).currentStep).toBe("quality_review")
      const fullOut = await init.execute({ review_scope: { scope_type: "full", granularity: "thorough", fix: "none" } }, o)
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      const fullId = `review-full-develop-${day}`
      expect(fullOut).toContain(fullId)
      expect(itemOf(wt, fullId).currentStep).toBe("verify_tool")
      const s = readState(wt, fullId)!
      expect(s.baseBranch).toBe("develop")
    } finally { teardown(root) }
  })

  test("origin/* 与不存在的本地分支拒绝", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      const err1 = await init.execute({ review_scope: { scope_type: "pr", head_ref: "origin/feature-x", granularity: "simple", fix: "none" } }, o).catch((e: Error) => e)
      expect(err1).toBeInstanceOf(Error)
      expect(err1.message).toMatch(/远端引用/)
      const err2 = await init.execute({ review_scope: { scope_type: "pr", head_ref: "no-such-branch", granularity: "simple", fix: "none" } }, o).catch((e: Error) => e)
      expect(err2.message).toMatch(/不是本地分支/)
      expect(err2.message).toContain("feature-x")
    } finally { teardown(root) }
  })

  test("base 缺省推导：main 不存在时取 master；均不存在报错列出本地分支", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.localBranches = new Set(["master", "feature-x"])
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "none" } }, o)
      expect(readState(wt, "review-pr-master-feature-x")!.reviewScope.baseRef).toBe("master")
      fakeGit.localBranches = new Set(["feature-x"])
      const err = await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "none" } }, o).catch((e: Error) => e)
      expect(err.message).toMatch(/无法自动推导/)
    } finally { teardown(root) }
  })

  test("幂等：同参数复用；不同参数拒绝；同传/都不传报错", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      const scope = { scope_type: "pr" as const, head_ref: "feature-x", granularity: "thorough" as const, fix: "none" as const }
      await init.execute({ review_scope: scope }, o)
      const again = await init.execute({ review_scope: scope }, o)
      expect(again).toContain("复用既有会话")
      const errDiff = await init.execute({ review_scope: { ...scope, fix: "fix" } }, o).catch((e: Error) => e)
      expect(errDiff.message).toMatch(/审查范围不同/)
      const errBoth = await init.execute({ review_scope: scope, change_id: "x", task_group_id: "1" } as any, o).catch((e: Error) => e)
      expect(errBoth.message).toMatch(/互斥/)
      const errNone = await init.execute({} as any, o).catch((e: Error) => e)
      expect(errNone.message).toMatch(/两种入口/)
    } finally { teardown(root) }
  })

  test("worktree：分支 review/<sessionId>、pr 审查锚点为 merge-base、merge_target 独立存", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "fix" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      const item = itemOf(wt, PR_SESSION)
      expect(item.metadata["branch_name"]).toBe(`review/${PR_SESSION}`)
      expect(item.metadata["merge_target"]).toBe("feature-x")
      // fake 的 merge-base 恒返回 baseRef 哨兵
      expect(item.metadata["base_ref"]).toBe(fakeGit.baseRef)
    } finally { teardown(root) }
  })
})

// ─── 驱动助手 ───

async function submit(wt: string, sessionId: string, agent: string, params: Record<string, unknown>): Promise<string> {
  return agent_submit.execute(
    { change_id: sessionId, step_id: params.step_id, verdict: params.verdict, ...params } as any,
    makeCtx(agent, wt),
  )
}

/** 走完 thorough 三层（全 passed）到达 done。 */
async function passThorough(wt: string, sessionId: string): Promise<void> {
  await submit(wt, sessionId, "openspec-reviewer-tool", { step_id: "verify_tool", verdict: "passed", validation_steps: [{ step: "build", completed: true }] })
  await submit(wt, sessionId, "openspec-reviewer-task", { step_id: "verify_task", verdict: "passed", validation_steps: [{ step: "regression", completed: true }] })
  for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
    await submit(wt, sessionId, `openspec-reviewer-${d}`, { step_id: "verify_quality", verdict: "passed" })
  }
}

describe("流转矩阵：审查通过收口", () => {
  test("pr + thorough + fix：三层全过 → done → 收尾合回 head_ref", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "fix" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await passThorough(wt, PR_SESSION)
      expect(itemOf(wt, PR_SESSION).phase).toBe("done")
      const out = await complete_task_group.execute({ change_id: PR_SESSION }, o)
      expect(out).toContain("审查结果摘要")
      // 合回目标为 head_ref（feature-x），非 main
      expect(fakeGit.refUpdates.some((u) => u.ref === "refs/heads/feature-x")).toBe(true)
      expect(fakeGit.refUpdates.some((u) => u.ref === "refs/heads/main")).toBe(false)
    } finally { teardown(root) }
  })

  test("full + simple + fix：单层过 → done → 收尾合回当前分支（develop）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.currentBranch = "develop"
      const o = makeOrchCtx(wt)
      const out = await init.execute({ review_scope: { scope_type: "full", granularity: "simple", fix: "fix" } }, o)
      const sessionId = (out.match(/`review-full-develop-\d+`/) ?? [""])[0].replace(/`/g, "")
      await set_worktree.execute({ change_id: sessionId }, o)
      const item = itemOf(wt, sessionId)
      expect(item.metadata["base_ref"]).toBeUndefined()
      expect(item.metadata["merge_target"]).toBe("develop")
      await submit(wt, sessionId, "openspec-reviewer", { step_id: "quality_review", verdict: "passed", validation_steps: [{ step: "regression", completed: true }] })
      expect(itemOf(wt, sessionId).phase).toBe("done")
      await complete_task_group.execute({ change_id: sessionId }, o)
      // 主仓库检出 develop（当前分支）→ 收尾走真实 merge --no-ff 合回 develop（分支指针由 git merge 自身推进，不经 update-ref CAS）
      expect(fakeGit.mergedBranches).toContain(itemOf(wt, sessionId).metadata["branch_name"])
      expect(fakeGit.refUpdates.some((u) => u.ref === "refs/heads/develop")).toBe(false)
    } finally { teardown(root) }
  })
})

describe("流转矩阵：fix=none 失败直达 done 不死循环", () => {
  test("pr + thorough + none：verify_tool failed 报 issue → 直达 done，issue 停留 todo；不再分派审查者/implement", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "none" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer-tool", {
        step_id: "verify_tool", verdict: "failed",
        new_children: [{ id: "i1", title: "格式违规", description: "格式违规", severity: "Low", dimension: "style", file: "src/a.ts", line: 1 }],
      })
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
      // failed tag 滞留 + issue todo + item done 为合法组合：recommendForItem 返回 terminal（非 recommend）
      const view = await status.execute({ change_id: PR_SESSION }, makeOrchCtx(wt))
      expect(view).toContain("独立审查已完成")
      expect(view).toContain("审查结果报告")
      // 收尾：fix=none 门禁放宽（Low+ issue 未终态不阻塞）+ 销毁不合并
      const out = await complete_task_group.execute({ change_id: PR_SESSION }, o)
      expect(out).toContain("只审模式")
      expect(fakeGit.mergeCommitBranches.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
      expect(existsSync(itemOf(wt, PR_SESSION).metadata["worktree_path"])).toBe(false)
    } finally { teardown(root) }
  })

  test("full + simple + none：quality_review failed → done → 收尾门禁放宽且不合并", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const o = makeOrchCtx(wt)
      const out = await init.execute({ review_scope: { scope_type: "full", granularity: "simple", fix: "none" } }, o)
      const sessionId = (out.match(/`review-full-main-\d+`/) ?? [""])[0].replace(/`/g, "")
      await set_worktree.execute({ change_id: sessionId }, o)
      await submit(wt, sessionId, "openspec-reviewer", {
        step_id: "quality_review", verdict: "failed",
        new_children: [{ id: "i1", title: "回归失败", description: "既有测试出现新失败", severity: "Medium", dimension: "maintainability", file: "src/b.ts", line: 2 }],
      })
      expect(itemOf(wt, sessionId).phase).toBe("done")
      await complete_task_group.execute({ change_id: sessionId }, o)
      expect(fakeGit.refUpdates.length).toBe(0)
    } finally { teardown(root) }
  })
})

describe("流转矩阵：fix 模式失败进 implement 修复后回审查层重跑", () => {
  test("pr + thorough + fix：工具层报 issue → implement 修复 → 回 verify_tool 重跑 → 全过收口", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "fix" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer-tool", {
        step_id: "verify_tool", verdict: "failed",
        new_children: [{ id: "i1", title: "格式违规", description: "格式违规", severity: "Low", dimension: "style", file: "src/a.ts", line: 1 }],
      })
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      // dev 修复后回 verify_tool（归因层 tag 已被重置）
      await submit(wt, PR_SESSION, "openspec-developer", { step_id: "implement", verdict: "passed", fixed_issue_ids: ["i1"], self_check_results: "已修复" })
      const after = itemOf(wt, PR_SESSION)
      expect(after.phase).toBe("review")
      expect(after.currentStep).toBe("verify_tool")
      // 修复后 issue 进入待复核
      const fixed = after.children.find((c: any) => c.externalId === "i1")
      expect(fixed.phase).toBe("review")
      // 审查者复核通过后推进
      await submit(wt, PR_SESSION, "openspec-reviewer-tool", {
        step_id: "verify_tool", verdict: "passed",
        recheck_adjudications: [{ issue_id: "i1", verdict: "passed" }],
        validation_steps: [{ step: "build", completed: true }],
      })
      await submit(wt, PR_SESSION, "openspec-reviewer-task", { step_id: "verify_task", verdict: "passed", validation_steps: [{ step: "regression", completed: true }] })
      for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
        await submit(wt, PR_SESSION, `openspec-reviewer-${d}`, { step_id: "verify_quality", verdict: "passed" })
      }
      expect(itemOf(wt, PR_SESSION).phase).toBe("done")
    } finally { teardown(root) }
  })

  test("simple + fix：合并审查失败 → implement → 回 quality_review；dev 申报不在审查视图渲染", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "fix" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer", {
        step_id: "quality_review", verdict: "failed",
        new_children: [{ id: "i1", title: "断言放水", description: "测试断言放水", severity: "Low", dimension: "maintainability", file: "tests/b.test.ts", line: 3 }],
      })
      await submit(wt, PR_SESSION, "openspec-developer", { step_id: "implement", verdict: "passed", fixed_issue_ids: ["i1"], self_check_results: "自检通过" })
      // review_merged 视图（简单颗粒度）不渲染「开发者自检申报」区块（独立审查无该数据源）
      const view = await status.execute({ change_id: PR_SESSION }, makeCtx("openspec-reviewer", wt))
      expect(view).not.toContain("开发者自检申报")
      expect(view).toContain("审查范围")
    } finally { teardown(root) }
  })

  test("review-and-fix 门禁保留：阻塞 issue 未终态时收尾拒绝", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "fix" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer", {
        step_id: "quality_review", verdict: "failed",
        new_children: [{ id: "i1", title: "问题", description: "阻塞问题", severity: "Low", dimension: "style", file: "src/a.ts", line: 1 }],
      })
      await submit(wt, PR_SESSION, "openspec-developer", { step_id: "implement", verdict: "failed" })
      // issue 未修复（todo 态）卡 implement；recovery 到 review 后 issue 仍 todo → 直接手工置 done 模拟收口尝试
      const s = readState(wt, PR_SESSION)!
      const item = s.workItems[0]
      item.phase = "done"
      item.currentStep = null
      const { writeState } = await import("../src/core/state")
      await writeState(wt, s)
      const err = await complete_task_group.execute({ change_id: PR_SESSION }, o).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未解决 issue/)
    } finally { teardown(root) }
  })
})

describe("回归验证（thorough 第二层）", () => {
  test("修复引入新失败：verify_task failed 报回归 issue 回退 implement；存量失败按 issue 上报进入处置通道", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "fix" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      // 首轮工具层通过 → 回归验证层报存量失败 issue（进入修复闭环）
      await submit(wt, PR_SESSION, "openspec-reviewer-tool", { step_id: "verify_tool", verdict: "passed", validation_steps: [{ step: "build", completed: true }] })
      await submit(wt, PR_SESSION, "openspec-reviewer-task", {
        step_id: "verify_task", verdict: "failed",
        new_children: [{ id: "r1", title: "存量失败", description: "既有测试存量失败（上轮未登记）", severity: "Medium", dimension: "maintainability", file: "tests/old.test.ts", line: 5 }],
      })
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      const issue = item.children.find((c: any) => c.externalId === "r1")
      expect(issue.phase).toBe("todo")
    } finally { teardown(root) }
  })
})

describe("恢复路径", () => {
  test("恢复到 review 各层：implement:passed 补齐、failed 审查标记回 pending、currentStep=第一个未全 passed 层", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "fix" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer-tool", { step_id: "verify_tool", verdict: "passed", validation_steps: [{ step: "build", completed: true }] })
      // change_id 入口恢复（task_group_id 缺省，虚拟组 review）
      await init.execute({ change_id: PR_SESSION, recovery: { phase: "review" } } as any, o)
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_task")
      expect(item.tags["implement:openspec-developer"]).toBe("passed")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      // reset_steps 值域按形态：thorough 不接受 quality_review
      const err = await init.execute({ change_id: PR_SESSION, recovery: { phase: "review", reset_steps: ["quality_review"] } } as any, o).catch((e: Error) => e)
      expect(err.message).toMatch(/不属于当前会话形态/)
      // task_analysis 拒绝
      const errTa = await init.execute({ change_id: PR_SESSION, recovery: { phase: "task_analysis" } } as any, o).catch((e: Error) => e)
      expect(errTa.message).toMatch(/task_analysis/)
      // reset_steps 强制重审 verify_tool
      await init.execute({ change_id: PR_SESSION, recovery: { phase: "review", reset_steps: ["verify_tool"] } } as any, o)
      expect(itemOf(wt, PR_SESSION).currentStep).toBe("verify_tool")
      expect(itemOf(wt, PR_SESSION).tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("simple 颗粒度 reset_steps 接受 quality_review；恢复 dev_impl 落 implement", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "fix" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await init.execute({ change_id: PR_SESSION, recovery: { phase: "dev_impl" } } as any, o)
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      await init.execute({ change_id: PR_SESSION, recovery: { phase: "review", reset_steps: ["quality_review"] } } as any, o)
      expect(itemOf(wt, PR_SESSION).currentStep).toBe("quality_review")
    } finally { teardown(root) }
  })
})

describe("fix=none 中途层失败直达 done（thorough 后置层 / simple）", () => {
  test("thorough + none：verify_tool passed 后 verify_task failed → 直达 done（不进 implement）", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "none" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer-tool", { step_id: "verify_tool", verdict: "passed", validation_steps: [{ step: "build", completed: true }] })
      await submit(wt, PR_SESSION, "openspec-reviewer-task", {
        step_id: "verify_task", verdict: "failed",
        new_children: [{ id: "r1", title: "回归失败", description: "修复引入回归", severity: "High", dimension: "maintainability", file: "tests/c.test.ts", line: 9 }],
      })
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
      const view = await status.execute({ change_id: PR_SESSION }, makeOrchCtx(wt))
      expect(view).toContain("独立审查已完成")
    } finally { teardown(root) }
  })

  test("thorough + none：verify_quality（第三层）failed 同样直达 done", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "none" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer-tool", { step_id: "verify_tool", verdict: "passed", validation_steps: [{ step: "build", completed: true }] })
      await submit(wt, PR_SESSION, "openspec-reviewer-task", { step_id: "verify_task", verdict: "passed", validation_steps: [{ step: "regression", completed: true }] })
      // verify_quality 为 5 维多 agent step：失败回退须等全部维度提交后才触发（单维 failed 不提前回退）
      await submit(wt, PR_SESSION, "openspec-reviewer-style", {
        step_id: "verify_quality", verdict: "failed",
        new_children: [{ id: "q1", title: "命名违规", description: "命名不符合规范", severity: "Low", dimension: "style", file: "src/d.ts", line: 4 }],
      })
      expect(itemOf(wt, PR_SESSION).phase).toBe("review")
      for (const d of ["architecture", "performance", "security", "maintainability"]) {
        await submit(wt, PR_SESSION, `openspec-reviewer-${d}`, { step_id: "verify_quality", verdict: "passed" })
      }
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("done")
      expect(item.currentStep).toBeNull()
    } finally { teardown(root) }
  })

  test("pr + simple + none：quality_review failed → 直达 done", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "none" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer", {
        step_id: "quality_review", verdict: "failed",
        new_children: [{ id: "s1", title: "问题", description: "单层审查报出问题", severity: "Low", dimension: "style", file: "src/e.ts", line: 1 }],
      })
      expect(itemOf(wt, PR_SESSION).phase).toBe("done")
    } finally { teardown(root) }
  })
})

describe("full + thorough 组合关键路径", () => {
  test("初始化（full 不设 base_ref、merge_target=当前分支）→ 失败 fix 进 implement → 收尾合回当前分支", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.currentBranch = "develop"
      const o = makeOrchCtx(wt)
      const out = await init.execute({ review_scope: { scope_type: "full", granularity: "thorough", fix: "fix" } }, o)
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      const sessionId = `review-full-develop-${day}`
      expect(out).toContain(sessionId)
      await set_worktree.execute({ change_id: sessionId }, o)
      const item = itemOf(wt, sessionId)
      expect(item.metadata["base_ref"]).toBeUndefined()
      expect(item.metadata["merge_target"]).toBe("develop")
      // 审查失败 → fix 模式进 implement 修复闭环
      await submit(wt, sessionId, "openspec-reviewer-tool", {
        step_id: "verify_tool", verdict: "failed",
        new_children: [{ id: "i1", title: "格式违规", description: "格式违规", severity: "Low", dimension: "style", file: "src/a.ts", line: 1 }],
      })
      expect(itemOf(wt, sessionId).currentStep).toBe("implement")
      await submit(wt, sessionId, "openspec-developer", { step_id: "implement", verdict: "passed", fixed_issue_ids: ["i1"], self_check_results: "已修复" })
      await submit(wt, sessionId, "openspec-reviewer-tool", {
        step_id: "verify_tool", verdict: "passed",
        recheck_adjudications: [{ issue_id: "i1", verdict: "passed" }],
        validation_steps: [{ step: "build", completed: true }],
      })
      await submit(wt, sessionId, "openspec-reviewer-task", { step_id: "verify_task", verdict: "passed", validation_steps: [{ step: "regression", completed: true }] })
      for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
        await submit(wt, sessionId, `openspec-reviewer-${d}`, { step_id: "verify_quality", verdict: "passed" })
      }
      expect(itemOf(wt, sessionId).phase).toBe("done")
      await complete_task_group.execute({ change_id: sessionId }, o)
      // full 形态收尾合回当前分支 develop：主仓库检出 develop → 走真实 merge --no-ff（不经 update-ref CAS）
      expect(fakeGit.mergedBranches).toContain(itemOf(wt, sessionId).metadata["branch_name"])
      expect(fakeGit.refUpdates.some((u) => u.ref === "refs/heads/develop")).toBe(false)
    } finally { teardown(root) }
  })
})

describe("fix=none 经 recovery 重放：fail→done 映射恢复后仍生效", () => {
  test("failed 收口 done 后 recovery(review) 恢复，再次 failed 提交仍直达 done（不死循环）", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "none" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      await submit(wt, PR_SESSION, "openspec-reviewer-tool", { step_id: "verify_tool", verdict: "passed", validation_steps: [{ step: "build", completed: true }] })
      await submit(wt, PR_SESSION, "openspec-reviewer-task", {
        step_id: "verify_task", verdict: "failed",
        new_children: [{ id: "r1", title: "回归失败", description: "首轮回归失败", severity: "Medium", dimension: "maintainability", file: "tests/f.test.ts", line: 7 }],
      })
      expect(itemOf(wt, PR_SESSION).phase).toBe("done")
      // 收口前经 recovery(review) 恢复：verify_tool passed 保留、verify_task failed tag 清除，currentStep 回落该层
      const rec = await init.execute({ change_id: PR_SESSION, recovery: { phase: "review" } } as any, o)
      expect(rec).toContain("已恢复到 review")
      const item = itemOf(wt, PR_SESSION)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_task")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      // 恢复后重放 failed 提交：fail→done 短路仍生效，不再走 implement/重派循环
      await submit(wt, PR_SESSION, "openspec-reviewer-task", {
        step_id: "verify_task", verdict: "failed",
        new_children: [{ id: "r2", title: "回归失败", description: "重放回归失败", severity: "Medium", dimension: "maintainability", file: "tests/g.test.ts", line: 8 }],
      })
      expect(itemOf(wt, PR_SESSION).phase).toBe("done")
      expect(itemOf(wt, PR_SESSION).currentStep).toBeNull()
    } finally { teardown(root) }
  })
})

describe("防御性路径", () => {
  test("分支名含非法字符时会话 id 归一：斜杠/空格折叠为单个连字符、无首尾连字符", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.localBranches = new Set(["main", "feature/x", "release v1.2"])
      const o = makeOrchCtx(wt)
      // 斜杠与其它非法字符归一为单个连字符（feature/x → feature-x）
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature/x", granularity: "simple", fix: "none" } }, o)
      expect(readState(wt, "review-pr-main-feature-x")).not.toBeNull()
      // full 形态当前分支含空格/点：归一后无连续连字符、无首尾连字符
      fakeGit.currentBranch = "release v1.2"
      const out = await init.execute({ review_scope: { scope_type: "full", granularity: "simple", fix: "none" } }, o)
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      expect(out).toContain(`review-full-release-v1-2-${day}`)
      // 含空白字符的 head_ref（pr 形态）在入口即拒绝
      fakeGit.localBranches.add("bad branch")
      const err = await init.execute({ review_scope: { scope_type: "pr", head_ref: "bad branch", granularity: "simple", fix: "none" } }, o).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/分支名不合法/)
    } finally { teardown(root) }
  })

  test("fix=none 会话 item 落在 implement（人为构造）时 recommendForItem 防御短路：视图 blocked 且不分派", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "thorough", fix: "none" } }, o)
      await set_worktree.execute({ change_id: PR_SESSION }, o)
      // 人为构造异常 state：item 落进 implement（正常 fix=none 不可达）
      const s = readState(wt, PR_SESSION)! as any
      const item = s.workItems[0]
      item.phase = "in_progress"
      item.currentStep = "implement"
      const { writeState } = await import("../src/core/state")
      await writeState(wt, s)
      const view = await status.execute({ change_id: PR_SESSION }, makeOrchCtx(wt))
      expect(view).toContain("只审（fix=none）会话不可进入 implement")
    } finally { teardown(root) }
  })

  test("discoverDiskWorktrees 识别 review/ 前缀分支（与 task-group/ 同为可恢复磁盘痕迹）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.worktrees.set("/tmp/wt-review", { branch: "review/review-pr-main-feature-x", path: "/tmp/wt-review" })
      fakeGit.worktrees.set("/tmp/wt-group", { branch: "task-group/cid/1", path: "/tmp/wt-group" })
      fakeGit.worktrees.set("/tmp/wt-main", { branch: "main", path: "/tmp/wt-main" })
      const { discoverDiskWorktrees } = await import("../src/core/git")
      const found = await discoverDiskWorktrees(wt)
      expect(found).toContainEqual({ branch: "review/review-pr-main-feature-x", path: "/tmp/wt-review" })
      expect(found).toContainEqual({ branch: "task-group/cid/1", path: "/tmp/wt-group" })
      expect(found.some((f) => f.branch === "main")).toBe(false)
    } finally { teardown(root) }
  })

  test("setWorktree 复用已存在 review/<sessionId> worktree：快进合并自 head_ref 后复用", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "fix" } }, o)
      // 预置磁盘痕迹：默认布局路径 + review/<sessionId> 分支
      const wtPath = join(root, "workspace", ".worktree", PR_SESSION, "review")
      fakeGit.worktrees.set(wtPath, { branch: `review/${PR_SESSION}`, path: wtPath })
      const out = await set_worktree.execute({ change_id: PR_SESSION }, o)
      expect(out).toContain("复用已有 worktree")
      // 快进合并发生在既有 worktree 目录内、目标为 baseBranch（pr 形态 = head_ref）的当前 tip
      expect(fakeGit.callSites.some((c) =>
        c.checked && c.args[0] === "merge" && c.args[1] === "--ff-only" && c.dir === wtPath
      )).toBe(true)
      const item = itemOf(wt, PR_SESSION)
      expect(item.metadata["branch_name"]).toBe(`review/${PR_SESSION}`)
      expect(item.metadata["merge_target"]).toBe("feature-x")
    } finally { teardown(root) }
  })

  test("setWorktree 复用路径保留本地提交：快进失败但干净且领先 baseBranch 时直接复用", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ review_scope: { scope_type: "pr", head_ref: "feature-x", granularity: "simple", fix: "fix" } }, o)
      const wtPath = join(root, "workspace", ".worktree", PR_SESSION, "review")
      fakeGit.worktrees.set(wtPath, { branch: `review/${PR_SESSION}`, path: wtPath })
      fakeGit.forceMergeFailure = true
      fakeGit.revListCount = 2
      const out = await set_worktree.execute({ change_id: PR_SESSION }, o)
      expect(out).toContain("复用已有 worktree")
      const item = itemOf(wt, PR_SESSION)
      expect(item.metadata["worktree_path"]).toBe(wtPath)
      expect(item.metadata["branch_name"]).toBe(`review/${PR_SESSION}`)
    } finally { teardown(root) }
  })
})

describe("入口拒绝分支（review_scope 入口参数互斥与 recovery 值域）", () => {
  test("review_scope 携带 base_branch / mode / change_id 显式拒绝；recovery 非法组合拒绝且错误可读", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      const scope = { scope_type: "pr" as const, head_ref: "feature-x", granularity: "simple" as const, fix: "none" as const }
      const errBase = await init.execute({ review_scope: scope, base_branch: "main" } as any, o).catch((e: Error) => e)
      expect(errBase).toBeInstanceOf(Error)
      expect(errBase.message).toMatch(/互斥/)
      expect(errBase.message).toMatch(/base_branch/)
      const errMode = await init.execute({ review_scope: scope, mode: "full" } as any, o).catch((e: Error) => e)
      expect(errMode.message).toMatch(/互斥/)
      expect(errMode.message).toMatch(/mode/)
      const errChange = await init.execute({ review_scope: scope, change_id: "some-change" } as any, o).catch((e: Error) => e)
      expect(errChange.message).toMatch(/互斥/)
      const errTa = await init.execute({ review_scope: scope, recovery: { phase: "task_analysis" } } as any, o).catch((e: Error) => e)
      expect(errTa.message).toMatch(/仅支持 phase="review"/)
      const errLayer = await init.execute({ review_scope: scope, recovery: { phase: "review", review_layer: "task" } } as any, o).catch((e: Error) => e)
      expect(errLayer.message).toMatch(/不支持 review_layer/)
      const errReopen = await init.execute({ review_scope: scope, recovery: { phase: "review", reopenIssues: true } } as any, o).catch((e: Error) => e)
      expect(errReopen.message).toMatch(/不支持 reopenIssues/)
    } finally { teardown(root) }
  })
})

describe("视图适配", () => {
  test("全量锚点：full 形态审查视图渲染「全量代码库」而非「未检出变更」；worktree 区块渲染全量审查范围", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      const out = await init.execute({ review_scope: { scope_type: "full", granularity: "simple", fix: "none" } }, o)
      const sessionId = (out.match(/`review-full-main-\d+`/) ?? [""])[0].replace(/`/g, "")
      await set_worktree.execute({ change_id: sessionId }, o)
      const view = await status.execute({ change_id: sessionId }, makeCtx("openspec-reviewer", wt))
      expect(view).toContain("全量代码库审查")
      expect(view).not.toContain("未检出")
    } finally { teardown(root) }
  })
})
