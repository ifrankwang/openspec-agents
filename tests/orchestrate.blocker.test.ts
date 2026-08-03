/**
 * blocker 生命周期测试（新流）：metadata.blockers + agent_submit 的 blockers/blocker_updates/blocker 参数
 *
 * 覆盖：
 * 1. analyze 上报 blockers → metadata.blockers awaiting_user；blocker_updates 置 resolved → passed 推进
 * 2. 无未解决 blocker 门禁：存在未解决 blocker 时 analyze passed 被拦截
 * 3. implement step 带 blocker（verdict=failed）→ on_fail 回 analyze，tasks 全 open
 * 4. blocker_updates 引用不存在 / 已 resolved blocker → 抛错
 * 5. 多个 blocker 全部处理后 analyze 才可 passed
 * 6. status 视图渲染 blockers（awaiting_user/resolved + 处理指引）
 * 7. recovery 后未解决 blocker 保留（awaiting_user）
 */
import { afterAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { __setGitRunner } from "../src/core/git"
import { init, agent_submit, status } from "../src/adapters/opencode/tools"
import { setupWithFakeGit, teardown, makeCtx } from "./helpers"
import {
  setupToAnalyze, driveToImplement, taskItemOf, blockersOf,
  taskListOf, readItem,
} from "./helpers-workflow"

const CID = "test-blocker"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string } {
  const root = `/tmp/blocker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree } = setupWithFakeGit(root, CID)
  return { wt: worktree, root }
}

describe("blocker 生命周期", () => {
  test("analyze 上报 blockers → awaiting_user；blocker_updates 置 resolved → passed 推进", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)

      // analyze failed 上报 blocker（EB 校验仅在 passed 生效）
      const r0 = await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "failed",
          blockers: [{ source_role: "architect", category: "external_dependency", description: "缺少外部接口地址", evidence: "spec 未提供", attempted_actions: "检查 spec", options: ["用户提供地址"] }],
        },
        ctx.arch
      )
      expect(r0).toBeDefined()
      const item0 = readItem(wt, CID)
      expect(blockersOf(item0)).toHaveLength(1)
      expect(blockersOf(item0)[0].status).toBe("awaiting_user")
      expect(blockersOf(item0)[0].id).toBe("b1")

      // 存在未解决 blocker → analyze passed 被拦截
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
        ctx.arch
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未解决的 blocker/)

      // blocker_updates 置 resolved → passed 推进
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "passed",
          execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
          blocker_updates: [{ blocker_id: "b1", user_response: "地址为 https://api.example.test" }],
        },
        ctx.arch
      )
      expect(r).toContain("- **推进**: 是 → implement")
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(blockersOf(item)[0].status).toBe("resolved")
      expect(blockersOf(item)[0].userResponse).toBe("地址为 https://api.example.test")
    } finally { teardown(root) }
  })

  test("developer status 视图：执行类 step 用 opx_agent_submit 提交约定", async () => {
    const { wt, root } = fresh()
    try {
      await driveToImplement(wt, CID)
      const dev = makeCtx("openspec-developer", wt)
      const out = await status.execute({ change_id: CID }, dev)
      expect(out).toContain("`opx_agent_submit()`")
      expect(out).toContain("verdict=passed")
      expect(out).toContain("verdict=failed")
    } finally { teardown(root) }
  })

  test("implement 带 blocker（verdict=failed）→ on_fail 回 analyze，tasks 全 open", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)

      // blocker 参数仅 verdict=failed 有效
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", blocker: { source_role: "developer", category: "infra", description: "构建环境异常", evidence: "CI 日志", attempted_actions: "已重试" } },
        ctx.dev
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/仅支持 verdict=failed/)

      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "infra", description: "构建环境异常", evidence: "CI 日志", attempted_actions: "已重试" },
        },
        ctx.dev
      )
      expect(r).toContain("- **推进**: 是")
      const item = readItem(wt, CID)
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBe("analyze")
      // tasks 全 open，review 验证标记清空
      expect(taskListOf(item).every((t: any) => t.status === "open")).toBe(true)
      expect(blockersOf(item)).toHaveLength(1)
      expect(blockersOf(item)[0].status).toBe("awaiting_user")
    } finally { teardown(root) }
  })

  test("blocker_updates 引用不存在或已 resolved 的 blocker → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      // 不存在的 blocker_id
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }, blocker_updates: [{ blocker_id: "b99", user_response: "x" }] },
        ctx.arch
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/b99/)

      // 先上报 1 个并 resolved
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "failed", blockers: [{ source_role: "architect", category: "credential", description: "缺凭证", evidence: "env 无值", attempted_actions: "检查 env" }] },
        ctx.arch
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "failed", blocker_updates: [{ blocker_id: "b1", user_response: "已提供" }] },
        ctx.arch
      )
      // 已 resolved 的 blocker 不能再更新
      const err2 = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "failed", blocker_updates: [{ blocker_id: "b1", user_response: "重复" }] },
        ctx.arch
      ).catch((e: Error) => e)
      expect(err2).toBeInstanceOf(Error)
      expect(err2.message).toMatch(/不是 awaiting_user/)
    } finally { teardown(root) }
  })

  test("多个 blocker 全部处理后 analyze 才可 passed", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "failed",
          blockers: [
            { source_role: "architect", category: "credential", description: "凭证", evidence: "缺失", attempted_actions: "检查 env" },
            { source_role: "architect", category: "external_dependency", description: "地址", evidence: "缺失", attempted_actions: "检查 spec" },
          ],
        },
        ctx.arch
      )
      const item0 = readItem(wt, CID)
      expect(blockersOf(item0)).toHaveLength(2)
      const [b1, b2] = blockersOf(item0)

      // 只处理 1 个 → passed 仍被拦截
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "failed", blocker_updates: [{ blocker_id: b1.id, user_response: "已提供凭证" }] },
        ctx.arch
      )
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
        ctx.arch
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未解决的 blocker/)

      // 全部处理后 → passed 推进
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "failed", blocker_updates: [{ blocker_id: b2.id, user_response: "已提供地址" }] },
        ctx.arch
      )
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
        ctx.arch
      )
      expect(r).toContain("- **推进**: 是 → implement")
      const item = readItem(wt, CID)
      expect(blockersOf(item).every((b: any) => b.status === "resolved")).toBe(true)
    } finally { teardown(root) }
  })

  test("status 视图渲染 blockers：awaiting_user/resolved + 处理指引", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "failed",
          blockers: [
            { source_role: "architect", category: "external_dependency", description: "接口契约未定", evidence: "E", attempted_actions: "A" },
            { source_role: "architect", category: "architecture_design", description: "已解决的 blocker", evidence: "E", attempted_actions: "A" },
          ],
        },
        ctx.arch
      )
      const item0 = readItem(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "failed", blocker_updates: [{ blocker_id: blockersOf(item0)[1].id, user_response: "ok" }] },
        ctx.arch
      )

      const out = await status.execute({ change_id: CID }, ctx.arch)
      expect(out).toContain("# ✅ 当前轮到你执行")
      expect(out).toContain("## Blocker")
      expect(out).toContain("接口契约未定")
      expect(out).toContain("⏳ 待用户答复")
      expect(out).toContain("已解决的 blocker")
      expect(out).toContain("✓ 已解决")
      expect(out).toContain("用户答复：ok")
      expect(out).toContain("blocker_updates")
      expect(out).toContain("无法以 passed 提交")
    } finally { teardown(root) }
  })

  test("recovery 后未解决 blocker 保留：awaiting_user 不被清空", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "failed",
          blockers: [{ source_role: "architect", category: "real_input", description: "缺少真实输入", evidence: "测试数据不可代表生产路径", attempted_actions: "检查现有 fixture" }],
        },
        ctx.arch
      )
      expect(blockersOf(readItem(wt, CID))[0].status).toBe("awaiting_user")

      // recovery 重初始化（task_analysis），未解决 blocker 保留
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "task_analysis" } }, ctx.orch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBe("analyze")
      expect(blockersOf(item)).toHaveLength(1)
      expect(blockersOf(item)[0].status).toBe("awaiting_user")
    } finally { teardown(root) }
  })
})
