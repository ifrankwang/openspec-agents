/**
 * simple 模式视图归属与渲染测试（变更组 3.5）：
 * - quality_review 合并渲染器（3.3）：openspec-reviewer 视角输出 Task(待验证) + Issue(待复核) +
 *   Issue(待裁定是否可豁免) 三区块
 * - isAgentOwnedIssue 归属扩展（3.4）：quality 层无维度调用者按报源 === 调用者归属——名下待复核/
 *   待裁定豁免清单可见，非名下 issue 不出现（spec:agent-identity#simple 审查者名下清单可见）
 * - isQualityAdjudicable 无维度调用者分支（3.4）：报源 === 调用者且带 exempt_request 即可裁定
 * - full 模式 verify_quality 5 逻辑身份并行视图回归（维度过滤与多身份并排分派不受改动影响）
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, set_worktree, status, agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWorkspace, teardown, initSimpleWorktree } from "./helpers"

const CID = "mode-view"
const DEV = "openspec-developer"
const REVIEWER = "openspec-reviewer"

afterAll(() => { __setGitRunner(null) })

function fresh(): { root: string; wt: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/modeview-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  return { root, wt, fakeGit }
}

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

function issueChild(id: string, source: string, phase: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: `issue:${id}`, source, externalId: id, type: "issue",
    title: `title-${id}`, description: `desc-${id}`, phase, suspended: false, currentStep: null,
    tags: {}, metadata: { source, dimension: "style" },
    children: [], labels: [], severity: "Low",
    ...overrides,
  }
}

/** simple 初始态 → implement passed 进入 quality_review。 */
async function enterQualityReview(wt: string): Promise<void> {
  await agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
    makeCtx(DEV, wt),
  )
}

describe("3.3 quality_review 合并渲染器（三区块）", () => {
  test("openspec-reviewer 视角：Task(待验证) + 名下待复核 + 名下待裁定豁免 三区块齐出", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      // 名下（报源 openspec-reviewer）review 态 issue + 名下豁免申请；其他报源 issue 不注入本场景
      injectIssue(wt, issueChild("r1", REVIEWER, "review"))
      injectIssue(wt, issueChild("x1", REVIEWER, "review", {
        metadata: { source: REVIEWER, dimension: "architecture", exempt_request: { requestedBy: DEV } },
      }))
      const output = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      expect(output).toContain("# ✅ 当前轮到你执行")
      // Task(待验证)：implement passed 后 3 个 task child 均 submitted
      expect(output).toContain("## Task (待验证)")
      expect(output).toContain("Task one")
      // Issue(待复核)：名下 review 态 issue
      expect(output).toContain("## Issue (待复核)")
      expect(output).toContain("desc-r1")
      // Issue(待裁定是否可豁免)：名下豁免申请（报源 === 调用者）
      expect(output).toContain("## Issue (待裁定是否可豁免)")
      expect(output).toContain("desc-x1")
      expect(output).toContain("豁免申请中")
    } finally { teardown(root) }
  })

  test("无待验证 task 时 Task 区块不渲染（其余区块不受影响）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // 不提交 implement，直接把 item 手工落 quality_review 且 task children 无 submitted
      const item = taskItemOf(wt)
      item.phase = "review"
      item.currentStep = "quality_review"
      item.tags["implement:openspec-developer"] = "passed"
      item.children = item.children.filter((c: any) => c.type !== "task")
      writeFileSync(join(wt, "openspec", "states", `${CID}.json`), JSON.stringify({ ...JSON.parse(readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8")), workItems: [item] }))
      injectIssue(wt, issueChild("r1", REVIEWER, "review"))
      const output = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      expect(output).not.toContain("## Task (待验证)")
      expect(output).toContain("## Issue (待复核)")
      expect(output).toContain("desc-r1")
    } finally { teardown(root) }
  })
})

describe("3.4 名下清单可见 / 非名下 issue 不出现", () => {
  test("simple 审查者仅见名下待复核与待裁定豁免；其他报源 review 态 issue 与豁免申请不出现", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      // 名下：review 态 + 豁免申请
      injectIssue(wt, issueChild("own1", REVIEWER, "review"))
      injectIssue(wt, issueChild("own2", REVIEWER, "review", {
        metadata: { source: REVIEWER, dimension: "performance", exempt_request: { requestedBy: DEV } },
      }))
      // 非名下：quality 维度 reviewer 报源（agentToReviewLayer=quality 但维度不同）、tool 层报源
      injectIssue(wt, issueChild("other1", "openspec-reviewer-style", "review"))
      injectIssue(wt, issueChild("other2", "openspec-reviewer-tool", "review", {
        metadata: { source: "openspec-reviewer-tool", dimension: "style" },
      }))
      injectIssue(wt, issueChild("other3", "openspec-reviewer-tool", "review", {
        metadata: { source: "openspec-reviewer-tool", dimension: "style", exempt_request: { requestedBy: DEV } },
      }))
      const output = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      // 名下可见
      expect(output).toContain("desc-own1")
      expect(output).toContain("desc-own2")
      // 非名下不出现（issue 描述与 id 均不出现）
      expect(output).not.toContain("desc-other1")
      expect(output).not.toContain("desc-other2")
      expect(output).not.toContain("desc-other3")
    } finally { teardown(root) }
  })

  test("非名下 issue 的 todo 态不进入审查者主区块（待复核只收 review 态）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      // 名下但 todo 态（dev 尚未修复）：不进入待复核主区块
      injectIssue(wt, issueChild("t1", REVIEWER, "todo"))
      const output = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      expect(output).not.toContain("desc-t1")
    } finally { teardown(root) }
  })
})

describe("blocked 视图：simple 审查者可见名下待复核 / 待裁定豁免（isAdjudicableExempt 扩展）", () => {
  test("quality_review 全 passed 但本层 blocking 未终态 → blocked 视图列出名下待复核与待裁定清单", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await enterQualityReview(wt)
      // 本层 blocking：名下 review 态 issue + 名下豁免申请（报源 openspec-reviewer）
      injectIssue(wt, issueChild("b1", REVIEWER, "review", { severity: "High" }))
      injectIssue(wt, issueChild("b2", REVIEWER, "review", {
        severity: "High",
        metadata: { source: REVIEWER, dimension: "style", exempt_request: { requestedBy: DEV } },
      }))
      // 审查者先提交 passed（漏带裁定）→ stepCanPass=false → blocked
      await agent_submit.execute(
        { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx(REVIEWER, wt),
      )
      const output = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      expect(output).toContain("# ⛔ 当前 step 阻塞中，等待编排处理")
      expect(output).toContain("本层待复核 issue")
      expect(output).toContain("Issue #b1")
      expect(output).toContain("本层待裁定豁免申请")
      expect(output).toContain("Issue #b2")
    } finally { teardown(root) }
  })
})

describe("full 模式 verify_quality 5 逻辑身份并行视图回归", () => {
  /** full 模式构造 verify_quality 聚合态：5 维全部 pending，tool/task 已 passed。 */
  async function driveToVerifyQuality(wt: string): Promise<void> {
    const orch = makeOrchCtx(wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, orch)
    await set_worktree.execute({ change_id: CID }, orch)
    const p = join(wt, "openspec", "states", `${CID}.json`)
    const state = JSON.parse(readFileSync(p, "utf-8")) as { workItems: any[] }
    const item = state.workItems.find((w: any) => w.id === "task:1")
    item.phase = "review"
    item.currentStep = "verify_quality"
    item.tags = {
      "analyze:openspec-architect": "passed",
      "implement:openspec-developer": "passed",
      "verify_tool:openspec-reviewer-tool": "passed",
      "verify_task:openspec-reviewer-task": "passed",
    }
    writeFileSync(p, JSON.stringify(state, null, 2))
  }

  test("style 维度视角：仅渲染 style 报源 review 态 issue（维度过滤回归）", async () => {
    const { root, wt } = fresh()
    try {
      await driveToVerifyQuality(wt)
      injectIssue(wt, issueChild("s1", "openspec-reviewer-style", "review", {
        metadata: { source: "openspec-reviewer-style", dimension: "style" },
      }))
      injectIssue(wt, issueChild("a1", "openspec-reviewer-architecture", "review", {
        metadata: { source: "openspec-reviewer-architecture", dimension: "architecture" },
      }))
      const output = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer-style", wt))
      expect(output).toContain("# ✅ 当前轮到你执行")
      expect(output).toContain("desc-s1")
      expect(output).not.toContain("desc-a1")
    } finally { teardown(root) }
  })

  test("编排视角：verify_quality 5 逻辑身份并排分派（多子代理并行文案）", async () => {
    const { root, wt } = fresh()
    try {
      await driveToVerifyQuality(wt)
      const output = await status.execute({ change_id: CID }, makeOrchCtx(wt))
      for (const dim of ["style", "architecture", "performance", "security", "maintainability"]) {
        expect(output).toContain("openspec-reviewer-" + dim)
      }
      expect(output).toContain("多子代理相互独立，可在单条消息中并排分派，无需串行等待")
    } finally { teardown(root) }
  })
})
