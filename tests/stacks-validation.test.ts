/**
 * 会话项目栈声明完整性测试：框架所属形态与会话形态矛盾时拒绝初始化；
 * 形态已声明但无框架覆盖时常驻警告；框架→形态推导来自 skill 索引、不硬编码。
 *
 * 运行：bun test tests/stacks-validation.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  conflictingFrameworks,
  frameworkShapes,
  shapeCoverageWarnings,
} from "../src/skills/stacks"
import { __resetSkillCache, __setSkillScanRootsForTest } from "../src/skills/resolve"
import { renderWorkflowStatusView } from "../src/core/workflow/status"
import { loadWorkflow } from "../src/core/workflow/loader"
import { init } from "../src/adapters/opencode/tools"
import { createFakeGit, installTestSkillEnv, makeOrchCtx, teardown } from "./helpers"
import { __setGitRunner } from "../src/core/git"

const tempDirs: string[] = []
const EMPTY_ROOT = join(tmpdir(), "opx-stacks-validation-noop")

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opx-stacks-validation-"))
  tempDirs.push(dir)
  return dir
}

function writeSkill(root: string, dir: string, frontmatter: string): void {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(
    join(root, dir, "SKILL.md"),
    `---\nname: ${dir}\ndescription: fixture\ncapabilities: [quality-gate]\n${frontmatter}\n---\n\n# ${dir}\n`,
    "utf-8",
  )
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不掩盖断言失败 */
    }
  }
  __setSkillScanRootsForTest(null)
  __resetSkillCache()
  teardown(EMPTY_ROOT)
})

describe("框架 → 形态推导", () => {
  test("只取同时声明 stacks 与 frameworks 的 skill，推导随索引变化", () => {
    const root = makeDir()
    writeSkill(root, "ledger-skill", "stacks: [ledger]\nframeworks: [ledgerjs]")
    writeSkill(root, "stacks-only", "stacks: [ledger]")
    __setSkillScanRootsForTest([root])
    __resetSkillCache()

    const shapes = frameworkShapes()

    expect(shapes.get("ledgerjs")).toEqual(new Set(["ledger"]))
    expect(shapes.has("ledger")).toBe(false)
    expect(shapes.size).toBe(1)
  })
})

describe("矛盾拒绝", () => {
  test("框架所属形态与会话形态无交集 → 列出矛盾框架与归属形态", () => {
    installTestSkillEnv()
    __resetSkillCache()

    const conflicts = conflictingFrameworks({
      project_stacks: ["frontend"],
      project_frameworks: ["java"],
    })

    expect(conflicts).toEqual([{ framework: "java", shapes: ["backend"] }])
  })

  test("前后端同仓（形态覆盖两端）→ 无矛盾", () => {
    installTestSkillEnv()
    __resetSkillCache()

    expect(
      conflictingFrameworks({
        project_stacks: ["frontend", "backend"],
        project_frameworks: ["vue", "java"],
      }),
    ).toEqual([])
  })

  test("初始化入口拒绝矛盾声明，且不写任何状态", async () => {
    installTestSkillEnv()
    __resetSkillCache()
    const dir = makeDir()
    __setGitRunner(createFakeGit())

    const err = await init
      .execute(
        {
          project_stacks: ["frontend"],
          project_frameworks: ["java"],
          change_id: "stack-conflict",
          task_group_id: "1",
        },
        makeOrchCtx(dir),
      )
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("矛盾")
    expect((err as Error).message).toContain("backend")
    expect((err as Error).message).toContain("project_stacks")
    expect(existsSync(join(dir, "openspec", "states", "stack-conflict.json"))).toBe(false)
  })
})

describe("形态无框架覆盖告警", () => {
  test("声明的形态没有框架覆盖 → 产生警告文本（区分形态已声明、框架未声明）", () => {
    installTestSkillEnv()
    __resetSkillCache()

    const warnings = shapeCoverageWarnings({
      project_stacks: ["backend", "frontend"],
      project_frameworks: ["vue"],
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("backend")
    expect(warnings[0]).toContain("已声明")
    expect(warnings[0]).toContain("框架")
  })

  test("全覆盖 → 无警告；空声明 → 无警告", () => {
    installTestSkillEnv()
    __resetSkillCache()

    expect(
      shapeCoverageWarnings({ project_stacks: ["backend"], project_frameworks: ["java"] }),
    ).toEqual([])
    expect(shapeCoverageWarnings({ project_stacks: [], project_frameworks: [] })).toEqual([])
  })

  test("opx_status 渲染时带出该警告（每次渲染都可见）", () => {
    installTestSkillEnv()
    __resetSkillCache()

    const wf = loadWorkflow(`
id: x
name: X
max_retries: 1
phases:
  - name: todo
    steps:
      - id: analyze
        agents:
          - id: architect
            capability_tags: [architecture]
        transitions:
          on_pass: verify
          on_fail: analyze
  - name: review
    steps:
      - id: verify
        agents:
          - id: reviewer
            capability_tags: [quality-gate]
        transitions:
          on_pass: done
          on_fail: analyze
`)
    const item: any = {
      id: "task:1",
      source: "openspec",
      type: "task",
      title: "t",
      description: "d",
      phase: "todo",
      suspended: false,
      currentStep: "analyze",
      tags: {},
      metadata: {},
      children: [],
      labels: [],
    }
    const state: any = {
      changeId: "cid",
      isolationNamespace: "ns",
      taskGroupId: "1",
      baseBranch: "main",
      workItems: [item],
      createdAt: "",
      updatedAt: "",
      stacks: { project_stacks: ["backend", "frontend"], project_frameworks: ["vue"] },
    }
    const out = renderWorkflowStatusView(
      item,
      wf,
      { status: "recommend", stepId: "analyze", agents: ["architect"] } as any,
      { agent: "architect", orchestrator: false },
      { state, tg: { worktreePath: "/wt", branchName: "b", baseRef: "base" } } as any,
    )

    expect(out).toContain("⚠️ 形态 `backend` 已声明")
    expect(out).toContain("没有与之匹配的框架声明")
  })
})
