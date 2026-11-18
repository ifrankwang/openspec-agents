/**
 * 提交层存量豁免抑制测试（tools/submit.ts + core/exemptions.applyExemptionSuppression）。
 *
 * 语义：review 系 agent 提交的 new_children 命中项目级跨 change 豁免清单时直接抑制、不入库
 * （不改 severity、不写 exempted_hit）；若抑制后无剩余 blocking，则按 passed 自动收口，
 * 但门禁不放宽（必做清单覆盖等仍按 passed 校验）。
 *
 * 覆盖：
 * s1 全抑制 → 命中条目不入库、step passed、留痕 verdict=passed_auto
 * s2 全抑制但缺必做清单覆盖 → 仍被门禁拒绝
 * s3 部分抑制 → 仍 failed；未命中入库、命中不入库
 * s4 verify_cleanup 不抑制 → 命中条目仍入库
 * s5 返回体：有抑制含专用段；无抑制严格等于 SUBMIT_OK_MESSAGE
 * s6 规则不变但行号漂移 → 旧三元组不命中、仍入库
 */
import { describe, expect, test, afterAll } from "bun:test"
import { __setGitRunner } from "../src/core/git"
import { agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, setupWithFakeGit, teardown } from "./helpers"
import {
  driveToQuality, driveToVerifyTool, readItem, submitQualityPassed,
} from "./helpers-workflow"
import { exemptionKeyOf, writeExemptions } from "../src/core/exemptions"

const CID = "test-exempt-suppression"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/exempt-suppress-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

/** 带 rule/file/line 的存量安全类 issue（tool reviewer 提报形态）。 */
function issue(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: "硬编码密钥", description: "检测到硬编码密钥", severity: "High",
    dimension: "security", file: "src/Main.java", line: 42, rule: "java:S2068",
    ...over,
  }
}

/** 写入一条与默认 issue 完全匹配的豁免记录（changeId 为其它 change，模拟跨 change 存量）。 */
async function seedExemption(wt: string, over: Record<string, unknown> = {}): Promise<void> {
  await writeExemptions(wt, {
    version: 1,
    items: [{
      key: exemptionKeyOf("java:S2068", "src/Main.java", 42)!,
      rule: "java:S2068", file: "src/Main.java", line: 42,
      sourcePhase: "tool", dimension: "security", severity: "High",
      description: "硬编码密钥", exemptedAt: "t1", exemptedBy: "reviewer", changeId: "other-change",
      ...over,
    }],
  })
}

describe("s1. 全抑制自动收口", () => {
  test("failed 且只带命中清单的 issue → 不入库、step passed、留痕 verdict=passed_auto", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await seedExemption(wt)
      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "failed", new_children: [issue("9")] },
        ctx.toolR
      )
      const item = readItem(wt, CID)
      // 命中条目不入库
      expect(item.children.filter((c: any) => c.type === "issue")).toHaveLength(0)
      // verify_tool passed → 推进 verify_task
      expect(item.currentStep).toBe("verify_task")
      const trail = item.metadata["exemption_suppressed"]
      expect(trail).toHaveLength(1)
      expect(trail[0]).toMatchObject({
        rule: "java:S2068", file: "src/Main.java", line: 42, severity: "High", verdict: "passed_auto",
      })
      expect(out).toContain("### 已抑制的存量豁免问题")
    } finally { teardown(root) }
  })
})

describe("s2. 自动收口不放宽门禁", () => {
  test("全抑制但缺必做清单覆盖 → 提交被拒，错误仍指向必做清单", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await seedExemption(wt)
      const err = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [issue("9")], must_do_checks: [],
        },
        ctx.toolR
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/必做/)
      // 被拒零状态变更：仍停在 verify_tool，命中条目未入库
      const item = readItem(wt, CID)
      expect(item.currentStep).toBe("verify_tool")
      expect(item.children.filter((c: any) => c.type === "issue")).toHaveLength(0)
    } finally { teardown(root) }
  })
})

describe("s3. 部分抑制", () => {
  test("命中 + 未命中 blocking → 仍 failed；未命中入库、命中不入库", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await seedExemption(wt)
      const out = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [issue("9"), issue("10", { line: 100, description: "另一处硬编码" })],
        },
        ctx.toolR
      )
      expect(out).toContain("提交成功")
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.children.find((c: any) => c.externalId === "10")).toBeDefined()
      expect(item.children.find((c: any) => c.externalId === "9")).toBeUndefined()
      const trail = item.metadata["exemption_suppressed"]
      expect(trail).toHaveLength(1)
      expect(trail[0].verdict).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("s4. verify_cleanup 不抑制", () => {
  test("命中清单的 issue 在 verify_cleanup 仍入库", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToQuality(wt, CID)
      await submitQualityPassed(ctx, CID)
      expect(readItem(wt, CID).currentStep).toBe("verify_cleanup")
      await seedExemption(wt)
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_cleanup", verdict: "failed", new_children: [issue("7")] },
        ctx.dev
      )
      const item = readItem(wt, CID)
      expect(item.children.find((c: any) => c.externalId === "7")).toBeDefined()
      expect(item.metadata["exemption_suppressed"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("s5. 返回体", () => {
  test("无抑制时严格等于 SUBMIT_OK_MESSAGE", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      // 返回体只能是原文，不追加空段或自由发挥
      const plain = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed" },
        ctx.toolR
      )
      expect(plain).toBe("提交成功，请直接结束当前会话")
    } finally { teardown(root) }
  })

  test("有抑制时追加「已抑制的存量豁免问题」专用段", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await seedExemption(wt)
      const suppressed = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "failed", new_children: [issue("9")] },
        ctx.toolR
      )
      expect(suppressed).toContain("### 已抑制的存量豁免问题")
      expect(suppressed).toContain("- java:S2068 | src/Main.java:42 | 原级别 High")
    } finally { teardown(root) }
  })
})

describe("s6. 规则不变但行号漂移", () => {
  test("旧三元组记录 file+line → 行号漂移不命中、仍入库", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      await seedExemption(wt)
      const out = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "failed", new_children: [issue("9", { line: 100 })] },
        ctx.toolR
      )
      expect(out).not.toContain("### 已抑制的存量豁免问题")
      const item = readItem(wt, CID)
      expect(item.children.find((c: any) => c.externalId === "9")).toBeDefined()
      expect(item.metadata["exemption_suppressed"]).toBeUndefined()
      expect(item.phase).toBe("in_progress")
    } finally { teardown(root) }
  })
})
