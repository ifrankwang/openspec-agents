/**
 * 必做清单门禁测试（G2：参数收敛为 must_do_checks + 双端门禁）。
 *
 * 覆盖：
 * - 单元级：skip_reason 结构化解析、生效清单按会话项目栈解析、覆盖度推导
 * - 单元级：申报格式（completed=true 必须有 evidence；completed=false 必须有合法结构化 skip_reason）
 * - review 端（verify_tool）：缺申报拒绝 / 逐项齐全通过 / 非结构化 skip_reason 拒绝 / 无清单不误伤 / no_change 豁免
 * - implement 端：缺申报拒绝 / 逐项齐全通过 / 不回落上一轮存档 / no_change 无代码变更放行、有代码变更拒绝
 * - 会话项目栈过滤：backend 不要求 e2e、frontend 不要求 api、legacy 只要求 always
 * - giveup 侧门：按当前 step 的按 step 存档判定，缺理由拒绝
 * - 旧参数 validation_steps 已从参数面移除（schema 不再声明 + 传了也不算申报）
 * - 视图：本 step 必做清单区块（id + 词表要求 + 证据 + 提交示例）；部署注意点走 deployment_notes
 *
 * 注入方式：helpers 的自动补申装饰器让存量用例免逐处构造申报；本文件拒绝路径用例一律显式传
 * must_do_checks（含空数组 / 缺项），或注入构造分组后走真实提交路径。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { agent_submit, status } from "../src/adapters/opencode/tools"
import {
  parseSkipReason, uncoveredMustDo, resolveStepMustDo, isValidSkipData,
  assertMustDoCoverage, mustDoChecksOfStep,
  __setMustDoOverride, EXEMPT_ALL_MUST_DO,
} from "../src/core/tools/gate"
import { agentSubmitSchema } from "../src/core/tools/schemas"
import { MUST_DO_CATALOG } from "../src/core/workflow/loader"
import { makeCtx, FakeGitRunner, setupWorkspace, fullMustDoChecks } from "./helpers"
import { setupToAnalyze, driveToVerifyTool, driveToVerifyTask, DIMENSION_AGENTS } from "./helpers-workflow"

const CID = "must-do"

const EB = { allowed_directories: ["src"], allowed_packages: ["com.p"], notes: "" }

/** 构造 3 项 always 必做清单的 step 声明（简化门禁用例）。 */
const STEP_3 = { must_do: { always: ["compile", "static_analysis", "deep_scan"] } }

/** 撤销注入：走真实 workflow step.must_do 声明。 */
function useRealDeclaration(): void {
  __setMustDoOverride(null)
}

/** 注入固定必做清单（忽略 step，全 step 同清单，供单元级推导用例）。 */
function useItems(items: string[]): void {
  __setMustDoOverride(() => ({ always: items }))
}

const FULL_CHECKS = [
  { step: "compile", completed: true, evidence: "BUILD SUCCESS" },
  { step: "static_analysis", completed: true, evidence: "0 violations" },
  { step: "deep_scan", completed: true, evidence: "quality gate OK" },
]

const REASONS_ALL = [
  { item: "compile", category: "env_unavailable", adjudication: "env_unavailable", note: "docker 不可用已尝试恢复" },
  { item: "static_analysis", category: "env_unavailable", adjudication: "env_unavailable", note: "docker 不可用已尝试恢复" },
  { item: "deep_scan", category: "env_unavailable", adjudication: "env_unavailable", note: "docker 不可用已尝试恢复" },
]

const NO_CHANGE_CHECK = {
  step: "no_change", completed: false,
  skip_reason: '{"item":"full_quality_gate","category":"no_change","adjudication":"user_response","note":"无代码/配置变更，直提"}',
}

function readItem(wt: string): any {
  const state = JSON.parse(readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8"))
  return state?.workItems?.find((w: any) => w.id === "task:1")
}

function writeItem(wt: string, mutate: (item: any) => void): void {
  const statePath = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(statePath, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

/** 驱动到 verify_tool（step 未提交），返回 worktree 根与 fake git。 */
async function freshAtTool(root: string): Promise<{ wt: string; fakeGit: FakeGitRunner }> {
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  await driveToVerifyTool(wt, CID)
  return { wt, fakeGit }
}

/** 驱动到 implement（analyze 已 passed），返回 worktree 根与 fake git。 */
async function freshAtImplement(root: string): Promise<{ wt: string; fakeGit: FakeGitRunner }> {
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  const ctx = await setupToAnalyze(wt, CID)
  await agent_submit.execute(
    { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
    ctx.arch,
  )
  return { wt, fakeGit }
}

// ─── 单元级：skip_reason 结构化解析 ───

describe("parseSkipReason 结构化解析", () => {
  test("合法 JSON（三要素齐全）→ ok", () => {
    const r = parseSkipReason('{"item":"deep_scan","category":"env_unavailable","adjudication":"user_response","note":"x"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.item).toBe("deep_scan")
  })

  test("非 JSON 文本 → 拒绝", () => {
    expect(parseSkipReason("无 UI 变更").ok).toBe(false)
  })

  test("缺 item / category / adjudication 任一字段 → 拒绝", () => {
    expect(parseSkipReason('{"category":"c","adjudication":"user_response"}').ok).toBe(false)
    expect(parseSkipReason('{"item":"a","adjudication":"user_response"}').ok).toBe(false)
    expect(parseSkipReason('{"item":"a","category":"c"}').ok).toBe(false)
  })

  test("adjudication 非法取值 → 拒绝", () => {
    expect(parseSkipReason('{"item":"a","category":"c","adjudication":"manual_override"}').ok).toBe(false)
  })

  test("isValidSkipData 对象形态校验", () => {
    expect(isValidSkipData({ item: "a", category: "c", adjudication: "user_response" })).toBe(true)
    expect(isValidSkipData({ item: "a", category: "c", adjudication: "bogus" })).toBe(false)
    expect(isValidSkipData({ category: "c", adjudication: "user_response" })).toBe(false)
  })
})

// ─── 单元级：覆盖度与格式 ───

describe("uncoveredMustDo / resolveStepMustDo", () => {
  test("全覆盖 → 未覆盖为空", () => {
    expect(uncoveredMustDo(STEP_3, FULL_CHECKS)).toEqual([])
  })

  test("缺 deep_scan → 返回缺项", () => {
    expect(uncoveredMustDo(STEP_3, FULL_CHECKS.filter((s) => s.step !== "deep_scan"))).toEqual(["deep_scan"])
  })

  test("step 名称首段匹配（deep_scan: SonarQube → 覆盖 deep_scan）", () => {
    const checks = [
      { step: "compile", completed: true },
      { step: "static_analysis", completed: true },
      { step: "deep_scan: SonarQube 深度扫描", completed: true },
    ]
    expect(uncoveredMustDo(STEP_3, checks)).toEqual([])
  })

  test("无 must_do 声明的 step → 未覆盖为空（不误伤）", () => {
    expect(uncoveredMustDo(undefined, [])).toEqual([])
    expect(uncoveredMustDo({}, [])).toEqual([])
    expect(uncoveredMustDo({ must_do: { always: [] } }, [])).toEqual([])
  })

  test("no_change 全量豁免声明 → 整体豁免必做清单", () => {
    expect(uncoveredMustDo(STEP_3, [NO_CHANGE_CHECK])).toEqual([])
    expect(uncoveredMustDo(STEP_3, [])).toEqual(["compile", "static_analysis", "deep_scan"])
  })

  test("核验申报形态（step 名首段命中 + completed=true）→ 视为已覆盖", () => {
    const checks = [
      { step: "compile", completed: true },
      { step: "static_analysis", completed: true },
      { step: "deep_scan: 核验 dev 申报并抽验命中项", completed: true },
    ]
    expect(uncoveredMustDo(STEP_3, checks)).toEqual([])
  })

  test("生效清单 = always + 会话命中的栈分组（去重、保持声明顺序）", () => {
    const step = {
      must_do: {
        always: ["compile", "behavior_surface"],
        backend: ["api_script", "chain_map"],
        frontend: ["e2e_script"],
      },
    }
    const backend = { project_stacks: ["backend"], project_frameworks: ["java"] }
    const frontend = { project_stacks: ["frontend"], project_frameworks: ["vue"] }
    const both = { project_stacks: ["backend", "frontend"], project_frameworks: ["java", "vue"] }

    expect(resolveStepMustDo(step, backend)).toEqual(["compile", "behavior_surface", "api_script", "chain_map"])
    expect(resolveStepMustDo(step, frontend)).toEqual(["compile", "behavior_surface", "e2e_script"])
    expect(resolveStepMustDo(step, both)).toEqual([
      "compile", "behavior_surface", "api_script", "chain_map", "e2e_script",
    ])
    // 旧会话（null）：只取 always，技术栈分组不并入
    expect(resolveStepMustDo(step, null)).toEqual(["compile", "behavior_surface"])
    // 无会话上下文（undefined）：always + 全部分组
    expect(resolveStepMustDo(step)).toEqual([
      "compile", "behavior_surface", "api_script", "chain_map", "e2e_script",
    ])
  })

  test("分组键重复的 id 去重（always 与栈分组并存时只保留首次出现）", () => {
    const step = { must_do: { always: ["compile"], backend: ["compile", "api_script"] } }
    expect(resolveStepMustDo(step, { project_stacks: ["backend"], project_frameworks: ["java"] })).toEqual([
      "compile", "api_script",
    ])
  })

  test("backend 会话不要求 e2e / frontend 会话不要求 api / legacy 只要求 always", () => {
    const step = {
      must_do: {
        always: ["compile"],
        backend: ["api_script", "api_execution"],
        frontend: ["e2e_script", "e2e_run"],
      },
    }
    const backend = { project_stacks: ["backend"], project_frameworks: ["java"] }
    const frontend = { project_stacks: ["frontend"], project_frameworks: ["vue"] }
    const onlyAlways = [{ step: "compile", completed: true, evidence: "e" }]

    // backend 会话：api 项是必做，e2e 项根本不进生效清单
    expect(uncoveredMustDo(step, onlyAlways, backend)).toEqual(["api_script", "api_execution"])
    // frontend 会话：e2e 项是必做，api 项不要求
    expect(uncoveredMustDo(step, onlyAlways, frontend)).toEqual(["e2e_script", "e2e_run"])
    // legacy 会话：只取 always，申报 always 即通过
    expect(uncoveredMustDo(step, onlyAlways, null)).toEqual([])
  })
})

describe("assertMustDoCoverage 申报格式与覆盖度", () => {
  test("completed=true 无 evidence → 拒绝（指出必做项）", () => {
    expect(() => assertMustDoCoverage(["compile"], [{ step: "compile", completed: true }]))
      .toThrow(/未提供证据（evidence）/)
  })

  test("completed=true 空串 evidence → 拒绝", () => {
    expect(() => assertMustDoCoverage(["compile"], [{ step: "compile", completed: true, evidence: "   " }]))
      .toThrow(/未提供证据（evidence）/)
  })

  test("completed=false 无 skip_reason → 拒绝", () => {
    expect(() => assertMustDoCoverage(["compile"], [{ step: "compile", completed: false }]))
      .toThrow(/未提供跳过原因/)
  })

  test("completed=false 非结构化 skip_reason → 拒绝", () => {
    expect(() => assertMustDoCoverage(["compile"], [{ step: "compile", completed: false, skip_reason: "无 UI 变更" }]))
      .toThrow(/结构化/)
  })

  test("completed=false + 合法结构化 skip_reason → 通过（视为已处理）", () => {
    const check = { step: "compile", completed: false, skip_reason: JSON.stringify(REASONS_ALL[0]) }
    expect(() => assertMustDoCoverage(["compile"], [check])).not.toThrow()
  })

  test("无必做清单（requiredItems 为空）→ 只校验格式，不要求覆盖", () => {
    expect(() => assertMustDoCoverage([], undefined)).not.toThrow()
    expect(() => assertMustDoCoverage([], [])).not.toThrow()
    expect(() => assertMustDoCoverage([], [{ step: "x", completed: true }])).toThrow(/evidence/)
  })

  test("漏项 → 拒绝并列出缺项", () => {
    expect(() => assertMustDoCoverage(["compile", "deep_scan"], [{ step: "compile", completed: true, evidence: "e" }]))
      .toThrow(/deep_scan/)
  })

  test("no_change 声明 → 覆盖度整体豁免（格式仍需合法）", () => {
    expect(() => assertMustDoCoverage(["compile", "deep_scan"], [NO_CHANGE_CHECK])).not.toThrow()
    expect(() => assertMustDoCoverage(["compile"], [{ step: "no_change", completed: false }])).toThrow(/跳过原因/)
  })
})

// ─── review 端：verify_tool 提交门禁 ───

describe("review 端 verify_tool 必做项门禁", () => {
  test("passed 无 must_do_checks → 拒绝（遗漏全部必做项），零状态变更", async () => {
    const root = `/tmp/mdg-1-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", must_do_checks: [] },
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未覆盖本 step 的必做清单/)
      expect(err.message).toContain("deep_scan")
      // 拒绝后状态不变：仍停在 verify_tool 未通过
      expect(readItem(wt).currentStep).toBe("verify_tool")
      expect(readItem(wt).tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("passed 逐项齐全 → 通过并推进 verify_task，申报按 step 存档", async () => {
    const root = `/tmp/mdg-2-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", must_do_checks: FULL_CHECKS },
        makeCtx("openspec-reviewer-tool", wt),
      )
      const item = readItem(wt)
      expect(item.currentStep).toBe("verify_task")
      expect(mustDoChecksOfStep(item.metadata, "verify_tool")).toHaveLength(3)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("completed=true evidence 为空 → 拒绝", async () => {
    const root = `/tmp/mdg-3-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile"])
    try {
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", must_do_checks: [{ step: "compile", completed: true, evidence: "" }] },
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/evidence/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("completed=false 无 skip_reason → 拒绝", async () => {
    const root = `/tmp/mdg-4-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile"])
    try {
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", must_do_checks: [{ step: "compile", completed: false }] },
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/跳过原因/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("未完成项带非结构化 skip_reason（一句话）→ 拒绝", async () => {
    const root = `/tmp/mdg-5-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile"])
    try {
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", must_do_checks: [{ step: "compile", completed: false, skip_reason: "无 UI 变更" }] },
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/结构化/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("verdict=failed 不查覆盖度（空申报也可提交）", async () => {
    const root = `/tmp/mdg-6-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      const r = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "d", severity: "Low", dimension: "style" }],
          must_do_checks: [],
        },
        makeCtx("openspec-reviewer-tool", wt),
      )
      expect(r).toContain("提交成功")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("step 无必做清单 → 不要求必做项申报（不误伤）", async () => {
    const root = `/tmp/mdg-7-${Date.now()}`
    const wt = setupWorkspace(root, CID)
    __setGitRunner(new FakeGitRunner())
    await driveToVerifyTask(wt, CID)
    __setMustDoOverride(EXEMPT_ALL_MUST_DO)
    try {
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx("openspec-reviewer-task", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_quality")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("no_change 豁免声明 → passed 放行并推进", async () => {
    const root = `/tmp/mdg-8-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", must_do_checks: [NO_CHANGE_CHECK] },
        makeCtx("openspec-reviewer-tool", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("真实 workflow 声明：verify_task 未申报被拒，逐项申报后推进 verify_quality", async () => {
    const root = `/tmp/mdg-9-${Date.now()}`
    const wt = setupWorkspace(root, CID)
    __setGitRunner(new FakeGitRunner())
    await driveToVerifyTask(wt, CID)
    useRealDeclaration()
    try {
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"], must_do_checks: [] },
        makeCtx("openspec-reviewer-task", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      for (const id of ["behavior_surface", "case_matrix", "negative_probe", "api_script", "api_execution", "chain_map"]) {
        expect(err.message).toContain(id)
      }
      expect(readItem(wt).currentStep).toBe("verify_task")

      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"],
          must_do_checks: fullMustDoChecks(wt, CID, "verify_task", "独立核验完成"),
        },
        makeCtx("openspec-reviewer-task", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_quality")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ─── implement 端门禁 ───

describe("implement 端必做项门禁", () => {
  const TASK_IDS = ["1", "2", "3"]

  test("缺 must_do_checks → 拒绝（不回落到其他 step 的存档）", async () => {
    const root = `/tmp/mdg-impl-1-${Date.now()}`
    const { wt } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      // 预置别 step 的存档：implement 门禁只读本轮参数，不得把别处存档当本轮通过
      writeItem(wt, (item) => {
        item.metadata["must_do_checks_by_step"] = {
          verify_tool: fullMustDoChecks(wt, CID, "verify_tool"),
        }
      })
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS, must_do_checks: [] },
        makeCtx("openspec-developer", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未覆盖本 step 的必做清单/)
      expect(err.message).toContain("compile")
      expect(readItem(wt).currentStep).toBe("implement")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("逐项齐全 → 通过并推进 verify_tool，申报落 implement 档", async () => {
    const root = `/tmp/mdg-impl-2-${Date.now()}`
    const { wt } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS,
          must_do_checks: fullMustDoChecks(wt, CID, "implement", "mvn compile / 覆盖 82%"),
        },
        makeCtx("openspec-developer", wt),
      )
      const item = readItem(wt)
      expect(item.currentStep).toBe("verify_tool")
      expect(mustDoChecksOfStep(item.metadata, "implement").length).toBeGreaterThan(0)
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("completed=true 无 evidence → 拒绝", async () => {
    const root = `/tmp/mdg-impl-3-${Date.now()}`
    const { wt } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS,
          must_do_checks: [{ step: "compile", completed: true }],
        },
        makeCtx("openspec-developer", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/evidence/)
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("completed=false 无 skip_reason → 拒绝", async () => {
    const root = `/tmp/mdg-impl-4-${Date.now()}`
    const { wt } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS,
          must_do_checks: [{ step: "compile", completed: false }],
        },
        makeCtx("openspec-developer", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/跳过原因/)
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no_change 声明 + 确无代码变更（fake git 无 diff 输出）→ 放行", async () => {
    const root = `/tmp/mdg-impl-5-${Date.now()}`
    const { wt } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS, must_do_checks: [NO_CHANGE_CHECK] },
        makeCtx("openspec-developer", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_tool")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no_change 声明但有代码变更 → 拒绝（不采信自述）", async () => {
    const root = `/tmp/mdg-impl-6-${Date.now()}`
    const { wt, fakeGit } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      const baseRef = readItem(wt).metadata["base_ref"] as string
      expect(typeof baseRef).toBe("string")
      fakeGit.diffNameOnlyByRange.set(`${baseRef}..HEAD`, "src/main/App.java\nopenspec/changes/must-do/proposal.md")
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS, must_do_checks: [NO_CHANGE_CHECK] },
        makeCtx("openspec-developer", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/no_change/)
      expect(err.message).toContain("src/main/App.java")
      expect(readItem(wt).currentStep).toBe("implement")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no_change 声明但缺 base_ref（无法界定变更区间）→ 拒绝，零状态变更", async () => {
    const root = `/tmp/mdg-impl-9-${Date.now()}`
    const { wt } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      // 抹掉 base_ref：豁免理由无法用变更检测核对，不得凭自述放行
      writeItem(wt, (item) => { delete item.metadata["base_ref"] })
      expect(readItem(wt).metadata["base_ref"]).toBeUndefined()
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS, must_do_checks: [NO_CHANGE_CHECK] },
        makeCtx("openspec-developer", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("无法界定变更区间")
      // 拒绝零状态变更：仍停在 implement，申报未落存档
      const item = readItem(wt)
      expect(item.currentStep).toBe("implement")
      expect(item.metadata["must_do_checks_by_step"]).toBeUndefined()
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("仅文档类变更的 no_change 声明 → 放行（文档变更不算代码变更）", async () => {
    const root = `/tmp/mdg-impl-7-${Date.now()}`
    const { wt, fakeGit } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      const baseRef = readItem(wt).metadata["base_ref"] as string
      fakeGit.diffNameOnlyByRange.set(`${baseRef}..HEAD`, "openspec/changes/must-do/proposal.md")
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS, must_do_checks: [NO_CHANGE_CHECK] },
        makeCtx("openspec-developer", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_tool")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("区间仅含 README.md 等根目录 .md → 放行（文档类判定统一走 isDocLikePath）", async () => {
    const root = `/tmp/mdg-impl-10-${Date.now()}`
    const { wt, fakeGit } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      const baseRef = readItem(wt).metadata["base_ref"] as string
      fakeGit.diffNameOnlyByRange.set(`${baseRef}..HEAD`, "README.md")
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS, must_do_checks: [NO_CHANGE_CHECK] },
        makeCtx("openspec-developer", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_tool")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("docs/ 下 .md 同样是文档类 → 放行（不被 hasNonDocChange 误判为代码变更）", async () => {
    const root = `/tmp/mdg-impl-11-${Date.now()}`
    const { wt, fakeGit } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      const baseRef = readItem(wt).metadata["base_ref"] as string
      fakeGit.diffNameOnlyByRange.set(`${baseRef}..HEAD`, "docs/guide.md\nREADME.md")
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS, must_do_checks: [NO_CHANGE_CHECK] },
        makeCtx("openspec-developer", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_tool")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("变更检测查询失败（无文件可列 + 变更标记异常）→ 拒绝，提示无法核对", async () => {
    const root = `/tmp/mdg-impl-12-${Date.now()}`
    const { wt, fakeGit } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      // git diff 查询失败 → detectChanges 返回 files=[] 且 hasNonDocChange=true（安全侧降级）
      fakeGit.failDiff = true
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS, must_do_checks: [NO_CHANGE_CHECK] },
        makeCtx("openspec-developer", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/无法核对/)
      const item = readItem(wt)
      expect(item.currentStep).toBe("implement")
      expect(item.metadata["must_do_checks_by_step"]).toBeUndefined()
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("deployment_notes 存档到 metadata.deployment_notes（空串条目丢弃）", async () => {
    const root = `/tmp/mdg-impl-8-${Date.now()}`
    const { wt } = await freshAtImplement(root)
    useRealDeclaration()
    try {
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: TASK_IDS,
          must_do_checks: fullMustDoChecks(wt, CID, "implement"),
          deployment_notes: ["新增功能开关需在部署前开启", "  "],
        },
        makeCtx("openspec-developer", wt),
      )
      expect(readItem(wt).metadata["deployment_notes"]).toEqual(["新增功能开关需在部署前开启"])
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ─── 旧参数移除 ───

describe("旧参数 validation_steps 已从参数面移除", () => {
  test("schema：不再声明 validation_steps / self_check_results / test_results，新增 must_do_checks / deployment_notes", () => {
    const props = agentSubmitSchema.properties ?? {}
    expect(props["validation_steps"]).toBeUndefined()
    expect(props["self_check_results"]).toBeUndefined()
    expect(props["test_results"]).toBeUndefined()
    expect(props["must_do_checks"]).toBeDefined()
    expect(props["deployment_notes"]).toBeDefined()
    // 未知参数一律拒绝（additionalProperties:false）
    expect(agentSubmitSchema.additionalProperties).toBe(false)
  })

  test("传旧参数 validation_steps 不算申报 → 门禁按未申报拒绝", async () => {
    const root = `/tmp/mdg-legacy-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile"])
    try {
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "passed",
          // 旧参数已从契约移除，此处刻意构造：自动补申被显式必须参数占位绕过
          must_do_checks: [],
          validation_steps: FULL_CHECKS,
        } as never,
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/缺少以下必做项|未覆盖本 step 的必做清单/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ─── giveup 侧门 ───

describe("giveup 按当前 step 存档判定", () => {
  async function freshCheckpointAtTool(root: string): Promise<{ wt: string }> {
    const { wt } = await freshAtTool(root)
    writeItem(wt, (item) => { item.metadata["_checkpoint"] = true })
    return { wt }
  }

  /** 显式带 checkpoint_skip_reasons（默认空数组）：helpers 的自动补申只对「未携带该参数」生效，
   *  拒绝路径用例必须以显式空数组关闭补申。 */
  const giveupParams = (extra: Record<string, unknown> = {}) => ({
    change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "giveup",
    checkpoint_skip_reasons: [], ...extra,
  })

  test("无结构化降级理由 → 拒绝（未覆盖必做项缺理由），零状态变更", async () => {
    const root = `/tmp/mdg-g1-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      const err = await agent_submit.execute(giveupParams(), makeCtx("openspec-reviewer-tool", wt)).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/giveup 无法应用/)
      expect(err.message).toContain("compile")
      expect(err.message).toContain("deep_scan")
      expect(readItem(wt).metadata["_giveup"]).toBeUndefined()
      expect(readItem(wt).currentStep).toBe("verify_tool")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("理由缺部分必做项 → 拒绝并列出剩余缺项", async () => {
    const root = `/tmp/mdg-g2-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      const err = await agent_submit.execute(
        giveupParams({ checkpoint_skip_reasons: [REASONS_ALL[0], REASONS_ALL[1]] }),
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("deep_scan")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("理由格式非法 → 不计入已处理，仍拒绝", async () => {
    const root = `/tmp/mdg-g3-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      const bad = REASONS_ALL.map((r) => ({ ...r, adjudication: "manual_override" }))
      const err = await agent_submit.execute(
        giveupParams({ checkpoint_skip_reasons: bad }),
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/giveup 无法应用/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("本 step 已按 step 存档申报过（覆盖度成立）→ 无需理由即可 giveup", async () => {
    const root = `/tmp/mdg-g4-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      writeItem(wt, (item) => {
        item.metadata["must_do_checks_by_step"] = { verify_tool: FULL_CHECKS }
      })
      const r = await agent_submit.execute(giveupParams(), makeCtx("openspec-reviewer-tool", wt))
      expect(r).toContain("giveup")
      const item = readItem(wt)
      expect(item.metadata["_giveup"]).toBe(true)
      expect(item.currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("存档属于别的 step 不算覆盖 → 仍要求理由", async () => {
    const root = `/tmp/mdg-g5-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      writeItem(wt, (item) => {
        item.metadata["must_do_checks_by_step"] = { implement: FULL_CHECKS }
      })
      const err = await agent_submit.execute(giveupParams(), makeCtx("openspec-reviewer-tool", wt)).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/giveup 无法应用/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("全覆盖结构化理由 → 放行并留痕，推进下一 step", async () => {
    const root = `/tmp/mdg-g6-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    useItems(["compile", "static_analysis", "deep_scan"])
    try {
      const r = await agent_submit.execute(
        giveupParams({ checkpoint_skip_reasons: REASONS_ALL }),
        makeCtx("openspec-reviewer-tool", wt),
      )
      expect(r).toContain("giveup")
      const item = readItem(wt)
      expect(item.metadata["_giveup"]).toBe(true)
      expect(item.metadata["_giveup_validation"]).toEqual(REASONS_ALL)
      expect(item.currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("无必做清单的 step（verify_quality）giveup 无理由放行", async () => {
    const root = `/tmp/mdg-g7-${Date.now()}`
    const wt = setupWorkspace(root, CID)
    __setGitRunner(new FakeGitRunner())
    await driveToVerifyTask(wt, CID)
    await agent_submit.execute(
      { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] },
      makeCtx("openspec-reviewer-task", wt),
    )
    writeItem(wt, (item) => { item.metadata["_checkpoint"] = true })
    useRealDeclaration()
    try {
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed", checkpoint_decision: "giveup" },
        makeCtx(`openspec-reviewer-${DIMENSION_AGENTS[0]}`, wt),
      )
      expect(r).toContain("giveup")
      expect(readItem(wt).currentStep).toBe("verify_cleanup")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ─── 视图注入 ───

describe("视图注入必做清单与证据要求", () => {
  test("implement 视图渲染「本 step 必做清单」：id + 词表要求 + 证据要求 + must_do_checks 示例", async () => {
    const root = `/tmp/mdg-view-1-${Date.now()}`
    const wt = setupWorkspace(root, CID)
    __setGitRunner(new FakeGitRunner())
    useRealDeclaration()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        ctx.arch,
      )
      const out = await status.execute({ change_id: CID }, ctx.dev)
      expect(out).toContain("## 本 step 必做清单")
      expect(out).toContain("`compile`")
      expect(out).toContain(MUST_DO_CATALOG["compile"].description)
      expect(out).toContain("证据要求：")
      expect(out).toContain("must_do_checks")
      // 提交示例含 step/completed/evidence 三字段
      expect(out).toContain('"step": "compile", "completed": true, "evidence"')
      // 提交指引提示申报
      expect(out).toContain("必做清单")
      // implement 专属提示：no_change 事实核对 + deployment_notes
      expect(out).toContain("deployment_notes")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("backend 会话：视图清单含 api 项、不含 e2e 项（与门禁同源）", async () => {
    const root = `/tmp/mdg-view-2-${Date.now()}`
    const wt = setupWorkspace(root, CID)
    __setGitRunner(new FakeGitRunner())
    useRealDeclaration()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        ctx.arch,
      )
      const out = await status.execute({ change_id: CID }, ctx.dev)
      expect(out).toContain("`api_script`")
      expect(out).not.toContain("`e2e_script`")
    } finally {
      __setMustDoOverride(EXEMPT_ALL_MUST_DO)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("检查点视图按当前 step 渲染必做清单与 giveup 申报要求", async () => {
    const root = `/tmp/mdg-view-3-${Date.now()}`
    const { wt } = await freshAtTool(root)
    useItems(["compile", "static_analysis"])
    try {
      writeItem(wt, (item) => { item.metadata["_checkpoint"] = true })
      const out = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer-tool", wt))
      expect(out).toContain("当前 step 的必做清单")
      expect(out).toContain("`compile`")
      expect(out).toContain("checkpoint_skip_reasons")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

afterAll(() => {
  __setGitRunner(null)
  __setMustDoOverride(null)
})
