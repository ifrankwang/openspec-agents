/**
 * verify_tool 三分支（无变更直提 / 仅复核）no_change 申报指引端到端测试（复核回环修复问题 1）。
 *
 * 场景：真实 must_do 索引（显式注入声明 must_do 的 quality-gate skill，非空索引豁免）下，
 * 评审者按 opx_status 渲染的更新后视图指引提交：
 * - 分支①（直提）：无代码/配置变更且本层无待复核/待裁定 → 视图指引以 validation_steps 含
 *   step=no_change（配合结构化 skip_reason）申报整体豁免必做清单 → 通过覆盖度门禁并推进。
 * - 分支②（仅复核/裁定）：无代码/配置变更但有本层待复核项 → 先复核再以 no_change 申报整体豁免 → 通过门禁。
 * - 对照：视图指引缺失时评审者裸提交 passed（无 validation_steps）会被门禁拒绝（复现生产破口）。
 *
 * 基建对齐 tests/must-do-gate.test.ts：FakeGitRunner + setupWorkspace + 显式注入构造索引；
 * 变更检测结果经 FakeGitRunner.diffNameOnlyDefault 置空（无已提交代码变更）驱动分支①②。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { status, agent_submit } from "../src/adapters/opencode/tools"
import type { SkillTagIndex } from "../src/skills/resolve"
import { __setMustDoIndex, EMPTY_MUST_DO_INDEX } from "../src/core/tools/gate"
import { makeCtx, FakeGitRunner, setupWorkspace } from "./helpers"
import { driveToVerifyTool } from "./helpers-workflow"

const CID = "tool-nochange"

/** 声明 must_do 的 quality-gate skill 索引（简化必做清单 3 项，与 must-do-gate.test 一致）。 */
const QUALITY_GATE_INDEX: SkillTagIndex = {
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
  skillMustDo: new Map([["quality-gate", ["compile", "static_analysis", "deep_scan"]]]),
}

function readItem(wt: string): any {
  const state = JSON.parse(readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8"))
  return state?.workItems?.find((w: any) => w.id === "task:1")
}

/** 无变更直提的整体豁免申报：step 名首段 no_change + 合法结构化 skip_reason。 */
function noChangeSteps(): Array<{ step: string; completed: boolean; skip_reason: string }> {
  return [{
    step: "no_change", completed: false,
    skip_reason: '{"item":"full_quality_gate","category":"no_change","adjudication":"user_response","note":"无代码/配置变更，直提"}',
  }]
}

/** 注入 review 态（已修复待复核）tool 层 issue child，模拟 dev 已提交 fixed_issue_ids 后待复核状态。 */
function injectToolReviewIssue(wt: string, issue: { id: string; description: string }): void {
  const statePath = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(statePath, "utf-8"))
  const item = state.workItems.find((w: any) => w.id === "task:1")
  item.children.push({
    id: `issue:${issue.id}`,
    source: "openspec",
    externalId: String(issue.id),
    type: "issue",
    title: issue.description,
    description: issue.description,
    phase: "review",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style", file: "src/a.ts", line: 1 },
    children: [],
    labels: [],
    severity: "Low",
  })
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

/** 驱动到 verify_tool 并配置「无代码/配置变更」的变更检测结果（diff 区间输出为空），返回 worktree 根。 */
async function freshAtToolNoChange(root: string): Promise<string> {
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  fakeGit.diffNameOnlyDefault = ""
  __setGitRunner(fakeGit)
  await driveToVerifyTool(wt, CID)
  return wt
}

afterAll(() => {
  __setGitRunner(null)
  __setMustDoIndex(null)
})

describe("verify_tool 无变更直提分支（分支①）no_change 申报端到端", () => {
  test("视图含 no_change 申报指引；裸提交被门禁拒绝，按指引申报整体豁免后通过并推进", async () => {
    const root = `/tmp/tnc-b1-${Date.now()}`
    const wt = await freshAtToolNoChange(root)
    __setMustDoIndex(QUALITY_GATE_INDEX)
    try {
      const toolR = makeCtx("openspec-reviewer-tool", wt)

      // 分支①直提视图：含 no_change 整体豁免申报指引（配合结构化 skip_reason）
      const view = await status.execute({ change_id: CID }, toolR)
      expect(view).toContain("无需运行全量工具检查")
      expect(view).toContain("no_change")
      expect(view).toContain("validation_steps")
      expect(view).toContain("结构化 skip_reason 格式")

      // 视图指引缺失时评审者裸提交 passed（无 validation_steps）→ 门禁拒绝（复现生产破口）
      const bareErr = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        toolR,
      ).catch((e: Error) => e)
      expect(bareErr).toBeInstanceOf(Error)
      expect(bareErr.message).toMatch(/必做清单/)
      expect(readItem(wt).currentStep).toBe("verify_tool")

      // 按视图指引提交：no_change 整体豁免 + 结构化 skip_reason → 通过门禁并推进
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", validation_steps: noChangeSteps() },
        toolR,
      )
      expect(readItem(wt).currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("verify_tool 仅复核分支（分支②）no_change 申报端到端", () => {
  test("视图含 no_change 申报指引；复核待复核项后按指引申报整体豁免 → 通过门禁并推进", async () => {
    const root = `/tmp/tnc-b2-${Date.now()}`
    const wt = await freshAtToolNoChange(root)
    injectToolReviewIssue(wt, { id: "9", description: "tool 层已修复待复核 issue" })
    __setMustDoIndex(QUALITY_GATE_INDEX)
    try {
      const toolR = makeCtx("openspec-reviewer-tool", wt)

      // 分支②仅复核视图：待复核项清单 + no_change 整体豁免申报指引
      const view = await status.execute({ change_id: CID }, toolR)
      expect(view).toContain("仅处理以下本层待复核 / 待裁定项")
      expect(view).toContain("Issue (待复核)")
      expect(view).toContain("no_change")
      expect(view).toContain("validation_steps")
      expect(view).toContain("recheck_adjudications")

      // 按视图指引：复核待复核项（passed）+ no_change 申报整体豁免 → 通过门禁并推进
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "passed",
          recheck_adjudications: [{ issue_id: "9", verdict: "passed" }],
          validation_steps: noChangeSteps(),
        },
        toolR,
      )
      const item = readItem(wt)
      expect(item.children.find((c: any) => c.externalId === "9").phase).toBe("done")
      expect(item.currentStep).toBe("verify_task")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("checkpoint 视图 giveup 申报指引（复核回环修复问题 2）", () => {
  test("质量门类 step（verify_tool）检查点视图含 checkpoint_skip_reasons 指引；空索引豁免时不渲染（不误伤非质量门 step）", async () => {
    const root = `/tmp/tnc-cp-${Date.now()}`
    const wt = await freshAtToolNoChange(root)
    const statePath = join(wt, "openspec", "states", `${CID}.json`)
    const state = JSON.parse(readFileSync(statePath, "utf-8"))
    state.workItems.find((w: any) => w.id === "task:1").metadata["_checkpoint"] = true
    writeFileSync(statePath, JSON.stringify(state, null, 2))
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    try {
      // 真实 must_do 索引：质量门类 step 检查点视图渲染 giveup 的 checkpoint_skip_reasons 申报指引
      __setMustDoIndex(QUALITY_GATE_INDEX)
      const view = await status.execute({ change_id: CID }, toolR)
      expect(view).toContain("检查点")
      expect(view).toContain("checkpoint_skip_reasons")
      expect(view).toContain("giveup")
      // 空索引豁免（解析不到质量门必做清单）：不渲染该指引，避免误伤非质量门 step 的检查点视图
      __setMustDoIndex(EMPTY_MUST_DO_INDEX)
      const emptyView = await status.execute({ change_id: CID }, toolR)
      expect(emptyView).not.toContain("checkpoint_skip_reasons")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
