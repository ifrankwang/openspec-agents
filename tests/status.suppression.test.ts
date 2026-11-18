/**
 * verify_tool 视图「配置忽略与豁免一致性」区块测试。
 *
 * 覆盖：两侧一致时渲染计数、配置侧不一致、豁免侧不一致；区块不改变任何门禁判定（verify_tool 仍可
 * passed 推进到 verify_task，由既有流程用例保证，此处只断言渲染）。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { agent_submit, status } from "../src/adapters/opencode/tools"
import { exemptionRecordKeyOf, writeExemptions } from "../src/core/exemptions"
import { makeCtx, setupWithFakeGit, teardown } from "./helpers"
import { driveToVerifyTool, readItem, setupToImplement, taskIdsOf } from "./helpers-workflow"

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

describe("verify_tool 配置忽略与豁免一致性区块", () => {
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

      expect(out).toContain("## 配置忽略与豁免一致性")
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

      expect(out).toContain("## 配置忽略与豁免一致性")
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

      expect(out).toContain("## 配置忽略与豁免一致性")
      expect(out).toContain("未核对（会话未固化项目栈）")
      expect(out).not.toContain("一致（0 条）")
    } finally { teardown(root) }
  })

  test("编排者视图不渲染该区块（维持现状）", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToImplement(wt, CID, { mode: "simple" })
      const out = await status.execute({ change_id: CID }, ctx.orch) as string
      expect(out).not.toContain("## 配置忽略与豁免一致性")
    } finally { teardown(root) }
  })
})
