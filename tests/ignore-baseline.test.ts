/**
 * 技术栈忽略基线收集（collectIgnoreBaseline）测试。
 *
 * 覆盖：仅后端 / 前后端同仓 / 形态命中但框架未声明 / 旧会话无 stacks（只有框架级）/
 * 目标文件名分组与排序 / 条目来源标注 / 资产内注释与 `!` 行的解析。
 *
 * 运行：bun test tests/ignore-baseline.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  collectIgnoreBaseline,
  normalizeIgnoreLine,
  parseIgnoreAsset,
} from "../src/core/ignore-baseline"
import { __resetSkillCache } from "../src/skills/resolve"
import { installTestSkillEnv, teardown } from "./helpers"
import type { SessionStacks } from "../src/skills/stacks"

const tempDirs: string[] = []
const EMPTY_ROOT = join(tmpdir(), "opx-ignore-baseline-noop")

const FRAMEWORK_ENTRIES = [".DS_Store", ".idea/", "*.iml", "*.log", ".env", ".env.local", ".env.*.local", "*.local"]

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opx-ignore-baseline-"))
  tempDirs.push(dir)
  return dir
}

function linesOf(target: { entries: { line: string }[] } | undefined): string[] {
  return (target?.entries ?? []).map((entry) => entry.line)
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
  teardown(EMPTY_ROOT)
  __resetSkillCache()
})

describe("框架级基线", () => {
  test("旧会话无 stacks → 只返回框架级基线，单目标 .gitignore", () => {
    const groups = collectIgnoreBaseline(null)

    expect(groups.map((g) => g.target)).toEqual([".gitignore"])
    expect(linesOf(groups[0])).toEqual(FRAMEWORK_ENTRIES)
    expect(groups[0].entries.every((entry) => entry.source === "框架通用基线")).toBe(true)
  })

  test("注入资产目录：按文件名分组、去重、保留 `!` 行并跳过注释", () => {
    const root = makeDir()
    writeFileSync(
      join(root, ".dockerignore"),
      "\uFEFF# 这是注释\n!keep-me\n\ndist/\ndist/\n",
      "utf-8",
    )

    const groups = collectIgnoreBaseline(null, { baselineRoot: root })

    expect(groups.map((g) => g.target)).toEqual([".dockerignore"])
    expect(linesOf(groups[0])).toEqual(["!keep-me", "dist/"])
  })
})

describe("按会话形态命中能力级基线", () => {
  test("仅后端 → 框架级 + 后端能力条目，无 .prettierignore", () => {
    installTestSkillEnv()
    __resetSkillCache()
    const session: SessionStacks = { project_stacks: ["backend"], project_frameworks: ["java"] }

    const groups = collectIgnoreBaseline(session)

    expect(groups.map((g) => g.target)).toEqual([".gitignore"])
    const lines = linesOf(groups[0])
    expect(lines).toEqual(expect.arrayContaining(FRAMEWORK_ENTRIES))
    expect(lines).toContain("target/")
    const target = groups[0].entries.find((entry) => entry.line === "target/")
    expect(target?.source).toBe("skill `java-dev-practices`")
  })

  test("前后端同仓 → .gitignore 与 .prettierignore 分组，来源区分能力", () => {
    installTestSkillEnv()
    __resetSkillCache()
    const session: SessionStacks = {
      project_stacks: ["frontend", "backend"],
      project_frameworks: ["vue", "java"],
    }

    const groups = collectIgnoreBaseline(session)

    // 目标名排序：.gitignore 在 .prettierignore 之前
    expect(groups.map((g) => g.target)).toEqual([".gitignore", ".prettierignore"])
    const gitLines = linesOf(groups[0])
    const prettierLines = linesOf(groups[1])
    expect(gitLines).toEqual(expect.arrayContaining(["node_modules/", "dist/", "e2e/reports/", "target/"]))
    expect(prettierLines).toEqual(
      expect.arrayContaining(["node_modules/", "dist/", "pnpm-lock.yaml", "e2e/reports/"]),
    )
    const dist = groups[0].entries.find((entry) => entry.line === "dist/")
    expect(dist?.source).toBe("skill `frontend-dev-practices`")
    const e2e = groups[0].entries.find((entry) => entry.line === "e2e/reports/")
    expect(e2e?.source).toBe("skill `frontend-e2e`")
  })

  test("形态命中但框架未声明 → 仍收该形态能力基线（命中只看形态）", () => {
    installTestSkillEnv()
    __resetSkillCache()
    const session: SessionStacks = { project_stacks: ["backend"], project_frameworks: ["vue"] }

    const groups = collectIgnoreBaseline(session)

    expect(linesOf(groups[0])).toContain("target/")
    expect(groups.map((g) => g.target)).toEqual([".gitignore"])
  })

  test("每个目标内条目唯一（多来源重复条目只保留一次）", () => {
    installTestSkillEnv()
    __resetSkillCache()
    const session: SessionStacks = { project_stacks: ["frontend"], project_frameworks: ["vue"] }

    for (const group of collectIgnoreBaseline(session)) {
      const lines = linesOf(group)
      expect(new Set(lines).size).toBe(lines.length)
    }
  })
})

describe("资产解析", () => {
  test("parseIgnoreAsset：去 BOM、跳过注释与空行、保留 `!` 行", () => {
    expect(parseIgnoreAsset("\uFEFF# c\n\n!a\nb/\n")).toEqual(["!a", "b/"])
  })

  test("normalizeIgnoreLine：去尾斜杠但保留 `!` 前缀", () => {
    expect(normalizeIgnoreLine(".worktree/")).toBe(".worktree")
    expect(normalizeIgnoreLine("!target/")).toBe("!target")
    expect(normalizeIgnoreLine("  node_modules/  ")).toBe("node_modules")
  })
})
