/**
 * 参数有效性校验测试（改进项 A/B/C：非法输入入口显式拒绝，不静默写坏状态）
 *
 * A. recovery 值域校验：非法 phase、非法 review_layer、string 形态 recovery 解析非对象、对象形态 phase 缺失
 * B. git 分支名校验：init base_branch 基本检查（非空 + 无空白）、set_worktree branch_name git check-ref-format
 * C. agent_submit 无效 id / 空字段校验：fixed/exempt 未命中 child 显式拒绝、new_children 空 id/title/description 拒绝
 */
import { describe, expect, test, afterAll } from "bun:test"
import { writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, set_worktree, agent_submit } from "../src/adapters/opencode/tools"
import { agentSubmitSchema } from "../src/adapters/opencode/schemas"
import { FakeGitRunner, setupWithFakeGit, teardown } from "./helpers"
import { setupToAnalyze, driveToImplement, driveToVerifyTool, driveToVerifyTask, driveToQuality, taskIdsOf, readItem } from "./helpers-workflow"

const CID = "param-validation"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/pv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

async function expectError(p: Promise<unknown>, pattern: RegExp): Promise<Error> {
  const err = await p.catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toMatch(pattern)
  return err
}

describe("A. recovery 值域校验", () => {
  test("非法 phase → 抛错并列出合法值", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const err = await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "bogus" } } as any, ctx.orch),
        /recovery.phase 不合法[\s\S]*task_analysis、dev_impl、review/
      )
      expect(err.message).toContain("bogus")
    } finally { teardown(root) }
  })

  test("对象形态 phase 缺失（undefined）→ 拒绝", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: {} } as any, ctx.orch),
        /recovery.phase 不合法/
      )
    } finally { teardown(root) }
  })

  test("非法 review_layer → 抛错并列出合法值", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "docs" } } as any, ctx.orch),
        /recovery.review_layer 不合法[\s\S]*tool、task、quality/
      )
    } finally { teardown(root) }
  })

  test("string 形态 recovery JSON.parse 结果为非对象（null/数字/数组）→ 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: "null" } as any, ctx.orch),
        /recovery 参数解析失败/
      )
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: "42" } as any, ctx.orch),
        /recovery 参数解析失败/
      )
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: "[1]" } as any, ctx.orch),
        /recovery 参数解析失败/
      )
    } finally { teardown(root) }
  })

  test("string 形态 recovery 合法 JSON 对象 → 正常走值域校验并恢复", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: '{"phase":"dev_impl"}' } as any, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("string 形态 recovery 解析出非法 phase → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", recovery: '{"phase":"bogus"}' } as any, ctx.orch),
        /recovery.phase 不合法/
      )
    } finally { teardown(root) }
  })
})

describe("B. git 分支名校验", () => {
  test("init base_branch 含空白 → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        init.execute({ change_id: CID, task_group_id: "1", base_branch: "my branch" } as any, ctx.orch),
        /base_branch 不合法/
      )
    } finally { teardown(root) }
  })

  test("set_worktree branch_name 含空格/非法字符 → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        set_worktree.execute({ change_id: CID, branch_name: "bad branch" }, ctx.orch),
        /分支名 "bad branch" 不合法/
      )
      await expectError(
        set_worktree.execute({ change_id: CID, branch_name: "feature/..x" }, ctx.orch),
        /分支名 "feature\/\.\.x" 不合法/
      )
    } finally { teardown(root) }
  })

  test("set_worktree branch_name 前导 dash → 抛错（--branch 形态拦截）", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        set_worktree.execute({ change_id: CID, branch_name: "-foo" }, ctx.orch),
        /分支名 "-foo" 不合法/
      )
    } finally { teardown(root) }
  })

  test("set_worktree branch_name 任一组件以 .lock 结尾 → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        set_worktree.execute({ change_id: CID, branch_name: "foo/bar.lock" }, ctx.orch),
        /分支名 "foo\/bar\.lock" 不合法/
      )
      await expectError(
        set_worktree.execute({ change_id: CID, branch_name: "foo.lock" }, ctx.orch),
        /分支名 "foo\.lock" 不合法/
      )
    } finally { teardown(root) }
  })

  test("set_worktree branch_name 含控制字符 → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await expectError(
        set_worktree.execute({ change_id: CID, branch_name: "foo\u0001bar" }, ctx.orch),
        /分支名 "foo\x01bar" 不合法/
      )
    } finally { teardown(root) }
  })

  test("set_worktree 合法 branch_name → 正常创建", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const r = await set_worktree.execute({ change_id: CID, branch_name: "feature/valid-name" }, ctx.orch)
      expect(r).toContain("feature/valid-name")
    } finally { teardown(root) }
  })

  test("set_worktree 不传 branch_name → 缺省自动生成", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const r = await set_worktree.execute({ change_id: CID }, ctx.orch)
      expect(r).toContain(`task-group/${CID}/1`)
    } finally { teardown(root) }
  })
})

describe("C. agent_submit 无效 id / 空字段校验", () => {
  test("schema 层：new_children 不再暴露 source_phase 参数（归因层由报源 agent 自动推导）", () => {
    const arr = agentSubmitSchema.shape["new_children"]
    const elem = arr.unwrap ? arr.unwrap().element : arr.element
    const keys = Object.keys(elem.shape ?? {})
    expect(keys).toContain("dimension")
    expect(keys).not.toContain("source_phase")
  })

  test("dev fixed_issue_ids 未命中 child → 抛错并列出可用 id", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await expectError(
        agent_submit.execute(
          {
            change_id: CID, step_id: "implement", verdict: "passed",
            fixed_issue_ids: ["nonexistent"], completed_task_ids: taskIdsOf(readItem(wt, CID)),
          },
          ctx.dev
        ),
        /fixed_issue_ids 中包含无效 issue id: "nonexistent"[\s\S]*可用 issue ID/
      )
    } finally { teardown(root) }
  })

  test("dev exempt_issue_ids 未命中 child → 抛错并列出可用 id", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await expectError(
        agent_submit.execute(
          {
            change_id: CID, step_id: "implement", verdict: "passed",
            exempt_issue_ids: ["ghost"], completed_task_ids: taskIdsOf(readItem(wt, CID)),
          },
          ctx.dev
        ),
        /exempt_issue_ids 中包含无效 issue id: "ghost"[\s\S]*可用 issue ID/
      )
    } finally { teardown(root) }
  })

  test("new_children 空 id → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_tool", verdict: "failed", new_children: [{ id: "", title: "t", description: "d", severity: "Low" }] },
          ctx.toolR
        ),
        /issue id 不能为空/
      )
    } finally { teardown(root) }
  })

  test("new_children 空 title → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_tool", verdict: "failed", new_children: [{ id: "7", title: "  ", description: "d", severity: "Low" }] },
          ctx.toolR
        ),
        /title 不能为空/
      )
    } finally { teardown(root) }
  })

  test("new_children 空 description → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_tool", verdict: "failed", new_children: [{ id: "7", title: "t", description: " ", severity: "Low" }] },
          ctx.toolR
        ),
        /description 不能为空/
      )
    } finally { teardown(root) }
  })

  test("new_children dimension 非法值 → 抛错并列出合法维度", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_tool", verdict: "failed", new_children: [{ id: "7", title: "t", description: "d", severity: "Low", dimension: "bogus" }] },
          ctx.toolR
        ),
        /dimension 非法[\s\S]*合法维度.*style.*architecture.*performance.*security.*maintainability/
      )
      // state 零变更：非法 dimension 校验在入库前，不产生任何 child
      expect(readItem(wt, CID).children.filter((c: any) => c.externalId === "7")).toHaveLength(0)
    } finally { teardown(root) }
  })

  test("new_children dimension 合法值正常入库（tool reviewer 显式声明）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [
            { id: "7", title: "安全", description: "d", severity: "Low", dimension: "security" },
            { id: "8", title: "风格", description: "d", severity: "Info", dimension: "style" },
          ],
        },
        ctx.toolR
      )
      const children = readItem(wt, CID).children
      expect(children.find((c: any) => c.externalId === "7").metadata["dimension"]).toBe("security")
      expect(children.find((c: any) => c.externalId === "8").metadata["dimension"]).toBe("style")
    } finally { teardown(root) }
  })

  test("tool reviewer 报 issue 缺 dimension → 抛错且零状态变更", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_tool", verdict: "failed", new_children: [{ id: "7", title: "t", description: "d", severity: "Low" }] },
          ctx.toolR
        ),
        /未声明归因维度 dimension/
      )
      // state 零变更：dimension 校验在入库前，不产生任何 child
      expect(readItem(wt, CID).children.filter((c: any) => c.externalId === "7")).toHaveLength(0)
    } finally { teardown(root) }
  })

  test("task reviewer 报 issue 缺 dimension → 抛错且零状态变更", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTask(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_task", verdict: "failed", new_children: [{ id: "7", title: "t", description: "d", severity: "Low" }] },
          ctx.taskR
        ),
        /未声明归因维度 dimension/
      )
      expect(readItem(wt, CID).children.filter((c: any) => c.externalId === "7")).toHaveLength(0)
    } finally { teardown(root) }
  })

  test("quality reviewer 报 issue 显式 dimension 与报源不一致 → 抛错且零状态变更", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_quality", verdict: "failed", new_children: [{ id: "7", title: "安全洞", description: "d", severity: "High", dimension: "security" }] },
          ctx.dims["style"]
        ),
        /与报源维度 "style" 不一致/
      )
      // state 零变更：维度校验在写入 tag / child 之前，不产生任何 child，style 维未写 tag
      expect(readItem(wt, CID).children.filter((c: any) => c.externalId === "7")).toHaveLength(0)
      expect(readItem(wt, CID).tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("quality reviewer 报 issue 不传 dimension → 由报源推断写入", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "failed", new_children: [{ id: "7", title: "风格遗留", description: "d", severity: "Low" }] },
        ctx.dims["style"]
      )
      const child = readItem(wt, CID).children.find((c: any) => c.externalId === "7")
      expect(child.metadata["dimension"]).toBe("style")
      expect(child.metadata["source"]).toBe("openspec-reviewer-style")
    } finally { teardown(root) }
  })

  test("回归：带 # 前缀的合法 fixed_issue_ids 仍正常（归一化后命中）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(readFileSync(p, "utf-8"))
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.children.push({
        id: "issue:99",
        source: "openspec",
        externalId: "99",
        type: "issue",
        title: "注入",
        description: "描述",
        phase: "todo",
        suspended: false,
        currentStep: null,
        tags: {},
        metadata: { source_phase: "tool", dimension: "style" },
        children: [],
        labels: [],
        severity: "Low",
      })
      writeFileSync(p, JSON.stringify(state, null, 2))

      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed",
          fixed_issue_ids: ["#99"], completed_task_ids: taskIdsOf(readItem(wt, CID)),
        },
        ctx.dev
      )
      expect(readItem(wt, CID).children.find((c: any) => c.externalId === "99").phase).toBe("review")
    } finally { teardown(root) }
  })
})
