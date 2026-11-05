/**
 * 会话项目栈过滤的端到端有效断言（防「传参被删仍全绿」的假覆盖）：
 * 1. 真实 init 前端会话（frontend + vue）→ opx_status 的 Skill 加载清单不含 java-*、含 frontend-*（含 e2e）
 * 2. 真实 init 后端会话（backend + java）→ 反向：含 java-*、不含 frontend-*
 * 3. 检查点提示按过滤后必做集合判定（后端有后端独有必做项才提示，前端会话不提示）
 * 4. 旧会话（state 无 stacks）→ 清单只含通用 skill、必做清单不含技术栈分组；重新 init 补齐后恢复
 *
 * 依赖真实 skill 索引（assets/skills），用于验证 status 渲染确实把 state.stacks 传给过滤层。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { init, set_worktree, status, agent_submit } from "../src/adapters/opencode/tools"
import { makeCtx, makeOrchCtx, readState, setupWithFakeGit, teardown } from "./helpers"
import { readItem, taskIdsOf, driveToVerifyTask } from "./helpers-workflow"
import { resolveStepMustDo, __setMustDoOverride } from "../src/core/tools/gate"

const CID = "session-filter"

function tmpRoot(tag: string): string {
  return `/tmp/${CID}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/** 从 status 输出中截取「Skill 加载清单」区块（到下一个二级标题为止）。 */
function skillSection(out: string): string {
  const marker = "## Skill 加载清单"
  const start = out.indexOf(marker)
  if (start < 0) return ""
  const rest = out.slice(start + marker.length)
  const end = rest.indexOf("\n## ")
  return end < 0 ? rest : rest.slice(0, end)
}

/** 初始化 full 模式会话并推进到 implement（developer 视图可渲染）→ 返回 developer 上下文。 */
async function initToImplement(wt: string, stacks: string[], frameworks: string[]) {
  const o = makeOrchCtx(wt)
  const a = makeCtx("openspec-architect", wt)
  const d = makeCtx("openspec-developer", wt)
  await init.execute(
    { project_stacks: stacks, project_frameworks: frameworks, change_id: CID, task_group_id: "1", mode: "full" },
    o,
  )
  await set_worktree.execute({ change_id: CID }, o)
  await agent_submit.execute(
    {
      change_id: CID,
      step_id: "analyze",
      verdict: "passed",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    },
    a,
  )
  return { o, a, d }
}

describe("会话项目栈过滤集成（真实 skill 索引 + opx_status）", () => {
  test("前端会话（frontend + vue）：清单含前端 skill（含 e2e），不含 java-*", async () => {
    const root = tmpRoot("frontend")
    try {
      const { worktree: wt } = setupWithFakeGit(root, CID)
      const { d } = await initToImplement(wt, ["frontend"], ["vue"])
      const out = await status.execute({ change_id: CID }, d)
      const section = skillSection(out)
      expect(section).toContain("`frontend-quality-gate`")
      expect(section).toContain("`frontend-e2e`") // implement 已挂 e2e-testing，开发者可拿到 e2e skill
      expect(section).toContain("`quality-gate`") // 通用 skill 始终加载
      expect(section).not.toContain("`java-")
    } finally {
      teardown(root)
    }
  })

  test("后端会话（backend + java）：清单含 Java 技术栈 skill，不含 frontend-*", async () => {
    const root = tmpRoot("backend")
    try {
      const { worktree: wt } = setupWithFakeGit(root, CID)
      const { d } = await initToImplement(wt, ["backend"], ["java"])
      const out = await status.execute({ change_id: CID }, d)
      const section = skillSection(out)
      expect(section).toContain("`java-quality-gate`")
      expect(section).toContain("`java-dev-practices`")
      expect(section).toContain("`quality-gate`")
      expect(section).not.toContain("`frontend-")
      expect(section).not.toContain("`frontend-e2e`")
    } finally {
      teardown(root)
    }
  })

  test("检查点提示按过滤后必做集合判定：后端会话提示、前端会话不提示", async () => {
    const root = tmpRoot("checkpoint")
    try {
      const { worktree: wt } = setupWithFakeGit(root, CID)
      const o = makeOrchCtx(wt)
      const a = makeCtx("openspec-architect", wt)
      const d = makeCtx("openspec-developer", wt)
      const toolR = makeCtx("openspec-reviewer-tool", wt)
      await init.execute(
        { project_stacks: ["backend"], project_frameworks: ["java"], change_id: CID, task_group_id: "1", mode: "full" },
        o,
      )
      await set_worktree.execute({ change_id: CID }, o)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
        a,
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(readItem(wt, CID, "1")) },
        d,
      )
      // 注入「只有 backend 分组」的 step 必做清单：后端会话生效集合非空，前端会话为空
      __setMustDoOverride(() => ({ always: [], backend: ["compile"] }))

      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const state = readState(wt, CID) as any
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.metadata["_checkpoint"] = true
      writeFileSync(statePath, JSON.stringify(state))

      const backendOut = await status.execute({ change_id: CID }, toolR)
      expect(backendOut).toContain("检查点")
      expect(backendOut).toContain("checkpoint_skip_reasons") // 后端会话解析出 Java 独有必做项 → 渲染 giveup 申报提示

      // 同一检查点状态改成前端会话：Java 技术栈 skill 被过滤，必做集合为空 → 不渲染该提示
      const stateFrontend = readState(wt, CID) as any
      stateFrontend.stacks = { project_stacks: ["frontend"], project_frameworks: ["vue"] }
      writeFileSync(statePath, JSON.stringify(stateFrontend))
      const frontendOut = await status.execute({ change_id: CID }, toolR)
      expect(frontendOut).toContain("检查点")
      expect(frontendOut).not.toContain("checkpoint_skip_reasons")
    } finally {
      __setMustDoOverride(null)
      teardown(root)
    }
  })

  test("旧会话（state 无 stacks）：清单只含通用 skill、must_do 不含技术栈项；重新 init 补齐后恢复", async () => {
    const root = tmpRoot("legacy")
    try {
      const { worktree: wt } = setupWithFakeGit(root, CID)
      const { d } = await initToImplement(wt, ["backend"], ["java"])
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const legacy = JSON.parse(readFileSync(statePath, "utf-8"))
      delete legacy.stacks
      writeFileSync(statePath, JSON.stringify(legacy))

      // 1) 清单只含通用 skill（不列 java-* / frontend-*），并给出补齐指引
      const out = await status.execute({ change_id: CID }, d)
      expect(out).toContain("旧会话未固化项目栈")
      expect(out).toContain("project_stacks")
      const section = skillSection(out)
      expect(section).toContain("`quality-gate`")
      expect(section).not.toContain("`java-")
      expect(section).not.toContain("`frontend-")

      // 2) 必做清单同口径：旧会话（null）只取 always 分组，技术栈分组不参与
      // 纯函数语义校验需先摘掉用例环境的整体豁免注入
      __setMustDoOverride(null)
      const stepDecl = { must_do: { always: ["compile"], backend: ["api_script"], frontend: ["e2e_script"] } }
      expect(resolveStepMustDo(stepDecl, null)).toEqual(["compile"])
      expect(resolveStepMustDo(stepDecl)).toEqual(["compile", "api_script", "e2e_script"]) // 无会话上下文不过滤
      expect(resolveStepMustDo(stepDecl, { project_stacks: ["backend"], project_frameworks: ["java"] })).toEqual([
        "compile", "api_script",
      ])

      // 3) 重新 init 带会话栈（旧会话无 stacks → 补齐），视图恢复按新声明过滤
      const initOut = await init.execute(
        { project_stacks: ["frontend"], project_frameworks: ["vue"], change_id: CID, task_group_id: "1", mode: "full" },
        makeOrchCtx(wt),
      )
      expect(initOut).toContain("已为旧会话补齐项目栈")
      const restoredOut = await status.execute({ change_id: CID }, d)
      expect(restoredOut).not.toContain("旧会话未固化项目栈")
      const restoredSection = skillSection(restoredOut)
      expect(restoredSection).toContain("`frontend-quality-gate`")
      expect(restoredSection).not.toContain("`java-")
    } finally {
      teardown(root)
    }
  })

  test("legacy 会话走 verify_task 提交：必做清单只取 always 分组（三项），不含 api/e2e 项", async () => {
    const root = tmpRoot("legacy-submit")
    try {
      const { worktree: wt } = setupWithFakeGit(root, CID)
      const { ctx } = await driveToVerifyTask(wt, CID)
      // 剥离 stacks 模拟升级在途旧会话（state 无项目栈）
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const legacy = JSON.parse(readFileSync(statePath, "utf-8"))
      delete legacy.stacks
      writeFileSync(statePath, JSON.stringify(legacy))
      // 真实 workflow 声明驱动门禁：后端会话另需 api_script/api_execution，
      // legacy（session=null）只取 always 三项
      __setMustDoOverride(null)
      await agent_submit.execute(
        {
          change_id: CID,
          step_id: "verify_task",
          verdict: "passed",
          verified_tasks: ["1", "2", "3"],
          must_do_checks: [
            { step: "behavior_surface: 行为面清单", completed: true, evidence: "测试证据" },
            { step: "case_matrix: 用例矩阵", completed: true, evidence: "测试证据" },
            { step: "negative_probe: 探针记录", completed: true, evidence: "测试证据" },
          ],
        },
        ctx.taskR,
      )
      expect(readItem(wt, CID, "1").currentStep).toBe("verify_quality")
    } finally {
      __setMustDoOverride(null)
      teardown(root)
    }
  })
})
