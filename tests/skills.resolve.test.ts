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
  type SkillTagIndex,
  resolveSkillsForCapabilities,
  getEfficiencySkills,
} from "../src/skills/resolve"
import { loadWorkflow } from "../src/core/workflow/loader"
import { renderSkillSuggestions } from "../src/core/views"
import { stepAgentIds } from "../src/core/workflow/types"
import { __setKnownStackTags, knownFrameworks, knownStacks } from "../src/skills/stacks"

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

  test("dev-practices 命中 java-dev-practices（不传会话栈时不过滤）", () => {
    const r = resolveSkillsForCapabilities(["dev-practices"])
    expect(r.skillNames).toContain("java-dev-practices")
  })

  test("真实索引：后端 java 会话命中 Java 技术栈 skill，前端会话不命中", () => {
    const backend = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["backend"], project_frameworks: ["java"] })
    expect(backend.skillNames).toContain("quality-gate")
    expect(backend.skillNames).toContain("java-quality-gate")

    const frontend = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["frontend"], project_frameworks: ["vue"] })
    expect(frontend.skillNames).toContain("quality-gate")
    expect(frontend.skillNames).not.toContain("java-quality-gate")
  })

  test("真实索引：未声明 stacks / frameworks 的基座 skill 在所有会话栈下命中", () => {
    for (const session of [
      { project_stacks: ["backend"], project_frameworks: ["java"] },
      { project_stacks: ["frontend"], project_frameworks: ["vue"] },
      { project_stacks: ["frontend"], project_frameworks: ["react"] },
    ]) {
      expect(resolveSkillsForCapabilities(["test-design"], session).skillNames).toContain("test-design")
    }
  })

  test("真实索引：api-test 声明 backend 形态——后端会话命中、前端会话不命中", () => {
    expect(
      resolveSkillsForCapabilities(["api-testing"], { project_stacks: ["backend"], project_frameworks: ["java"] }).skillNames,
    ).toContain("api-test")
    expect(
      resolveSkillsForCapabilities(["api-testing"], { project_stacks: ["frontend"], project_frameworks: ["vue"] }).skillNames,
    ).not.toContain("api-test")
  })

  test("真实索引：前端 skill 声明 frameworks=[vue,react]——vue / react 会话均命中，混合会话两侧命中", () => {
    for (const frameworks of [["vue"], ["react"]]) {
      const r = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["frontend"], project_frameworks: frameworks })
      expect(r.skillNames).toContain("frontend-quality-gate")
      expect(r.skillNames).not.toContain("java-quality-gate")
    }
    const mixed = resolveSkillsForCapabilities(
      ["quality-gate"],
      { project_stacks: ["backend", "frontend"], project_frameworks: ["java", "react"] },
    )
    expect(mixed.skillNames).toContain("frontend-quality-gate")
    expect(mixed.skillNames).toContain("java-quality-gate")
  })

  test("architecture 命中技术债识别 skill（均为通用，不分组）", () => {
    const r = resolveSkillsForCapabilities(["architecture"])
    expect(r.skillNames).toContain("technical-debt")
    expect(r.skillNames).toContain("java-technical-debt")
  })

  test("architecture 命中架构演进审查 skill", () => {
    const r = resolveSkillsForCapabilities(["architecture"])
    expect(r.skillNames).toContain("architecture-evolution")
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

  test("无匹配 tag → 清单为空", () => {
    const r = resolveSkillsForCapabilities(["no-such-capability"])
    expect(r.skillNames).toEqual([])
  })

  test("caps 为空/undefined → 空数组", () => {
    expect(resolveSkillsForCapabilities(undefined).skillNames).toEqual([])
    expect(resolveSkillsForCapabilities([]).skillNames).toEqual([])
  })
})

/**
 * 会话栈过滤（构造索引，不依赖真实 skill 文件）：
 * 命中规则 = 能力维度命中 ∧ skill 声明的 stacks 与会话 project_stacks 有交集 ∧ skill 声明的
 * frameworks 与会话 project_frameworks 有交集；声明多值表示「支持其中任一」，不要求全部覆盖。
 * 未声明 stacks / frameworks 视为通用，始终命中。
 */
describe("会话项目栈过滤（stacks / frameworks 字段）", () => {
  const stackIndex: SkillTagIndex = {
    tagMap: new Map([
      ["quality-gate", ["quality-gate", "java-quality-gate", "vue-quality-gate", "fullstack-quality-gate"]],
      ["style", ["generic-style", "java-style", "vue-style"]],
    ]),
    skillTags: new Map([
      ["quality-gate", ["quality-gate"]], // 通用
      ["java-quality-gate", ["quality-gate"]],
      ["vue-quality-gate", ["quality-gate"]],
      ["fullstack-quality-gate", ["quality-gate"]],
      ["generic-style", ["style"]], // 通用
      ["java-style", ["style"]],
      ["vue-style", ["style"]],
    ]),
    skillStacks: new Map([
      ["java-quality-gate", ["backend"]],
      ["vue-quality-gate", ["frontend"]],
      ["fullstack-quality-gate", ["backend", "frontend"]],
      ["java-style", ["backend"]],
      ["vue-style", ["frontend"]],
    ]),
    skillFrameworks: new Map([
      ["java-quality-gate", ["java"]],
      ["vue-quality-gate", ["vue"]],
      ["fullstack-quality-gate", ["java", "vue"]],
      ["java-style", ["java"]],
      ["vue-style", ["vue"]],
    ]),
  }

  test("后端 java 会话命中后端与通用 skill，不命中纯前端 skill；多形态 skill 命中", () => {
    const r = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["backend"], project_frameworks: ["java"] }, stackIndex)
    expect(r.skillNames).toContain("quality-gate")
    expect(r.skillNames).toContain("java-quality-gate")
    expect(r.skillNames).toContain("fullstack-quality-gate") // 声明 backend+frontend，与 backend 有交集即命中
    expect(r.skillNames).not.toContain("vue-quality-gate")
  })

  test("前端 vue 会话命中前端与通用 skill，不命中纯后端 skill；多形态 skill 命中", () => {
    const r = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["frontend"], project_frameworks: ["vue"] }, stackIndex)
    expect(r.skillNames).toContain("quality-gate")
    expect(r.skillNames).toContain("vue-quality-gate")
    expect(r.skillNames).toContain("fullstack-quality-gate")
    expect(r.skillNames).not.toContain("java-quality-gate")
  })

  test("混合栈会话（前后端 + 多框架）两侧 skill 都可见，多形态 skill 也被覆盖", () => {
    const r = resolveSkillsForCapabilities(
      ["quality-gate"],
      { project_stacks: ["backend", "frontend"], project_frameworks: ["java", "vue"] },
      stackIndex,
    )
    expect(r.skillNames).toContain("java-quality-gate")
    expect(r.skillNames).toContain("vue-quality-gate")
    expect(r.skillNames).toContain("fullstack-quality-gate")
    expect(r.skillNames).toContain("quality-gate")
  })

  test("形态有交集但框架无交集 → 不命中（两通道同时要求交集）", () => {
    const r = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["backend"], project_frameworks: ["vue"] }, stackIndex)
    expect(r.skillNames).not.toContain("java-quality-gate")
    expect(r.skillNames).toContain("quality-gate")
  })

  test("未声明 stacks / frameworks 的 skill 在任何会话栈下都命中", () => {
    for (const session of [
      { project_stacks: ["backend"], project_frameworks: ["java"] },
      { project_stacks: ["frontend"], project_frameworks: ["vue"] },
      { project_stacks: ["frontend"], project_frameworks: ["react"] },
    ]) {
      expect(resolveSkillsForCapabilities(["style"], session, stackIndex).skillNames).toContain("generic-style")
    }
  })

  test("不传会话栈 → 不过滤（兼容无会话调用）", () => {
    const r = resolveSkillsForCapabilities(["quality-gate"], undefined, stackIndex)
    expect(r.skillNames).toContain("java-quality-gate")
    expect(r.skillNames).toContain("vue-quality-gate")
  })
})

/**
 * 交集语义（多值声明 = 支持其中任一）：同一通道只要声明非空就要求与会话有交集，
 * 不要求会话覆盖全部声明值。该语义让框架无关的 skill 可同时声明多个框架。
 */
describe("会话栈过滤（交集语义：多值声明支持任一）", () => {
  // 通道隔离索引：每个 skill 只声明待验证的通道，未声明通道留空（按通用处理）
  const idx: SkillTagIndex = {
    tagMap: new Map([["style", ["frontend-only", "multi-framework", "both-forms", "generic-style"]]]),
    skillTags: new Map([
      ["frontend-only", ["style"]],
      ["multi-framework", ["style"]],
      ["both-forms", ["style"]],
      ["generic-style", ["style"]],
    ]),
    skillStacks: new Map([
      ["frontend-only", ["frontend"]],
      ["multi-framework", ["frontend"]],
      ["both-forms", ["backend", "frontend"]],
    ]),
    skillFrameworks: new Map([
      ["multi-framework", ["vue", "react"]],
    ]),
  }
  const hit = (skill: string, stacks: string[], frameworks: string[]): boolean =>
    resolveSkillsForCapabilities(["style"], { project_stacks: stacks, project_frameworks: frameworks }, idx).skillNames.includes(skill)

  test("单值形态：会话含该形态即命中（含混合形态会话）", () => {
    expect(hit("frontend-only", ["frontend"], ["vue"])).toBe(true)
    expect(hit("frontend-only", ["backend", "frontend"], ["java"])).toBe(true)
  })

  test("多值形态：会话命中其中任一即命中，不要求全部覆盖", () => {
    expect(hit("both-forms", ["backend"], ["java"])).toBe(true)
    expect(hit("both-forms", ["frontend"], ["vue"])).toBe(true)
    expect(hit("both-forms", ["backend", "frontend"], ["java", "vue"])).toBe(true)
  })

  test("形态与会话无交集 → 不命中", () => {
    expect(hit("frontend-only", ["backend"], ["java"])).toBe(false)
    expect(hit("both-forms", ["mobile"], ["swift"])).toBe(false)
  })

  test("多值框架：会话任一框架相同即命中（框架无关 skill 可同时服务 Vue / React）", () => {
    expect(hit("multi-framework", ["frontend"], ["vue"])).toBe(true)
    expect(hit("multi-framework", ["frontend"], ["react"])).toBe(true)
    expect(hit("multi-framework", ["frontend"], ["vue", "react"])).toBe(true)
  })

  test("框架与会话无交集 → 不命中", () => {
    expect(hit("multi-framework", ["frontend"], ["svelte"])).toBe(false)
  })

  test("两通道需同时满足：任一通道无交集即不命中", () => {
    expect(hit("multi-framework", ["backend"], ["vue"])).toBe(false) // 形态无交集
    expect(hit("multi-framework", ["frontend"], ["svelte"])).toBe(false) // 框架无交集
  })

  test("未声明某通道的 skill 不受该通道约束（通用）", () => {
    expect(hit("generic-style", ["backend"], ["java"])).toBe(true)
    expect(hit("frontend-only", ["frontend"], ["svelte"])).toBe(true) // 未声明 frameworks → 框架通道不拦
  })
})

describe("scanSkillTags 进程内缓存", () => {
  test("默认 roots 两次调用返回同一实例", () => {
    const a = scanSkillTags()
    const b = scanSkillTags()
    expect(a).toBe(b)
    expect(a.tagMap).toBe(b.tagMap)
    expect(a.skillTags).toBe(b.skillTags)
    expect(a.skillStacks).toBe(b.skillStacks)
    expect(a.skillFrameworks).toBe(b.skillFrameworks)
  })

  test("skill 索引内容正确", () => {
    const a = scanSkillTags()
    expect(a.skillTags.get("code-efficiency")).toEqual(["efficiency"])
    expect(a.tagMap.get("efficiency")).toContain("code-efficiency")
  })
})

/**
 * frontmatter 三层次字段解析：capabilities（能力维度）/ stacks（形态）/ frameworks（框架）。
 * stacks / frameworks 未声明 = 通用；值域词汇由 skill 索引动态提供，代码内无硬编码清单。
 */
describe("frontmatter stacks / frameworks 解析与动态值域", () => {
  test("真实索引：java 技术栈 skill 声明 stacks/frameworks，基座 skill 不声明", () => {
    const idx = scanSkillTags()
    expect(idx.skillStacks.get("java-quality-gate")).toEqual(["backend"])
    expect(idx.skillFrameworks.get("java-quality-gate")).toEqual(["java"])
    expect(idx.skillStacks.get("api-test")).toEqual(["backend"])
    expect(idx.skillFrameworks.has("api-test")).toBe(false)
    expect(idx.skillStacks.has("quality-gate")).toBe(false)
    expect(idx.skillFrameworks.has("quality-gate")).toBe(false)
    expect(idx.skillStacks.has("test-design")).toBe(false)
  })

  test("真实索引：所有 java-* skill 均声明 stacks=[backend] 且 frameworks=[java]", () => {
    const idx = scanSkillTags()
    const javaSkills = [...idx.skillTags.keys()].filter((n) => n.startsWith("java-"))
    expect(javaSkills.length).toBeGreaterThan(0)
    for (const name of javaSkills) {
      expect(idx.skillStacks.get(name)).toEqual(["backend"])
      expect(idx.skillFrameworks.get(name)).toEqual(["java"])
    }
  })

  test("能力维度标签不进入形态/框架值域（stacks/frameworks 与 capabilities 三层次独立）", () => {
    const idx = scanSkillTags()
    const values = new Set<string>()
    for (const list of idx.skillStacks.values()) for (const t of list) values.add(t)
    for (const list of idx.skillFrameworks.values()) for (const t of list) values.add(t)
    for (const tag of idx.tagMap.keys()) expect(values.has(tag)).toBe(false)
  })

  test("knownStacks / knownFrameworks 分字段取索引并集（动态取值，无硬编码清单）", () => {
    const idx = scanSkillTags()
    const expectedStacks = new Set<string>()
    for (const list of idx.skillStacks.values()) for (const t of list) expectedStacks.add(t)
    const expectedFrameworks = new Set<string>()
    for (const list of idx.skillFrameworks.values()) for (const t of list) expectedFrameworks.add(t)
    expect(knownStacks(idx)).toEqual(expectedStacks)
    expect(knownFrameworks(idx)).toEqual(expectedFrameworks)
    // 分字段、不混用：框架值不进入形态值域，反之亦然
    expect(knownStacks(idx).has("backend")).toBe(true)
    expect(knownStacks(idx).has("java")).toBe(false)
    expect(knownFrameworks(idx).has("java")).toBe(true)
    expect(knownFrameworks(idx).has("backend")).toBe(false)
    expect(knownStacks(idx).has("quality-gate")).toBe(false)
  })

  test("测试注入覆盖分字段值域；null 恢复动态取值", () => {
    __setKnownStackTags({ stacks: ["x-stack"], frameworks: ["x-framework"] })
    try {
      expect(knownStacks(scanSkillTags())).toEqual(new Set(["x-stack"]))
      expect(knownFrameworks(scanSkillTags())).toEqual(new Set(["x-framework"]))
    } finally {
      __setKnownStackTags(null)
    }
    expect(knownStacks(scanSkillTags()).has("backend")).toBe(true)
    expect(knownFrameworks(scanSkillTags()).has("java")).toBe(true)
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

describe("必做清单归属 workflow step（skill 不再声明）", () => {
  const MUST_DO_SKILLS = [
    "api-test", "test-design", "quality-gate",
    "java-quality-gate", "frontend-quality-gate", "frontend-e2e",
  ]

  test("6 份原声明 must_do 的 skill 已不含该字段与任何必做项 id", () => {
    for (const name of MUST_DO_SKILLS) {
      const doc = readFileSync(join(import.meta.dir, "..", "assets", "skills", name, "SKILL.md"), "utf8")
      expect(doc).not.toContain("must_do")
      expect(doc).not.toContain("必做项")
    }
  })

  test("skill 索引不再承载必做清单字段（清单单一事实源在 workflow step）", () => {
    const idx = scanSkillTags() as unknown as Record<string, unknown>
    expect("skillMustDo" in idx).toBe(false)
  })

  test("skill 的 capabilities 解析不受清单移除影响（标签仍可解析）", () => {
    expect(resolveSkillsForCapabilities(["test-design"]).skillNames).toContain("test-design")
    expect(resolveSkillsForCapabilities(["api-testing"]).skillNames).toContain("api-test")
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
    expectResolvable("implement", "openspec-developer", ["efficiency", "api-testing", "e2e-testing", "test-design", "quality-gate", "dev-practices", "db-design", "style", "architecture", "performance", "security", "maintainability", "cleanup"])
    expectResolvable("verify_tool", "openspec-reviewer-tool", ["quality-gate", "efficiency"])
    expectResolvable("verify_task", "openspec-reviewer-task", ["api-testing", "e2e-testing", "test-design", "efficiency", "dev-practices", "cleanup"])
    expectResolvable("verify_quality", "openspec-reviewer-style", ["style", "efficiency", "tool-improvement"])
    expectResolvable("verify_quality", "openspec-reviewer-security", ["security", "efficiency", "tool-improvement"])
  })

  test("review.yaml / review-simple.yaml 的 implement capability_tags 含 e2e-testing（独立审查 fix 模式 dev 交付 e2e）", () => {
    const expected = ["efficiency", "api-testing", "e2e-testing", "test-design", "quality-gate", "dev-practices", "db-design", "style", "architecture", "performance", "security", "maintainability", "cleanup"]
    for (const name of ["review.yaml", "review-simple.yaml"]) {
      const wf = readWf(name)
      const a = wf.stepMap.get("implement")!.step.agents.find((x) => x.id === "openspec-developer")
      expect(a?.capability_tags).toEqual(expected)
      expect(resolveSkillsForCapabilities(a?.capability_tags).skillNames).toContain("frontend-e2e")
    }
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

/**
 * opx_status 视图侧：Skill 加载清单渲染。
 * 渲染按会话项目栈过滤（stacks / frameworks 与会话有交集才加载），旧「仅当技术栈匹配时加载」分区已废弃。
 */
describe("Skill 加载清单视图渲染", () => {
  test("渲染清单且不再出现旧技术栈分区提示", () => {
    const lines = renderSkillSuggestions("openspec-developer", ["quality-gate", "dev-practices"])
    const out = lines.join("\n")
    expect(out).toContain("## Skill 加载清单")
    expect(out).toContain("`quality-gate`")
    expect(out).not.toContain("仅当技术栈匹配时加载")
  })

  test("会话栈参与清单过滤：后端 java 会话含 Java 技术栈 skill，前端 vue 会话不含", () => {
    const backend = renderSkillSuggestions(
      "openspec-developer",
      ["quality-gate", "dev-practices"],
      { project_stacks: ["backend"], project_frameworks: ["java"] },
    ).join("\n")
    expect(backend).toContain("`quality-gate`")
    expect(backend).toContain("`java-dev-practices`")

    const frontend = renderSkillSuggestions(
      "openspec-developer",
      ["quality-gate", "dev-practices"],
      { project_stacks: ["frontend"], project_frameworks: ["vue"] },
    ).join("\n")
    expect(frontend).toContain("`quality-gate`")
    expect(frontend).not.toContain("`java-dev-practices`")
    expect(frontend).not.toContain("仅当技术栈匹配时加载")
  })

  test("不传会话栈 → 不过滤（兼容无会话调用）", () => {
    const out = renderSkillSuggestions("openspec-developer", ["quality-gate", "dev-practices"]).join("\n")
    expect(out).toContain("`java-dev-practices`")
  })

  test("能力集为空 → 不渲染清单区块", () => {
    expect(renderSkillSuggestions("openspec-developer", [])).toEqual([])
  })
})
