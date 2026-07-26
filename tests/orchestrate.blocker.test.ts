import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  __setGitRunner,
  arch_blocker,
  arch_submit,
  dev_submit,
  init,
  set_worktree,
  status,
} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-blocker"

afterAll(() => { __setGitRunner(null) })

function freshWt(root: string): string {
  const wt = join(root, "w")
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), "## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n", "utf-8")
  return wt
}

function readState(wt: string): any {
  return JSON.parse(readFileSync(join(wt, ".opencode", ".orchestrate_state", `${CID}.json`), "utf-8"))
}

function output(result: string | { output: string }): string {
  return typeof result === "string" ? result : result.output
}

function boundary() {
  return { allowed_directories: ["src"], allowed_packages: ["pkg"], notes: "" }
}

describe("blocker 生命周期", () => {
  test("architect 创建 blocker → arch_blocker 更新 → arch_submit ready", async () => {
    const root = `/tmp/blocker-arch-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const orch = makeCtx("openspec-orchestrator", wt)
    const arch = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, orch)
    const createResult = output(await arch_blocker.execute({
      blockers: [{
        source_role: "openspec-architect",
        task_id: "1",
        category: "external_dependency",
        description: "缺少外部接口地址",
        evidence: "spec 未提供",
        attempted_actions: "检查 spec",
        options: ["用户提供地址"],
      }],
    } as any, arch))
    expect(createResult).toContain("已记录 1 个 blocker")

    let tg = readState(wt).taskGroups[0]
    expect(tg.blockers).toHaveLength(1)
    expect(tg.blockers[0].status).toBe("awaiting_user")

    const architectContext = output(await status.execute({}, arch))
    expect(architectContext).toContain("Blocker #b1 | awaiting_user | external_dependency")
    expect(architectContext).toContain("描述：缺少外部接口地址")
    expect(architectContext).toContain("证据：spec 未提供")
    expect(architectContext).toContain("已尝试：检查 spec")
    expect(architectContext).toContain("可选方案：用户提供地址")
    expect(architectContext).not.toContain("passed=true")

    const updateResult = output(await arch_blocker.execute({
      blocker_id: tg.blockers[0].id,
      user_response: "地址为 https://api.example.test",
    } as any, arch))
    expect(updateResult).toContain("blocker #b1 已处理")
    expect(updateResult).toContain("全部 blocker 已处理")

    tg = readState(wt).taskGroups[0]
    expect(tg.blockers[0].status).toBe("resolved")
    expect(tg.blockers[0].userResponse).toBe("地址为 https://api.example.test")

    await arch_submit.execute({ outcome: "ready", execution_boundary: boundary() } as any, arch)
    tg = readState(wt).taskGroups[0]
    expect(tg.status).toBe("dev_impl")
    expect(tg.blockers[0].status).toBe("resolved")
    expect(tg.tasks[0].status).toBe("open")
    expect(tg.phases.review.tool.completed).toBe(false)
    expect(tg.phases.review.retryCount).toBe(0)

    await set_worktree.execute({}, orch)
    expect(readState(wt).taskGroups[0].status).toBe("dev_impl")
    expect(existsSync(wt)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  test("developer status 指引使用 outcome 提交约定", async () => {
    const root = `/tmp/blocker-dev-status-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const orch = makeCtx("openspec-orchestrator", wt)
    const arch = makeCtx("openspec-architect", wt)
    const dev = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, orch)
    await arch_submit.execute({ outcome: "ready", execution_boundary: boundary() } as any, arch)
    await set_worktree.execute({}, orch)

    const developerContext = output(await status.execute({}, dev))
    expect(developerContext).toContain("outcome=completed` 或 `outcome=blocked")
    expect(developerContext).not.toContain("passed=true")
    rmSync(root, { recursive: true, force: true })
  })

  test("developer blocked 在 checkpoint 前回 task_analysis，不提交 task，保留重试计数", async () => {
    const root = `/tmp/blocker-dev-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const orch = makeCtx("openspec-orchestrator", wt)
    const arch = makeCtx("openspec-architect", wt)
    const dev = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, orch)
    await arch_submit.execute({ outcome: "ready", execution_boundary: boundary() }, arch)
    await set_worktree.execute({}, orch)
    let state = readState(wt)
    let tg = state.taskGroups[0]
    tg.phases.review.retryCount = 2
    tg.phases.review.lastResolvedRetryCount = 1
    writeFileSync(join(wt, ".opencode", ".orchestrate_state", `${CID}.json`), JSON.stringify(state, null, 2))

    const result = JSON.parse(output(await dev_submit.execute({
      outcome: "blocked",
      blocker: {
        source_role: "openspec-developer",
        task_id: "1",
        category: "real_input",
        description: "缺少真实输入",
        evidence: "测试数据不可代表生产路径",
        attempted_actions: "检查现有 fixture",
        options: ["用户提供样本"],
      },
    } as any, dev)))
    expect(result.outcome).toBe("blocked")

    tg = readState(wt).taskGroups[0]
    expect(tg.status).toBe("task_analysis")
    expect(tg.tasks[0].status).toBe("open")
    expect(tg.phases.review.retryCount).toBe(2)
    expect(tg.phases.review.lastResolvedRetryCount).toBe(1)
    expect(tg.phases.review.tool.completed).toBe(false)
    expect(tg.blockers[0].status).toBe("awaiting_user")
    rmSync(root, { recursive: true, force: true })
  })

  test("未解决 developer blocker recovery 强制回架构复核", async () => {
    for (const recoveryPhase of ["dev_impl", "review"] as const) {
      const root = `/tmp/blocker-recovery-${recoveryPhase}-${Date.now()}`
      const wt = freshWt(root)
      __setGitRunner(new FakeGitRunner())
      const orch = makeCtx("openspec-orchestrator", wt)
      const arch = makeCtx("openspec-architect", wt)
      const dev = makeCtx("openspec-developer", wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, orch)
      await arch_submit.execute({ outcome: "ready", execution_boundary: boundary() }, arch)
      await set_worktree.execute({}, orch)
      let tg = readState(wt).taskGroups[0]
      tg.phases.review.retryCount = 2
      tg.phases.review.lastResolvedRetryCount = 1
      const state = readState(wt)
      state.taskGroups[0] = tg
      writeFileSync(join(wt, ".opencode", ".orchestrate_state", `${CID}.json`), JSON.stringify(state, null, 2))

      await dev_submit.execute({
        outcome: "blocked",
        blocker: {
          source_role: "openspec-developer",
          task_id: "1",
          category: "real_input",
          description: "缺少真实输入",
          evidence: "测试数据不可代表生产路径",
          attempted_actions: "检查现有 fixture",
          options: ["用户提供样本"],
        },
      } as any, dev)

      tg = readState(wt).taskGroups[0]
      const worktreePath = tg.worktreePath
      const branchName = tg.branchName
      await init.execute({
        change_id: CID,
        task_group_id: "1",
        recovery: { phase: recoveryPhase },
      }, orch)
      await set_worktree.execute({}, orch)

      tg = readState(wt).taskGroups[0]
      expect(tg.status).toBe("task_analysis")
      expect(tg.phases.architect_review.completed).toBe(false)
      expect(tg.blockers[0].status).toBe("awaiting_user")
      expect(tg.worktreePath).toBe(worktreePath)
      expect(tg.phases.review.retryCount).toBe(2)
      expect(tg.phases.review.lastResolvedRetryCount).toBe(1)
      const orchestratorContext = output(await status.execute({}, orch))
      const nextStep = orchestratorContext.split("## 下一步")[1]
      expect(nextStep).toContain("openspec-architect")
      expect(nextStep).not.toContain("openspec-developer")
      expect(nextStep).not.toContain("openspec-reviewer-")
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("blocked 参数、dirty worktree、更新已 resolved blocker 拒绝", async () => {
    const root = `/tmp/blocker-guard-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const orch = makeCtx("openspec-orchestrator", wt)
    const arch = makeCtx("openspec-architect", wt)
    const dev = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, orch)
    await arch_submit.execute({ outcome: "ready", execution_boundary: boundary() }, arch)
    await set_worktree.execute({}, orch)
    const devWt = readState(wt).taskGroups[0].worktreePath
    fakeGit.dirtyPaths.add(devWt)
    await expect(dev_submit.execute(({ outcome: "blocked", blocker: {
      source_role: "openspec-developer", task_id: "1", category: "credential", description: "缺凭证", evidence: "env 无值", attempted_actions: "检查 env", options: ["用户提供凭证"],
    } }) as any, dev)).rejects.toThrow(/未 commit/)
    fakeGit.dirtyPaths.delete(devWt)
    await dev_submit.execute(({ outcome: "blocked", blocker: {
      source_role: "openspec-developer", task_id: "1", category: "credential", description: "缺凭证", evidence: "env 无值", attempted_actions: "检查 env", options: ["用户提供凭证"],
    } }) as any, dev)
    const blockerId = readState(wt).taskGroups[0].blockers[0].id
    await arch_blocker.execute({ blocker_id: blockerId, user_response: "已提供" } as any, arch)
    await expect(arch_blocker.execute({ blocker_id: blockerId, user_response: "重复" } as any, arch)).rejects.toThrow(/awaiting_user/)
    expect(devWt).toBe(readState(wt).taskGroups[0].worktreePath)
    rmSync(root, { recursive: true, force: true })
  })

  test("多个 blocker 全部处理后才能由架构师 arch_submit ready", async () => {
    const root = `/tmp/blocker-many-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const orch = makeCtx("openspec-orchestrator", wt)
    const arch = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, orch)
    await arch_blocker.execute({
      blockers: [
        { source_role: "openspec-architect", task_id: "1", category: "credential", description: "凭证", evidence: "缺失", attempted_actions: "检查 env", options: ["提供凭证"] },
        { source_role: "openspec-architect", task_id: "1", category: "external_dependency", description: "地址", evidence: "缺失", attempted_actions: "检查 spec", options: ["提供地址"] },
      ],
    } as any, arch)
    const blockers = readState(wt).taskGroups[0].blockers
    await arch_blocker.execute({ blocker_id: blockers[0].id, user_response: "已提供凭证" } as any, arch)
    await expect(arch_submit.execute({ outcome: "ready", execution_boundary: boundary() } as any, arch)).rejects.toThrow(/awaiting_user/)
    await arch_blocker.execute({ blocker_id: blockers[1].id, user_response: "已提供地址" } as any, arch)
    await arch_submit.execute({ outcome: "ready", execution_boundary: boundary() } as any, arch)
    expect(readState(wt).taskGroups[0].blockers.every((blocker: any) => blocker.status === "resolved")).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  test("旧状态缺 blockers 且架构已完成时归一到 dev_impl，并只提示资源准备", async () => {
    const root = `/tmp/blocker-migrate-${Date.now()}`
    const wt = freshWt(root)
    __setGitRunner(new FakeGitRunner())
    const orch = makeCtx("openspec-orchestrator", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, orch)
    const legacy = readState(wt)
    legacy.taskGroups[0].phases.architect_review.completed = true
    legacy.taskGroups[0].executionBoundary = boundary()
    delete legacy.taskGroups[0].blockers
    writeFileSync(join(wt, ".opencode", ".orchestrate_state", `${CID}.json`), JSON.stringify(legacy, null, 2))

    const outputStr = output(await status.execute({}, orch))
    expect(outputStr).toContain("**当前阶段**: dev_impl")
    expect(outputStr).toContain("opx_orch_set_worktree")
    expect(outputStr).not.toContain("openspec-developer")
    expect(outputStr).not.toContain("recovery")
    rmSync(root, { recursive: true, force: true })
  })
})
