/**
 * 引擎状态视图测试：gate / checkpoint / terminal / blocked / blocked_agent / 终态 / worktree_not_ready /
 * dispatch_* / orchestrator_blockers 均回退为代码内硬编码文案（views 块已删除，不再走模板插值）。
 *
 * 覆盖：
 * 1. loader：views / agents 字段不再被识别（解析 undefined，不抛错）
 * 2. gate：硬编码门禁文案（含动态值）
 * 3. checkpoint / terminal：硬编码文案
 * 4. blocked：轮次 agent 用 blocked_agent 文案，非轮次 agent 用 blocked 文案
 * 5. 终态：done（已完成/待收尾）/ cancelled
 * 6. worktree_not_ready：未就绪拒绝执行
 * 7. orchestrator 分派视图：推进阻塞 / 主仓库污染 / 分派子代理 / 状态不一致
 * 8. orchestrator blocker 汇总
 */
import { describe, expect, test } from "bun:test"

import { loadWorkflow } from "../src/core/workflow/loader"
import { renderWorkflowStatusView } from "../src/core/workflow/status"

// ─── 基建 ───

function makeItem(overrides: Record<string, unknown> = {}): any {
  return {
    id: "task:1",
    source: "openspec",
    type: "task",
    title: "t",
    description: "d",
    phase: "todo",
    suspended: false,
    currentStep: "analyze",
    tags: {},
    metadata: {},
    children: [],
    labels: [],
    ...overrides,
  }
}

const BASE_YAML = `
id: x
name: X
max_retries: 1
phases:
  - name: todo
    steps:
      - id: analyze
        agents:
          - id: architect
            capability_tags: [architecture]
        transitions:
          on_pass: implement
          on_fail: analyze
  - name: in_progress
    steps:
      - id: implement
        agents:
          - id: developer
            capability_tags: [efficiency]
        transitions:
          on_pass: verify
          on_fail: analyze
  - name: review
    steps:
      - id: verify
        agents:
          - id: reviewer
            capability_tags: [quality-gate]
        transitions:
          on_pass: done
          on_fail: implement
`

function render(item: any, workflow: ReturnType<typeof loadWorkflow>, rec: any, agent: string, opts: any = {}): string {
  const state = {
    changeId: "cid", isolationNamespace: "ns", taskGroupId: "1", baseBranch: "main",
    workItems: [item], createdAt: "", updatedAt: "",
  }
  const tg = { worktreePath: "/wt", branchName: "b", baseRef: "base", ...(opts.tg ?? {}) }
  return renderWorkflowStatusView(item, workflow, rec, agent, { state, tg, ...opts } as any)
}

// ═══════════════════════════════════════════════════
//  1. loader：views / agents 不再被识别
// ═══════════════════════════════════════════════════

describe("loader：views / agents 字段不再识别", () => {
  test("普通 workflow 不含 views / agents 字段", () => {
    const wf = loadWorkflow(BASE_YAML)
    expect(wf.views).toBeUndefined()
    expect(wf.agents).toBeUndefined()
  })

  test("YAML 中仍写 views / agents 块 → 不再解析（静默忽略，不抛错）", () => {
    const wf = loadWorkflow(`
${BASE_YAML}
views:
  gate: "GATE {{phase}}"
agents:
  developer:
    role: 开发
`)
    expect(wf.views).toBeUndefined()
    expect(wf.agents).toBeUndefined()
    // 引擎状态文案仍走代码硬编码，不读 views 块
    const item = makeItem({ phase: "review", currentStep: "verify" })
    const out = render(item, wf, { status: "recommend", stepId: "verify", agents: ["reviewer"] }, "developer")
    expect(out).toContain("# ⛔ 阶段门禁")
    expect(out).not.toContain("GATE")
  })
})

// ═══════════════════════════════════════════════════
//  2. gate / checkpoint / terminal 硬编码
// ═══════════════════════════════════════════════════

describe("引擎状态视图：gate / checkpoint / terminal 硬编码", () => {
  test("gate 硬编码门禁文案（含动态值）", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "review", currentStep: "verify" })
    const out = render(item, wf, { status: "recommend", stepId: "verify", agents: ["reviewer"] }, "developer")
    expect(out).toContain("# ⛔ 阶段门禁")
    expect(out).toContain("当前阶段为 **review**（step `verify`），未轮到你（**developer**）执行。")
    expect(out).toContain("当前预期角色为：`reviewer`")
  })

  test("checkpoint 硬编码（round / step_id 插值）", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "review", currentStep: "verify", metadata: { _checkpoint: true } })
    const out = render(item, wf, { status: "checkpoint", stepId: "verify", checkpoint: { retryCount: 3 } }, "reviewer")
    expect(out).toContain("检查点（第 3 轮）")
    expect(out).toContain('step_id: "verify"')
    expect(out).toContain("continue / giveup")
  })

  test("terminal 硬编码（message 缺省回退）", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "review", currentStep: "verify" })
    const out = render(item, wf, { status: "terminal", stepId: "verify", agents: [] }, "reviewer")
    expect(out).toContain("# 🏁 当前 step 已通过")
    expect(out).toContain("沿 transitions.on_pass 推进")
  })
})

// ═══════════════════════════════════════════════════
//  3. blocked / blocked_agent
// ═══════════════════════════════════════════════════

describe("blocked：轮次 agent 用 blocked_agent，非轮次 agent 用 blocked", () => {
  test("非轮次 agent → 通用 blocked 文案", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "review", currentStep: "verify" })
    const out = render(item, wf, { status: "blocked", stepId: "verify", agents: [], blockedReason: "门禁拦截" }, "someone")
    expect(out).toContain("# ⛔ 当前无法推进（blocked）")
    expect(out).toContain("**原因**: 门禁拦截")
  })

  test("轮次 agent → blocked_agent 文案", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "review", currentStep: "verify" })
    const out = render(item, wf, { status: "blocked", stepId: "verify", agents: [], blockedReason: "门禁拦截" }, "reviewer")
    expect(out).toContain("# ⛔ 当前 step 阻塞中，等待编排处理")
    expect(out).toContain("等待编排者解除阻塞")
  })
})

// ═══════════════════════════════════════════════════
//  4. 终态 + worktree_not_ready
// ═══════════════════════════════════════════════════

describe("终态与 worktree 未就绪硬编码", () => {
  test("done（已完成 / 待收尾）与 cancelled", () => {
    const wf = loadWorkflow(BASE_YAML)
    const done = render(makeItem({ phase: "done", currentStep: null, metadata: { completed_at: "2026-01-01" } }), wf, {}, "openspec-orchestrator")
    expect(done).toContain("# ✅ 任务组已完成")
    expect(done).toContain("**完成时间**: 2026-01-01")

    const pending = render(makeItem({ phase: "done", currentStep: null }), wf, {}, "openspec-orchestrator")
    expect(pending).toContain("任务组已完成，待收尾")
    expect(pending).toContain("opx_orch_complete_task_group")
    expect(pending).not.toContain("完成时间")

    const cancelled = render(makeItem({ phase: "cancelled", currentStep: null }), wf, {}, "openspec-orchestrator")
    expect(cancelled).toContain("任务组已取消")
  })

  test("worktree_not_ready：未就绪拒绝执行", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    const out = render(item, wf, { status: "recommend", stepId: "implement", agents: ["developer"] }, "developer", { tg: { worktreePath: "" } })
    expect(out).toContain("# ⛔ worktree 未就绪，当前拒绝执行")
    expect(out).toContain("opx_orch_set_worktree")
    expect(out).not.toContain("# ✅ 当前轮到你执行")
  })
})

// ═══════════════════════════════════════════════════
//  5. orchestrator 分派视图
// ═══════════════════════════════════════════════════

describe("orchestrator 分派视图硬编码", () => {
  test("推进阻塞 + 分派子代理（多子代理行）+ 状态不一致", () => {
    const wf = loadWorkflow(BASE_YAML)
    // 推进阻塞 + 分派子代理
    const item = makeItem({ phase: "review", currentStep: "verify", metadata: { _advance_block_reason: "原因A" } })
    const out = render(item, wf, { status: "recommend", stepId: "verify", agents: ["reviewer", "other"] }, "openspec-orchestrator")
    expect(out).toContain("**推进阻塞**: 原因A")
    expect(out).toContain("分派子代理：`reviewer`、`other`。")
    expect(out).toContain("多子代理相互独立")

    // 状态不一致：rec.agents 空 + failed 残留 tag
    const item2 = makeItem({ phase: "review", currentStep: "verify", tags: { "verify:reviewer": "failed" } })
    const out2 = render(item2, wf, { status: "recommend", stepId: "verify", agents: [] }, "openspec-orchestrator")
    expect(out2).toContain("⚠️ 状态不一致")
    expect(out2).toContain("失败维度：`reviewer`")
  })

  test("主仓库污染渲染", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "review", currentStep: "verify" })
    const out = render(
      item, wf,
      { status: "recommend", stepId: "verify", agents: ["reviewer"] },
      "openspec-orchestrator",
      { mainPollution: { repoRoot: "/repo", files: ["a.md", "b.md"] } },
    )
    expect(out).toContain("## ⚠️ 主仓库 openspec 污染")
    expect(out).toContain("检测到主仓库 `/repo` 下 openspec 文档存在未提交变更")
    expect(out).toContain("- `a.md`")
    expect(out).toContain("- `b.md`")
  })

  test("orchestrator blocker 汇总（含状态）", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({
      phase: "review", currentStep: "verify",
      metadata: {
        blockers: [
          { id: "b1", sourceRole: "architect", taskId: null, category: "cat", description: "d1", status: "resolved", userResponse: "ok" },
          { id: "b2", sourceRole: "developer", taskId: "1", category: "cat2", description: "d2", status: "awaiting_user", userResponse: null },
        ],
      },
    })
    const out = render(item, wf, { status: "recommend", stepId: "verify", agents: ["reviewer"] }, "openspec-orchestrator")
    expect(out).toContain("## Blocker")
    expect(out).toContain("- Blocker #b1 | ✓ 已解决 | cat")
    expect(out).toContain("- Blocker #b2 | ⏳ 待处理 | cat2")
    expect(out).toContain("用户答复：ok")
    expect(out).toContain("Task #1")
  })

  test("分派前置：worktree 未就绪时不给出分派指令", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "review", currentStep: "verify" })
    const out = render(item, wf, { status: "recommend", stepId: "verify", agents: ["reviewer"] }, "openspec-orchestrator", { tg: { worktreePath: "" } })
    expect(out).toContain("分派前置条件未满足")
    expect(out).not.toContain("分派子代理：")
  })
})

// ═══════════════════════════════════════════════════════════════
//  6. 执行视图：baseRef 为空时省略「变更范围」指引（status.ts:389-391 分支）
// ═══════════════════════════════════════════════════════════════

describe("执行视图：baseRef 分支控制「变更范围」指引", () => {
  test("tg.baseRef 为空/undefined → 不含变更范围文案；有 baseRef → 包含", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    const rec = { status: "recommend", stepId: "implement", agents: ["developer"] } as any
    // baseRef undefined → status.ts:389 `if (tg.worktreePath && tg.baseRef)` 分支省略该指引步骤
    const noBase = render(item, wf, rec, "developer", { tg: { worktreePath: "/wt", baseRef: undefined } })
    expect(noBase).toContain("# ✅ 当前轮到你执行")
    expect(noBase).not.toContain("变更范围")
    // baseRef 有值 → 指引步骤与 Worktree 区块变更范围命令均渲染
    const withBase = render(item, wf, rec, "developer")
    expect(withBase).toContain("变更范围")
    expect(withBase).toContain("diff --name-only")
  })
})
