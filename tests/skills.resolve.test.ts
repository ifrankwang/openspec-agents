/**
 * skill 解析模块（resolve.ts）单测：
 * - resolveSkillsForCapabilities tag 匹配
 * - scanSkillTags 进程内缓存
 * - task.yaml / issue.yaml 各 step capability_tags 经 loadWorkflow 可解析
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  scanSkillTags,
  resolveSkillsForCapabilities,
  getEfficiencySkills,
  getToolImprovementSkills,
} from "../src/skills/resolve"
import { loadWorkflow } from "../src/core/workflow/loader"

describe("resolveSkillsForCapabilities tag 匹配", () => {
  test("caps 命中 → skillNames 非空", () => {
    const r = resolveSkillsForCapabilities(["efficiency"])
    expect(r.skillNames.length).toBeGreaterThan(0)
    expect(r.skillNames).toContain("code-efficiency")
  })

  test("api-testing 命中 api-test", () => {
    const r = resolveSkillsForCapabilities(["api-testing"])
    expect(r.skillNames).toContain("api-test")
  })

  test("tool-improvement 命中 java-quality-tool-improve", () => {
    const r = resolveSkillsForCapabilities(["tool-improvement"])
    expect(r.skillNames).toContain("java-quality-tool-improve")
  })

  test("tech-stack tag 归 techStackOnly，generic tag 归 generic", () => {
    const r = resolveSkillsForCapabilities(["quality-gate", "efficiency"])
    expect(r.generic).toContain("quality-gate")
    expect(r.generic).toContain("code-efficiency")
    expect(r.techStackOnly).toContain("java-quality-gate")
    expect([...r.generic, ...r.techStackOnly].sort()).toEqual([...r.skillNames].sort())
  })

  test("无匹配 tag → 三列表均为空", () => {
    const r = resolveSkillsForCapabilities(["no-such-capability"])
    expect(r.skillNames).toEqual([])
    expect(r.generic).toEqual([])
    expect(r.techStackOnly).toEqual([])
  })

  test("caps 为空/undefined → 空数组", () => {
    expect(resolveSkillsForCapabilities(undefined).skillNames).toEqual([])
    expect(resolveSkillsForCapabilities([]).skillNames).toEqual([])
    expect(resolveSkillsForCapabilities(undefined).generic).toEqual([])
    expect(resolveSkillsForCapabilities(undefined).techStackOnly).toEqual([])
  })
})

describe("scanSkillTags 进程内缓存", () => {
  test("默认 roots 两次调用返回同一实例", () => {
    const a = scanSkillTags()
    const b = scanSkillTags()
    expect(a).toBe(b)
    expect(a.tagMap).toBe(b.tagMap)
    expect(a.skillTags).toBe(b.skillTags)
  })

  test("skill 索引内容正确", () => {
    const a = scanSkillTags()
    expect(a.skillTags.get("code-efficiency")).toEqual(["efficiency"])
    expect(a.tagMap.get("efficiency")).toContain("code-efficiency")
  })
})

describe("getEfficiencySkills / getToolImprovementSkills", () => {
  test("efficiency tag 命中效率类 skill", () => {
    expect(getEfficiencySkills()).toContain("code-efficiency")
  })

  test("tool-improvement tag 命中工具改进类 skill", () => {
    expect(getToolImprovementSkills()).toContain("java-quality-tool-improve")
  })
})

describe("workflow YAML capability_tags 可解析", () => {
  const readWf = (name: string) => loadWorkflow(readFileSync(join(import.meta.dir, "..", "assets", "workflows", name), "utf8"))

  test("task.yaml 各 step capability_tags 经 loadWorkflow 解析且可 resolve", () => {
    const wf = readWf("task.yaml")
    const expectResolvable = (stepId: string, expected: string[]) => {
      const step = wf.stepMap.get(stepId)!.step
      expect(step.capability_tags).toEqual(expected)
      const r = resolveSkillsForCapabilities(step.capability_tags)
      expect(r.skillNames.length).toBeGreaterThan(0)
    }
    expectResolvable("analyze", ["architecture", "api-design", "db-design", "efficiency"])
    expectResolvable("implement", ["efficiency", "api-testing"])
    expectResolvable("verify_tool", ["quality-gate", "efficiency", "api-testing"])
    expectResolvable("verify_task", ["api-testing", "quality-gate"])
    expectResolvable("verify_quality", ["style", "architecture", "performance", "security", "maintainability", "efficiency"])
  })

  test("issue.yaml 各 step capability_tags 经 loadWorkflow 解析且可 resolve", () => {
    const wf = readWf("issue.yaml")
    const expectResolvable = (stepId: string, expected: string[]) => {
      const step = wf.stepMap.get(stepId)!.step
      expect(step.capability_tags).toEqual(expected)
      const r = resolveSkillsForCapabilities(step.capability_tags)
      expect(r.skillNames.length).toBeGreaterThan(0)
    }
    expectResolvable("triage", ["architecture", "efficiency"])
    expectResolvable("fix", ["efficiency"])
    expectResolvable("verify_fix", ["quality-gate", "efficiency"])
  })

  test("既有测试断言的 skill 名由两个来源兜底产出", () => {
    const wf = readWf("task.yaml")
    const yamlTags = new Set<string>()
    for (const step of wf.phases.flatMap((p) => p.steps)) {
      for (const t of step.capability_tags || []) yamlTags.add(t)
    }
    const fromYaml = resolveSkillsForCapabilities([...yamlTags])
    expect(fromYaml.skillNames).toContain("code-efficiency")
    expect(fromYaml.skillNames).toContain("api-test")
    expect(resolveSkillsForCapabilities(["tool-improvement"]).skillNames).toContain("java-quality-tool-improve")
  })
})
