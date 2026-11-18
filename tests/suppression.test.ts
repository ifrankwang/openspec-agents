/**
 * 抑制配置 ↔ 豁免记录双向核对（suppression.ts）测试。
 *
 * 覆盖：资产声明收集（形态命中 / 不命中 / 配置文件缺失跳过）、两种 format 解析、
 * 双向核对的两个不一致方向、一致时两侧均为空。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  checkSuppressionConsistency,
  collectSuppressionEntries,
  collectSuppressionSnapshot,
  parseGlobList,
  parsePropertiesGlobList,
  parseSuppressionConfig,
  parseSuppressionConfigWithSkips,
} from "../src/core/suppression"
import type { ExemptionRecord } from "../src/core/exemptions"
import { __resetSkillCache, __setSkillScanRootsForTest } from "../src/skills/resolve"
import { installTestSkillEnv, teardown } from "./helpers"
import type { SessionStacks } from "../src/skills/stacks"

const tempDirs: string[] = []
const EMPTY_ROOT = join(tmpdir(), "opx-suppression-noop")

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "opx-suppression-"))
  tempDirs.push(dir)
  return dir
}

function exemption(over: Partial<ExemptionRecord> = {}): ExemptionRecord {
  return {
    key: "k",
    sourcePhase: "tool",
    dimension: "security",
    severity: "High",
    description: "存量问题",
    exemptedAt: "t1",
    exemptedBy: "reviewer",
    changeId: "c1",
    ...over,
  }
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
  __setSkillScanRootsForTest(null)
  __resetSkillCache()
})

describe("资产收集", () => {
  test("后端会话命中 skill 资产，按声明的配置键解析出忽略条目并标注来源", () => {
    installTestSkillEnv()
    __resetSkillCache()
    const repo = makeRepo()
    writeFileSync(
      join(repo, "sonar-project.properties"),
      "# 扫描配置\nsonar.exclusions=src/generated/**, build/**\nsonar.other=ignored\n",
      "utf-8",
    )
    const session: SessionStacks = { project_stacks: ["backend"], project_frameworks: ["java"] }

    const entries = collectSuppressionEntries(repo, session)

    expect(entries).toEqual([
      { file: "sonar-project.properties", pattern: "build/**", source: "skill `java-quality-gate` · sonar-project.properties#sonar.exclusions" },
      { file: "sonar-project.properties", pattern: "src/generated/**", source: "skill `java-quality-gate` · sonar-project.properties#sonar.exclusions" },
    ])
  })

  test("前端会话命中前端 skill 资产（同一配置文件、来源随 skill 变化）", () => {
    installTestSkillEnv()
    __resetSkillCache()
    const repo = makeRepo()
    writeFileSync(join(repo, "sonar-project.properties"), "sonar.exclusions=node_modules/**\n", "utf-8")
    const session: SessionStacks = { project_stacks: ["frontend"], project_frameworks: ["vue"] }

    const entries = collectSuppressionEntries(repo, session)

    expect(entries.map((e) => e.pattern)).toEqual(["node_modules/**"])
    expect(entries[0].source).toBe("skill `frontend-quality-gate` · sonar-project.properties#sonar.exclusions")
  })

  test("形态不命中（会话形态与 skill 声明无交集）→ 不收集", () => {
    installTestSkillEnv()
    __resetSkillCache()
    const repo = makeRepo()
    writeFileSync(join(repo, "sonar-project.properties"), "sonar.exclusions=src/generated/**\n", "utf-8")
    const session: SessionStacks = { project_stacks: ["data"], project_frameworks: ["python"] }

    expect(collectSuppressionEntries(repo, session)).toEqual([])
  })

  test("声明的配置文件不存在 → 跳过，不报错", () => {
    installTestSkillEnv()
    __resetSkillCache()
    const repo = makeRepo()
    const session: SessionStacks = { project_stacks: ["backend"], project_frameworks: ["java"] }

    expect(collectSuppressionEntries(repo, session)).toEqual([])
  })

  test("会话无栈（旧会话 / 空栈）→ 不收集", () => {
    installTestSkillEnv()
    __resetSkillCache()
    expect(collectSuppressionEntries(makeRepo(), null)).toEqual([])
    expect(collectSuppressionEntries(makeRepo(), { project_stacks: [], project_frameworks: [] })).toEqual([])
  })
})

describe("format 解析", () => {
  test("properties-key-glob-list：只取声明键、逗号切分、支持续行与注释", () => {
    const content = [
      "# comment",
      "! 另一种注释",
      "sonar.exclusions=src/a/**, \\",
      "  src/b/**",
      "sonar.other=src/c/**",
    ].join("\n")

    expect(parsePropertiesGlobList(content, "sonar.exclusions")).toEqual(["src/a/**", "src/b/**"])
    expect(parsePropertiesGlobList(content, "sonar.other")).toEqual(["src/c/**"])
    expect(parsePropertiesGlobList(content, "missing.key")).toEqual([])
  })

  test("glob-list：整文件逐行 glob，忽略空行与 # 注释", () => {
    expect(parseGlobList("\uFEFF# 注释\n\nsrc/generated/**\ndist/**\n")).toEqual(["src/generated/**", "dist/**"])
  })

  test("资产声明解析：两种 format 均接受；缺 file / 缺 key 或未知 format 的项跳过", () => {
    const decls = parseSuppressionConfig(
      [
        "- file: a.properties",
        "  format: properties-key-glob-list",
        "  key: exclusions",
        "- file: b.txt",
        "  format: glob-list",
        "- file: c.properties",
        "  format: properties-key-glob-list",
        "- file: d.txt",
        "  format: unknown",
        "- file: \"\"",
      ].join("\n"),
    )

    expect(decls).toEqual([
      { file: "a.properties", format: "properties-key-glob-list", key: "exclusions" },
      { file: "b.txt", format: "glob-list" },
    ])
  })

  test("未识别声明计数：未知 format / 缺 key / 缺 file / 非数组 都计入 skipped，不静默丢弃", () => {
    const parsed = parseSuppressionConfigWithSkips(
      [
        "- file: a.properties",
        "  format: properties-key-glob-list",
        "  key: exclusions",
        "- file: c.properties",
        "  format: properties-key-glob-list",
        "- file: d.txt",
        "  format: unknown",
        "- file: \"\"",
        "- 纯字符串",
      ].join("\n"),
    )
    expect(parsed.declarations).toEqual([
      { file: "a.properties", format: "properties-key-glob-list", key: "exclusions" },
    ])
    expect(parsed.skippedDeclarations).toBe(4)

    // 整文件非数组 / YAML 损坏：按一条未识别声明处理
    expect(parseSuppressionConfigWithSkips("file: a.properties\n").skippedDeclarations).toBe(1)
    expect(parseSuppressionConfigWithSkips("a: [unclosed\n").skippedDeclarations).toBe(1)
    // 全部合法时不产生跳过计数
    expect(parseSuppressionConfigWithSkips("- file: b.txt\n  format: glob-list\n").skippedDeclarations).toBe(0)
  })

  test("未识别声明计数：空文件不计入（yaml.load 返回 undefined）", () => {
    expect(parseSuppressionConfigWithSkips("")).toEqual({ declarations: [], skippedDeclarations: 0 })
  })

  test("未识别声明计数：纯注释文件不计入（没有声明可识别不等于声明非法）", () => {
    expect(parseSuppressionConfigWithSkips("# 仅注释\n# 第二条\n")).toEqual({
      declarations: [],
      skippedDeclarations: 0,
    })
  })
})

describe("未识别声明的收集计数（视图披露口径）", () => {
  test("skill 资产含不可识别声明 → entries 只含合法条目，skippedDeclarations 计数", () => {
    const root = mkdtempSync(join(tmpdir(), "opx-suppression-skip-"))
    tempDirs.push(root)
    const skillDir = join(root, "skills", "bad-gate")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: bad-gate\ndescription: 测试用 skill\ncapabilities: ["quality-gate"]\n` +
        `stacks: ["backend"]\nframeworks: ["java"]\n---\n\n## 测试\n`,
    )
    writeFileSync(
      join(skillDir, "suppression-config.yaml"),
      [
        "- file: a.properties",
        "  format: properties-key-glob-list",
        "  key: exclusions",
        "- file: b.txt",
        "  format: unknown-format",
        "- file: c.properties",
        "  format: properties-key-glob-list",
        "",
      ].join("\n"),
    )
    __setSkillScanRootsForTest([join(root, "skills")])
    __resetSkillCache()
    const repo = makeRepo()
    writeFileSync(join(repo, "a.properties"), "exclusions=src/x/**\n", "utf-8")
    const session: SessionStacks = { project_stacks: ["backend"], project_frameworks: ["java"] }

    const snapshot = collectSuppressionSnapshot(repo, session)

    expect(snapshot.entries.map((e) => e.pattern)).toEqual(["src/x/**"])
    expect(snapshot.skippedDeclarations).toBe(2) // 未知 format 1 条 + properties 缺 key 1 条
  })
})

describe("双向核对", () => {
  const entries = [
    { file: "sonar-project.properties", pattern: "src/generated/**", source: "s1" },
    { file: "sonar-project.properties", pattern: "build/**", source: "s2" },
  ]

  test("一致：配置条目都有 path_pattern 豁免对应 → 两侧均为空", () => {
    const { unmatchedConfig, unmatchedExemptions } = checkSuppressionConsistency(entries, [
      exemption({ pathPattern: "src/generated/**" }),
      exemption({ pathPattern: "build/**" }),
    ])
    expect(unmatchedConfig).toEqual([])
    expect(unmatchedExemptions).toEqual([])
  })

  test("配置有、豁免无 → unmatchedConfig 列出缺失豁免的条目", () => {
    const { unmatchedConfig, unmatchedExemptions } = checkSuppressionConsistency(entries, [
      exemption({ pathPattern: "src/generated/**" }),
    ])
    expect(unmatchedConfig.map((e) => e.pattern)).toEqual(["build/**"])
    expect(unmatchedExemptions).toEqual([])
  })

  test("豁免有、配置无 → unmatchedExemptions 列出无落点的豁免记录", () => {
    const { unmatchedConfig, unmatchedExemptions } = checkSuppressionConsistency(entries, [
      exemption({ pathPattern: "src/generated/**" }),
      exemption({ pathPattern: "build/**" }),
      exemption({ pathPattern: "src/legacy/**", changeId: "c2" }),
    ])
    expect(unmatchedConfig).toEqual([])
    expect(unmatchedExemptions.map((r) => r.changeId)).toEqual(["c2"])
  })

  test("精确三元组豁免不算配置抑制意图，不参与双向核对", () => {
    const { unmatchedConfig, unmatchedExemptions } = checkSuppressionConsistency(entries, [
      exemption({ rule: "java:S1", file: "src/Main.java", line: 1 }),
    ])
    expect(unmatchedConfig).toHaveLength(2)
    expect(unmatchedExemptions).toEqual([])
  })

  test("豁免 file 落在配置 glob 上也算有落点（路径维度对应）", () => {
    const { unmatchedConfig } = checkSuppressionConsistency(entries, [
      exemption({ pathPattern: "src/generated/specific/**", file: "src/generated/specific/A.java" }),
      exemption({ pathPattern: "build/**" }),
    ])
    expect(unmatchedConfig).toEqual([])
  })
})
