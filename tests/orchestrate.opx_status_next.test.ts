/**
 * 验证编排 agent 通过 opx_status 能否正确获取到下一环节指引（新流 renderWorkflowStatusView）。
 *
 * 10 个场景，每个驱动状态推进到节点后调 opx_status(ctx) 断言渲染内容：
 * S1  未初始化 → 提示
 * S2  analyze → architect ✅ 视图 + skill 名
 * S3  implement → developer ✅ 视图
 * S4  verify_tool → reviewer-tool ✅ 视图 + skill 名
 * S5  verify_task → reviewer-task ✅ 视图
 * S6  verify_quality → style 维度 ✅ 视图
 * S7  门禁：developer 在 review 阶段被门禁
 * S8  orchestrator 分派视图：verify_quality 5 维并排分派
 * S9  检查点 → opx_agent_submit({checkpoint_decision}) 指引
 * S10 负断言：非检查点态不含 checkpoint_decision / gate 视图不含提交指引
 */
import { describe, expect, test, afterAll } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"

import { __setGitRunner } from "../src/core/git"
import { status } from "../src/adapters/opencode/tools"
import { FakeGitRunner, setupWithFakeGit, teardown, makeCtx } from "./helpers"
import {
  setupToAnalyze, driveToImplement, driveToVerifyTool,
  driveToVerifyTask, driveToQuality, readItem,
} from "./helpers-workflow"

const CID = "test-orch-next"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string } {
  const root = `/tmp/osn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree } = setupWithFakeGit(root, CID)
  __setGitRunner(new FakeGitRunner())
  return { wt: worktree, root }
}

/** 直接改写 state（注入检查点标记等）。 */
function mutateState(wt: string, fn: (item: any) => void): void {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  fn(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

// ═══════════════════════════════════════════════════
//  场景 1: 未初始化 → 提示
// ═══════════════════════════════════════════════════

describe("S1: 未初始化", () => {
  test("status 输出提示未初始化", async () => {
    const { wt, root } = fresh()
    try {
      // 不调 init，直接查 status
      const out = await status.execute({ change_id: CID }, makeCtx("openspec-orchestrator", wt))
      expect(out).toContain("尚未初始化")
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 2: analyze step → architect ✅ 视图
// ═══════════════════════════════════════════════════

describe("S2: analyze step", () => {
  test("architect 视角输出 ✅ 视图 + skill 名", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.arch)
      expect(out).toContain("# ✅ 当前轮到你执行")
      expect(out).toContain("**必须**调用 `opx_agent_submit()` 提交")
      expect(out).toContain("## Skill 加载清单")
      expect(out).toContain("## 操作指引")
      expect(out).toContain(`opx_agent_submit({ step_id: "analyze"`)
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 3: implement step → developer ✅ 视图
// ═══════════════════════════════════════════════════

describe("S3: implement step", () => {
  test("developer 视角输出 ✅ 视图 + 提交指引", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.dev)
      expect(out).toContain("# ✅ 当前轮到你执行")
      expect(out).toContain("**阶段**: in_progress | **step**: `implement`")
      expect(out).toContain(`opx_agent_submit({ step_id: "implement", verdict: "passed" })`)
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 4: verify_tool step → reviewer-tool ✅ 视图 + skill 名
// ═══════════════════════════════════════════════════

describe("S4: verify_tool step", () => {
  test("reviewer-tool 视角输出 ✅ 视图 + skill 名（quality-gate/code-efficiency/api-test）", async () => {
    const { wt, root } = fresh()
    try {
      // 检查点增量检测下 reviewer-tool 视图会按「检查点→HEAD」变更分流；配置代码变更使该用例走全量分支
      const fake = new FakeGitRunner()
      fake.diffNameOnlyDefault = "src/main.ts"
      __setGitRunner(fake)
      const { ctx } = await driveToVerifyTool(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.toolR)
      expect(out).toContain("# ✅ 当前轮到你执行")
      expect(out).toContain("## Skill 加载清单")
      expect(out).toContain("`code-efficiency`")
      expect(out).toContain("`api-test`")
      expect(out).toContain("`quality-gate`")
      expect(out).toContain(`opx_agent_submit({ step_id: "verify_tool"`)
      // 不泄露旧流专属提交工具
      expect(out).not.toContain("opx_tool_review_submit")
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 5: verify_task step → reviewer-task ✅ 视图
// ═══════════════════════════════════════════════════

describe("S5: verify_task step", () => {
  test("reviewer-task 视角输出 ✅ 视图", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTask(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.taskR)
      expect(out).toContain("# ✅ 当前轮到你执行")
      expect(out).toContain("**阶段**: review | **step**: `verify_task`")
      expect(out).toContain(`opx_agent_submit({ step_id: "verify_task"`)
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 6: verify_quality step → style 维度 ✅ 视图
// ═══════════════════════════════════════════════════

describe("S6: verify_quality step", () => {
  test("style 维度 reviewer 视角输出 ✅ 视图", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.dims["style"] as any)
      expect(out).toContain("# ✅ 当前轮到你执行")
      expect(out).toContain("**阶段**: review | **step**: `verify_quality`")
      expect(out).toContain(`opx_agent_submit({ step_id: "verify_quality"`)
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 7: 门禁——developer 在 review 阶段被拦截
// ═══════════════════════════════════════════════════

describe("S7: 门禁", () => {
  test("developer 在 verify_tool 阶段被门禁，预期角色来自 step.agents", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.dev)
      expect(out).toContain("# ⛔ 阶段门禁")
      expect(out).toContain("当前预期角色为：`openspec-reviewer-tool`")
      expect(out).toContain("请立即结束当前会话")
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 8: orchestrator 分派视图——verify_quality 5 维并排分派
// ═══════════════════════════════════════════════════

describe("S8: orchestrator 分派视图", () => {
  test("verify_quality 阶段 → 5 维 quality reviewer 并排分派", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain("# 编排进度")
      expect(out).toContain("## 下一步")
      expect(out).toContain("分派子代理：`openspec-reviewer-style`")
      expect(out).toContain("`openspec-reviewer-architecture`")
      expect(out).toContain("`openspec-reviewer-performance`")
      expect(out).toContain("`openspec-reviewer-security`")
      expect(out).toContain("`openspec-reviewer-maintainability`")
      expect(out).toContain("并排分派")
    } finally { teardown(root) }
  })

  test("空返回登记后（pending + resume_sessions）视图输出 task_id 复用提示；无记录不输出", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // 未登记：不输出续派提示（默认无记录）
      const out0 = await status.execute({ change_id: CID }, ctx.orch)
      expect(out0).not.toContain("task_id=")
      expect(out0).not.toContain("未返回结果")
      // 登记一个仍待分派（pending）维度的会话 → 视图提示复用 task_id 续派
      await status.execute(
        { change_id: CID, resume_sessions: [{ agent: "openspec-reviewer-style", session_id: "sess-abc" }] },
        ctx.orch
      )
      const out = await status.execute({ change_id: CID }, ctx.orch)
      expect(out).toContain(`task_id="sess-abc"`)
      expect(out).toContain("复用会话提醒继续执行")
      expect(out).toContain("勿全新重派")
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 9: 检查点 → opx_agent_submit({checkpoint_decision}) 指引
// ═══════════════════════════════════════════════════

describe("S9: 检查点", () => {
  test("metadata._checkpoint → 检查点文案 + continue/giveup 决策指引", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      mutateState(wt, (item) => {
        item.metadata["_retryCount"] = 5
        item.metadata["_checkpoint"] = true
      })
      const out = await status.execute({ change_id: CID }, ctx.toolR)
      expect(out).toContain("检查点")
      expect(out).toContain("opx_agent_submit")
      expect(out).toContain("checkpoint_decision")
      expect(out).toContain("continue / giveup")
    } finally { teardown(root) }
  })
})

// ═══════════════════════════════════════════════════
//  场景 10: 负断言
// ═══════════════════════════════════════════════════

describe("S10: 负断言", () => {
  test("非检查点态（正常 verify_tool）不含 checkpoint_decision 决策指引", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.toolR)
      expect(out).toContain("# ✅ 当前轮到你执行")
      expect(out).not.toContain("checkpoint_decision")
      expect(out).not.toContain("continue / giveup")
    } finally { teardown(root) }
  })

  test("gate 视图不含提交指引（未轮到该 agent 执行）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const out = await status.execute({ change_id: CID }, ctx.dev)
      expect(out).toContain("# ⛔ 阶段门禁")
      expect(out).not.toContain("opx_agent_submit(")
      expect(out).not.toContain("## Skill 加载清单")
    } finally { teardown(root) }
  })
})
