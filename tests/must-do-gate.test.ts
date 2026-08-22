/**
 * 质量门必做清单（must_do）覆盖度门禁与 giveup 侧门测试。
 *
 * 覆盖（对应实施项 2/3/5/6）：
 * - 提交遗漏必做项（无 skip_reason）→ 拒绝
 * - 遗漏但带合法结构化 skip_reason → 通过
 * - 带非结构化 skip_reason → 拒绝
 * - 非质量门 step 或未声明 must_do 的 skill → 不受影响（优雅降级）
 * - giveup 路径无法无痕绕过覆盖度核对（缺理由拒绝 / 带结构化理由放行并留痕）
 *
 * skill 索引注入：helpers.setupWorkspace 默认注入空索引（EMPTY_MUST_DO_INDEX）豁免存量测试；
 * 本文件用例显式注入构造索引（含 quality-gate 声明 must_do）验证门禁。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { agent_submit } from "../src/adapters/opencode/tools"
import type { SkillTagIndex } from "../src/skills/resolve"
import {
  parseSkipReason, uncoveredMustDo, resolveMustDoForCaps, isValidSkipData,
  __setMustDoIndex, EMPTY_MUST_DO_INDEX,
} from "../src/core/tools/gate"
import { makeCtx, FakeGitRunner, setupWorkspace } from "./helpers"
import { driveToVerifyTool, driveToVerifyTask, DIMENSION_AGENTS } from "./helpers-workflow"

const CID = "must-do"

const EB = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

/** 构造一个声明 must_do 的 quality-gate skill 索引（简化必做清单 3 项）。 */
function makeQualityGateIndex(items: string[] = ["compile", "static_analysis", "deep_scan"]): SkillTagIndex {
  return {
    tagMap: new Map([
      ["quality-gate", ["quality-gate"]],
      ["efficiency", ["code-efficiency"]],
      ["api-testing", ["api-test"]],
    ]),
    skillTags: new Map([
      ["quality-gate", ["quality-gate"]],
      ["code-efficiency", ["efficiency"]],
      ["api-test", ["api-testing"]],
    ]),
    skillMustDo: new Map([["quality-gate", items]]),
  }
}

/** capability 命中但 skill 未声明 must_do（优雅降级：该 skill 不参与覆盖度门禁）。 */
function makeNoMustDoIndex(): SkillTagIndex {
  return {
    tagMap: new Map([["quality-gate", ["quality-gate"]]]),
    skillTags: new Map([["quality-gate", ["quality-gate"]]]),
    skillMustDo: new Map(),
  }
}

const FULL_STEPS = [
  { step: "compile", completed: true, evidence: "BUILD SUCCESS" },
  { step: "static_analysis", completed: true, evidence: "0 violations" },
  { step: "deep_scan", completed: true, evidence: "quality gate OK" },
]

const REASONS_ALL = [
  { item: "compile", category: "env_unavailable", adjudication: "env_unavailable", note: "docker 不可用已尝试恢复" },
  { item: "static_analysis", category: "env_unavailable", adjudication: "env_unavailable", note: "docker 不可用已尝试恢复" },
  { item: "deep_scan", category: "env_unavailable", adjudication: "env_unavailable", note: "docker 不可用已尝试恢复" },
]

function readItem(wt: string): any {
  const state = JSON.parse(readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8"))
  return state?.workItems?.find((w: any) => w.id === "task:1")
}

/** 驱动到 verify_tool（step 未提交），返回 worktree 根。 */
async function driveToTool(wt: string): Promise<void> {
  await driveToVerifyTool(wt, CID)
}

// ─── 单元级：skip_reason 结构化解析 ───

describe("parseSkipReason 结构化解析", () => {
  test("合法 JSON（三要素齐全）→ ok", () => {
    const r = parseSkipReason('{"item":"deep_scan","category":"env_unavailable","adjudication":"user_response","note":"x"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.item).toBe("deep_scan")
  })

  test("非 JSON 文本 → 拒绝", () => {
    const r = parseSkipReason("无 UI 变更")
    expect(r.ok).toBe(false)
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

// ─── 单元级：必做清单覆盖度推导 ───

describe("uncoveredMustDo / resolveMustDoForCaps", () => {
  const idx = makeQualityGateIndex()

  test("全覆盖 → 未覆盖为空", () => {
    expect(uncoveredMustDo(["quality-gate"], FULL_STEPS, idx)).toEqual([])
  })

  test("缺 deep_scan → 返回缺项", () => {
    const steps = FULL_STEPS.filter((s) => s.step !== "deep_scan")
    expect(uncoveredMustDo(["quality-gate"], steps, idx)).toEqual(["deep_scan"])
  })

  test("step 名称首段匹配（deep_scan: SonarQube → 覆盖 deep_scan）", () => {
    const steps = [
      { step: "compile", completed: true },
      { step: "static_analysis", completed: true },
      { step: "deep_scan: SonarQube 深度扫描", completed: true },
    ]
    expect(uncoveredMustDo(["quality-gate"], steps, idx)).toEqual([])
  })

  test("未声明 must_do 的 skill → 未覆盖为空（优雅降级）", () => {
    expect(uncoveredMustDo(["quality-gate"], [], makeNoMustDoIndex())).toEqual([])
  })

  test("caps 空 / 无 quality-gate 能力 → 未覆盖为空（不误伤非质量门 step）", () => {
    expect(uncoveredMustDo(undefined, [], idx)).toEqual([])
    expect(uncoveredMustDo(["api-testing"], [], idx)).toEqual([])
  })

  test("resolveMustDoForCaps 合并多个 skill 清单并去重", () => {
    const both: SkillTagIndex = {
      ...idx,
      skillMustDo: new Map([
        ["quality-gate", ["compile", "static_analysis", "deep_scan"]],
        ["java-quality-gate", ["compile", "format", "static_analysis"]],
      ]),
      tagMap: new Map([...idx.tagMap, ["tech-stack-java", ["java-quality-gate"]]]),
      skillTags: new Map([...idx.skillTags, ["java-quality-gate", ["quality-gate", "tech-stack-java"]]]),
    }
    const caps = ["quality-gate", "tech-stack-java"]
    expect(resolveMustDoForCaps(caps, both)).toEqual(["compile", "static_analysis", "deep_scan", "format"])
  })

  test("EMPTY 索引下任何 caps 都不产出必做清单", () => {
    expect(uncoveredMustDo(["quality-gate"], [], EMPTY_MUST_DO_INDEX)).toEqual([])
  })

  test("no_change 全量豁免声明 → 整体豁免必做清单（无变更/注释性变更直提不误伤）", () => {
    const idx = makeQualityGateIndex()
    const exemptStep = [
      { step: "no_change", completed: false, skip_reason: '{"item":"full_quality_gate","category":"no_change","adjudication":"user_response","note":"无代码/配置变更，直提"}' },
    ]
    expect(uncoveredMustDo(["quality-gate"], exemptStep, idx)).toEqual([])
    // 不声明 no_change 时仍逐项要求覆盖
    expect(uncoveredMustDo(["quality-gate"], [], idx)).toEqual(["compile", "static_analysis", "deep_scan"])
  })

  test("核验申报形态（step 名首段命中 + completed=true + 核验方式与抽验样本描述）→ 视为已覆盖", () => {
    const idx = makeQualityGateIndex()
    const steps = [
      { step: "compile", completed: true },
      { step: "static_analysis", completed: true },
      { step: "deep_scan: 核验 dev 申报并抽验命中项（本地复跑单规则静态分析验证命中真实存在）", completed: true },
    ]
    expect(uncoveredMustDo(["quality-gate"], steps, idx)).toEqual([])
  })

  test("低成本项以核验形态申报：机制层 token 命中即覆盖（白名单约束由 workflow 指令与门禁错误提示承载，非门禁拦截）", () => {
    const idx = makeQualityGateIndex()
    const steps = [
      { step: "compile: 核验 dev 申报", completed: true },
      { step: "static_analysis", completed: true },
      { step: "deep_scan", completed: true },
    ]
    expect(uncoveredMustDo(["quality-gate"], steps, idx)).toEqual([])
  })
})

// ─── 集成：verify_tool 提交门禁 ───

describe("verify_tool 提交必做清单覆盖度门禁", () => {
  async function freshAtTool(root: string): Promise<{ wt: string; fakeGit: FakeGitRunner }> {
    const wt = setupWorkspace(root, CID)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await driveToTool(wt)
    return { wt, fakeGit }
  }

  test("passed 无 validation_steps → 拒绝（遗漏全部必做项）", async () => {
    const root = `/tmp/mdg-1-${Date.now()}`
    const { wt } = await freshAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/必做清单/)
      expect(err.message).toContain("deep_scan")
      // 状态不变：仍停在 verify_tool 未通过
      expect(readItem(wt).currentStep).toBe("verify_tool")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("passed 遗漏 deep_scan（无 skip_reason）→ 拒绝并指明缺项", async () => {
    const root = `/tmp/mdg-2-${Date.now()}`
    const { wt } = await freshAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const steps = FULL_STEPS.filter((s) => s.step !== "deep_scan")
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", validation_steps: steps },
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/缺少以下必做项/)
      expect(err.message).toContain("deep_scan")
      // 低成本必做项实跑口径在门禁错误提示中明示（核验申报白名单回归固化）
      expect(err.message).toContain("低成本必做项必须实跑后申报")
      expect(err.message).toContain("核验申报仅限 workflow 指令白名单限定的高成本必做项")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("passed 全覆盖 → 通过并推进 verify_task", async () => {
    const root = `/tmp/mdg-3-${Date.now()}`
    const { wt } = await freshAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", validation_steps: FULL_STEPS },
        makeCtx("openspec-reviewer-tool", wt),
      )
      const item = readItem(wt)
      expect(item.currentStep).toBe("verify_task")
      expect(item.metadata["validation_steps"]).toHaveLength(3)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("遗漏必做项但带合法结构化 skip_reason → 通过（视为已处理）", async () => {
    const root = `/tmp/mdg-4-${Date.now()}`
    const { wt } = await freshAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const steps = [
        { step: "compile", completed: true, evidence: "BUILD SUCCESS" },
        { step: "static_analysis", completed: true, evidence: "0 violations" },
        {
          step: "deep_scan", completed: false,
          skip_reason: '{"item":"deep_scan","category":"env_unavailable","adjudication":"env_unavailable","note":"SonarQube 容器无法启动，已尝试 docker compose up 与重启"}',
        },
      ]
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", validation_steps: steps },
        makeCtx("openspec-reviewer-tool", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("未完成项带非结构化 skip_reason（一句话）→ 拒绝", async () => {
    const root = `/tmp/mdg-5-${Date.now()}`
    const { wt } = await freshAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const steps = [
        ...FULL_STEPS.filter((s) => s.step !== "deep_scan"),
        { step: "deep_scan", completed: false, skip_reason: "无 UI 变更" },
      ]
      const err = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", validation_steps: steps },
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/结构化/)
      expect(err.message).toContain("deep_scan")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("非质量门 step（verify_task）passed → 不受必做清单门禁影响", async () => {
    const root = `/tmp/mdg-6-${Date.now()}`
    const wt = setupWorkspace(root, CID)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await driveToVerifyTask(wt, CID)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      // verify_task 的 capability 解析不出 quality-gate 必做清单 → 即使无 validation_steps 也放行
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] },
        makeCtx("openspec-reviewer-task", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_quality")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("无变更直提（no_change 豁免声明）→ passed 放行并推进", async () => {
    const root = `/tmp/mdg-8-${Date.now()}`
    const { wt } = await freshAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const steps = [
        {
          step: "no_change", completed: false,
          skip_reason: '{"item":"full_quality_gate","category":"no_change","adjudication":"user_response","note":"无代码/配置变更，直提"}',
        },
      ]
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", validation_steps: steps },
        makeCtx("openspec-reviewer-tool", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("skill 未声明 must_do → verify_tool passed 无 validation_steps 也放行（优雅降级）", async () => {
    const root = `/tmp/mdg-7-${Date.now()}`
    const { wt } = await freshAtTool(root)
    __setMustDoIndex(makeNoMustDoIndex())
    try {
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        makeCtx("openspec-reviewer-tool", wt),
      )
      expect(readItem(wt).currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ─── 集成：giveup 侧门 ───

describe("giveup 无法无痕绕过覆盖度核对", () => {
  async function freshCheckpointAtTool(root: string): Promise<{ wt: string; fakeGit: FakeGitRunner }> {
    const wt = setupWorkspace(root, CID)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await driveToTool(wt)
    // 置检查点态：_checkpoint=true（对齐 opx_agent_submit.test 的检查点构造方式）
    const statePath = join(wt, "openspec", "states", `${CID}.json`)
    const state = JSON.parse(readFileSync(statePath, "utf-8"))
    const item = state.workItems.find((w: any) => w.id === "task:1")
    item.metadata["_checkpoint"] = true
    writeFileSync(statePath, JSON.stringify(state, null, 2))
    return { wt, fakeGit }
  }

  const giveupParams = (extra: Record<string, unknown> = {}) => ({
    change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "giveup", ...extra,
  })

  test("verify_tool giveup 无结构化降级理由 → 拒绝（未覆盖必做项缺理由）", async () => {
    const root = `/tmp/mdg-g1-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const err = await agent_submit.execute(
        giveupParams(),
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/giveup 无法应用/)
      expect(err.message).toContain("compile")
      expect(err.message).toContain("deep_scan")
      // 拒绝后状态不变：仍处于检查点态，未推进
      expect(readItem(wt).metadata["_giveup"]).toBeUndefined()
      expect(readItem(wt).currentStep).toBe("verify_tool")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("giveup 提供的降级理由缺部分必做项 → 拒绝并列出剩余缺项", async () => {
    const root = `/tmp/mdg-g2-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const err = await agent_submit.execute(
        giveupParams({ checkpoint_skip_reasons: [REASONS_ALL[0], REASONS_ALL[1]] }),
        makeCtx("openspec-reviewer-tool", wt),
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("deep_scan")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("giveup 提供的降级理由格式非法 → 不计入已处理，仍拒绝", async () => {
    const root = `/tmp/mdg-g3-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
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

  test("giveup 全覆盖结构化理由 → 放行并留痕（_giveup_validation），推进到 verify_task", async () => {
    const root = `/tmp/mdg-g4-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const r = await agent_submit.execute(
        giveupParams({ checkpoint_skip_reasons: REASONS_ALL }),
        makeCtx("openspec-reviewer-tool", wt),
      )
      expect(r).toContain("giveup")
      const item = readItem(wt)
      expect(item.metadata["_giveup"]).toBe(true)
      expect(item.metadata["_giveup_validation"]).toEqual(REASONS_ALL)
      // giveup 沿 on_pass 推进到下一 step（verify_task）
      expect(item.currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("skill 未声明 must_do → verify_tool giveup 无理由也放行（不误伤）", async () => {
    const root = `/tmp/mdg-g5-${Date.now()}`
    const { wt } = await freshCheckpointAtTool(root)
    __setMustDoIndex(makeNoMustDoIndex())
    try {
      const r = await agent_submit.execute(
        giveupParams(),
        makeCtx("openspec-reviewer-tool", wt),
      )
      expect(r).toContain("giveup")
      expect(readItem(wt).currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("非质量门 step（verify_quality）giveup → 无理由放行推进 verify_cleanup（不误伤）", async () => {
    const root = `/tmp/mdg-g6-${Date.now()}`
    const wt = setupWorkspace(root, CID)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await driveToVerifyTask(wt, CID)
    await agent_submit.execute(
      { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1", "2", "3"] },
      makeCtx("openspec-reviewer-task", wt),
    )
    // verify_quality 检查点态
    const statePath = join(wt, "openspec", "states", `${CID}.json`)
    const state = JSON.parse(readFileSync(statePath, "utf-8"))
    const item = state.workItems.find((w: any) => w.id === "task:1")
    item.metadata["_checkpoint"] = true
    writeFileSync(statePath, JSON.stringify(state, null, 2))
    __setMustDoIndex(makeQualityGateIndex())
    try {
      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed", checkpoint_decision: "giveup" },
        makeCtx(`openspec-reviewer-${DIMENSION_AGENTS[0]}`, wt),
      )
      expect(r).toContain("giveup")
      // verify_quality 不再是末位 step：giveup 后沿 on_pass 推进到 verify_cleanup
      expect(readItem(wt).phase).toBe("review")
      expect(readItem(wt).currentStep).toBe("verify_cleanup")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

afterAll(() => {
  __setGitRunner(null)
  __setMustDoIndex(null)
})
