import { describe, expect, test } from "bun:test"
import { loadWorkflow } from "../src/core/workflow/loader"
import { DIMENSION_AGENT_MAP } from "../src/core/constants"

const QUALITY_AGENTS = Object.values(DIMENSION_AGENT_MAP)

function makeQualityYaml(agents: string[]): string {
  return `id: quality-agents
max_retries: 3
phases:
  - name: review
    steps:
      - id: verify_quality
        agents: ${JSON.stringify(agents)}
        transitions:
          on_pass: done
          on_fail: halt
`
}

describe("verify_quality 双源一致性校验（DIMENSION_AGENT_MAP ↔ task.yaml verify_quality.agents）", () => {
  test("agents 与 DIMENSION_AGENT_MAP 值集合一致 → 正常加载", () => {
    const wf = loadWorkflow(makeQualityYaml(QUALITY_AGENTS))
    expect(wf.stepMap.get("verify_quality")?.step.agents).toEqual(QUALITY_AGENTS)
  })

  test("agents 与 DIMENSION_AGENT_MAP 值集合一致但顺序不同 → 正常加载（集合语义）", () => {
    const reversed = [...QUALITY_AGENTS].reverse()
    const wf = loadWorkflow(makeQualityYaml(reversed))
    expect(wf.stepMap.get("verify_quality")?.step.agents).toEqual(reversed)
  })

  test("agents 缺少一个维度 → 抛错", () => {
    const missing = QUALITY_AGENTS.slice(0, QUALITY_AGENTS.length - 1)
    expect(() => loadWorkflow(makeQualityYaml(missing))).toThrow(/不一致/)
  })

  test("agents 多出一个非质量维度 agent → 抛错", () => {
    const extra = [...QUALITY_AGENTS, "openspec-reviewer-tool"]
    expect(() => loadWorkflow(makeQualityYaml(extra))).toThrow(/不一致/)
  })

  test("不含 verify_quality step 的 workflow → 跳过校验正常加载", () => {
    const wf = loadWorkflow(`id: no-quality
max_retries: 3
phases:
  - name: review
    steps:
      - id: verify_tool
        agents: [openspec-reviewer-tool]
        transitions:
          on_pass: done
          on_fail: halt
`)
    expect(wf.stepMap.get("verify_tool")).toBeDefined()
  })
})
