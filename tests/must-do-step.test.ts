/**
 * 必做清单归 workflow step 的结构契约测试。
 *
 * 覆盖：
 * - 词表完整性：id 齐全、每条 description/evidence 非空
 * - 分组键合法性：除 always 外均命中 skill 声明的形态标签（knownStacks）
 * - step 引用 id ⊆ 词表（加载期校验 + 本文件正向断言）
 * - 词表无孤儿项（每个 id 至少被一份 workflow 某个 step 引用）
 * - resolveStepMustDo 在 backend / frontend / full-stack / legacy 四种会话下的结果
 * - 跨 workflow 同语义 step 清单一致（implement 在 4 份 workflow 一致、quality_review 在 2 份 simple 一致）
 * - 词表/step 声明的非法输入在加载期被拒（负向校验）
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  loadWorkflow, loadMustDoCatalog, assertMustDoCatalogReferenced,
  MUST_DO_CATALOG, MUST_DO_ALWAYS_KEY,
  type LoadedWorkflow,
} from "../src/core/workflow/loader"
import { resolveStepMustDo } from "../src/core/tools/gate"
import { knownStacks } from "../src/skills/stacks"
import { scanSkillTags } from "../src/skills/resolve"

const WF_DIR = join(import.meta.dir, "..", "assets", "workflows")
const WORKFLOW_FILES = ["task.yaml", "task-simple.yaml", "review.yaml", "review-simple.yaml"] as const

function readWf(name: string): LoadedWorkflow {
  return loadWorkflow(readFileSync(join(WF_DIR, name), "utf8"))
}

const WORKFLOWS = WORKFLOW_FILES.map((f) => ({ file: f, wf: readWf(f) }))

const SESSIONS = {
  backend: { project_stacks: ["backend"], project_frameworks: ["java"] },
  frontend: { project_stacks: ["frontend"], project_frameworks: ["vue"] },
  "full-stack": { project_stacks: ["backend", "frontend"], project_frameworks: ["java", "vue"] },
  legacy: null,
} as const

/** 方案表：各语义 step 的期望分组（跨 workflow 一致性的事实基准）。 */
const EXPECTED = {
  implement: {
    always: ["compile", "format", "architecture", "static_analysis", "unit_test", "coverage", "behavior_surface", "case_matrix"],
    backend: ["api_script", "api_execution", "chain_map"],
    frontend: ["e2e_script", "e2e_run"],
  },
  verify_tool: {
    always: ["env", "compile", "format", "architecture", "static_analysis", "unit_test", "coverage", "deep_scan", "config_check"],
  },
  verify_task: {
    always: ["behavior_surface", "case_matrix", "negative_probe"],
    backend: ["api_script", "api_execution", "chain_map"],
    frontend: ["e2e_script", "e2e_run"],
  },
  verify_cleanup: {
    always: [],
    backend: ["api_script", "api_execution", "chain_map"],
    frontend: ["e2e_script", "e2e_run"],
  },
  quality_review: {
    always: [
      "env", "compile", "format", "architecture", "static_analysis", "unit_test", "coverage",
      "deep_scan", "config_check", "behavior_surface", "case_matrix", "negative_probe",
      "dimension_skill_review",
    ],
    backend: ["api_script", "api_execution", "chain_map"],
    frontend: ["e2e_script", "e2e_run"],
  },
  analyze: { always: [] },
  verify_quality: { always: ["dimension_skill_review"] },
} as const

// ─── 词表完整性 ───

describe("must-do 词表完整性", () => {
  test("词表收录全部必做项 id（含 chain_map 与 dimension_skill_review）", () => {
    const expectedIds = [
      "env", "compile", "format", "architecture", "static_analysis", "unit_test", "coverage",
      "deep_scan", "config_check", "api_script", "api_execution", "behavior_surface", "case_matrix",
      "negative_probe", "e2e_script", "e2e_run", "chain_map", "dimension_skill_review",
    ]
    expect(Object.keys(MUST_DO_CATALOG).sort()).toEqual([...expectedIds].sort())
  })

  test("每条词表条目含非空 description 与 evidence", () => {
    for (const [id, item] of Object.entries(MUST_DO_CATALOG)) {
      expect(typeof item.description, id).toBe("string")
      expect(item.description.trim().length, id).toBeGreaterThan(0)
      expect(typeof item.evidence, id).toBe("string")
      expect(item.evidence.trim().length, id).toBeGreaterThan(0)
    }
  })

  test("每份 workflow 加载后携带同一份词表实例", () => {
    for (const { wf } of WORKFLOWS) expect(wf.mustDoCatalog).toBe(MUST_DO_CATALOG)
  })

  test("词表 YAML 结构非法 → 加载期抛错（缺 evidence / 空 items / 非映射）", () => {
    expect(() => loadMustDoCatalog("items:\n  compile:\n    description: x\n")).toThrow(/evidence/)
    expect(() => loadMustDoCatalog("items: {}\n")).toThrow(/不得为空/)
    expect(() => loadMustDoCatalog("items: [a, b]\n")).toThrow(/items/)
    expect(() => loadMustDoCatalog("{}\n")).toThrow(/items/)
  })
})

// ─── step 引用 id ⊆ 词表 ───

describe("step.must_do 引用 id ⊆ 词表", () => {
  test("4 份 workflow 每个 step 的每个 id 都在词表内", () => {
    const ids = new Set(Object.keys(MUST_DO_CATALOG))
    for (const { file, wf } of WORKFLOWS) {
      for (const { step } of wf.stepMap.values()) {
        for (const [key, group] of Object.entries(step.must_do ?? {})) {
          for (const id of group ?? []) {
            expect(ids.has(id), `${file} step ${step.id} ${key} 引用了词表外 id ${id}`).toBe(true)
          }
        }
      }
    }
  })

  test("引用词表外 id → 加载期抛错", () => {
    const yaml = `
id: t
max_retries: 1
phases:
  - name: in_progress
    steps:
      - id: implement
        must_do:
          always: [no_such_item]
        agents:
          - id: openspec-developer
            capability_tags: [quality-gate]
        transitions:
          on_pass: done
          on_fail: implement
`
    expect(() => loadWorkflow(yaml)).toThrow(/词表外必做项 "no_such_item"/)
  })
})

// ─── 分组键合法性 ───

describe("must_do 分组键合法性", () => {
  test("除 always 外的分组键均命中 skill 声明的形态标签（knownStacks）", () => {
    const stacks = knownStacks()
    for (const { file, wf } of WORKFLOWS) {
      for (const { step } of wf.stepMap.values()) {
        for (const key of Object.keys(step.must_do ?? {})) {
          if (key === MUST_DO_ALWAYS_KEY) continue
          expect(stacks.has(key), `${file} step ${step.id} 的分组键 ${key} 不是合法形态栈`).toBe(true)
        }
      }
    }
  })

  test("真实 skill 索引声明了 backend / frontend 两个形态标签", () => {
    const stacks = knownStacks(scanSkillTags())
    expect(stacks.has("backend")).toBe(true)
    expect(stacks.has("frontend")).toBe(true)
  })

  test("非法分组键 → 加载期抛错", () => {
    const yaml = `
id: t
max_retries: 1
phases:
  - name: in_progress
    steps:
      - id: implement
        must_do:
          always: [compile]
          no_such_stack: [compile]
        agents:
          - id: openspec-developer
            capability_tags: [quality-gate]
        transitions:
          on_pass: done
          on_fail: implement
`
    expect(() => loadWorkflow(yaml)).toThrow(/不是合法项目形态栈/)
  })

  test("分组值非字符串数组 → 加载期抛错", () => {
    const yaml = `
id: t
max_retries: 1
phases:
  - name: in_progress
    steps:
      - id: implement
        must_do:
          always: compile
        agents:
          - id: openspec-developer
            capability_tags: [quality-gate]
        transitions:
          on_pass: done
          on_fail: implement
`
    expect(() => loadWorkflow(yaml)).toThrow(/必须是字符串数组/)
  })
})

// ─── 词表无孤儿项 ───

describe("词表无孤儿项", () => {
  test("真实 4 份 workflow 引用覆盖词表全部 id", () => {
    expect(() => assertMustDoCatalogReferenced(MUST_DO_CATALOG, WORKFLOWS.map((w) => w.wf))).not.toThrow()
  })

  test("词表条目无任何 step 引用 → 抛错并列出孤儿项", () => {
    const catalog = {
      ...MUST_DO_CATALOG,
      orphan_item: { description: "x", evidence: "y" },
    }
    expect(() => assertMustDoCatalogReferenced(catalog, WORKFLOWS.map((w) => w.wf))).toThrow(/孤儿项.*orphan_item/)
  })
})

// ─── resolveStepMustDo 四种会话 ───

describe("resolveStepMustDo 四种会话结果", () => {
  const implementStep = WORKFLOWS[0].wf.stepMap.get("implement")!.step

  test("backend 会话：always + backend 分组", () => {
    expect(resolveStepMustDo(implementStep, SESSIONS.backend)).toEqual([
      ...EXPECTED.implement.always, ...EXPECTED.implement.backend,
    ])
  })

  test("frontend 会话：always + frontend 分组（不含 api 项）", () => {
    const ids = resolveStepMustDo(implementStep, SESSIONS.frontend)
    expect(ids).toEqual([...EXPECTED.implement.always, ...EXPECTED.implement.frontend])
    expect(ids).not.toContain("api_script")
    expect(ids).not.toContain("chain_map")
  })

  test("full-stack 会话：always + 两个分组", () => {
    expect(resolveStepMustDo(implementStep, SESSIONS["full-stack"])).toEqual([
      ...EXPECTED.implement.always, ...EXPECTED.implement.backend, ...EXPECTED.implement.frontend,
    ])
  })

  test("legacy 会话（null）：只取 always，技术栈分组不并入", () => {
    expect(resolveStepMustDo(implementStep, SESSIONS.legacy)).toEqual([...EXPECTED.implement.always])
  })

  test("无会话上下文（undefined）：always + 全部分组", () => {
    expect(resolveStepMustDo(implementStep)).toEqual([
      ...EXPECTED.implement.always, ...EXPECTED.implement.backend, ...EXPECTED.implement.frontend,
    ])
  })

  test("verify_quality：always 恒含 dimension_skill_review（四种会话口径一致）", () => {
    for (const { wf } of WORKFLOWS) {
      const entry = wf.stepMap.get("verify_quality")
      if (!entry) continue
      expect(entry.step.must_do).toEqual({ always: ["dimension_skill_review"] })
      for (const session of Object.values(SESSIONS)) {
        expect(resolveStepMustDo(entry.step, session)).toEqual([...EXPECTED.verify_quality.always])
      }
    }
  })

  test("verify_cleanup 的 always 为空：legacy 会话生效清单为空（仅取 always）", () => {
    for (const { wf } of WORKFLOWS) {
      const entry = wf.stepMap.get("verify_cleanup")
      if (!entry) continue
      expect(entry.step.must_do?.always).toEqual([])
      expect(resolveStepMustDo(entry.step, SESSIONS.legacy)).toEqual([])
      expect(resolveStepMustDo(entry.step, SESSIONS.backend)).toEqual([...EXPECTED.verify_cleanup.backend])
    }
  })
})

// ─── 跨 workflow 同语义 step 清单一致 ───

describe("跨 workflow 同语义 step 清单一致", () => {
  test("4 份 workflow 的 implement 声明完全一致", () => {
    const decls = WORKFLOWS.map(({ wf }) => wf.stepMap.get("implement")?.step.must_do)
    for (const decl of decls) {
      expect(decl).toEqual(EXPECTED.implement)
    }
    // 四份两两相同（含键顺序无关的深比较）
    expect(new Set(decls.map((d) => JSON.stringify(d))).size).toBe(1)
  })

  test("2 份 simple workflow 的 quality_review 声明完全一致", () => {
    const simples = WORKFLOWS.filter((w) => w.file.includes("simple"))
    expect(simples).toHaveLength(2)
    const decls = simples.map(({ wf }) => wf.stepMap.get("quality_review")?.step.must_do)
    for (const decl of decls) expect(decl).toEqual(EXPECTED.quality_review)
    expect(new Set(decls.map((d) => JSON.stringify(d))).size).toBe(1)
  })

  test("2 份含 verify_tool 的 workflow 声明一致（task / review）", () => {
    const withTool = WORKFLOWS.filter((w) => w.wf.stepMap.has("verify_tool"))
    expect(withTool.map((w) => w.file).sort()).toEqual(["review.yaml", "task.yaml"])
    const decls = withTool.map(({ wf }) => wf.stepMap.get("verify_tool")?.step.must_do)
    for (const decl of decls) expect(decl).toEqual(EXPECTED.verify_tool)
    expect(new Set(decls.map((d) => JSON.stringify(d))).size).toBe(1)
  })

  test("2 份含 verify_task 的 workflow 声明一致（task / review）", () => {
    const withTask = WORKFLOWS.filter((w) => w.wf.stepMap.has("verify_task"))
    expect(withTask.map((w) => w.file).sort()).toEqual(["review.yaml", "task.yaml"])
    const decls = withTask.map(({ wf }) => wf.stepMap.get("verify_task")?.step.must_do)
    for (const decl of decls) expect(decl).toEqual(EXPECTED.verify_task)
    expect(new Set(decls.map((d) => JSON.stringify(d))).size).toBe(1)
  })

  test("2 份含 verify_cleanup 的 workflow 声明一致（task / task-simple）", () => {
    const withCleanup = WORKFLOWS.filter((w) => w.wf.stepMap.has("verify_cleanup"))
    expect(withCleanup.map((w) => w.file).sort()).toEqual(["task-simple.yaml", "task.yaml"])
    const decls = withCleanup.map(({ wf }) => wf.stepMap.get("verify_cleanup")?.step.must_do)
    for (const decl of decls) expect(decl).toEqual(EXPECTED.verify_cleanup)
    expect(new Set(decls.map((d) => JSON.stringify(d))).size).toBe(1)
  })
})
