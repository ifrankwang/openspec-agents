/**
 * blocker 生命周期测试（新流）：metadata.blockers + agent_submit 的 blockers/blocker_updates/blocker 参数
 *
 * 新流语义：blocker 由 implement（verdict=failed）上报 → on_fail 回退 analyze；
 * analyze 是唯一裁决落点（架构师经 blocker_updates 置 resolved 后 passed 回到 implement）。
 * analyze 不再首轮执行、也不再承载「执行边界产出」（边界来自 clarify.md）。
 *
 * 覆盖：
 * 1. implement 上报 blockers → 回退 analyze（awaiting_user）；blocker_updates 置 resolved → passed 回 implement
 * 2. 无未解决 blocker 门禁：存在未解决 blocker 时 analyze passed 被拦截
 * 3. implement step 带 blocker（verdict=failed）→ on_fail 回 analyze，tasks 全 open
 * 4. blocker_updates 引用不存在 / 已 resolved blocker → 抛错
 * 5. 多个 blocker 全部处理后 analyze 才可 passed
 * 6. status 视图渲染 blockers（awaiting_user/resolved + 处理指引）
 * 7. 重复 init 时未解决 blocker 保留 analyze 回退落点（解决后迁移回 implement）
 * 8. simple 旧会话遗留未解决 blocker：重复 init 自动关闭（留痕保留记录）+ 返回体提示 + 可正常 passed
 * 9. recovery.phase=task_analysis 重制：未解决 blocker 随重制关闭（留痕保留记录）+ 返回体提示 + 可正常 passed
 * 10. 旧数据兼容：blocker 缺 status 时保守拦截 passed，blocker_updates 归一 awaiting_user 后可解除
 */
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, agent_submit, status } from "../src/adapters/opencode/tools"
import { INIT_PROJECT_STACKS, setupWithFakeGit, teardown, makeCtx, makeOrchCtx, initSimpleWorktree } from "./helpers"
import {
  driveToImplement, taskItemOf, blockersOf,
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
  test("implement 上报 blocker → 回退 analyze；blocker_updates 置 resolved 后 passed 回到 implement", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)

      // implement failed 上报 blocker → on_fail 回退 analyze（回退落点不要求 execution_boundary）
      const r0 = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "external_dependency", description: "缺少外部接口地址", evidence: "spec 未提供", attempted_actions: "检查 spec", options: ["用户提供地址"] },
        },
        ctx.dev
      )
      expect(r0).toBeDefined()
      const item0 = readItem(wt, CID)
      expect(item0.phase).toBe("todo")
      expect(item0.currentStep).toBe("analyze")
      expect(blockersOf(item0)).toHaveLength(1)
      expect(blockersOf(item0)[0].status).toBe("awaiting_user")
      expect(blockersOf(item0)[0].id).toBe("b1")

      // 存在未解决 blocker → analyze passed 被拦截
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed" },
        ctx.arch
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未解决的 blocker/)

      // blocker_updates 置 resolved → passed 推进回 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "passed",
          blocker_updates: [{ blocker_id: "b1", user_response: "地址为 https://api.example.test" }],
        },
        ctx.arch
      )
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

      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "infra", description: "构建环境异常", evidence: "CI 日志", attempted_actions: "已重试" },
        },
        ctx.dev
      )
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
      const { ctx } = await driveToImplement(wt, CID)
      // 先经 implement 上报 blocker → 回退 analyze（analyze 是可裁决落点）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "credential", description: "缺凭证", evidence: "env 无值", attempted_actions: "检查 env" },
        },
        ctx.dev
      )
      expect(readItem(wt, CID).currentStep).toBe("analyze")
      // 不存在的 blocker_id
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", blocker_updates: [{ blocker_id: "b99", user_response: "x" }] },
        ctx.arch
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/b99/)

      // 先 resolved 该 blocker
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
      const { ctx } = await driveToImplement(wt, CID)
      // implement 上报第一个 blocker → 回退 analyze
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "credential", description: "凭证", evidence: "缺失", attempted_actions: "检查 env" },
        },
        ctx.dev
      )
      // 架构师在裁决中发现第二个阻塞（analyze 保留 blockers 参数），逐条登记
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "failed",
          blockers: [
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
        { change_id: CID, step_id: "analyze", verdict: "passed" },
        ctx.arch
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未解决的 blocker/)

      // 全部处理后 → passed 回 implement
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "failed", blocker_updates: [{ blocker_id: b2.id, user_response: "已提供地址" }] },
        ctx.arch
      )
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed" },
        ctx.arch
      )
      expect(r).toContain("提交成功")
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("implement")
      expect(blockersOf(item).every((b: any) => b.status === "resolved")).toBe(true)
    } finally { teardown(root) }
  })

  test("status 视图渲染 blockers：awaiting_user/resolved + 处理指引", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      // 两条 blocker：implement 上报 1 条，架构师在回退步骤登记第 2 条
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "external_dependency", description: "接口契约未定", evidence: "E", attempted_actions: "A" },
        },
        ctx.dev
      )
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "failed",
          blockers: [
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

  test("重复 init：未解决 blocker 保留 analyze 回退落点，解决后迁移回 implement", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "real_input", description: "缺少真实输入", evidence: "测试数据不可代表生产路径", attempted_actions: "检查现有 fixture" },
        },
        ctx.dev
      )
      expect(blockersOf(readItem(wt, CID))[0].status).toBe("awaiting_user")

      // 重复 init（无 recovery）：存在未解决 blocker → 保留 analyze（回退落点职责），不迁移
      const out1 = await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, ctx.orch)
      expect(out1).toContain("存在未解决 blocker，保留 analyze 回退步骤。")
      const item = readItem(wt, CID)
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBe("analyze")
      expect(blockersOf(item)).toHaveLength(1)
      expect(blockersOf(item)[0].status).toBe("awaiting_user")

      // 裁决完成后重复 init（无 recovery）：旧在途会话迁移到 implement，留痕保留
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "failed", blocker_updates: [{ blocker_id: "b1", user_response: "已提供真实输入" }] },
        ctx.arch
      )
      const out2 = await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, ctx.orch)
      expect(out2).toContain("已迁移旧在途会话：初始落点由 analyze 前移到 implement。")
      const migrated = readItem(wt, CID)
      expect(migrated.phase).toBe("in_progress")
      expect(migrated.currentStep).toBe("implement")
      expect(blockersOf(migrated)[0].status).toBe("resolved")
    } finally { teardown(root) }
  })

  test("simple 旧会话遗留 awaiting_user blocker：重复 init 自动关闭（留痕）+ 提示 + 可正常 passed", async () => {
    const { wt, root } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // 模拟旧版本 simple 会话残留 blocker（simple 已不支持 blocker 状态机，无裁决落点）
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      const item0 = state.workItems.find((w: any) => w.id === "task:1")
      item0.metadata["blockers"] = [{
        id: "b1", sourceRole: "openspec-developer", taskId: "2", category: "manual_operation",
        description: "旧版本遗留阻塞", evidence: "e", attemptedActions: "a", options: [],
        status: "awaiting_user", userResponse: null, architectConclusion: null,
      }]
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8")

      // 重复 init（无 recovery，simple）：自动关闭未解决 blocker 并在返回体提示关闭数量
      const out = await init.execute(
        { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "simple" },
        makeOrchCtx(wt),
      )
      expect(out).toContain("simple 模式已关闭 1 个未解决 blocker")

      // 记录保留（不删除，审计留痕）：id 不变、状态置 resolved、userResponse/architectConclusion 写关闭原因
      const closed = readItem(wt, CID)
      expect(blockersOf(closed)).toHaveLength(1)
      expect(blockersOf(closed)[0].id).toBe("b1")
      expect(blockersOf(closed)[0].status).toBe("resolved")
      expect(blockersOf(closed)[0].userResponse).toBe("simple 模式已不支持 blocker 状态机，随初始化关闭")
      expect(blockersOf(closed)[0].architectConclusion).toBe("simple 模式已不支持 blocker 状态机，随初始化关闭")

      // 解锁：后续 implement passed 可正常推进 quality_review（不再被未解决 blocker 永久拦截）
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        makeCtx("openspec-developer", wt),
      )
      expect(readItem(wt, CID).currentStep).toBe("quality_review")
    } finally { teardown(root) }
  })

  test("recovery.phase=task_analysis 重制：未解决 blocker 随重制关闭（留痕保留）+ 返回体提示 + 可正常 passed", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      // 构造 analyze 回退态：implement 上报 blocker → on_fail 回退 analyze，blocker 停在 awaiting_user
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "environment", description: "环境不可用", evidence: "E", attempted_actions: "A" },
        },
        ctx.dev,
      )
      const rolled = readItem(wt, CID)
      expect(rolled.phase).toBe("todo")
      expect(rolled.currentStep).toBe("analyze")
      expect(blockersOf(rolled)[0].status).toBe("awaiting_user")

      // recovery.phase=task_analysis 重制当前组：analyze 裁决入口被抹掉，未解决 blocker 随重制关闭
      const out = await init.execute(
        { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", recovery: { phase: "task_analysis" } },
        ctx.orch,
      )
      expect(out).toContain("任务组重制已关闭 1 个未解决 blocker（随重制处理）")

      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      // 记录保留（不删除，含 id）：置 resolved 并写重制留痕
      expect(blockersOf(item)).toHaveLength(1)
      expect(blockersOf(item)[0].id).toBe("b1")
      expect(blockersOf(item)[0].status).toBe("resolved")
      expect(blockersOf(item)[0].userResponse).toBe("随任务组重制处理")
      expect(blockersOf(item)[0].architectConclusion).toBe("随任务组重制处理")

      // 解锁：重制后 implement passed 不再被未解决 blocker 拦截，正常推进 verify_tool
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        ctx.dev,
      )
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
    } finally { teardown(root) }
  })

  test("旧数据兼容：blocker 缺 status → analyze passed 保守拦截；blocker_updates 归一 awaiting_user 后可解除", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "failed",
          blocker: { source_role: "developer", category: "external_dependency", description: "旧数据阻塞", evidence: "E", attempted_actions: "A" },
        },
        ctx.dev,
      )
      // 模拟旧版本数据：blocker 记录缺 status 字段
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const state = JSON.parse(readFileSync(statePath, "utf-8"))
      delete state.workItems.find((w: any) => w.id === "task:1").metadata.blockers[0].status
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8")

      // 保守口径：缺 status 视为未解决（不静默放行 passed）→ analyze passed 被拦
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed" },
        ctx.arch,
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/存在未解决的 blocker/)

      // 兼容策略：blocker_updates 把缺 status 归一为 awaiting_user → 可解除并记录用户答复
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "failed",
          blocker_updates: [{ blocker_id: "b1", user_response: "旧数据已确认" }],
        },
        ctx.arch,
      )
      const resolved = blockersOf(readItem(wt, CID))[0]
      expect(blockersOf(readItem(wt, CID))).toHaveLength(1)
      expect(resolved.status).toBe("resolved")
      expect(resolved.userResponse).toBe("旧数据已确认")

      // 解除后 analyze passed 可正常回到 implement
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed" }, ctx.arch)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })
})
