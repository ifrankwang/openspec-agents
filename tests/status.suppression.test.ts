/**
 * verify_tool 视图「配置忽略与豁免一致性」区块测试。
 *
 * 覆盖：两侧一致时渲染计数、配置侧不一致、豁免侧不一致；区块不改变任何门禁判定（verify_tool 仍可
 * passed 推进到 verify_task，由既有流程用例保证，此处只断言渲染）。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { status } from "../src/adapters/opencode/tools"
import { exemptionRecordKeyOf, writeExemptions } from "../src/core/exemptions"
import { setupWithFakeGit, teardown } from "./helpers"
import { driveToVerifyTool, readItem } from "./helpers-workflow"

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
