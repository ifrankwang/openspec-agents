/**
 * 编排守卫测试（M1e 新流单轨版）：阶段校验、身份校验、重复提交校验
 *
 * 与 flow test 分离——这些测试校验工具的门禁逻辑，非完整流程场景。
 * 每项测试针对单一守卫条件，不依赖完整流程上下文。
 *
 * 新流迁移说明：
 * - 旧 arch_submit/dev_submit/tool_review_submit/task_review_submit/quality_review_submit
 *   全部经 opx_agent_submit({step_id, verdict, ...}) 触发
 * - 守卫断言保持「抛错 + 零状态变更」：经 helpers-workflow 驱动到目标 step 再触发
 * - 旧 taskGroups.find 投影替换为 taskItemOf/readItem/metaOf/taskListOf
 */
import { describe, expect, test, afterAll } from "bun:test"
import { writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, set_worktree, agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWithFakeGit, teardown } from "./helpers"
import {
  setupToAnalyze, driveToImplement, driveToVerifyTool, driveToVerifyTask, driveToQuality,
  taskItemOf, taskListOf, metaOf, readItem, taskIdsOf, rollbackQuality,
} from "./helpers-workflow"

const CID = "test-guard"

const EB = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string): string {
  return join(wt, "openspec", "states", `${CID}.json`)
}

/** 直接改写活跃 task WorkItem（手动构造前置状态用）。 */
function rewriteItem(wt: string, mutate: (item: any) => void): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 注入一个 issue child（metadata 承载归因字段）。 */
function injectIssue(wt: string, issue: Record<string, unknown>): void {
  const status = (issue.status as string) ?? "open"
  const phase = status === "verified" ? "done"
    : status === "exempted" ? "cancelled"
    : "todo"
  rewriteItem(wt, (item) => {
    item.children.push({
      id: `issue:${issue.id}`,
      source: "openspec",
      externalId: String(issue.id),
      type: "issue",
      title: (issue.description as string) ?? "",
      description: (issue.description as string) ?? "",
      phase,
      suspended: false,
      currentStep: null,
      tags: {},
      metadata: {
        source_phase: (issue.sourcePhase as string) ?? "quality",
        dimension: (issue.dimension as string) ?? "style",
        file: issue.file ?? "",
        line: issue.line ?? 0,
        suggestion: issue.suggestion ?? "",
      },
      children: [],
      labels: [],
      severity: (issue.severity as string) ?? "Low",
    })
  })
}

/** 捕获 agent_submit 抛错并断言错误文案。 */
async function expectError(p: Promise<unknown>, pattern: RegExp): Promise<Error> {
  const err = await p.catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toMatch(pattern)
  return err
}

/** 注入一个 review 态（已修复待复核）issue child（metadata.source 承载报源，供谁提谁裁定）。 */
function injectReviewIssue(wt: string, issue: Record<string, unknown>): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  const item = state.workItems.find((w: any) => w.id === "task:1")
  item.children.push({
    id: `issue:${issue.id}`,
    source: "openspec",
    externalId: String(issue.id),
    type: "issue",
    title: (issue.description as string) ?? "",
    description: (issue.description as string) ?? "",
    phase: "review",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: {
      source: (issue.source as string) ?? "openspec-reviewer-style",
      source_phase: (issue.sourcePhase as string) ?? "quality",
      dimension: (issue.dimension as string) ?? "style",
      file: issue.file ?? "",
      line: issue.line ?? 0,
      suggestion: issue.suggestion ?? "",
      ...(typeof issue.refixCount === "number" ? { refix_count: issue.refixCount } : {}),
    },
    children: [],
    labels: [],
    severity: (issue.severity as string) ?? "Low",
  })
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/**
 * 构造「verify_quality 阶段存在 style 维度豁免申请」前置：
 * style 报 Low issue（其余维度通过后聚合回退）→ 回 implement → dev 申请豁免（exempt_request 标记）→ 手动移回 verify_quality。
 */
async function setupExemptRequest(wt: string): Promise<void> {
  const { ctx } = await driveToQuality(wt, CID)
  await rollbackQuality(ctx, CID, {
    failedDim: "style",
    newChildren: [{ id: "7", title: "不可修 issue", description: "第三方限制", severity: "Low", dimension: "style" }],
  })
  const item0 = readItem(wt, CID)
  await agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["7"], completed_task_ids: taskIdsOf(item0) },
    ctx.dev
  )
  rewriteItem(wt, (item) => { item.phase = "review"; item.currentStep = "verify_quality" })
}

// ── G1: set_worktree 无阶段守卫 ──

describe("G1. set_worktree 守卫已移除", () => {
  test("init 后直接调 set_worktree → 成功", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      const result = await set_worktree.execute({ change_id: CID }, o)
      expect(result).toContain("已创建 worktree")
      expect(result).toContain("**路径**")
    } finally { teardown(root) }
  })
})

// ── G1.2: set_worktree 自修复 ──

describe("G1.2. set_worktree 自修复", () => {
  test("change 目录有未提交变更 → auto-commit", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.dirtyPaths.add(`${wt}-openspec`)
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      const result = await set_worktree.execute({ change_id: CID }, o)
      expect(result).toContain("已创建 worktree")
    } finally { teardown(root) }
  })

  test("已有 worktree 可 fast-forward → merge + 复用", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      let result = await set_worktree.execute({ change_id: CID }, o)
      expect(result).toContain("已创建 worktree")
      result = await set_worktree.execute({ change_id: CID }, o)
      expect(result).toContain("复用已有 worktree")
    } finally { teardown(root) }
  })

  test("已有 worktree 分叉 + clean → 清理重建", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      let result = await set_worktree.execute({ change_id: CID }, o)
      expect(result).toContain("已创建 worktree")
      fakeGit.mergeConflictOnNext = true
      result = await set_worktree.execute({ change_id: CID }, o)
      expect(result).toContain("已创建 worktree")
    } finally { teardown(root) }
  })

  test("已有 worktree 分叉 + dirty → 抛错", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      const result = await set_worktree.execute({ change_id: CID }, o)
      expect(result).toContain("已创建 worktree")
      fakeGit.mergeConflictOnNext = true
      fakeGit.dirtyPaths.add(join(wt, ".worktree", CID, "task-group-1"))
      await expectError(set_worktree.execute({ change_id: CID }, o), /分叉且有未提交变更/)
    } finally { teardown(root) }
  })
})

// ── G2: 身份守卫 ──

describe("G2. 身份守卫", () => {
  test("non-orchestrator 调 init → throws", async () => {
    const dev = makeCtx("openspec-developer", "/tmp")
    await expectError(init.execute({ change_id: CID, task_group_id: "1" }, dev), /仅限编排者/)
  })

  test("non-orchestrator 调 set_worktree → throws", async () => {
    const { wt, root } = fresh()
    try {
      await init.execute({ change_id: CID, task_group_id: "1" }, makeOrchCtx(wt))
      await expectError(
        set_worktree.execute({ change_id: CID }, makeCtx("openspec-developer", wt)),
        /仅限编排者/
      )
    } finally { teardown(root) }
  })

  test("非 step.agents 的 agent 提交 verify_quality → 越权抛错且 state 不变", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      const before = readItem(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.arch),
        /submit 越权/
      )
      const after = readItem(wt, CID)
      expect(after.phase).toBe(before.phase)
      expect(after.currentStep).toBe(before.currentStep)
    } finally { teardown(root) }
  })
})

// ── G3: 重复提交守卫 ──

describe("G3. 重复提交守卫", () => {
  test("verify_quality 同维度 agent 重复提交 → 抛错且 tags 不变", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims["style"])
      const snapshot = JSON.stringify(readItem(wt, CID).tags)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "failed" }, ctx.dims["style"]),
        /重复提交守卫/
      )
      expect(JSON.stringify(readItem(wt, CID).tags)).toBe(snapshot)
    } finally { teardown(root) }
  })
})

// ── G4: analyze 参数守卫 ──

describe("G4. analyze 参数守卫", () => {
  test("analyze passed 不带 execution_boundary → 抛错且 state 不变", async () => {
    const { wt, root } = fresh()
    try {
      await setupToAnalyze(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed" }, makeCtx("openspec-architect", wt)),
        /execution_boundary/
      )
      const item = readItem(wt, CID)
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBe("analyze")
    } finally { teardown(root) }
  })
})

// ── G4.1: 重复 init 保留当前阶段 ──

describe("G4.1. init 重入", () => {
  test("无 recovery 重复 init 保留 analyze 之后的阶段", async () => {
    const { wt, root } = fresh()
    try {
      await driveToImplement(wt, CID)
      const result = await init.execute({ change_id: CID, task_group_id: "1" }, makeOrchCtx(wt))
      expect(result).toBe("编排会话已初始化。")
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })
})

// ── G5: 非法 task id ──

describe("G5. 非法 task id 守卫", () => {
  test("verify_task verified_tasks 含无效 id → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["99"] },
          makeCtx("openspec-reviewer-task", wt)
        ),
        /非法 task id/
      )
    } finally { teardown(root) }
  })
})

// ── G6: verify_task 覆盖门禁 + validation_steps ──

describe("G6. verify_task 覆盖门禁与 validation_steps", () => {
  test("verified_tasks 未覆盖全部 submitted → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1"] },
          makeCtx("openspec-reviewer-task", wt)
        ),
        /未被 verified_tasks 或 failed_tasks 覆盖/
      )
    } finally { teardown(root) }
  })

  test("validation_steps 全 completed → 写入 metadata", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: taskIdsOf(readItem(wt, CID)),
          validation_steps: [{ step: "构建", completed: true, evidence: "BUILD SUCCESS" }],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      const steps = metaOf(readItem(wt, CID), "validation_steps")
      expect(steps).toHaveLength(1)
      expect(steps[0].evidence).toBe("BUILD SUCCESS")
    } finally { teardown(root) }
  })

  test("validation_steps skipped 缺 skip_reason → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await expectError(
        agent_submit.execute(
          {
            change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: taskIdsOf(readItem(wt, CID)),
            validation_steps: [{ step: "冒烟", completed: false }],
          },
          makeCtx("openspec-reviewer-task", wt)
        ),
        /跳过原因/
      )
    } finally { teardown(root) }
  })

  test("validation_steps skipped + 结构化 skip_reason → 接受并落盘", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      const reason = '{"item":"冒烟","category":"no_ui_change","adjudication":"user_response"}'
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: taskIdsOf(readItem(wt, CID)),
          validation_steps: [{ step: "冒烟", completed: false, skip_reason: reason }],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(metaOf(readItem(wt, CID), "validation_steps")[0].skip_reason).toBe(reason)
    } finally { teardown(root) }
  })

  test("仅测试代码变更豁免②③：skipped + 结构化 skip_reason → passed 接受并推进到 verify_quality", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      const reason = '{"item":"服务健康与 API 测试","category":"test_code_only","adjudication":"user_response","note":"本次变更仅含测试代码，豁免启动服务与 API 测试"}'
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: taskIdsOf(readItem(wt, CID)),
          validation_steps: [
            { step: "①task 产出完整性", completed: true, evidence: "全部 task 验证通过" },
            { step: "②启动服务并检查健康", completed: false, skip_reason: reason },
            { step: "③独立执行全量 API 测试", completed: false, skip_reason: reason },
            { step: "④审查测试代码质量", completed: true, evidence: "测试代码质量审查通过" },
          ],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      const item = readItem(wt, CID)
      const steps = metaOf(item, "validation_steps")
      expect(steps).toHaveLength(4)
      expect(steps[1]).toMatchObject({ completed: false, skip_reason: reason })
      expect(steps[2]).toMatchObject({ completed: false, skip_reason: reason })
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_quality")
    } finally { teardown(root) }
  })
})

// ── G7: 非法 task id in failed_tasks ──

describe("G7. 非法 task id in failed_tasks", () => {
  test("verify_task failed_tasks 含无效 id → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await expectError(
        agent_submit.execute(
          {
            change_id: CID, step_id: "verify_task", verdict: "failed",
            verified_tasks: ["1", "2", "3"], failed_tasks: [{ task_id: "999", reason: "Invalid" }],
          },
          makeCtx("openspec-reviewer-task", wt)
        ),
        /非法 task id/
      )
    } finally { teardown(root) }
  })
})

// ── G8: 层门禁（非当前 step 提交被拒）──

describe("G8. 层门禁", () => {
  test("verify_tool 未完成时 taskR 提交 verify_task → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed" }, makeCtx("openspec-reviewer-task", wt)),
        /submit 校验失败/
      )
    } finally { teardown(root) }
  })
})

// ── G9: 豁免裁定非法参数 ──

describe("G9. 豁免裁定非法参数", () => {
  test("exempt_adjudications 引用不存在的 issue → 抛错且 state 不变", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      const before = JSON.stringify(readItem(wt, CID).children)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "fake", action: "dismissed" }] },
          ctx.dims["style"]
        ),
        /不存在于/
      )
      expect(JSON.stringify(readItem(wt, CID).children)).toBe(before)
    } finally { teardown(root) }
  })
})

// ── G9.1: Info 级 issue 禁止申请豁免 ──

describe("G9.1. Info 级 issue 禁止申请豁免", () => {
  test("dev 对 Info 级 issue 提交 exempt_issue_ids → 抛错且 state 不变（Info 不阻塞提交，无需豁免）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      injectIssue(wt, { id: "8", sourcePhase: "quality", dimension: "style", severity: "Info", description: "建议项" })
      const before = JSON.stringify(readItem(wt, CID).children)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["8"], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
          ctx.dev
        ),
        /Info 级 issue，不阻塞提交，无需申请豁免/
      )
      expect(JSON.stringify(readItem(wt, CID).children)).toBe(before)
    } finally { teardown(root) }
  })
})

// ── G9.2: 豁免裁定组合守卫（rejected + passed 禁止）──

describe("G9.2. 豁免裁定组合守卫", () => {
  test("exempt_adjudications 含 rejected + verdict=passed → 抛错且 child 不变（驳回的 issue 需修复，审查不能判定通过）", async () => {
    const { wt, root } = fresh()
    try {
      await setupExemptRequest(wt)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "rejected" }] },
          makeCtx("openspec-reviewer-style", wt)
        ),
        /被驳回（rejected）[\s\S]*verdict 必须为 failed/
      )
      const child = readItem(wt, CID).children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("review")
      expect(child.metadata["exempt_request"]).toBeDefined()
    } finally { teardown(root) }
  })

  test("exempt_adjudications 含 dismissed + verdict=passed → 正常裁定（dismissed→cancelled）并推进", async () => {
    const { wt, root } = fresh()
    try {
      await setupExemptRequest(wt)
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
        makeCtx("openspec-reviewer-style", wt)
      )
      expect(r).toContain("提交成功")
      const child = readItem(wt, CID).children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("cancelled")
      expect(child.metadata["exempt_request"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("exempt_adjudications 含 rejected + verdict=failed → 合法裁定（rejected→todo 回退待修复）", async () => {
    const { wt, root } = fresh()
    try {
      await setupExemptRequest(wt)
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "failed", exempt_adjudications: [{ issue_id: "7", action: "rejected" }] },
        makeCtx("openspec-reviewer-style", wt)
      )
      expect(r).toContain("提交成功")
      const child = readItem(wt, CID).children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("todo")
      expect(child.metadata["exempt_request"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

// ── G9.3: 裁定一致性统一守卫（exempt/recheck 驳回 + passed 禁止，一次覆盖两个裁定参数）──

describe("G9.3. 裁定驳回一致性守卫", () => {
  test("recheck_adjudications 含 rejected + verdict=passed → 抛错且零状态变更（child 保持 review 态、refix_count 不变、reject_reason 未写入）", async () => {
    const { wt, root } = fresh()
    try {
      await driveToQuality(wt, CID)
      injectReviewIssue(wt, { id: "9", source: "openspec-reviewer-style", sourcePhase: "quality", dimension: "style" })
      const before = JSON.stringify(readItem(wt, CID).children)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_quality", verdict: "passed", recheck_adjudications: [{ issue_id: "9", verdict: "rejected", reject_reason: "修复不达标" }] },
          makeCtx("openspec-reviewer-style", wt)
        ),
        /复核失败[\s\S]*被驳回（rejected）[\s\S]*该 issue 需修复[\s\S]*verdict 必须为 failed/
      )
      expect(JSON.stringify(readItem(wt, CID).children)).toBe(before)
      const child = readItem(wt, CID).children.find((c: any) => c.externalId === "9")
      expect(child.phase).toBe("review")
      expect(child.metadata["refix_count"]).toBeUndefined()
      expect(child.metadata["reject_reason"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("混合清单（exempt rejected + recheck rejected + verdict=passed）→ 抛错且零状态变更（统一守卫先于一切裁定写入）", async () => {
    const { wt, root } = fresh()
    try {
      await setupExemptRequest(wt)
      const before = JSON.stringify(readItem(wt, CID).children)
      await expectError(
        agent_submit.execute(
          {
            change_id: CID, step_id: "verify_quality", verdict: "passed",
            exempt_adjudications: [{ issue_id: "7", action: "rejected" }],
            recheck_adjudications: [{ issue_id: "7", verdict: "rejected", reject_reason: "修复不达标" }],
          },
          makeCtx("openspec-reviewer-style", wt)
        ),
        /豁免裁定失败[\s\S]*该 issue 需修复[\s\S]*verdict 必须为 failed/
      )
      expect(JSON.stringify(readItem(wt, CID).children)).toBe(before)
      const child = readItem(wt, CID).children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("review")
      expect(child.metadata["exempt_request"]).toBeDefined()
    } finally { teardown(root) }
  })

  test("混合合法清单（exempt dismissed + recheck passed + verdict=passed）→ 正常裁定（cancelled/done）并推进 done", async () => {
    const { wt, root } = fresh()
    try {
      await setupExemptRequest(wt)
      injectReviewIssue(wt, { id: "9", source: "openspec-reviewer-style", sourcePhase: "quality", dimension: "style" })
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "passed",
          exempt_adjudications: [{ issue_id: "7", action: "dismissed" }],
          recheck_adjudications: [{ issue_id: "9", verdict: "passed" }],
        },
        makeCtx("openspec-reviewer-style", wt)
      )
      expect(r).toContain("提交成功")
      const item = readItem(wt, CID)
      const child7 = item.children.find((c: any) => c.externalId === "7")
      expect(child7.phase).toBe("cancelled")
      expect(child7.metadata["exempt_request"]).toBeUndefined()
      const child9 = item.children.find((c: any) => c.externalId === "9")
      expect(child9.phase).toBe("done")
      // verify_quality passed 后推进到 verify_cleanup（收尾验证），不再直接 done
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_cleanup")

      // developer 提交 verify_cleanup passed → 收尾验证通过落 done
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "passed" },
        makeCtx("openspec-developer", wt)
      )
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
    } finally { teardown(root) }
  })
})

// ── G10: 谁提谁裁定守卫 ──

describe("G10. 谁提谁裁定守卫", () => {
  test("非报 issue 维度的 agent 裁定 quality 豁免 → 抛错且 child 不变", async () => {
    const { wt, root } = fresh()
    try {
      await setupExemptRequest(wt)
      // architecture 维度在上一轮 verify_quality 已 passed（rollbackQuality 聚合回退前的裁决保留）。
      // 其带 exempt_adjudications 提交为纯裁定补交（isSupplementOnly 放行重复提交守卫），
      // 随后由谁提谁裁定在 adjudicateExempt 拦截：非报源 agent 无权裁定（guard 放行不改变裁定归属）。
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
          makeCtx("openspec-reviewer-architecture", wt)
        ),
        /由报源 "openspec-reviewer-style"/
      )
      const child = readItem(wt, CID).children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("review")
      expect(child.metadata["exempt_request"]).toBeDefined()
    } finally { teardown(root) }
  })

  test("无豁免申请标记的 issue 被裁定 → 抛未申请豁免且落盘 children 零变更", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await rollbackQuality(ctx, CID, {
        failedDim: "style",
        newChildren: [{ id: "7", title: "不可修 issue", description: "第三方限制", severity: "Low", dimension: "style" }],
      })
      // 不经过 dev exempt_issue_ids 申请豁免 → child 无 exempt_request 标记
      const child0 = readItem(wt, CID).children.find((c: any) => c.externalId === "7")
      expect(child0.metadata["exempt_request"]).toBeUndefined()
      const before = JSON.stringify(readItem(wt, CID).children)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_quality", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
          ctx.dims["style"]
        ),
        /未申请豁免/
      )
      expect(JSON.stringify(readItem(wt, CID).children)).toBe(before)
    } finally { teardown(root) }
  })
})

// ── G11: review 参数守卫 ──

describe("G11. review 参数守卫", () => {
  test("verify_tool passed + Low new_children → 抛错且 state 不变", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_tool", verdict: "passed", new_children: [{ id: "7", title: "阻塞问题", description: "d", severity: "Low", dimension: "style" }] },
          makeCtx("openspec-reviewer-tool", wt)
        ),
        /passed=true 只能带 Info 新报/
      )
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
    } finally { teardown(root) }
  })

  test("verify_tool passed + boundary_expansion → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_tool", verdict: "passed", boundary_expansion: { allowed_directories: ["src/extra"] } },
          makeCtx("openspec-reviewer-tool", wt)
        ),
        /passed=true 时不允许边界扩展/
      )
    } finally { teardown(root) }
  })
})

// ── G12: task 层完成守卫 ──

describe("G12. task 层完成守卫", () => {
  test("verify_task 未完成时 quality reviewer 提交 verify_quality → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, makeCtx("openspec-reviewer-style", wt)),
        /submit 校验失败/
      )
    } finally { teardown(root) }
  })
})

// ── G13: tool 层二次提交守卫 ──

describe("G13. verify_tool 二次提交守卫", () => {
  test("verify_tool passed 后再提交 → 抛错（重复提交守卫优先于 currentStep 校验）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR),
        /重复提交守卫/
      )
    } finally { teardown(root) }
  })
})

// ── G14: task 层二次提交守卫 ──

describe("G14. verify_task 二次提交守卫", () => {
  test("verify_task passed 后再提交 → 抛错（重复提交守卫优先于 currentStep 校验）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTask(wt, CID)
      const ids = taskIdsOf(readItem(wt, CID))
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ids },
        ctx.taskR
      )
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ids },
          ctx.taskR
        ),
        /重复提交守卫/
      )
    } finally { teardown(root) }
  })
})

// ── G15: 豁免完整性门禁 ──

describe("G15. 豁免完整性门禁", () => {
  test("存在未裁定豁免申请时对应 reviewer passed → 不推进", async () => {
    const { wt, root } = fresh()
    try {
      await setupExemptRequest(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed" },
        makeCtx("openspec-reviewer-style", wt)
      )
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_quality")
      const child = item.children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("review")
      expect(child.metadata["exempt_request"]).toBeDefined()
    } finally { teardown(root) }
  })
})

// ── G16: 层失败回退 ──

describe("G16. 层失败回退 implement", () => {
  test("verify_tool failed（带 Low+ 新报理由）→ 回 implement，后续层级提交被拒", async () => {
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
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(metaOf(item, "_retryCount")).toBe(1)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed" }, ctx.taskR),
        /submit 校验失败/
      )
    } finally { teardown(root) }
  })

  test("verify_task failed → 回 implement，后续层级提交被拒", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTask(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: ["1", "2"], failed_tasks: [{ task_id: "3", reason: "Incomplete" }],
        },
        ctx.taskR
      )
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims["style"]),
        /submit 校验失败/
      )
    } finally { teardown(root) }
  })
})

// ── G17: rejectReason 存储与清除 ──

describe("G17. rejectReason 存储", () => {
  test("verify_task failed → task child reject_reason 落盘", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: ["1", "2"], failed_tasks: [{ task_id: "3", reason: "Output file not found" }],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      const tasks = taskListOf(readItem(wt, CID))
      expect(tasks.find((t: any) => t.id === "3").status).toBe("rejected")
      expect(tasks.find((t: any) => t.id === "3").rejectReason).toBe("Output file not found")
    } finally { teardown(root) }
  })

  test("dev 修复后 rejectReason 清除并回 submitted", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTask(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: ["1", "2"], failed_tasks: [{ task_id: "3", reason: "Incomplete" }],
        },
        ctx.taskR
      )
      // 已自动回 implement，dev 重新提交全部 task
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        ctx.dev
      )
      const tasks = taskListOf(readItem(wt, CID))
      expect(tasks.find((t: any) => t.id === "3").status).toBe("submitted")
      expect(tasks.find((t: any) => t.id === "3").rejectReason).toBeNull()
    } finally { teardown(root) }
  })
})

// ── G18: verify_tool test_results 参数 ──

describe("G18. verify_tool test_results 参数", () => {
  test("提交 verify_tool 携带 test_results → 写入 metadata", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", test_results: "Tests run: 42, Passed: 42, Failed: 0" },
        ctx.toolR
      )
      expect(metaOf(readItem(wt, CID), "test_results")).toBe("Tests run: 42, Passed: 42, Failed: 0")
    } finally { teardown(root) }
  })
})

// ── G20: passed=false 守卫放宽 + 分层重置 ──

describe("G20. passed=false 守卫放宽 + 分层重置", () => {
  test("verify_tool failed + new_children → 回 implement（passed=false 允许带 Low+ 新报）", async () => {
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
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("verify_task failed 仅带 Info new_children（无 Low+ 理由）→ 拒绝且零状态变更", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await expectError(
        agent_submit.execute(
          {
            change_id: CID, step_id: "verify_task", verdict: "failed",
            verified_tasks: ["1", "2", "3"],
            new_children: [{ id: "7", title: "建议", description: "d", severity: "Info", dimension: "style" }],
          },
          makeCtx("openspec-reviewer-task", wt)
        ),
        /不存在未解决的阻塞 issue/
      )
      expect(readItem(wt, CID).currentStep).toBe("verify_task")
    } finally { teardown(root) }
  })

  test("verify_task failed 带 failed_tasks + Info new_children → 正常回 implement", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: ["1", "2"], failed_tasks: [{ task_id: "3", reason: "验收未过" }],
          new_children: [{ id: "7", title: "建议", description: "d", severity: "Info", dimension: "style" }],
        },
        makeCtx("openspec-reviewer-task", wt)
      )
      expect(readItem(wt, CID).currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("dev 修复 task 层 issue → verify_tool/verify_task 验证标记清除", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      rewriteItem(wt, (item) => { item.phase = "in_progress"; item.currentStep = "implement" })
      injectIssue(wt, { id: "5", sourcePhase: "task", dimension: "style", severity: "Medium", description: "task issue", suggestion: "fix" })
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: ["5"], completed_task_ids: taskIdsOf(readItem(wt, CID)) },
        ctx.dev
      )
      const tags = readItem(wt, CID).tags
      expect(tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

// ── G22: review failed 必须带不通过理由（对齐 main assertPassedConsistency）──

describe("G22. review failed 必须带不通过理由", () => {
  test("verify_quality failed 不带具体问题（无 new_children、无遗留阻塞）→ 拒绝且零状态变更", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "failed" }, ctx.dims["style"]),
        /AI 审查层\(style\) 审核声称 passed=false[\s\S]*不存在未解决的阻塞 issue/
      )
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_quality")
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("verify_tool failed 不带具体问题 → 拒绝且零状态变更", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "failed" }, ctx.toolR),
        /工具层 审核声称 passed=false[\s\S]*不存在未解决的阻塞 issue/
      )
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
    } finally { teardown(root) }
  })

  test("verify_task failed 不带具体问题（无 failed_tasks、无 new_children）→ 拒绝且零状态变更", async () => {
    const { wt, root } = fresh()
    try {
      await driveToVerifyTask(wt, CID)
      await expectError(
        agent_submit.execute(
          { change_id: CID, step_id: "verify_task", verdict: "failed", verified_tasks: ["1", "2", "3"] },
          makeCtx("openspec-reviewer-task", wt)
        ),
        /任务层 审核声称 passed=false[\s\S]*不存在未解决的阻塞 issue/
      )
      expect(readItem(wt, CID).currentStep).toBe("verify_task")
    } finally { teardown(root) }
  })

  test("遗留阻塞 issue 可作为 failed 理由：已存在未终态 Low+ tool 层 child → verify_tool failed 合法", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      injectIssue(wt, { id: "9", sourcePhase: "tool", dimension: "style", severity: "Low", description: "遗留工具层问题" })
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "failed" }, ctx.toolR)
      expect(readItem(wt, CID).currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("verify_task 遗留 task 层 Low+ 阻塞 child 可作为 failed 理由", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTask(wt, CID)
      injectIssue(wt, { id: "9", sourcePhase: "task", dimension: "style", severity: "Low", description: "遗留任务层问题" })
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "failed", verified_tasks: ["1", "2", "3"] },
        ctx.taskR
      )
      expect(readItem(wt, CID).currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("verify_quality failed 理由按当前 agent 维度过滤：他维遗留阻塞不计为本维理由", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      injectIssue(wt, { id: "9", sourcePhase: "quality", dimension: "architecture", severity: "Low", description: "架构遗留问题" })
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "failed" }, ctx.dims["style"]),
        /AI 审查层\(style\) 审核声称 passed=false[\s\S]*不存在未解决的阻塞 issue/
      )
      // 归属本维的遗留阻塞 → architecture 维 failed 合法（聚合等待，不立即回退）
      const r = await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "failed" }, ctx.dims["architecture"])
      expect(r).toContain("提交成功")
    } finally { teardown(root) }
  })
})

// ── G21: implement completed_task_ids 校验 ──

describe("G21. implement completed_task_ids 校验", () => {
  test("不传 completed_task_ids + 有 open task → 抛错", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed" }, ctx.dev),
        /未在 completed_task_ids 中/
      )
    } finally { teardown(root) }
  })

  test("completed_task_ids 漏掉 open task → 抛错且消息含 task id 和 title", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1"] }, ctx.dev),
        /未在 completed_task_ids 中[\s\S]*#2[\s\S]*Task two/
      )
    } finally { teardown(root) }
  })

  test("所有 open task 均在 completed_task_ids → 提交成功", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
        ctx.dev
      )
      expect(taskListOf(readItem(wt, CID)).every((t: any) => t.status === "submitted")).toBe(true)
    } finally { teardown(root) }
  })

  test("全部 task 已 submitted → 不传 completed_task_ids 提交成功", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      rewriteItem(wt, (item) => { item.phase = "in_progress"; item.currentStep = "implement" })
      const r = await agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed" }, ctx.dev)
      expect(r).toContain("提交成功")
    } finally { teardown(root) }
  })

  test("implement 携带 self_check_results → 写入 metadata", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"], self_check_results: "lint: pass, tests: 42/42" },
        ctx.dev
      )
      expect(metaOf(readItem(wt, CID), "self_check_results")).toBe("lint: pass, tests: 42/42")
    } finally { teardown(root) }
  })
})

// ── G19: verify_task passed 同步 tasks.md 复选框 ──

describe("G19. verify_task passed 同步 tasks.md 复选框", () => {
  test("verify_task passed 且全部 task 验证通过 → tasks.md [ ] → [x]", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await set_worktree.execute({ change_id: CID }, ctx.orch)
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)

      const worktreePath = readItem(wt, CID).metadata["worktree_path"] as string
      const tasksMdPath = join(worktreePath, "openspec", "changes", CID, "tasks.md")
      expect(readFileSync(tasksMdPath, "utf-8")).toContain("- [ ] 1.1 Task one")

      const ids = taskIdsOf(readItem(wt, CID))
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ids },
        ctx.taskR
      )
      const after = readFileSync(tasksMdPath, "utf-8")
      expect(after).toContain("- [x] 1.1 Task one")
      expect(after).not.toContain("- [ ] 1.1 Task one")
    } finally { teardown(root) }
  })

  test("verify_task failed（部分失败）→ 不标记复选框", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await set_worktree.execute({ change_id: CID }, ctx.orch)
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)

      const worktreePath = readItem(wt, CID).metadata["worktree_path"] as string
      const tasksMdPath = join(worktreePath, "openspec", "changes", CID, "tasks.md")

      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: ["1", "2"], failed_tasks: [{ task_id: "3", reason: "验收未过" }],
        },
        ctx.taskR
      )
      const after = readFileSync(tasksMdPath, "utf-8")
      expect(after).toContain("- [ ] 1.1 Task one")
      expect(after).not.toContain("- [x] 1.1 Task one")
    } finally { teardown(root) }
  })
})
