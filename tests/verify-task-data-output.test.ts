/**
 * 任务验证数据产出要求框架契约测试（变更：关键数据产出断言落位）。
 *
 * 覆盖：
 * 1. task.yaml / task-simple.yaml 的 implement 自证须含关键数据产出断言（字段持久化到 spec 指定承载位置、搬迁承接与基线一致）
 * 2. verify_task / quality_review 逐项验证须含⑥关键数据产出核验；纯测试代码豁免句同步升级为⑤⑥
 * 3. api-test skill 含关键数据产出覆盖行与「数据模型搬迁与数据产出回归」小节
 * 4. openspec-reviewer agent 含关键数据产出缺失/未落库/落错位置判例与测试审查断言要求
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { loadWorkflowFile, TASK_WORKFLOW_PATH, SIMPLE_WORKFLOW_PATH } from "../src/core/workflow/loader"

const REPO_ROOT = join(import.meta.dir, "..")

function stepInstructions(filePath: string, stepId: string): string {
  const wf = loadWorkflowFile(filePath)
  const step = wf.stepMap.get(stepId)
  if (!step) throw new Error(`workflow ${filePath} 缺 step ${stepId}`)
  return (step.step.instructions ?? []).join("\n")
}

describe("数据产出断言落位（task.yaml）", () => {
  test("implement 自证须含关键数据产出断言", () => {
    const ins = stepInstructions(TASK_WORKFLOW_PATH, "implement")
    expect(ins).toContain("关键数据产出断言")
    expect(ins).toContain("产出字段已持久化到 spec 指定承载位置且值完整非空")
    expect(ins).toContain("搬迁承接与同一输入产出基线一致")
    expect(ins).toContain("禁止仅以流程跑通/接口成功替代")
  })

  test("verify_task 逐项验证含⑥关键数据产出核验", () => {
    const ins = stepInstructions(TASK_WORKFLOW_PATH, "verify_task")
    expect(ins).toContain("关键数据产出核验")
    expect(ins).toContain("识别『流程正常但数据缺失/落错位置』类缺陷")
  })

  test("纯测试代码豁免句升级为⑤⑥", () => {
    const ins = stepInstructions(TASK_WORKFLOW_PATH, "verify_task")
    expect(ins).toContain("⑤⑥的实现核验在纯测试代码变更场景无对象，其断言证据核验并入④测试代码质量")
  })
})

describe("数据产出断言落位（task-simple.yaml）", () => {
  test("implement 自证须含关键数据产出断言", () => {
    const ins = stepInstructions(SIMPLE_WORKFLOW_PATH, "implement")
    expect(ins).toContain("关键数据产出断言")
    expect(ins).toContain("产出字段已持久化到 spec 指定承载位置且值完整非空")
    expect(ins).toContain("搬迁承接与同一输入产出基线一致")
    expect(ins).toContain("禁止仅以流程跑通/接口成功替代")
  })

  test("quality_review 逐项验证含⑥关键数据产出核验", () => {
    const ins = stepInstructions(SIMPLE_WORKFLOW_PATH, "quality_review")
    expect(ins).toContain("关键数据产出核验")
    expect(ins).toContain("识别『流程正常但数据缺失/落错位置』类缺陷")
  })

  test("纯测试代码豁免句升级为⑤⑥", () => {
    const ins = stepInstructions(SIMPLE_WORKFLOW_PATH, "quality_review")
    expect(ins).toContain("⑤⑥的实现核验在纯测试代码变更场景无对象，其断言证据核验并入④测试代码质量")
  })
})

describe("数据产出要求（skill / agent 资产）", () => {
  test("api-test skill 含关键数据产出覆盖要求与搬迁回归小节", () => {
    const skill = readFileSync(join(REPO_ROOT, "assets/skills/api-test/SKILL.md"), "utf8")
    expect(skill).toContain("关键产出字段已持久化到 spec 指定承载位置")
    expect(skill).toContain("数据模型搬迁与数据产出回归")
    expect(skill).toContain("仅凭响应 2xx 与流程跑通不构成验收")
  })

  test("openspec-reviewer agent 含数据产出缺失判例与测试审查断言要求", () => {
    const agent = readFileSync(join(REPO_ROOT, "assets/agents/openspec-reviewer.md"), "utf8")
    expect(agent).toContain("关键数据产出缺失/未落库/落错位置")
    expect(agent).toContain("未对 spec 要求的关键数据产出（落位/完整性）断言")
  })
})
