/**
 * 新流初始化落点与 clarify.md 执行边界测试。
 *
 * 覆盖：
 * a) clarify.md 有边界 → init 后 metadata.execution_boundary 正确
 * b) 已有边界（analyze 回退修订 / reviewer 边界扩展）不被 init 覆盖
 * c) clarify 缺失 / 格式非法 → init 成功、无边界、返回体提示
 * d) 旧在途会话（todo/analyze）无 blocker → 迁移到 implement 且 analyze tag 清空
 * e) 旧在途会话有未解决 blocker → 保留 analyze 并提示
 * f) simple 模式同样写入 clarify 边界
 * g) 首次 implement passed 触发主仓库污染 reconcile 一次且不重复
 * h) analyze 回退闭环：implement 上报 blocker → 回退 analyze（视图含待处理 blocker）→
 *    blocker_updates 置 resolved + passed → 前进回 implement
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { init, status, agent_submit, set_worktree } from "../src/adapters/opencode/tools"
import { INIT_PROJECT_STACKS, FakeGitRunner, makeCtx, makeOrchCtx, setupWithFakeGit, teardown, writeClarifyMd } from "./helpers"
import {
  setupToImplement, driveToImplement, driveToQuality, rollbackQuality,
  metaOf, readItem, taskIdsOf,
} from "./helpers-workflow"

const CID = "init-boundary"

const EB = { allowed_directories: ["src/core"], allowed_packages: ["src/core/x"], notes: "限定核心目录" }
const EB2 = { allowed_directories: ["src/core", "src/util"], allowed_packages: ["src/core/x"], notes: "修订后边界" }

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/opxinit-b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string): string {
  return join(wt, "openspec", "states", `${CID}.json`)
}

function rewriteItem(wt: string, mutate: (item: any) => void): void {
  const state = JSON.parse(readFileSync(statePath(wt), "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(statePath(wt), JSON.stringify(state, null, 2))
}

describe("Init 执行边界：clarify.md 解析与落盘", () => {
  test("a) clarify.md 有边界 → init 后 metadata.execution_boundary 正确", async () => {
    const { wt, root } = fresh()
    try {
      await setupToImplement(wt, CID, { boundary: EB })
      expect(metaOf(readItem(wt, CID), "execution_boundary")).toEqual(EB)
    } finally { teardown(root) }
  })

  test("b) 已有边界不被 init 覆盖（analyze 回退修订 / reviewer 边界扩展为事实源）", async () => {
    const { wt, root } = fresh()
    try {
      await setupToImplement(wt, CID, { boundary: EB })
      // 模拟 analyze 回退修订（或 reviewer boundary_expansion 合并）后的 metadata
      rewriteItem(wt, (item) => { item.metadata["execution_boundary"] = EB2 })
      const o = makeOrchCtx(wt)
      await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, o)
      expect(metaOf(readItem(wt, CID), "execution_boundary")).toEqual(EB2)
    } finally { teardown(root) }
  })

  test("c1) clarify.md 缺失 → init 成功、无边界、返回体提示按整个 worktree", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      const r = await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, o)
      expect(r).toContain("未从 clarify.md 解析到本任务组执行边界")
      expect(metaOf(readItem(wt, CID), "execution_boundary")).toBeUndefined()
    } finally { teardown(root) }
  })

  test("c2) clarify.md 格式非法（边界数组为空）→ init 成功、无边界、返回体提示", async () => {
    const { wt, root } = fresh()
    try {
      // allowed_directories 为空数组 → parseExecutionBoundary 返回 null
      writeFileSync(
        join(wt, "openspec", "changes", CID, "clarify.md"),
        ["# 需求澄清", "", "## 执行边界", "", "```yaml", "task_groups:", '  "1":', "    allowed_directories: []", "    allowed_packages: [\"src/core/x\"]", "```", ""].join("\n"),
        "utf-8",
      )
      const o = makeOrchCtx(wt)
      const r = await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, o)
      expect(r).toContain("未从 clarify.md 解析到本任务组执行边界")
      expect(metaOf(readItem(wt, CID), "execution_boundary")).toBeUndefined()
    } finally { teardown(root) }
  })

  test("f) simple 模式同样写入 clarify.md 执行边界", async () => {
    const { wt, root } = fresh()
    try {
      await setupToImplement(wt, CID, { boundary: EB, mode: "simple" })
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(metaOf(item, "execution_boundary")).toEqual(EB)
    } finally { teardown(root) }
  })
})

describe("Init 旧在途会话迁移", () => {
  test("d) todo/analyze 且无未解决 blocker → 迁移到 implement，analyze tag 清空", async () => {
    const { wt, root } = fresh()
    try {
      await setupToImplement(wt, CID)
      // 构造旧流初始态会话（phase=todo / currentStep=analyze + analyze passed tag）
      rewriteItem(wt, (item) => {
        item.phase = "todo"
        item.currentStep = "analyze"
        item.tags["analyze:openspec-architect"] = "passed"
      })
      const o = makeOrchCtx(wt)
      const r = await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, o)
      const item = readItem(wt, CID)
      expect(r).toContain("已迁移旧在途会话")
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(item.tags["analyze:openspec-architect"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("e) 存在未解决 blocker → 保留 analyze 并提示", async () => {
    const { wt, root } = fresh()
    try {
      await setupToImplement(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "todo"
        item.currentStep = "analyze"
        item.metadata["blockers"] = [{
          id: "b1", sourceRole: "openspec-developer", taskId: null, category: "requirement",
          description: "待用户确认", evidence: "E", attemptedActions: "A", options: [],
          status: "awaiting_user", userResponse: null, architectConclusion: null,
        }]
      })
      const o = makeOrchCtx(wt)
      const r = await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, o)
      const item = readItem(wt, CID)
      expect(r).toContain("存在未解决 blocker，保留 analyze 回退步骤")
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBe("analyze")
    } finally { teardown(root) }
  })
})

describe("analyze 回退闭环", () => {
  const BLOCKER = {
    source_role: "openspec-developer", category: "requirement",
    description: "需求缺口待确认", evidence: "spec 未覆盖该行为", attempted_actions: "按 spec 推导",
  }

  test("h) implement 上报 blocker → analyze（视图含待处理 blocker）→ resolved+passed → 回 implement", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID, { boundary: EB })
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "failed", blocker: BLOCKER },
        ctx.dev
      )
      const rolled = readItem(wt, CID)
      expect(rolled.phase).toBe("todo")
      expect(rolled.currentStep).toBe("analyze")

      // 回退到 analyze 后，架构师视图渲染待处理 blocker
      const archView = await status.execute({ change_id: CID }, ctx.arch)
      expect(archView).toContain("# ✅ 当前轮到你执行")
      expect(archView).toContain("## Blocker")
      expect(archView).toContain("需求缺口待确认")
      expect(archView).toContain("⏳ 待用户答复")

      const blockerId = rolled.metadata.blockers[0].id
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "passed",
          blocker_updates: [{ blocker_id: blockerId, user_response: "按方案 X 处理" }],
        },
        ctx.arch
      )
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(item.metadata.blockers[0].status).toBe("resolved")
      // clarify.md 边界未被回退提交覆盖（未携带 execution_boundary）
      expect(metaOf(item, "execution_boundary")).toEqual(EB)
    } finally { teardown(root) }
  })
})

describe("首次 implement passed 触发主仓库污染 reconcile", () => {
  test("g) 首次 implement passed 触发一次；回退后再次 passed 不重复触发", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      // 写 clarify 边界并预置主仓库污染文档
      writeClarifyMd(wt, CID, { "1": EB })
      const o = makeOrchCtx(wt)
      await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, o)
      await set_worktree.execute({ change_id: CID }, o)
      fakeGit.pollutionFiles.set(`${wt}-${CID}`, ["openspec/changes/cid/design.md"])

      // 首次 implement passed（driveToQuality 内部第一步）→ reconcile 合并提交一次
      const { ctx } = await driveToQuality(wt, CID)
      expect(fakeGit.commitShas.length).toBe(1)
      const pollSha = fakeGit.commitShas[0]
      // 强断言：合并提交消息、commit-tree 单次、worktree 分支确实并入该提交
      expect(fakeGit.commitTreeCalls).toHaveLength(1)
      expect(fakeGit.commitTreeCalls[0].message).toBe("docs(openspec): reconcile main-repo edits into worktree branch")
      expect(fakeGit.commitTreeCalls[0].tree).toBe(fakeGit.treeShas[0])
      expect(fakeGit.callLog.some((l) => l.includes(`merge --no-ff ${pollSha}`))).toBe(true)
      expect(fakeGit.mergedBranches).toEqual([pollSha])
      expect(metaOf(readItem(wt, CID), "_main_pollution_reconciled")).toBe(true)

      // 质量聚合回退 implement，dev 修复后再次 passed → 标记已存在，不再触发
      await rollbackQuality(ctx, CID, {
        failedDim: "style",
        newChildren: [{ id: "7", title: "命名问题", description: "命名不规范", severity: "Low", dimension: "style" }],
      })
      const item0 = readItem(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["7"], completed_task_ids: taskIdsOf(item0) },
        ctx.dev
      )
      // 第二次 passed 不产生新的污染合并提交（标记去重），标记仍为 true
      expect(fakeGit.commitShas.length).toBe(1)
      expect(fakeGit.commitTreeCalls).toHaveLength(1)
      expect(fakeGit.mergedBranches).toEqual([pollSha])
      expect(metaOf(readItem(wt, CID), "_main_pollution_reconciled")).toBe(true)
    } finally { teardown(root) }
  })
})
