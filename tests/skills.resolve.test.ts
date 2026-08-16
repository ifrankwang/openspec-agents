/**
 * skill 解析模块（resolve.ts）单测：
 * - resolveSkillsForCapabilities tag 匹配
 * - scanSkillTags 进程内缓存
 * - task.yaml 各 agent 级 capability_tags 经 loadWorkflow 可解析
 * - loader 对 agents 对象数组 schema 的校验（缺 id / 缺 tags / tags 非字符串数组 / 旧字符串形式）
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  scanSkillTags,
  resolveSkillsForCapabilities,
  getEfficiencySkills,
  getSkillMustDo,
} from "../src/skills/resolve"
import { loadWorkflow } from "../src/core/workflow/loader"
import { stepAgentIds } from "../src/core/workflow/types"

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

  test("dev-practices 命中 java-dev-practices（techStackOnly 组）", () => {
    const r = resolveSkillsForCapabilities(["dev-practices"])
    expect(r.skillNames).toContain("java-dev-practices")
    expect(r.techStackOnly).toContain("java-dev-practices")
    expect(r.generic).not.toContain("java-dev-practices")
  })

  test("tech-stack tag 归 techStackOnly，generic tag 归 generic", () => {
    const r = resolveSkillsForCapabilities(["quality-gate", "efficiency"])
    expect(r.generic).toContain("quality-gate")
    expect(r.generic).toContain("code-efficiency")
    expect(r.techStackOnly).toContain("java-quality-gate")
    expect([...r.generic, ...r.techStackOnly].sort()).toEqual([...r.skillNames].sort())
  })

  test("architecture 命中技术债识别 skill（generic/techStackOnly 分组）", () => {
    const r = resolveSkillsForCapabilities(["architecture"])
    expect(r.skillNames).toContain("technical-debt")
    expect(r.skillNames).toContain("java-technical-debt")
    expect(r.generic).toContain("technical-debt")
    expect(r.generic).not.toContain("java-technical-debt")
    expect(r.techStackOnly).toContain("java-technical-debt")
  })

  test("architecture 命中架构演进审查 skill（generic 组）", () => {
    const r = resolveSkillsForCapabilities(["architecture"])
    expect(r.skillNames).toContain("architecture-evolution")
    expect(r.generic).toContain("architecture-evolution")
    expect(r.techStackOnly).not.toContain("architecture-evolution")
  })

  test("其他维度 tag 不命中架构演进审查 skill（归口边界防误伤）", () => {
    for (const cap of ["maintainability", "security", "performance", "style", "db-design", "api-design", "api-testing", "dev-practices", "efficiency"]) {
      const r = resolveSkillsForCapabilities([cap])
      expect(r.skillNames).not.toContain("architecture-evolution")
    }
  })

  test("其他维度 tag 不命中技术债识别 skill（归口边界防误伤）", () => {
    for (const cap of ["maintainability", "security", "performance", "style", "db-design", "api-design", "api-testing", "dev-practices"]) {
      const r = resolveSkillsForCapabilities([cap])
      expect(r.skillNames).not.toContain("technical-debt")
      expect(r.skillNames).not.toContain("java-technical-debt")
    }
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

describe("getEfficiencySkills", () => {
  test("efficiency tag 命中效率类 skill", () => {
    expect(getEfficiencySkills()).toContain("code-efficiency")
  })

  test("不含 java-dev-practices（与 code-efficiency 解耦）", () => {
    expect(getEfficiencySkills()).not.toContain("java-dev-practices")
  })
})

describe("must_do 必做清单（机器可读）", () => {
  test("quality-gate 与 java-quality-gate 声明完整必做清单且与文档表格一一对应", () => {
    const idx = scanSkillTags()
    const expectMustDo = (name: string, expected: string[]) => {
      expect(idx.skillMustDo.get(name)).toEqual(expected)
      expect(getSkillMustDo(name)).toEqual(expected)
    }
    const items = ["env", "compile", "format", "architecture", "static_analysis", "unit_test", "coverage", "deep_scan", "config_check"]
    expectMustDo("quality-gate", items)
    // java 版第 7 行「SonarQube 深度扫描」对应 deep_scan；2-6 全量生命周期拆分为
    // compile/format/architecture/static_analysis/unit_test/coverage
    expectMustDo("java-quality-gate", items)
  })

  test("未声明 must_do 的 skill → getSkillMustDo 返回 null（不参与覆盖度门禁）", () => {
    expect(getSkillMustDo("code-efficiency")).toBeNull()
    expect(getSkillMustDo("api-test")).toBeNull()
    expect(getSkillMustDo("no-such-skill")).toBeNull()
  })

  test("verify_tool capability 解析出质量门 skill 必做清单；verify_task 解析为空（不误伤）", () => {
    const tool = resolveSkillsForCapabilities(["quality-gate", "efficiency", "api-testing"])
    const toolMustDo = tool.skillNames.flatMap((n) => getSkillMustDo(n) ?? [])
    expect(toolMustDo).toContain("deep_scan")
    expect(toolMustDo).toContain("config_check")

    const task = resolveSkillsForCapabilities(["api-testing", "efficiency", "dev-practices"])
    const taskMustDo = task.skillNames.flatMap((n) => getSkillMustDo(n) ?? [])
    expect(taskMustDo).toEqual([])
  })
})

describe("workflow YAML agent 级 capability_tags 可解析", () => {
  const readWf = (name: string) => loadWorkflow(readFileSync(join(import.meta.dir, "..", "assets", "workflows", name), "utf8"))

  test("task.yaml 各 agent capability_tags 经 loadWorkflow 解析且可 resolve", () => {
    const wf = readWf("task.yaml")
    const expectResolvable = (stepId: string, agent: string, expected: string[]) => {
      const step = wf.stepMap.get(stepId)!.step
      const a = step.agents.find((x) => x.id === agent)
      expect(a?.capability_tags).toEqual(expected)
      const r = resolveSkillsForCapabilities(a?.capability_tags)
      expect(r.skillNames.length).toBeGreaterThan(0)
    }
    expectResolvable("analyze", "openspec-architect", ["architecture", "api-design", "db-design", "efficiency"])
    expectResolvable("implement", "openspec-developer", ["efficiency", "api-testing", "quality-gate", "dev-practices", "db-design"])
    expectResolvable("verify_tool", "openspec-reviewer-tool", ["quality-gate", "efficiency", "api-testing"])
    expectResolvable("verify_task", "openspec-reviewer-task", ["api-testing", "efficiency", "dev-practices"])
    expectResolvable("verify_quality", "openspec-reviewer-style", ["style", "efficiency", "tool-improvement"])
    expectResolvable("verify_quality", "openspec-reviewer-security", ["security", "efficiency", "tool-improvement"])
  })

  test("verify_quality 全部 5 个 agent 的 capability_tags 均命中 java-quality-tool-improve", () => {
    const wf = readWf("task.yaml")
    const step = wf.stepMap.get("verify_quality")!.step
    expect(step.agents.length).toBe(5)
    for (const agent of step.agents) {
      expect(agent.capability_tags).toContain("tool-improvement")
      const r = resolveSkillsForCapabilities(agent.capability_tags)
      expect(r.skillNames).toContain("java-quality-tool-improve")
    }
  })

  test("agent 级 capability_tags 生效：style 命中 style 相关 skill，security 命中 security 相关 skill", () => {
    const style = resolveSkillsForCapabilities(["style", "efficiency"])
    expect(style.skillNames).toContain("java-code-style")
    expect(style.skillNames).not.toContain("security-baseline")
    expect(style.skillNames).not.toContain("java-security")
    const security = resolveSkillsForCapabilities(["security", "efficiency"])
    expect(security.skillNames).toContain("security-baseline")
    expect(security.skillNames).toContain("java-security")
    expect(security.skillNames).not.toContain("java-code-style")
  })

  test("既有测试断言的 skill 名由两个来源兜底产出", () => {
    const wf = readWf("task.yaml")
    const yamlTags = new Set<string>()
    for (const step of wf.phases.flatMap((p) => p.steps)) {
      for (const a of step.agents) {
        for (const t of a.capability_tags) yamlTags.add(t)
      }
    }
    const fromYaml = resolveSkillsForCapabilities([...yamlTags])
    expect(fromYaml.skillNames).toContain("code-efficiency")
    expect(fromYaml.skillNames).toContain("api-test")
    expect(resolveSkillsForCapabilities(["tool-improvement"]).skillNames).toContain("java-quality-tool-improve")
  })
})

describe("loader：agents 对象数组 schema 校验", () => {
  const wrap = (agentsYaml: string) => `id: x
max_retries: 3
phases:
  - name: review
    steps:
      - id: s1
        ${agentsYaml}
        transitions:
          on_pass: done
          on_fail: s1
`

  test("合法对象数组 → 解析出 id 与 capability_tags", () => {
    const wf = loadWorkflow(wrap(`agents:
          - id: a
            capability_tags: [style]`))
    expect(stepAgentIds(wf.stepMap.get("s1")!.step)).toEqual(["a"])
    expect(wf.stepMap.get("s1")!.step.agents[0].capability_tags).toEqual(["style"])
  })

  test("缺 id → 抛错", () => {
    expect(() => loadWorkflow(wrap(`agents:
          - capability_tags: [style]`))).toThrow(/agents\[0\]\.id/)
  })

  test("缺 capability_tags → 抛错", () => {
    expect(() => loadWorkflow(wrap(`agents:
          - id: a`))).toThrow(/capability_tags/)
  })

  test("capability_tags 非字符串数组 → 抛错", () => {
    expect(() => loadWorkflow(wrap(`agents:
          - id: a
            capability_tags: style`))).toThrow(/capability_tags/)
    expect(() => loadWorkflow(wrap(`agents:
          - id: a
            capability_tags: [1, 2]`))).toThrow(/capability_tags/)
  })

  test("字符串 agents 旧形式 → 不再支持，按新 schema 校验失败", () => {
    expect(() => loadWorkflow(wrap("agents: [a]"))).toThrow(/agents/)
  })
})
