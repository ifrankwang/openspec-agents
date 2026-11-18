/**
 * status 视图「豁免与抑制」区块测试。
 *
 * 覆盖：配置一致性核对（两侧一致 / 配置侧不一致 / 豁免侧不一致）、按生效必做清单渲染、
 * 已豁免清单段（出现 / 按变更文件过滤 / 超 50 条截断 / 无 toolChanges 只给摘要）、
 * 维度审查者只挂段二不挂段一。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { agent_submit, status } from "../src/adapters/opencode/tools"
import { exemptionRecordKeyOf, writeExemptions, type ExemptionRecord } from "../src/core/exemptions"
import { makeCtx, setupWithFakeGit, teardown } from "./helpers"
import { driveToVerifyTool, readItem, renderWorkingView, setupToImplement, taskIdsOf } from "./helpers-workflow"

const CID = "test-suppression-view"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string } {
  const root = `/tmp/suppression-view-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree } = setupWithFakeGit(root, CID)
  return { wt: worktree, root }
}

/** 变更 worktree 的真实路径（状态里 worktree_path 指向嵌套工作区，仓库文件写在这里）。 */
function repoRoot(wt: string): string {
  return readItem(wt, CID).metadata["worktree_path"] as string
}

describe("配置一致性核对区块（verify_tool）", () => {
  test("两侧一致 → 渲染计数，不出现不一致方向文案", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      writeFileSync(join(repoRoot(wt), "sonar-project.properties"), "sonar.exclusions=node_modules/**\n", "utf-8")
      const target = { pathPattern: "node_modules/**" }
      await writeExemptions(wt, {
        version: 1,
        items: [{
          key: exemptionRecordKeyOf(target)!,
          pathPattern: "node_modules/**",
          sourcePhase: "tool", dimension: "security", severity: "High",
          description: "依赖目录告警", exemptedAt: "t1", exemptedBy: "r1", changeId: CID,
        }],
      })

      const out = await status.execute({ change_id: CID }, ctx.toolR) as string

      expect(out).toContain("## 豁免与抑制")
      expect(out).toContain("### 配置一致性核对")
      expect(out).toContain("配置忽略条目与豁免记录一致（1 条）")
      expect(out).not.toContain("配置里有但豁免记录缺失")
      expect(out).not.toContain("豁免记录声称配置抑制但配置里无对应忽略")
    } finally { teardown(root) }
  })

  test("配置里有、豁免记录缺失 → 列出条目与来源", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      writeFileSync(join(repoRoot(wt), "sonar-project.properties"), "sonar.exclusions=src/generated/**\n", "utf-8")

      const out = await status.execute({ change_id: CID }, ctx.toolR) as string

      expect(out).toContain("配置里有但豁免记录缺失：")
      expect(out).toContain("sonar-project.properties → src/generated/**")
      expect(out).toContain("skill `java-quality-gate`")
    } finally { teardown(root) }
  })

  test("豁免记录声称配置抑制、配置里无对应忽略 → 列出该记录", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const target = { pathPattern: "src/legacy/**", ruleKeys: ["java:S1"] }
      await writeExemptions(wt, {
        version: 1,
        items: [{
          key: exemptionRecordKeyOf(target)!,
          pathPattern: "src/legacy/**", ruleKeys: ["java:S1"],
          sourcePhase: "tool", dimension: "maintainability", severity: "Low",
          description: "遗留目录告警", exemptedAt: "t1", exemptedBy: "r1", changeId: CID,
        }],
      })

      const out = await status.execute({ change_id: CID }, ctx.toolR) as string

      expect(out).toContain("豁免记录声称配置抑制但配置里无对应忽略：")
      expect(out).toContain("src/legacy/**")
      expect(out).toContain(`change=${CID}`)
    } finally { teardown(root) }
  })
})

describe("渲染条件按生效必做清单（simple 模式同样可见）", () => {
  /** 写一条与 node_modules/** 对应的豁免记录。 */
  async function writeNodeModulesExemption(wt: string): Promise<void> {
    const target = { pathPattern: "node_modules/**" }
    await writeExemptions(wt, {
      version: 1,
      items: [{
        key: exemptionRecordKeyOf(target)!,
        pathPattern: "node_modules/**",
        sourcePhase: "tool", dimension: "security", severity: "High",
        description: "依赖目录告警", exemptedAt: "t1", exemptedBy: "r1", changeId: CID,
      }],
    })
  }

  test("simple 模式：quality_review 视图渲染一致性区块", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToImplement(wt, CID, { mode: "simple" })
      writeFileSync(join(repoRoot(wt), "sonar-project.properties"), "sonar.exclusions=node_modules/**\n", "utf-8")
      await writeNodeModulesExemption(wt)
      await agent_submit.execute(
        {
          change_id: CID,
          step_id: "implement",
          verdict: "passed",
          completed_task_ids: taskIdsOf(readItem(wt, CID)),
        },
        ctx.dev,
      )
      expect(readItem(wt, CID).currentStep).toBe("quality_review")

      const out = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer", wt)) as string

      expect(out).toContain("## 豁免与抑制")
      expect(out).toContain("### 配置一致性核对")
      expect(out).toContain("配置忽略条目与豁免记录一致（1 条）")
    } finally { teardown(root) }
  })

  test("simple 模式：会话未固化项目栈 → 显式「未核对」，不报「一致（0 条）」", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToImplement(wt, CID, { mode: "simple" })
      await agent_submit.execute(
        {
          change_id: CID,
          step_id: "implement",
          verdict: "passed",
          completed_task_ids: taskIdsOf(readItem(wt, CID)),
        },
        ctx.dev,
      )
      // 剥离 stacks 模拟旧会话
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const legacy = JSON.parse(readFileSync(statePath, "utf-8"))
      delete legacy.stacks
      writeFileSync(statePath, JSON.stringify(legacy))

      const out = await status.execute({ change_id: CID }, makeCtx("openspec-reviewer", wt)) as string

      expect(out).toContain("## 豁免与抑制")
      expect(out).toContain("### 配置一致性核对")
      expect(out).toContain("未核对（会话未固化项目栈）")
      expect(out).not.toContain("一致（0 条）")
    } finally { teardown(root) }
  })

  test("编排者视图不渲染该区块（维持现状）", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToImplement(wt, CID, { mode: "simple" })
      const out = await status.execute({ change_id: CID }, ctx.orch) as string
      expect(out).not.toContain("## 豁免与抑制")
    } finally { teardown(root) }
  })
})

// ── 段一「已豁免清单」与维度审查者挂载范围 ──

describe("已豁免清单段（renderExemptionSection 段一）", () => {
  /** 极简 working 视图 item：只保留 status 渲染所需字段。 */
  function itemAt(stepId: string, over: Record<string, unknown> = {}): any {
    return {
      id: "task:1", source: "openspec", type: "task", title: "t", description: "d",
      phase: "review", suspended: false, currentStep: stepId, tags: {}, metadata: {},
      children: [], labels: [], ...over,
    }
  }

  function rec(over: Partial<ExemptionRecord> = {}): ExemptionRecord {
    return {
      key: "k", sourcePhase: "tool", dimension: "security", severity: "High",
      description: "存量问题", exemptedAt: "t1", exemptedBy: "reviewer", changeId: "other",
      ...over,
    }
  }

  test("清单区块出现：与变更相关的条目逐条列出", () => {
    const out = renderWorkingView(itemAt("verify_tool"), "verify_tool", "openspec-reviewer-tool", {
      toolChanges: { files: ["src/Main.java"], hasNonDocChange: true },
      exemptionItems: [rec({ rule: "java:S2068", file: "src/Main.java", line: 42 })],
    })
    expect(out).toContain("## 豁免与抑制")
    expect(out).toContain("### 已豁免清单（命中以下条目不要再提报）")
    expect(out).toContain("- 与本次变更文件相关的豁免条目共 1 条（清单总计 1 条）。")
    expect(out).toContain("`src/Main.java:42` | java:S2068 | High | 存量问题")
  })

  test("按变更文件过滤：无关文件条目不展示", () => {
    const out = renderWorkingView(itemAt("verify_tool"), "verify_tool", "openspec-reviewer-tool", {
      toolChanges: { files: ["src/generated/Gen.java"], hasNonDocChange: true },
      exemptionItems: [
        rec({ pathPattern: "src/generated/**", ruleKeys: ["java:S1"], description: "生成代码告警" }),
        rec({ pathPattern: "docs/**", ruleKeys: ["md:S1"], description: "文档告警" }),
      ],
    })
    expect(out).toContain("- 与本次变更文件相关的豁免条目共 1 条（清单总计 2 条）。")
    expect(out).toContain("`src/generated/**`（路径模式） | java:S1 | High | 生成代码告警")
    expect(out).not.toContain("docs/**")
    expect(out).not.toContain("文档告警")
  })

  test("超过 50 条出现截断提示，只列前 50 条", () => {
    const items = Array.from({ length: 51 }, (_, i) =>
      rec({ file: "src/Main.java", line: i + 1, rule: `java:S${i}`, description: `存量问题${i}` })
    )
    const out = renderWorkingView(itemAt("verify_tool"), "verify_tool", "openspec-reviewer-tool", {
      toolChanges: { files: ["src/Main.java"], hasNonDocChange: true },
      exemptionItems: items,
    })
    expect(out).toContain("> 已截断，共 51 条（仅列出前 50 条）。")
    expect(out).toContain("`src/Main.java:50` | java:S49 | High | 存量问题49")
    expect(out).not.toContain("`src/Main.java:51`")
  })

  test("无 toolChanges 时只给摘要行，不展开明细", () => {
    const out = renderWorkingView(itemAt("verify_tool"), "verify_tool", "openspec-reviewer-tool", {
      exemptionItems: [rec({ rule: "java:S2068", file: "src/Main.java", line: 42 })],
    })
    expect(out).toContain("- 项目级跨 change 豁免清单共 1 条（本次未预计算变更检测结果，不展示明细）。")
    expect(out).not.toContain("| java:S2068 |")
  })

  test("维度审查者视图只挂段二（本轮已抑制），不含段一与段三", () => {
    const item = itemAt("verify_quality", {
      metadata: {
        exemption_suppressed: [{
          rule: "java:S2068", file: "src/Main.java", line: 42, severity: "High",
          description: "检测到硬编码密钥", verdict: "passed_auto",
        }],
      },
    })
    const out = renderWorkingView(item, "verify_quality", "openspec-reviewer-security", {
      toolChanges: { files: ["src/Main.java"], hasNonDocChange: true },
      exemptionItems: [rec({ rule: "java:S2068", file: "src/Main.java", line: 42 })],
    })
    expect(out).toContain("## 豁免与抑制")
    expect(out).toContain("### 本轮已抑制")
    expect(out).toContain("以下 1 条提报命中「已豁免清单」，已抑制、不入库：")
    expect(out).not.toContain("### 已豁免清单")
    expect(out).not.toContain("### 配置一致性核对")
  })
})
