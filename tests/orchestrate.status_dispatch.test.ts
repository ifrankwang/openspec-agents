/**
 * opx_status 调度指示集成测试（orchestrator 分派指示视图缺口补齐）。
 *
 * 背景：既有测试覆盖子代理执行视图/门禁视图较扎实，但 orchestrator 分派指示视图存在真缺口，
 * 本文件按 gap 编号逐项补齐（全部经 opx_agent_submit.execute 推真实状态机后以相应角色 ctx 调
 * status.execute 断言调度指示提示词；边界态用本地 rewriteItem 注入）。
 *
 * 用例与源码依据：
 * - gap1   未初始化 + 磁盘有 worktree → 恢复候选列表（lifecycle.ts:491-505 discoverDiskWorktrees）
 * - gap2   找不到活跃 WorkItem（lifecycle.ts:507-510）
 * - gap3+4 checkpoint giveup 后查 status（engine.ts:198-208 applyCheckpointGiveup；status.ts:153 renderTerminal）
 * - gap5   blocked 态子代理视图集成（status.ts:137 renderBlocked；status.ts:186-194 推进阻塞）
 * - gap6   分派视图防御出口 2：agents=[] 且无 failed 残留（status.ts:230-231）
 * - gap7   verify_quality 聚合等待期 orchestrator 分派（engine.ts:114-118 recommendAgents 聚合语义）
 * - gap8   回退 implement 后分派 developer（status.ts:215）
 * - gap9   recovery 后立即查 status（engine.ts:215-217 resetInternalRetryCount）
 * - gap10  多任务组切换只渲染活跃组（state.taskGroupId 权威）
 * - gap11  worktree 内 session 调 status 走 isWorktreePath 分支（state.ts:62-66）
 * - gap12  detectMainRepoPollution 抛错时 status 容错（git.ts:198-215 修复）
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner, type GitRunner } from "../src/core/git"
import { status, init, agent_submit, set_worktree } from "../src/adapters/opencode/tools"
import { FakeGitRunner, setupWithFakeGit, teardown, makeCtx } from "./helpers"
import {
  setupToAnalyze, driveToImplement, driveToVerifyTool, driveToQuality, readItem, makeAgentCtxs,
} from "./helpers-workflow"

const CID = "test-status-dispatch"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/sd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string): string {
  return join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
}

/** 直接改写活跃 task WorkItem（手工构造前置状态用）。 */
function rewriteItem(wt: string, mutate: (item: any) => void): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 改写 state.taskGroupId（切换/悬空活跃组指针）。 */
function setTaskGroupId(wt: string, id: string): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  state.taskGroupId = id
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 最小 issue child（注入给 checkpoint/blocked 用例用）。 */
function makeIssueChild(id: string): any {
  return {
    id: `issue:${id}`, source: "openspec", externalId: id, type: "issue",
    title: "遗留 issue", description: "d", phase: "todo", suspended: false,
    currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low",
  }
}

// ════════════════════════════════════════════════════════════════
//  gap1：未初始化 + 磁盘有 worktree → 恢复候选列表
// ════════════════════════════════════════════════════════════════

describe("gap1 未初始化 + 磁盘 worktree → 恢复候选列表", () => {
  test("orchestrator 见恢复候选列表；developer 仍见尚未初始化", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      // 不调 init，仅注入磁盘 worktree（lifecycle.ts:493 discoverDiskWorktrees）
      fakeGit.worktrees.set(join(wt, ".worktree", CID, "task-group-1"), {
        branch: `task-group/${CID}/1`,
        path: join(wt, ".worktree", CID, "task-group-1"),
      })
      const out = await status.execute({ change_id: CID }, makeCtx("openspec-orchestrator", wt))
      expect(out).toContain("未初始化")
      expect(out).toContain("## 磁盘 Worktree（可恢复进度）")
      expect(out).toContain("opx_orch_init(recovery=...)")
      // 非 orchestrator 不渲染恢复候选，仍见"尚未初始化"
      const devOut = await status.execute({ change_id: CID }, makeCtx("openspec-developer", wt))
      expect(devOut).toContain("尚未初始化")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap2：找不到活跃 WorkItem（state.taskGroupId 悬空）
// ════════════════════════════════════════════════════════════════

describe("gap2 找不到活跃 WorkItem", () => {
  test("taskGroupId 指向不存在的 workItem → 未就绪提示", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      setTaskGroupId(wt, "ghost")
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("编排会话未就绪：找不到活跃任务组的工作项")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap3+4：checkpoint giveup 后查 status
// ════════════════════════════════════════════════════════════════

describe("gap3+4 checkpoint giveup 后查 status", () => {
  test("giveup 后 child 置 cancelled、子代理见 step 已通过、orchestrator 分派视图不含检查点", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      rewriteItem(wt, (item) => {
        item.metadata["_retryCount"] = 3
        item.metadata["_checkpoint"] = true
        item.children.push(makeIssueChild("7"))
      })
      // 检查点决策 giveup（submit.ts applyCheckpointGiveup：未解决 children 置 cancelled + step 全 passed）
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "giveup" },
        ctx.toolR
      )
      const item = readItem(wt, CID)
      expect(item.children.find((c: any) => c.id === "issue:7").phase).toBe("cancelled")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      // 子代理视图：# 🏁 当前 step 已通过（status.ts:153 renderTerminal）
      const toolRView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(toolRView).toContain("# 🏁 当前 step 已通过")
      // orchestrator 分派视图：含当前阶段、不再含"检查点"（terminal → 防御出口分支）
      const orchView = await status.execute({ change_id: CID }, ctx.orch)
      expect(orchView).toContain("# 编排进度")
      expect(orchView).toContain("**当前阶段**: review")
      expect(orchView).not.toContain("检查点")
      expect(orchView).not.toContain("checkpoint_decision")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap5：blocked 态子代理视图集成
// ════════════════════════════════════════════════════════════════

describe("gap5 blocked 态子代理视图集成", () => {
  test("developer 见阻塞等待视图且不含分派指示；orchestrator 见推进阻塞原因", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      // implement 全 passed + 遗留 todo task child → forwardGatePassed 拦截（engine.ts:340-348）
      rewriteItem(wt, (item) => {
        item.tags["implement:openspec-developer"] = "passed"
        item.children.push({
          id: "9", source: "openspec", externalId: "1.9", type: "task", title: "遗留子任务",
          description: "遗留子任务", phase: "todo", suspended: false, currentStep: null,
          tags: {}, metadata: {}, children: [], labels: [],
        })
      })
      const devView = await status.execute({ change_id: CID }, ctx.dev)
      expect(devView).toContain("# ⛔ 当前 step 阻塞中，等待编排处理")
      expect(devView).not.toContain("分派子代理：")
      const orchView = await status.execute({ change_id: CID }, ctx.orch)
      expect(orchView).toContain("# 编排进度")
      expect(orchView).toContain("**推进阻塞**:")
      expect(orchView).toContain("跨 phase 正向推进被门禁拦截")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap6：blocked 分派视图（原防御出口断言锁定的 bug 行为已修复）
//  blocked（step 全 passed 但本层 blocking children 未终态）不再恒 agents=[]：
//  - 报源可推导 → 分派报源 reviewer 补交裁定（engine.blockedSupplementAgents）
//  - 报源不可推导 / 全为 todo 态 → 输出阻塞 children 诊断清单（status.renderBlockedChildrenDiagnostic）
// ════════════════════════════════════════════════════════════════

describe("gap6 blocked 分派视图", () => {
  test("blocked 且报源可推导 → 分派报源 reviewer，不再输出（无待分派项，请检查状态）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // verify_quality 5 维全 passed + 本层 review 态 blocking child（报源 style reviewer，漏带复核）→ 引擎 blocked
      rewriteItem(wt, (item) => {
        item.tags["verify_quality:openspec-reviewer-style"] = "passed"
        item.tags["verify_quality:openspec-reviewer-architecture"] = "passed"
        item.tags["verify_quality:openspec-reviewer-performance"] = "passed"
        item.tags["verify_quality:openspec-reviewer-security"] = "passed"
        item.tags["verify_quality:openspec-reviewer-maintainability"] = "passed"
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "遗留 issue", description: "d", phase: "review", suspended: false,
          currentStep: null, tags: {}, metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style" },
          children: [], labels: [], severity: "Low",
        })
      })
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("**推进阻塞**:")
      expect(out).toContain("需报源 reviewer 补交复核/裁定")
      expect(out).toContain("分派子代理：`openspec-reviewer-style`")
      expect(out).not.toContain("（无待分派项，请检查状态）")
    } finally { teardown(root) }
  })

  test("blocked 且报源缺失（无 source 且无 dimension 无法推导）→ 输出阻塞 children 诊断清单", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      rewriteItem(wt, (item) => {
        item.tags["verify_quality:openspec-reviewer-style"] = "passed"
        item.tags["verify_quality:openspec-reviewer-architecture"] = "passed"
        item.tags["verify_quality:openspec-reviewer-performance"] = "passed"
        item.tags["verify_quality:openspec-reviewer-security"] = "passed"
        item.tags["verify_quality:openspec-reviewer-maintainability"] = "passed"
        // 报源缺失且无显式 dimension → 多 agent step 无法映射回维度 reviewer → agents 空
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "遗留 issue", description: "d", phase: "review", suspended: false,
          currentStep: null, tags: {}, metadata: { source_phase: "quality" },
          children: [], labels: [], severity: "Low",
        })
      })
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("当前 step 已全 passed 但存在阻塞 children，且无可补交裁定的 reviewer")
      expect(out).toContain("Issue #7")
      expect(out).toContain("报源:(报源缺失)")
      expect(out).not.toContain("（无待分派项，请检查状态）")
      expect(out).not.toContain("⚠️ 状态不一致")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap7：verify_quality 聚合等待期 orchestrator 分派
// ════════════════════════════════════════════════════════════════

describe("gap7 verify_quality 聚合等待期分派", () => {
  test("style 维 failed 后分派视图仅含其余 4 个 pending 维（不含 style）", async () => {
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
      const out = await status.execute({ change_id: CID }, ctx.orch)
      // recommendAgents 聚合等待语义：存在 pending → 仅重派 pending 维，不重复分派已 failed 维（engine.ts:114-118）
      expect(out).toContain("分派子代理：`openspec-reviewer-architecture`")
      expect(out).toContain("`openspec-reviewer-performance`")
      expect(out).toContain("`openspec-reviewer-security`")
      expect(out).toContain("`openspec-reviewer-maintainability`")
      // style 维不在分派列表（以 "`、" 分隔片段负断言，避免命中阶段进展表格里的 style 行）
      expect(out).not.toContain("`openspec-reviewer-style`、")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap8：verify_tool 回退 implement 后 orchestrator 分派 developer
// ════════════════════════════════════════════════════════════════

describe("gap8 回退 implement 后分派 developer", () => {
  test("verify_tool failed（带 Low+ 新报）→ 回退后分派 openspec-developer，阶段 in_progress", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "7", title: "Tool issue", description: "d", severity: "Low", dimension: "style" }],
        },
        ctx.toolR
      )
      expect(readItem(wt, CID).currentStep).toBe("implement")
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("**当前阶段**: in_progress")
      expect(out).toContain("分派子代理：`openspec-developer`")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap9：recovery 后立即查 status
// ════════════════════════════════════════════════════════════════

describe("gap9 recovery 后立即查 status", () => {
  test("recovery review 后 orchestrator 分派 reviewer-tool，阶段 review（勿断言 _retryCount 残留）", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      // recovery 已清 _retryCount/_checkpoint（engine.ts:215-217 resetInternalRetryCount），此处不断言残留
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("**当前阶段**: review")
      expect(out).toContain("分派子代理：`openspec-reviewer-tool`")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap10：多任务组切换只渲染活跃组
// ════════════════════════════════════════════════════════════════

describe("gap10 多任务组切换", () => {
  test("切换到组 2 后 orchestrator 分派视图渲染活跃组（todo/analyze → architect）", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      // 切换活跃组到 2（state.taskGroupId 权威）
      await init.execute({ change_id: CID, task_group_id: "2" }, ctx.orch)
      await set_worktree.execute({ change_id: CID }, ctx.orch)
      expect(readItem(wt, CID, "2").phase).toBe("todo")
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("**当前阶段**: todo")
      expect(out).toContain("分派子代理：`openspec-architect`")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap11：worktree 内 session 调 status（isWorktreePath 分支）
// ════════════════════════════════════════════════════════════════

describe("gap11 worktree 内 session 调 status", () => {
  test("从 worktree 路径调 status 走 readStateByWorktree isWorktreePath 分支正常渲染", async () => {
    const { wt, root } = fresh()
    try {
      // 构造 worktree：.git 为 gitdir 指针文件 + context.json 由 set_worktree 写入
      mkdirSync(join(wt, ".git", "worktrees", "wt-live"), { recursive: true })
      const wtLive = join(wt, "worktree-live")
      mkdirSync(join(wtLive, "openspec", "changes", CID), { recursive: true })
      writeFileSync(join(wtLive, ".git"), `gitdir: ${join(wt, ".git", "worktrees", "wt-live")}`)
      writeFileSync(join(wtLive, "openspec", "changes", CID, "tasks.md"), `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n`, "utf-8")

      // 主仓库 init + set_worktree（worktree_path 指向 wtLive，写入 metadata 与 context.json）
      const ctx = makeAgentCtxs(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, ctx.orch)
      await set_worktree.execute({ change_id: CID, worktree_path: "worktree-live" }, ctx.orch)

      // 从 worktree 内 session（worktree=wtLive）查 status → readStateByWorktree 走 isWorktreePath 分支
      const orchView = await status.execute({ change_id: CID }, makeCtx("openspec-orchestrator", wtLive))
      expect(orchView).toContain("# 编排进度")
      expect(orchView).toContain("分派子代理：`openspec-architect`")
      const archView = await status.execute({ change_id: CID }, makeCtx("openspec-architect", wtLive))
      expect(archView).toContain("# ✅ 当前轮到你执行")
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  gap12：detectMainRepoPollution 抛错时 status 容错（任务二修复验证）
// ════════════════════════════════════════════════════════════════

describe("gap12 detectMainRepoPollution 抛错时 status 容错", () => {
  test("status --porcelain 抛错 → opx_status 不抛错、正常渲染分派视图", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      // 主仓库形态：.git 为目录 → detectMainRepoPollution 走 runGit(status) 路径（git.ts:206）
      mkdirSync(join(wt, ".git"), { recursive: true })
      let statusCalls = 0
      const boomRunner: GitRunner = {
        async run(_w, args) {
          if (args[0] === "status") {
            statusCalls++
            throw new Error("git status 失败")
          }
          return ""
        },
        async runChecked() { return { success: true, stdout: "", stderr: "" } },
      }
      __setGitRunner(boomRunner)
      // 修复前此处会抛错（git.ts:208 runGit 无捕获）；修复后返回 null 正常渲染
      const out = await status.execute({ change_id: CID }, ctx.orch)
      // 证明真实走到 runGit(status) 抛错路径被容错（非 stat 提前返 null 的假绿）
      expect(statusCalls).toBeGreaterThan(0)
      expect(out).toContain("# 编排进度")
      expect(out).toContain("分派子代理：`openspec-developer`")
    } finally { teardown(root) }
  })
})
