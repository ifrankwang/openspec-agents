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
  getSkillMustDo,
} from "../src/skills/resolve"
import { resolveMustDoForCaps } from "../src/core/tools/gate"
import { loadWorkflow } from "../src/core/workflow/loader"
import { renderSkillSuggestions } from "../src/core/views"
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

  test("dev-practices 命中 java-dev-practices（未声明形态/框架标签 → 通用，始终命中）", () => {
    const r = resolveSkillsForCapabilities(["dev-practices"])
    expect(r.skillNames).toContain("java-dev-practices")
    expect(r.skillNames).toContain("java-dev-practices")
  })

  test("旧 tech-stack-* 前缀标签不参与栈过滤：任意会话栈下都命中", () => {
    // skill 尚未迁移到形态/框架标签时，tech-stack-java 不是形态/框架标签 → 按通用处理
    const r = resolveSkillsForCapabilities(["quality-gate", "efficiency"], { project_stacks: ["frontend"], project_frameworks: ["vue"] })
    expect(r.skillNames).toContain("quality-gate")
    expect(r.skillNames).toContain("code-efficiency")
    expect(r.skillNames).toContain("java-quality-gate")
      })

  test("architecture 命中技术债识别 skill（均为通用，不分组）", () => {
    const r = resolveSkillsForCapabilities(["architecture"])
    expect(r.skillNames).toContain("technical-debt")
    expect(r.skillNames).toContain("java-technical-debt")
    expect(r.skillNames).toContain("technical-debt")
    expect(r.skillNames).toContain("java-technical-debt")
  })

  test("architecture 命中架构演进审查 skill", () => {
    const r = resolveSkillsForCapabilities(["architecture"])
    expect(r.skillNames).toContain("architecture-evolution")
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
    expect(r.skillNames).toEqual([])
  })

  test("caps 为空/undefined → 空数组", () => {
    expect(resolveSkillsForCapabilities(undefined).skillNames).toEqual([])
    expect(resolveSkillsForCapabilities([]).skillNames).toEqual([])
  })
})

/**
 * 会话栈过滤（构造索引，不依赖真实 skill 文件的标签迁移进度）：
 * 命中规则 = 能力维度命中 ∧ skill 形态标签 ⊆ 会话 project_stacks ∧ skill 框架标签 ⊆ 会话 project_frameworks；
 * skill 未声明形态/框架标签视为通用，始终命中。
 */
describe("会话项目栈过滤（形态/框架标签）", () => {
  const stackIndex: SkillTagIndex = {
    tagMap: new Map([
      ["quality-gate", ["quality-gate", "java-quality-gate", "vue-quality-gate"]],
      ["style", ["generic-style", "java-style", "vue-style"]],
    ]),
    skillTags: new Map([
      ["quality-gate", ["quality-gate"]], // 通用
      ["java-quality-gate", ["quality-gate", "backend", "java"]],
      ["vue-quality-gate", ["quality-gate", "frontend", "vue"]],
      ["generic-style", ["style"]], // 通用
      ["java-style", ["style", "backend", "java"]],
      ["vue-style", ["style", "frontend", "vue"]],
    ]),
    skillMustDo: new Map(),
  }

  test("后端 java 会话只看得到后端与通用 skill，看不到前端 skill", () => {
    const r = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["backend"], project_frameworks: ["java"] }, stackIndex)
    expect(r.skillNames).toContain("quality-gate")
    expect(r.skillNames).toContain("java-quality-gate")
    expect(r.skillNames).not.toContain("vue-quality-gate")
  })

  test("前端 vue 会话只看得到前端与通用 skill，看不到后端 skill", () => {
    const r = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["frontend"], project_frameworks: ["vue"] }, stackIndex)
    expect(r.skillNames).toContain("quality-gate")
    expect(r.skillNames).toContain("vue-quality-gate")
    expect(r.skillNames).not.toContain("java-quality-gate")
  })

  test("混合栈会话（前后端 + 多框架）两侧 skill 都可见", () => {
    const r = resolveSkillsForCapabilities(
      ["quality-gate"],
      { project_stacks: ["backend", "frontend"], project_frameworks: ["java", "vue"] },
      stackIndex,
    )
    expect(r.skillNames).toContain("java-quality-gate")
    expect(r.skillNames).toContain("vue-quality-gate")
    expect(r.skillNames).toContain("quality-gate")
  })

  test("形态命中但框架不匹配 → 不命中（框架标签须 ⊆ 会话 frameworks）", () => {
    const r = resolveSkillsForCapabilities(["quality-gate"], { project_stacks: ["backend"], project_frameworks: ["vue"] }, stackIndex)
    expect(r.skillNames).not.toContain("java-quality-gate")
  })

  test("未声明形态/框架标签的 skill 在任何会话栈下都命中", () => {
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

  test("test-design 声明的清单与文档表格一一对应，且其标签可解析出该 skill", () => {
    const idx = scanSkillTags()
    const items = ["behavior_surface", "case_matrix", "negative_probe"]
    expect(idx.skillMustDo.get("test-design")).toEqual(items)
    expect(getSkillMustDo("test-design")).toEqual(items)
    const doc = readFileSync(
      join(import.meta.dir, "..", "assets", "skills", "test-design", "SKILL.md"),
      "utf8",
    )
    for (const item of items) expect(doc).toContain(`| ${item} |`)
    expect(resolveSkillsForCapabilities(["test-design"]).skillNames).toContain("test-design")
  })

  test("api-test 声明 api_script / api_execution 两项必做清单", () => {
    const apiItems = ["api_script", "api_execution"]
    expect(getSkillMustDo("api-test")).toEqual(apiItems)
    expect(scanSkillTags().skillMustDo.get("api-test")).toEqual(apiItems)
  })

  test("未声明 must_do 的 skill → getSkillMustDo 返回 null（不参与覆盖度门禁）", () => {
    expect(getSkillMustDo("code-efficiency")).toBeNull()
    expect(getSkillMustDo("no-such-skill")).toBeNull()
  })

  test("caps 含接口测试能力 → 解析出 api-test 两项（质量门清单照常解析）", () => {
    const tool = resolveSkillsForCapabilities(["quality-gate", "efficiency", "api-testing"])
    const toolMustDo = tool.skillNames.flatMap((n) => getSkillMustDo(n) ?? [])
    expect(toolMustDo).toContain("deep_scan")
    expect(toolMustDo).toContain("config_check")

    const task = resolveSkillsForCapabilities(["api-testing", "efficiency", "dev-practices"])
    const taskMustDo = task.skillNames.flatMap((n) => getSkillMustDo(n) ?? [])
    // caps 含 api-testing → 命中 api-test 的两项必做清单（声明顺序）
    expect(taskMustDo).toEqual(["api_script", "api_execution"])
  })

  test("test-design 挂载接线：task/task-simple/review/review-simple 各 step 解析正确", () => {
    const idx = scanSkillTags()
    const readWf = (name: string) =>
      loadWorkflow(readFileSync(join(import.meta.dir, "..", "assets", "workflows", name), "utf8"))
    const capsOf = (wf: ReturnType<typeof readWf>, stepId: string, agentId: string) =>
      wf.stepMap.get(stepId)!.step.agents.find((a) => a.id === agentId)!.capability_tags
    const design = ["behavior_surface", "case_matrix", "negative_probe"]
    // 合并顺序按 caps 解析顺序（gate.ts resolveMustDoForCaps → resolveSkillsForCapabilities）：
    // 任务验证/合并审查能力集首个命中项为 api-testing → api-test 两项，随后 test-design 三项。
    const reviewLayerMustDo = ["api_script", "api_execution", ...design]

    const taskWf = readWf("task.yaml")
    expect(resolveMustDoForCaps(capsOf(taskWf, "verify_task", "openspec-reviewer-task"), idx)).toEqual(reviewLayerMustDo)
    for (const item of reviewLayerMustDo) {
      expect(resolveMustDoForCaps(capsOf(taskWf, "implement", "openspec-developer"), idx)).toContain(item)
    }
    expect(resolveMustDoForCaps(capsOf(taskWf, "verify_tool", "openspec-reviewer-tool"), idx)).not.toContain("behavior_surface")
    expect(resolveMustDoForCaps(capsOf(taskWf, "verify_tool", "openspec-reviewer-tool"), idx)).not.toContain("api_script")

    const simpleWf = readWf("task-simple.yaml")
    const reviewMustDo = resolveMustDoForCaps(capsOf(simpleWf, "quality_review", "openspec-reviewer"), idx)
    for (const item of reviewLayerMustDo) expect(reviewMustDo).toContain(item)
    expect(reviewMustDo).toContain("compile")

    // verify_cleanup 能力集含 api-testing → 解析出 api-test 两项（该 step 能力集不含 test-design，不要求三项）
    expect(resolveMustDoForCaps(capsOf(taskWf, "verify_cleanup", "openspec-developer"), idx)).toEqual(["api_script", "api_execution"])
    expect(resolveMustDoForCaps(capsOf(simpleWf, "verify_cleanup", "openspec-developer"), idx)).toEqual(["api_script", "api_execution"])

    // 独立审查会话两个 workflow 与 change 会话同口径：dev 与任务验证/合并审查层均挂 test-design
    const reviewWf = readWf("review.yaml")
    expect(resolveMustDoForCaps(capsOf(reviewWf, "verify_task", "openspec-reviewer-task"), idx)).toEqual(reviewLayerMustDo)
    for (const item of reviewLayerMustDo) {
      expect(resolveMustDoForCaps(capsOf(reviewWf, "implement", "openspec-developer"), idx)).toContain(item)
    }
    expect(resolveMustDoForCaps(capsOf(reviewWf, "verify_tool", "openspec-reviewer-tool"), idx)).not.toContain("behavior_surface")
    expect(resolveMustDoForCaps(capsOf(reviewWf, "verify_tool", "openspec-reviewer-tool"), idx)).not.toContain("api_script")

    const simpleReviewWf = readWf("review-simple.yaml")
    const simpleReviewMustDo = resolveMustDoForCaps(capsOf(simpleReviewWf, "quality_review", "openspec-reviewer"), idx)
    for (const item of reviewLayerMustDo) expect(simpleReviewMustDo).toContain(item)
    expect(simpleReviewMustDo).toContain("compile")
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
    expectResolvable("implement", "openspec-developer", ["efficiency", "api-testing", "test-design", "quality-gate", "dev-practices", "db-design", "style", "architecture", "performance", "security", "maintainability", "cleanup"])
    expectResolvable("verify_tool", "openspec-reviewer-tool", ["quality-gate", "efficiency"])
    expectResolvable("verify_task", "openspec-reviewer-task", ["api-testing", "e2e-testing", "test-design", "efficiency", "dev-practices", "cleanup"])
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

/**
 * opx_status 视图侧：Skill 加载清单渲染。
 * 标签迁移期（skill 仍声明旧 tech-stack-* 标签）形态/框架过滤为空操作，行为与迁移前一致；
 * 旧「仅当技术栈匹配时加载」分区已随标签模型废弃，不再渲染。
 */
describe("Skill 加载清单视图渲染", () => {
  test("渲染清单且不再出现旧技术栈分区提示", () => {
    const lines = renderSkillSuggestions("openspec-developer", ["quality-gate", "dev-practices"])
    const out = lines.join("\n")
    expect(out).toContain("## Skill 加载清单")
    expect(out).toContain("`quality-gate`")
    expect(out).not.toContain("仅当技术栈匹配时加载")
  })

  test("传会话栈不改变迁移期输出（旧标签按通用处理，全部命中）", () => {
    const withoutSession = renderSkillSuggestions("openspec-developer", ["quality-gate", "dev-practices"]).join("\n")
    const withSession = renderSkillSuggestions(
      "openspec-developer",
      ["quality-gate", "dev-practices"],
      { project_stacks: ["frontend"], project_frameworks: ["vue"] },
    ).join("\n")
    expect(withSession).toBe(withoutSession)
  })

  test("能力集为空 → 不渲染清单区块", () => {
    expect(renderSkillSuggestions("openspec-developer", [])).toEqual([])
  })
})
