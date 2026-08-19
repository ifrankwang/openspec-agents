/**
 * P6-B：opx_status 新流动态视图渲染（workItems 单轨）。
 *
 * 覆盖：
 * 1. 新流 review 阶段 reviewer-tool 查 status → 命中动态 ✅ 视图（capability_tags → skill 名）
 * 2. 新流 gate：developer 在 review 阶段被门禁（预期角色来自 recommendForItem.agents）
 * 3. 新流 orchestrator 分派视图（下一步分派子代理）
 * 4. checkpoint：metadata._checkpoint 标记 → 检查点文案 + continue/giveup
 * 5. checkpoint：引擎 retry 达到上限（recommendForItem status=checkpoint）
 * 6. suspended：暂停状态 + suspend_reason
 * （M1e-1 删除旧流工具后无回退语义，原「旧流回归」用例已删）
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { __setMustDoIndex, EMPTY_MUST_DO_INDEX } from "../src/core/tools/gate"
import { init, status, agent_submit, set_worktree } from "../src/adapters/opencode/tools"
import { renderWorkflowStatusView } from "../src/core/workflow/status"
import { loadWorkflow } from "../src/core/workflow/loader"
import { FakeGitRunner, makeCtx, makeOrchCtx } from "./helpers"

const CID = "wf-status"

afterAll(() => { __setGitRunner(null) })

function freshWt(root: string): string {
  const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = join(root, id, "w")
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), "## 1. G1\n\n- [ ] 1.1 T1\n- [ ] 1.2 T2\n", "utf-8")
  // 与 helpers.setupWorkspace 对齐：非质量门测试默认豁免必做清单门禁（gate 索引置空）
  __setMustDoIndex(EMPTY_MUST_DO_INDEX)
  return wt
}

function readStateSync(wt: string): any {
  const p = join(wt, "openspec", "states", `${CID}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

function writeStateSync(wt: string, s: any): void {
  writeFileSync(join(wt, "openspec", "states", `${CID}.json`), JSON.stringify(s, null, 2))
}

function taskItemOf(s: any): any {
  return s.workItems.find((w: any) => w.id === "task:1")
}

/** 用 opx_agent_submit 把新流推进到 review（verify_tool 步），返回 orchestrator/architect/developer ctx。 */
async function driveToReview(wt: string): Promise<{ o: ReturnType<typeof makeCtx>; a: ReturnType<typeof makeCtx>; d: ReturnType<typeof makeCtx> }> {
  const o = makeOrchCtx(wt)
  const a = makeCtx("openspec-architect", wt)
  const d = makeCtx("openspec-developer", wt)
  await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
  await set_worktree.execute({ change_id: CID }, o)
  await agent_submit.execute(
    {
      change_id: CID, step_id: "analyze", verdict: "passed",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    },
    a
  )
  await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2"] }, d)
  return { o, a, d }
}

/** 把新流推进到 implement step（in_progress），返回 developer ctx。 */
async function driveToImplement(wt: string): Promise<ReturnType<typeof makeCtx>> {
  const o = makeOrchCtx(wt)
  const a = makeCtx("openspec-architect", wt)
  await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
  await set_worktree.execute({ change_id: CID }, o)
  await agent_submit.execute(
    {
      change_id: CID, step_id: "analyze", verdict: "passed",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    },
    a
  )
  return makeCtx("openspec-developer", wt)
}

/** 构造最小 issue child（含归因 metadata），供视图测试直接写入 workItems。 */
function makeIssueChild(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: `issue:${id}`,
    externalId: id,
    source: "openspec",
    type: "issue",
    title: `issue ${id}`,
    description: `issue ${id} 描述`,
    phase: "todo",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: { source_phase: "tool", dimension: "style" },
    children: [],
    labels: [],
    severity: "Low",
    ...overrides,
  }
}

describe("P6-B 新流动态视图", () => {
  test("review 阶段 reviewer-tool → 动态 ✅ 视图：skill 名来自 capability_tags", async () => {
    const root = `/tmp/wf-status-a-${Date.now()}`
    const wt = freshWt(root)
    const fake = new FakeGitRunner()
    // 检查点增量检测下 reviewer-tool 视图会按「检查点→HEAD」变更分流；配置代码变更使该用例走全量分支，
    // 验证既有全量工作视图（skill 清单 / 操作指引）渲染不受影响
    fake.diffNameOnlyDefault = "src/main.ts"
    __setGitRunner(fake)
    await driveToReview(wt)

    const state = readStateSync(wt)
    expect(taskItemOf(state).currentStep).toBe("verify_tool")

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    // instructionBlock 文案保留
    expect(output).toContain("# ✅ 当前轮到你执行")
    expect(output).toContain("**必须**调用 `opx_agent_submit()` 提交")
    // capability_tags [quality-gate, efficiency, api-testing] → 解析出的 skill 名
    expect(output).toContain("## Skill 加载清单")
    expect(output).toContain("`code-efficiency`")
    expect(output).toContain("`api-test`")
    expect(output).toContain("`quality-gate`")
    expect(output).toContain("## 操作指引")
    // 不泄露旧流专属提交工具
    expect(output).not.toContain("opx_tool_review_submit")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("新流 gate：developer 在 review 阶段被门禁，预期角色来自 step.agents", async () => {
    const root = `/tmp/wf-status-b-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const d = makeCtx("openspec-developer", wt)
    const output = await status.execute({ change_id: CID }, d)
    expect(output).toContain("# ⛔ 阶段门禁")
    expect(output).toContain("当前预期角色为：`openspec-reviewer-tool`")
    expect(output).toContain("请立即结束当前会话")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("新流 orchestrator 分派视图：下一步分派子代理", async () => {
    const root = `/tmp/wf-status-c-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const o = makeOrchCtx(wt)
    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("# 编排进度")
    expect(output).toContain("## 下一步")
    expect(output).toContain("分派子代理：`openspec-reviewer-tool`")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("orchestrator 分派视图：rec.agents 为空但当前 step 有 failed 残留 tag → 状态不一致警告（防御出口）", async () => {
    const root = `/tmp/wf-status-h-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    // 构造 verify_quality 聚合态：architecture 维 failed、其余 passed、无 pending → 引擎自愈前的静默死锁态
    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.phase = "review"
    item.currentStep = "verify_quality"
    item.tags = {
      "analyze:openspec-architect": "passed",
      "implement:openspec-developer": "passed",
      "verify_tool:openspec-reviewer-tool": "passed",
      "verify_task:openspec-reviewer-task": "passed",
      "verify_quality:openspec-reviewer-style": "passed",
      "verify_quality:openspec-reviewer-architecture": "failed",
      "verify_quality:openspec-reviewer-performance": "passed",
      "verify_quality:openspec-reviewer-security": "passed",
      "verify_quality:openspec-reviewer-maintainability": "passed",
    }
    writeStateSync(wt, state)

    // 直接构造 rec.agents=[] 的推荐（模拟引擎未自愈时视图兜底），渲染 orchestrator 分派视图
    const workflow = loadWorkflow(readFileSync(join(import.meta.dir, "../assets/workflows/task.yaml"), "utf8"))
    const output = renderWorkflowStatusView(
      item,
      workflow,
      { status: "recommend", stepId: "verify_quality", agents: [] },
      { agent: "primary", orchestrator: true },
      { state, tg: {} }
    )
    expect(output).toContain("⚠️ 状态不一致")
    expect(output).toContain("`openspec-reviewer-architecture`")
    expect(output).toContain("recovery")
    expect(output).toContain("勿盲目回退")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

describe("P6-B 检查点 / 暂停 / 阻塞态", () => {
  test("checkpoint：metadata._checkpoint=true → 检查点文案 + continue/giveup", async () => {
    const root = `/tmp/wf-status-d-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    taskItemOf(state).metadata["_checkpoint"] = true
    writeStateSync(wt, state)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    expect(output).toContain("检查点")
    expect(output).toContain("opx_agent_submit")
    expect(output).toContain("continue / giveup")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("checkpoint：引擎 retry 达上限（recommendForItem status=checkpoint）", async () => {
    const root = `/tmp/wf-status-e-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.metadata["_retryCount"] = 10
    item.children = [{ id: "issue:1", source: "openspec", type: "issue", phase: "todo", suspended: false, currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low" }]
    writeStateSync(wt, state)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    expect(output).toContain("检查点（第 10 轮）")
    expect(output).toContain("opx_agent_submit")
    expect(output).toContain("continue / giveup")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("suspended：暂停状态 + suspend_reason", async () => {
    const root = `/tmp/wf-status-f-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.suspended = true
    item.metadata["suspend_reason"] = "等待外部凭证"
    item.phase = "in_progress"
    item.currentStep = "implement"
    writeStateSync(wt, state)

    const d = makeCtx("openspec-developer", wt)
    const output = await status.execute({ change_id: CID }, d)
    expect(output).toContain("WorkItem 已暂停")
    expect(output).toContain("等待外部凭证")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

describe("M1d 新流视图补齐：children/blockers/边界/摘要/terminal/进度", () => {
  test("implement step developer 视角：children 待修复清单（含 reject_reason/refix_count）", async () => {
    const root = `/tmp/wf-m1d-a-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const d = await driveToImplement(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    expect(item.phase).toBe("in_progress")
    expect(item.currentStep).toBe("implement")
    item.children = [
      makeIssueChild("1", {
        severity: "Medium",
        metadata: { source_phase: "tool", dimension: "style", file: "src/a.ts", line: 3, reject_reason: "修复不完整", refix_count: 2 },
      }),
      makeIssueChild("2", { severity: "Info", description: "Info 级问题" }),
    ]
    writeStateSync(wt, state)

    const output = await status.execute({ change_id: CID }, d)
    expect(output).toContain("# ✅ 当前轮到你执行")
    // 构建验证指引由配置 implement instructions 承载（P2 去双源），developer 视图仍渲染
    expect(output).toContain("提交前按已加载的质量门类 skill 完成本地构建验证并核对覆盖率门禁达标后再提交")
    // 约束区块占位符插值（执行边界信息承载，逗号拼接无反引号）
    expect(output).toContain("## 约束")
    expect(output).toContain("允许变更目录范围：src")
    expect(output).toContain("允许引用包范围：com.t")
    // children 待修复清单
    expect(output).toContain("Issue (待修复 · Low 及以上，必办)")
    expect(output).toContain("issue 1 描述")
    expect(output).toContain("驳回原因：修复不完整")
    expect(output).toContain("修复未过次数：2")
    expect(output).toContain("Issue #1")
    // Info 级单独分栏
    expect(output).toContain("Issue (待修复 · Info，建议修复，不阻塞提交)")
    expect(output).toContain("Info 级问题")
    // 高 refix 区块仅列 issue 清单；5-Why 规则句由配置 implement instructions 承载（P3 去双源）
    expect(output).toContain("修复多次未过的 issue")
    expect(output).toContain("对修复未过次数≥2 的 issue 须先完成 5-Why 根因分析再动手")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_tool 视角：仅 tool 报源 review 态 issue + 待裁定（豁免申请中）", async () => {
    const root = `/tmp/wf-m1d-b-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.children = [
      makeIssueChild("1", { phase: "review", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "architecture", file: "src/b.ts", line: 9 } }),
      makeIssueChild("2", { metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style", exempt_request: { requestedBy: "openspec-developer" }, exempt_reason: "设计如此" } }),
    ]
    writeStateSync(wt, state)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    expect(output).toContain("# ✅ 当前轮到你执行")
    // tool 报源 review 态 issue → 主区块（待复核）
    expect(output).toContain("Issue (待复核)")
    expect(output).toContain("issue 1 描述")
    expect(output).toContain("待复核")
    // 带 exempt_request 标记的 child → 待裁定区块
    expect(output).toContain("Issue (待裁定是否可豁免)")
    // 无标记 review 态 child 不再进入待裁定（新语义仅豁免申请可裁定）——防回归：上一版本旧标题「待裁定 (豁免申请中)」不应出现
    expect(output).not.toContain("待裁定 (豁免申请中)")
    // exempt_request child → 豁免申请中
    expect(output).toContain("issue 2 描述")
    expect(output).toContain("豁免申请中")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_tool 视角：review 态 + exempt_request 待裁定项只进待裁定区块，不进待复核主区块（isAgentOwnedIssue 排除）", async () => {
    const root = `/tmp/wf-m1d-b2-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.children = [
      // 真实 dev 提交 exempt 后的形态：review 态 + exempt_request 标记
      makeIssueChild("1", { phase: "review", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style", exempt_request: { requestedBy: "openspec-developer" } } }),
    ]
    writeStateSync(wt, state)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    expect(output).toContain("# ✅ 当前轮到你执行")
    // 待裁定区块可见待裁定项（reviewer 能看到自己需裁定的豁免申请）
    expect(output).toContain("Issue (待裁定是否可豁免)")
    expect(output).toContain("issue 1 描述")
    expect(output).toContain("豁免申请中")
    // 不进待复核主区块（避免重复展示，也防止被 recheck 自助恢复误列）
    expect(output).not.toContain("Issue (待复核)")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("无豁免申请标记的终态 child 不进入待裁定区块", async () => {
    const root = `/tmp/wf-pending-clean-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.children = [
      makeIssueChild("1", { phase: "cancelled", metadata: { source_phase: "tool", dimension: "architecture", file: "src/b.ts", line: 9 } }),
      makeIssueChild("2", { phase: "review", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style", file: "src/c.ts", line: 3 } }),
    ]
    writeStateSync(wt, state)

    const output = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer-tool", wt))
    // 无豁免申请 → 不渲染待裁定区块（cancelled/todo 无标记均不进入）
    expect(output).not.toContain("Issue (待裁定是否可豁免)")
    // 主区块仅渲染 tool 报源 review 态 issue：review 态 child 2 仍在，cancelled child 1 不再出现
    expect(output).toContain("Issue (待复核)")
    expect(output).toContain("issue 2 描述")
    expect(output).not.toContain("issue 1 描述")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_tool 待裁定区块：仅含调用者可裁（tool 报源）的豁免申请，不含 quality 报源豁免", async () => {
    const root = `/tmp/wf-tool-pending-filter-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.children = [
      makeIssueChild("1", { metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style", exempt_request: { requestedBy: "openspec-developer" } } }),
      makeIssueChild("2", { metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style", exempt_request: { requestedBy: "openspec-developer" } } }),
    ]
    writeStateSync(wt, state)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    // tool 报源豁免 → 待裁定区块
    expect(output).toContain("## Issue (待裁定是否可豁免)")
    expect(output).toContain("issue 1 描述")
    // quality 报源豁免 → 调用者（tool）无权裁定，不进入待裁定区块（todo 态也不进入主区块）
    const pendingIdx = output.indexOf("待裁定是否可豁免")
    expect(pendingIdx).toBeGreaterThan(-1)
    expect(output.slice(pendingIdx)).not.toContain("issue 2 描述")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_quality style 视角：本维度豁免申请进入待裁定区块，非本维度豁免不可见", async () => {
    const root = `/tmp/wf-quality-pending-filter-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.currentStep = "verify_quality"
    item.tags = {
      "analyze:openspec-architect": "passed",
      "implement:openspec-developer": "passed",
      "verify_tool:openspec-reviewer-tool": "passed",
      "verify_task:openspec-reviewer-task": "passed",
    }
    item.children = [
      makeIssueChild("1", { metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style", exempt_request: { requestedBy: "openspec-developer" } } }),
      makeIssueChild("2", { metadata: { source: "openspec-reviewer-architecture", source_phase: "quality", dimension: "architecture", exempt_request: { requestedBy: "openspec-developer" } } }),
    ]
    writeStateSync(wt, state)

    const styleR = makeCtx("openspec-reviewer-style", wt)
    const output = await status.execute({ change_id: CID }, styleR)
    // 本维度（style 报源）豁免 → 待裁定区块
    expect(output).toContain("## Issue (待裁定是否可豁免)")
    expect(output).toContain("issue 1 描述")
    // 非本维度（architecture 报源）豁免 → style reviewer 无权裁定，不进入待裁定区块
    const pendingIdx = output.indexOf("待裁定是否可豁免")
    expect(pendingIdx).toBeGreaterThan(-1)
    expect(output.slice(pendingIdx)).not.toContain("issue 2 描述")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("dev 视图：仅显示 todo 态 issue，不含已交复核（review 态）issue", async () => {
    const root = `/tmp/wf-dev-review-hide-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const d = await driveToImplement(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.children = [
      makeIssueChild("1", { severity: "Medium", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" } }),
      makeIssueChild("2", { phase: "review", severity: "High", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" } }),
    ]
    writeStateSync(wt, state)

    const output = await status.execute({ change_id: CID }, d)
    expect(output).toContain("# ✅ 当前轮到你执行")
    expect(output).toContain("Issue (待修复 · Low 及以上，必办)")
    // todo 态 issue 仍在待修复清单
    expect(output).toContain("issue 1 描述")
    expect(output).toContain("Issue #1")
    // review 态 issue 由对应 reviewer 复核，dev 视图不展示
    expect(output).not.toContain("issue 2 描述")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("reviewer-tool 主区块：不含 task/quality 报源 issue（谁提谁裁定收敛到报源层）", async () => {
    const root = `/tmp/wf-tool-own-only-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.children = [
      makeIssueChild("1", { phase: "review", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" } }),
      makeIssueChild("2", { phase: "review", metadata: { source: "openspec-reviewer-task", source_phase: "task", dimension: "style" } }),
      makeIssueChild("3", { phase: "review", metadata: { source: "openspec-reviewer-architecture", source_phase: "quality", dimension: "architecture" } }),
    ]
    writeStateSync(wt, state)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    expect(output).toContain("# ✅ 当前轮到你执行")
    // 仅 tool 报源 review 态 issue 进入主区块
    expect(output).toContain("Issue (待复核)")
    expect(output).toContain("issue 1 描述")
    expect(output).not.toContain("issue 2 描述")
    expect(output).not.toContain("issue 3 描述")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_quality：主区块不含 tool/task 跨维报源 issue（即使 dimension 指向本维）", async () => {
    const root = `/tmp/wf-quality-no-cross-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.currentStep = "verify_quality"
    item.tags = {
      "analyze:openspec-architect": "passed",
      "implement:openspec-developer": "passed",
      "verify_tool:openspec-reviewer-tool": "passed",
      "verify_task:openspec-reviewer-task": "passed",
    }
    item.children = [
      // tool 层报源、dimension 指向 style：报源层为 tool，style reviewer 无权裁定 → 不展示
      makeIssueChild("1", { phase: "review", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" } }),
      // task 层报源、dimension 指向 style：同上
      makeIssueChild("2", { phase: "review", metadata: { source: "openspec-reviewer-task", source_phase: "task", dimension: "style" } }),
      // 本维 quality 报源 review 态 → 展示
      makeIssueChild("3", { phase: "review", metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style" } }),
    ]
    writeStateSync(wt, state)

    const styleR = makeCtx("openspec-reviewer-style", wt)
    const output = await status.execute({ change_id: CID }, styleR)
    expect(output).toContain("# ✅ 当前轮到你执行")
    expect(output).toContain("## Issue (待复核)")
    // tool/task 跨维报源 issue 不进入主区块
    expect(output).not.toContain("issue 1 描述")
    expect(output).not.toContain("issue 2 描述")
    // 本维报源 issue 正常展示
    expect(output).toContain("issue 3 描述")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("reviewer 主区块：不再显示 todo 态 issue（仅 review 态）", async () => {
    const root = `/tmp/wf-review-no-todo-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.children = [
      makeIssueChild("1", { phase: "todo", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" } }),
      makeIssueChild("2", { phase: "review", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" } }),
    ]
    writeStateSync(wt, state)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    expect(output).toContain("# ✅ 当前轮到你执行")
    expect(output).toContain("## Issue (待复核)")
    // todo 态 issue 不进入 reviewer 主区块（由 dev 修复）
    expect(output).not.toContain("issue 1 描述")
    expect(output).not.toContain("待处理")
    // review 态 issue 正常展示
    expect(output).toContain("issue 2 描述")
    expect(output).toContain("待复核")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_quality style 维度：仅渲染 style 维度 children（其他维度不可见）", async () => {
    const root = `/tmp/wf-m1d-c-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.currentStep = "verify_quality"
    item.tags = {
      "analyze:openspec-architect": "passed",
      "implement:openspec-developer": "passed",
      "verify_tool:openspec-reviewer-tool": "passed",
      "verify_task:openspec-reviewer-task": "passed",
    }
    item.children = [
      makeIssueChild("1", { phase: "review", metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style", file: "src/c.ts", line: 5 } }),
      makeIssueChild("2", { phase: "review", severity: "Critical", metadata: { source: "openspec-reviewer-architecture", source_phase: "quality", dimension: "architecture", file: "src/d.ts", line: 7 } }),
    ]
    writeStateSync(wt, state)

    const styleR = makeCtx("openspec-reviewer-style", wt)
    const output = await status.execute({ change_id: CID }, styleR)
    expect(output).toContain("# ✅ 当前轮到你执行")
    expect(output).toContain("## Issue (待复核)")
    expect(output).toContain("issue 1 描述")
    // architecture 维度 child 不可见（描述与 child id 均不出现）
    expect(output).not.toContain("issue 2 描述")
    expect(output).not.toContain("#2")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_quality 视角：终态（done/cancelled）维度 child 不再出现在 Issue (待复核) 区块", async () => {
    const root = `/tmp/wf-m1d-c-terminal-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.currentStep = "verify_quality"
    item.tags = {
      "analyze:openspec-architect": "passed",
      "implement:openspec-developer": "passed",
      "verify_tool:openspec-reviewer-tool": "passed",
      "verify_task:openspec-reviewer-task": "passed",
    }
    item.children = [
      makeIssueChild("1", { phase: "review", metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style", file: "src/c.ts", line: 5 } }),
      makeIssueChild("2", { phase: "done", metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style", file: "src/d.ts", line: 7 } }),
      makeIssueChild("3", { phase: "cancelled", metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style", file: "src/e.ts", line: 9 } }),
    ]
    writeStateSync(wt, state)

    const styleR = makeCtx("openspec-reviewer-style", wt)
    const output = await status.execute({ change_id: CID }, styleR)
    expect(output).toContain("# ✅ 当前轮到你执行")
    expect(output).toContain("## Issue (待复核)")
    // 非终态维度 child 仍渲染
    expect(output).toContain("issue 1 描述")
    // 终态维度 child 不再出现在本维度区块
    expect(output).not.toContain("issue 2 描述")
    expect(output).not.toContain("issue 3 描述")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_quality：style 与 security reviewer 渲染出不同的 skill 加载清单（agent 级 capability_tags 生效）", async () => {
    const root = `/tmp/wf-agent-caps-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.currentStep = "verify_quality"
    item.tags = {
      "analyze:openspec-architect": "passed",
      "implement:openspec-developer": "passed",
      "verify_tool:openspec-reviewer-tool": "passed",
      "verify_task:openspec-reviewer-task": "passed",
    }
    writeStateSync(wt, state)

    // style 只命中 [style, efficiency] 对应 skill；security 只命中 [security, efficiency] 对应 skill
    const styleOut = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer-style", wt))
    expect(styleOut).toContain("## Skill 加载清单")
    expect(styleOut).toContain("`java-code-style`")
    expect(styleOut).not.toContain("`security-baseline`")

    const secOut = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer-security", wt))
    expect(secOut).toContain("## Skill 加载清单")
    expect(secOut).toContain("`security-baseline`")
    expect(secOut).not.toContain("`java-code-style`")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("implement：developer 视图 skill 加载清单包含五个质量维度的维度规范类 skill（提交前自检依据）", async () => {
    const root = `/tmp/wf-dev-caps-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const d = await driveToImplement(wt)

    const output = await status.execute({ change_id: CID }, d)
    expect(output).toContain("## Skill 加载清单")
    // developer 的 capability_tags 含 style/architecture/performance/security/maintainability
    // → 与 reviewer 同源的维度规范类 skill 进入加载清单
    expect(output).toContain("`java-code-style`")
    expect(output).toContain("`java-ddd-architecture`")
    expect(output).toContain("`java-code-performance`")
    expect(output).toContain("`security-baseline`")
    expect(output).toContain("`java-code-maintainability`")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("analyze step：blockers 渲染（awaiting_user/resolved + 处理指引）", async () => {
    const root = `/tmp/wf-m1d-d-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const o = makeOrchCtx(wt)
    await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
    await set_worktree.execute({ change_id: CID }, o)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.metadata["blockers"] = [
      {
        id: "b1", sourceRole: "openspec-architect", taskId: null, category: "architecture_design",
        description: "接口契约未定", evidence: "E", attemptedActions: "A", options: [],
        status: "awaiting_user", userResponse: null, architectConclusion: null,
      },
      {
        id: "b2", sourceRole: "openspec-architect", taskId: null, category: "architecture_design",
        description: "已解决的 blocker", evidence: "E", attemptedActions: "A", options: [],
        status: "resolved", userResponse: "ok", architectConclusion: "采纳方案",
      },
    ]
    writeStateSync(wt, state)

    const a = makeCtx("openspec-architect", wt)
    const output = await status.execute({ change_id: CID }, a)
    expect(output).toContain("# ✅ 当前轮到你执行")
    // 构建验证句仅对 dev 角色渲染，analyze 视图不得出现（56ddfe9 回归）
    expect(output).not.toContain("构建验证")
    expect(output).toContain("## Blocker")
    expect(output).toContain("接口契约未定")
    expect(output).toContain("⏳ 待用户答复")
    expect(output).toContain("已解决的 blocker")
    expect(output).toContain("✓ 已解决")
    expect(output).toContain("用户答复：ok")
    expect(output).toContain("blocker_updates")
    expect(output).toContain("无法以 passed 提交")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("done 态：待收尾文案；completed_at 已写 → 已完成", async () => {
    const root = `/tmp/wf-m1d-e-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    taskItemOf(state).phase = "done"
    taskItemOf(state).currentStep = null
    writeStateSync(wt, state)

    const o = makeOrchCtx(wt)
    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("任务组已完成，待收尾")
    expect(output).toContain("opx_orch_complete_task_group")
    expect(output).not.toContain("完成时间")

    const state2 = readStateSync(wt)
    taskItemOf(state2).metadata["completed_at"] = new Date().toISOString()
    writeStateSync(wt, state2)
    const output2 = await status.execute({ change_id: CID }, o)
    expect(output2).toContain("任务组已完成")
    expect(output2).toContain("编排已完成并收尾")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("cancelled 态：渲染已取消", async () => {
    const root = `/tmp/wf-m1d-e2-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    taskItemOf(state).phase = "cancelled"
    taskItemOf(state).currentStep = null
    writeStateSync(wt, state)

    const o = makeOrchCtx(wt)
    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("任务组已取消")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("orchestrator：阶段进展/审核进度统计（tags 汇总 + children 统计）", async () => {
    const root = `/tmp/wf-m1d-f-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.children = [
      makeIssueChild("1", { phase: "todo", severity: "Medium" }),
      makeIssueChild("2", { phase: "review", severity: "High" }),
      makeIssueChild("3", { phase: "done", severity: "Low" }),
      makeIssueChild("4", { phase: "cancelled", severity: "Low" }),
    ]
    writeStateSync(wt, state)

    const o = makeOrchCtx(wt)
    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("# 编排进度")
    expect(output).toContain("## 阶段进展 / 审核进度")
    // tags 汇总：analyze/implement passed，verify_tool pending
    expect(output).toContain("| `analyze` | `openspec-architect` | passed |")
    expect(output).toContain("| `implement` | `openspec-developer` | passed |")
    expect(output).toContain("| `verify_tool` | `openspec-reviewer-tool` | pending |")
    // children 统计（review 态计为待复核）
    expect(output).toContain("待处理 1 · 待复核 1 · 已验证 1 · 已豁免 1")
    // 下一步分派
    expect(output).toContain("## 下一步")
    expect(output).toContain("分派子代理：`openspec-reviewer-tool`")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("会话摘要：metadata.agent_summaries 按角色隔离渲染（409c411）", async () => {
    const root = `/tmp/wf-m1d-g-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const d = await driveToImplement(wt)

    const state = readStateSync(wt)
    taskItemOf(state).metadata["agent_summaries"] = {
      "openspec-architect": "预检通过，已输出执行边界",
      "openspec-developer": "完成 task 2 个",
    }
    writeStateSync(wt, state)

    // dev 视角：只渲染 dev 自己的摘要，不跨 agent 传递 architect 摘要
    const output = await status.execute({ change_id: CID }, d)
    expect(output).toContain("## 上轮会话摘要")
    expect(output).toContain("**openspec-developer**：完成 task 2 个")
    expect(output).not.toContain("预检通过，已输出执行边界")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_tool blocked 视图：本层待复核 issue 清单 + recheck_adjudications 自助恢复指引", async () => {
    const root = `/tmp/wf-status-rcheck-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)

    // verify_tool 已 passed 但 tool 层 review 态 blocking issue 未复核 → stepCanPass false → blocked
    const state = readStateSync(wt)
    const item = taskItemOf(state)
    item.tags["verify_tool:openspec-reviewer-tool"] = "passed"
    item.children.push(makeIssueChild("9", { phase: "review", metadata: { source_phase: "tool", dimension: "style" } }))
    writeStateSync(wt, state)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const output = await status.execute({ change_id: CID }, toolR)
    expect(output).toContain("# ⛔ 当前 step 阻塞中，等待编排处理")
    expect(output).toContain("本层待复核 issue")
    expect(output).toContain("Issue #9")
    expect(output).toContain("recheck_adjudications")
    expect(output).toContain("自助恢复")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("verify_quality blocked 视图按报源维度过滤：非报源维度 reviewer 不展示其他维度待复核 issue", async () => {
    const root = `/tmp/wf-status-rcheck-dim-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    await driveToReview(wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)
    await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, toolR)
    await agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2"] }, taskR)
    expect(taskItemOf(readStateSync(wt)).currentStep).toBe("verify_quality")

    // verify_quality 5 维全 passed + style 报源维度 review 态 blocking issue → blocked
    const state = readStateSync(wt)
    const item = taskItemOf(state)
    for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
      item.tags[`verify_quality:openspec-reviewer-${d}`] = "passed"
    }
    item.children.push(makeIssueChild("9", { phase: "review", metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style" } }))
    writeStateSync(wt, state)

    // 非报源维度 reviewer（architecture）→ 不展示 style 报源维度待复核 issue（避免照指引补交后被谁提谁裁定拒绝）
    const archView = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer-architecture", wt))
    expect(archView).toContain("# ⛔ 当前 step 阻塞中，等待编排处理")
    expect(archView).not.toContain("Issue #9")
    expect(archView).not.toContain("recheck_adjudications")
    // 报源维度 reviewer（style）→ 展示待复核清单与自助恢复指引
    const styleView = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer-style", wt))
    expect(styleView).toContain("本层待复核 issue")
    expect(styleView).toContain("Issue #9")
    expect(styleView).toContain("recheck_adjudications")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})
