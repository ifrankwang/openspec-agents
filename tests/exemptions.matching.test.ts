/**
 * 豁免匹配单一事实源（exemptions.matchesExemption）单元测试。
 *
 * 覆盖：旧精确三元组语义不变、path_pattern 路径模式命中（含整类/整文件）、rule_keys 规则维度命中、
 * 路径+规则双维度 AND、glob 通配语义、带 pattern/rule_keys 的独立 key 空间、跨 change 命中降 Info 不变。
 */
import { describe, expect, test } from "bun:test"

import {
  applyExemptionDowngrade,
  exemptionKeyOf,
  exemptionRecordKeyOf,
  isSuppressionIntent,
  matchesExemption,
  pathMatchesGlob,
  type ExemptionRecord,
} from "../src/core/exemptions"

function record(over: Partial<ExemptionRecord> = {}): ExemptionRecord {
  return {
    key: "k",
    sourcePhase: "tool",
    dimension: "security",
    severity: "High",
    description: "存量问题",
    exemptedAt: "t1",
    exemptedBy: "reviewer",
    changeId: "other-change",
    ...over,
  }
}

describe("旧精确三元组语义不变", () => {
  test("rule+file+line 全等命中；行号不同不命中；路径模式不参与", () => {
    const legacy = record({ rule: "java:S2068", file: "src/Main.java", line: 42 })
    expect(matchesExemption({ rule: "java:S2068", file: "src/Main.java", line: 42 }, legacy)).toBe(true)
    expect(matchesExemption({ rule: "java:S2068", file: "src/Main.java", line: 43 }, legacy)).toBe(false)
    expect(matchesExemption({ rule: "java:S2068", file: "src/Other.java", line: 42 }, legacy)).toBe(false)
    expect(matchesExemption({ rule: "java:S1", file: "src/Main.java", line: 42 }, legacy)).toBe(false)

    // 旧记录 line=0 仍按原语义只匹配 line=0（整文件豁免需用 path_pattern 表达）
    const wholeFile = record({ rule: "java:S1", file: "src/Main.java", line: 0 })
    expect(matchesExemption({ rule: "java:S1", file: "src/Main.java", line: 0 }, wholeFile)).toBe(true)
    expect(matchesExemption({ rule: "java:S1", file: "src/Main.java", line: 5 }, wholeFile)).toBe(false)
  })

  test("旧记录不改 key：exemptionRecordKeyOf 回落 exemptionKeyOf", () => {
    const target = { rule: "java:S2068", file: "src/Main.java", line: 42 }
    expect(exemptionRecordKeyOf(target)).toBe(exemptionKeyOf("java:S2068", "src/Main.java", 42))
  })
})

describe("path_pattern 路径模式", () => {
  test("整类命中：文件落在 glob 上且不带 line 时任意行号命中", () => {
    const rec = record({ pathPattern: "src/generated/**", rule: "java:S1" })
    expect(matchesExemption({ file: "src/generated/a/b.java", rule: "java:S1", line: 0 }, rec)).toBe(true)
    expect(matchesExemption({ file: "src/generated/a/b.java", rule: "java:S1", line: 99 }, rec)).toBe(true)
    expect(matchesExemption({ file: "src/main/java/A.java", rule: "java:S1", line: 0 }, rec)).toBe(false)
  })

  test("路径模式带 line 时要求行号相等", () => {
    const rec = record({ pathPattern: "src/gen/**", line: 7 })
    expect(matchesExemption({ file: "src/gen/a.java", line: 7 }, rec)).toBe(true)
    expect(matchesExemption({ file: "src/gen/a.java", line: 8 }, rec)).toBe(false)
  })

  test("带 path_pattern 的记录使用独立 key 空间，且 rule_keys 顺序不影响 key", () => {
    expect(exemptionRecordKeyOf({ pathPattern: "src/gen/**", ruleKeys: ["b", "a"] })).toBe(
      exemptionRecordKeyOf({ pathPattern: "src/gen/**", ruleKeys: ["a", "b", "a"] }),
    )
    expect(exemptionRecordKeyOf({ pathPattern: "src/gen/**", ruleKeys: ["a"] })).not.toBe(
      exemptionRecordKeyOf({ pathPattern: "src/other/**", ruleKeys: ["a"] }),
    )
  })
})

describe("rule_keys 规则维度", () => {
  test("issue.rule 落在记录的 rule_keys → 命中；不在 → 不命中", () => {
    const rec = record({ file: "src/A.java", ruleKeys: ["java:S1", "java:S2"] })
    expect(matchesExemption({ file: "src/A.java", rule: "java:S2" }, rec)).toBe(true)
    expect(matchesExemption({ file: "src/A.java", rule: "java:S9" }, rec)).toBe(false)
  })

  test("issue.rule_keys 与记录 rule_keys 有交集 / 记录 rule 落在 issue.rule_keys → 命中", () => {
    const rec = record({ file: "src/A.java", ruleKeys: ["java:S1"] })
    expect(matchesExemption({ file: "src/A.java", ruleKeys: ["java:S1", "java:S2"] }, rec)).toBe(true)
    const recRule = record({ file: "src/A.java", rule: "java:S3" })
    expect(matchesExemption({ file: "src/A.java", ruleKeys: ["java:S3"] }, recRule)).toBe(true)
  })

  test("路径与规则同时声明 → 两个维度都命中才成立", () => {
    const rec = record({ pathPattern: "src/gen/**", ruleKeys: ["java:S1"] })
    expect(matchesExemption({ file: "src/gen/a.java", rule: "java:S1" }, rec)).toBe(true)
    expect(matchesExemption({ file: "src/gen/a.java", rule: "java:S9" }, rec)).toBe(false)
    expect(matchesExemption({ file: "src/main/a.java", rule: "java:S1" }, rec)).toBe(false)
  })
})

describe("glob 通配语义", () => {
  test("** 跨目录、**/ 可零层、* 不跨目录、? 单字符", () => {
    expect(pathMatchesGlob("src/**/*.ts", "src/a.ts")).toBe(true)
    expect(pathMatchesGlob("src/**/*.ts", "src/a/b/c.ts")).toBe(true)
    expect(pathMatchesGlob("src/*.ts", "src/a/b.ts")).toBe(false)
    expect(pathMatchesGlob("src/?.ts", "src/a.ts")).toBe(true)
    expect(pathMatchesGlob("src/?.ts", "src/ab.ts")).toBe(false)
  })
})

describe("跨 change 命中降 Info 行为不变", () => {
  test("旧精确三元组记录（changeId 不同）命中后降 Info 并写 exempted_hit", () => {
    const child: any = {
      id: "issue:1",
      description: "硬编码密钥",
      severity: "High",
      metadata: {
        source: "openspec-reviewer-tool",
        dimension: "security",
        file: "src/Main.java",
        line: 42,
        rule: "java:S2068",
      },
    }
    const store = {
      version: 1,
      items: [record({ rule: "java:S2068", file: "src/Main.java", line: 42, changeId: "other-change" })],
    }
    expect(applyExemptionDowngrade([child], store)).toBe(1)
    expect(child.severity).toBe("Info")
    expect(child.metadata["exempted_hit"]).toBe("java:S2068")
  })

  test("path_pattern 豁免同样跨 change 命中：issue 带路径 glob 维度即可降级", () => {
    const child: any = {
      id: "issue:2",
      description: "生成代码告警",
      severity: "High",
      metadata: {
        source: "openspec-reviewer-tool",
        dimension: "maintainability",
        file: "src/generated/Gen.java",
        line: 0,
        rule: "java:S1",
      },
    }
    const store = {
      version: 1,
      items: [record({ pathPattern: "src/generated/**", ruleKeys: ["java:S1"], severity: "High" })],
    }
    expect(applyExemptionDowngrade([child], store)).toBe(1)
    expect(child.severity).toBe("Info")
    expect(child.metadata["exempted_hit"]).toBe("java:S1")
  })
})

describe("isSuppressionIntent", () => {
  test("带 path_pattern 或 rule_keys 才算配置抑制意图；旧三元组不算", () => {
    expect(isSuppressionIntent(record({ pathPattern: "src/gen/**" }))).toBe(true)
    expect(isSuppressionIntent(record({ ruleKeys: ["java:S1"] }))).toBe(true)
    expect(isSuppressionIntent(record({ rule: "java:S1", file: "src/A.java", line: 1 }))).toBe(false)
  })
})
