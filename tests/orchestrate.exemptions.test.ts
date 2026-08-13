/**
 * 项目级跨 change 豁免清单（exemptions.json）测试。
 *
 * 背景：worktree 模式下每个新 change 是全新状态账本 + 全新 Sonar 项目，tool review 全量扫描把
 * 存量已豁免安全问题重新报为阻塞。豁免清单把 dismissed 裁定结论落为 (rule+file+line) 跨 change 共享，
 * 后续 change 命中时降为 Info 级，不阻塞、无需重复豁免。
 *
 * 覆盖：
 * a) 清单读写与幂等 upsert（同 key 刷新不重复累积）
 * b) 专用锁并发串行（两个 changeId 并行写清单不丢更新）
 * c) 两轮不同 changeId 命中降级：第一轮报 High → dev 豁免 → dismissed → 写清单；
 *    第二轮同 rule+file+line 上报 → 命中 → 降为 Info → 不阻塞、无需重复豁免
 * d) Info 级 issue 豁免申请被拒（tools/submit.ts 现有逻辑 + 降级联动）
 * e) giveup 不写清单（giveup 走 applyCheckpointGiveup，不经豁免裁定路径）
 * f) 降级后仅存量豁免问题的 change 里 failed 提交被 assertFailedHasReason 拒绝（防死锁回归）
 */
import { describe, expect, test, afterAll } from "bun:test"
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, set_worktree, agent_submit, status } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, setupWithFakeGit, setupWorkspace, teardown } from "./helpers"
import {
  setupToAnalyze, driveToVerifyTool, readItem, taskIdsOf,
} from "./helpers-workflow"
import {
  readExemptions, writeExemptions, upsertExemption, exemptionKeyOf, applyExemptionDowngrade,
  EXEMPTIONS_FILE,
} from "../src/core/exemptions"
import type { ExemptionRecord } from "../src/core/exemptions"

const CID1 = "test-exempt-1"
const CID2 = "test-exempt-2"

const EB = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/exempt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID1)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string, cid: string): string {
  return join(wt, "openspec", "states", `${cid}.json`)
}

function rewriteItem(wt: string, cid: string, mutate: (item: any) => void): void {
  const p = statePath(wt, cid)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

function exemptionsPath(wt: string): string {
  return join(wt, "openspec", "states", EXEMPTIONS_FILE)
}

/** 带 rule/file/line 的存量安全类 issue（tool reviewer 提报形态）。 */
function highIssue(id: string): Record<string, unknown> {
  return {
    id, title: "硬编码密钥", description: "检测到硬编码密钥", severity: "High",
    dimension: "security", file: "src/Main.java", line: 42, rule: "java:S2068",
  }
}

// ── a: 清单读写与幂等 upsert ──

describe("a. 豁免清单读写与幂等 upsert", () => {
  test("a1. 同 key 再次 upsert 刷新不重复累积；不同 key 追加", async () => {
    const { wt, root } = fresh()
    try {
      const key1 = exemptionKeyOf("java:S2068", "src/Main.java", 42)!
      const rec1: ExemptionRecord = {
        key: key1, rule: "java:S2068", file: "src/Main.java", line: 42,
        sourcePhase: "tool", dimension: "security", severity: "High",
        description: "d", exemptedAt: "t1", exemptedBy: "r1", changeId: CID1,
      }
      await upsertExemption(wt, rec1)
      let store = await readExemptions(wt)
      expect(store.version).toBe(1)
      expect(store.items).toHaveLength(1)
      expect(store.items[0].key).toBe(["java:S2068", "src/Main.java", 42].join("\u0000"))

      // 同 key 再次 upsert → 整体刷新（exemptedAt/changeId 更新），数组不增长
      const rec2 = { ...rec1, exemptedAt: "t2", changeId: CID2, description: "d2" }
      await upsertExemption(wt, rec2)
      store = await readExemptions(wt)
      expect(store.items).toHaveLength(1)
      expect(store.items[0].exemptedAt).toBe("t2")
      expect(store.items[0].changeId).toBe(CID2)
      expect(store.items[0].description).toBe("d2")

      // 不同 key → 追加第二条
      const rec3 = { ...rec1, key: exemptionKeyOf("java:S5804", "src/App.java", 10)!, rule: "java:S5804", file: "src/App.java", line: 10 }
      await upsertExemption(wt, rec3)
      store = await readExemptions(wt)
      expect(store.items).toHaveLength(2)
    } finally { teardown(root) }
  })

  test("a2. rule 缺失时 key 构造返回 null（宁漏勿误），writeExemptions 原子写落盘", async () => {
    const { wt, root } = fresh()
    try {
      expect(exemptionKeyOf(undefined, "src/A.java", 1)).toBeNull()
      expect(exemptionKeyOf("", "src/A.java", 1)).toBeNull()
      expect(exemptionKeyOf("java:S2068", "src/A.java", 1)).toBe("java:S2068\u0000src/A.java\u00001")
      await writeExemptions(wt, { version: 1, items: [] })
      expect(existsSync(exemptionsPath(wt))).toBe(true)
      const store = await readExemptions(wt)
      expect(store.items).toHaveLength(0)
    } finally { teardown(root) }
  })
})

// ── b: 专用锁并发串行 ──

describe("b. 专用锁并发串行", () => {
  test("b1. 两个 changeId 并行写不同 key → 专用锁串行，不丢更新", async () => {
    const { wt, root } = fresh()
    try {
      const rec1: ExemptionRecord = {
        key: exemptionKeyOf("java:S2068", "src/Main.java", 42)!, rule: "java:S2068",
        file: "src/Main.java", line: 42, sourcePhase: "tool", dimension: "security",
        severity: "High", description: "d1", exemptedAt: "t1", exemptedBy: "r1", changeId: CID1,
      }
      const rec2: ExemptionRecord = {
        key: exemptionKeyOf("java:S5804", "src/App.java", 10)!, rule: "java:S5804",
        file: "src/App.java", line: 10, sourcePhase: "tool", dimension: "maintainability",
        severity: "Medium", description: "d2", exemptedAt: "t2", exemptedBy: "r2", changeId: CID2,
      }
      await Promise.all([upsertExemption(wt, rec1), upsertExemption(wt, rec2)])
      const store = await readExemptions(wt)
      expect(store.items).toHaveLength(2)
      const keys = store.items.map((i) => i.key).sort()
      expect(keys).toEqual([rec1.key, rec2.key].sort())
    } finally { teardown(root) }
  })
})

// ── c/f: 两轮不同 changeId 命中降级 + 防死锁 ──

describe("c/f. 跨 change 命中降级与防死锁", () => {
  test("c1. 第一轮 dismissed 写清单；第二轮同 rule+file+line 命中降级（failed 被拒防死锁 → Info 提报通过）", async () => {
    const { wt, root } = fresh()
    try {
      // ── 第一轮 changeId1：tool reviewer 报 High → dev 豁免 → dismissed → 写清单 ──
      const { ctx } = await driveToVerifyTool(wt, CID1)
      await agent_submit.execute(
        { change_id: CID1, step_id: "verify_tool", verdict: "failed", new_children: [highIssue("7")] },
        ctx.toolR
      )
      const item1 = readItem(wt, CID1)
      expect(item1.phase).toBe("in_progress")
      await agent_submit.execute(
        { change_id: CID1, step_id: "implement", verdict: "passed", exempt_issue_ids: ["7"], completed_task_ids: taskIdsOf(item1) },
        ctx.dev
      )
      // tool reviewer 裁定 dismissed（写清单）并推进
      await agent_submit.execute(
        { change_id: CID1, step_id: "verify_tool", verdict: "passed", exempt_adjudications: [{ issue_id: "7", action: "dismissed" }] },
        ctx.toolR
      )
      expect(readItem(wt, CID1).children.find((c: any) => c.externalId === "7").phase).toBe("cancelled")
      const store = JSON.parse(readFileSync(exemptionsPath(wt), "utf-8"))
      expect(store.items).toHaveLength(1)
      expect(store.items[0].key).toBe(["java:S2068", "src/Main.java", 42].join("\u0000"))
      expect(store.items[0].sourcePhase).toBe("tool")
      expect(store.items[0].dimension).toBe("security")
      expect(store.items[0].changeId).toBe(CID1)

      // ── 第二轮 changeId2：全新账本，同 rule+file+line 上报 ──
      setupWorkspace(root, CID2)
      const ctx2 = await setupToAnalyze(wt, CID2)
      await agent_submit.execute({ change_id: CID2, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx2.arch)
      const item2 = readItem(wt, CID2)
      await agent_submit.execute(
        { change_id: CID2, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(item2) },
        ctx2.dev
      )
      // f1：报 High + failed → 命中清单被降为 Info → assertFailedHasReason 拒绝（防死锁）
      const err = await agent_submit.execute(
        { change_id: CID2, step_id: "verify_tool", verdict: "failed", new_children: [highIssue("9")] },
        ctx2.toolR
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/不存在未解决的阻塞 issue/)
      // 被拒零状态变更：issue 未入库
      expect(readItem(wt, CID2).children.find((c: any) => c.externalId === "9")).toBeUndefined()

      // c1 正向：按 Info 提报 + passed → 正常入库，命中标记与中性描述追加
      await agent_submit.execute(
        {
          change_id: CID2, step_id: "verify_tool", verdict: "passed",
          new_children: [{ ...highIssue("9"), severity: "Info" }],
        },
        ctx2.toolR
      )
      const item3 = readItem(wt, CID2)
      const child9 = item3.children.find((c: any) => c.externalId === "9")
      expect(child9.severity).toBe("Info")
      expect(child9.description).toContain("命中项目级豁免清单（rule=java:S2068）")
      expect(child9.metadata["exempted_hit"]).toBe("java:S2068")
      // 命中 Info 不阻塞 verify_tool → 正常推进 verify_task
      expect(item3.currentStep).toBe("verify_task")
    } finally { teardown(root) }
  })

  test("f2. 无豁免清单时，同类 High + failed 正常构成理由（对照：非存量问题不受降级影响）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID1)
      // 清单为空：同类 High + failed 正常回退 implement（未被降级拦截）
      const r = await agent_submit.execute(
        { change_id: CID1, step_id: "verify_tool", verdict: "failed", new_children: [highIssue("7")] },
        ctx.toolR
      )
      expect(r).toContain("提交成功")
      expect(readItem(wt, CID1).phase).toBe("in_progress")
    } finally { teardown(root) }
  })
})

// ── d: Info 级 issue 豁免申请被拒（降级联动）──

describe("d. Info 级 issue 豁免申请被拒", () => {
  test("d1. 命中清单降级入库的 Info issue，dev 申请豁免被拒（Info 不阻塞，无需豁免）", async () => {
    const { wt, root } = fresh()
    try {
      // 直接构造前置：implement 阶段 + 一个命中清单标记的 Info issue child
      const ctx = await setupToAnalyze(wt, CID1)
      await agent_submit.execute({ change_id: CID1, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      const item0 = readItem(wt, CID1)
      await agent_submit.execute(
        { change_id: CID1, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(item0) },
        ctx.dev
      )
      // 回 implement（模拟第二轮循环中 dev 视角）
      rewriteItem(wt, CID1, (item: any) => {
        item.phase = "in_progress"
        item.currentStep = "implement"
        item.children.push({
          id: "issue:9", source: "openspec", externalId: "9", type: "issue",
          title: "硬编码密钥", description: "检测到硬编码密钥", phase: "todo",
          suspended: false, currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-tool", dimension: "security", file: "src/Main.java", line: 42, rule: "java:S2068", exempted_hit: "java:S2068" },
          children: [], labels: [], severity: "Info",
        })
      })
      const err = await agent_submit.execute(
        { change_id: CID1, step_id: "implement", verdict: "passed", exempt_issue_ids: ["9"], completed_task_ids: taskIdsOf(readItem(wt, CID1)) },
        ctx.dev
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/Info 级 issue，不阻塞提交，无需申请豁免/)
    } finally { teardown(root) }
  })
})

// ── e: giveup 不写清单 ──

describe("e. giveup 不写清单", () => {
  test("e1. checkpoint giveup 把未终态 child 置 cancelled，但不写豁免清单", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID1)
      rewriteItem(wt, CID1, (item: any) => {
        item.metadata["_retryCount"] = 3
        item.metadata["_checkpoint"] = true
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "带规则问题", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-tool", dimension: "security", file: "src/Main.java", line: 42, rule: "java:S2068" },
          children: [], labels: [], severity: "High",
        })
      })
      await agent_submit.execute(
        { change_id: CID1, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "giveup" },
        ctx.toolR
      )
      const item = readItem(wt, CID1)
      expect(item.children.find((c: any) => c.id === "issue:7").phase).toBe("cancelled")
      expect(item.metadata["_giveup"]).toBe(true)
      // giveup 不经过豁免裁定路径 → 清单不生成
      expect(existsSync(exemptionsPath(wt))).toBe(false)
      const store = await readExemptions(wt)
      expect(store.items).toHaveLength(0)
    } finally { teardown(root) }
  })
})

// ── 视图：存量豁免提示（点 4）──

describe("视图存量豁免提示", () => {
  test("v1. verify_tool 工作视图渲染「存量豁免提示」汇总与逐条命中标注", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID1)
      // 构造一个命中豁免清单标记的存量 Info issue（模拟上一轮降级入库）
      rewriteItem(wt, CID1, (item: any) => {
        item.children.push({
          id: "issue:9", source: "openspec", externalId: "9", type: "issue",
          title: "硬编码密钥", description: "检测到硬编码密钥", phase: "todo",
          suspended: false, currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-tool", dimension: "security", file: "src/Main.java", line: 42, rule: "java:S2068", exempted_hit: "java:S2068" },
          children: [], labels: [], severity: "Info",
        })
      })
      const out = await status.execute({ change_id: CID1 }, ctx.toolR)
      expect(out).toContain("存量豁免提示")
      expect(out).toContain("1 个命中项目级跨 change 豁免清单的存量问题")
      // 命中降级入库的 Info issue 在 dev 视图（implement）逐条标注，提示无需重复豁免
      rewriteItem(wt, CID1, (item: any) => {
        item.phase = "in_progress"
        item.currentStep = "implement"
        delete item.tags["implement:openspec-developer"]
      })
      const devOut = await status.execute({ change_id: CID1 }, ctx.dev)
      expect(devOut).toContain("Issue (待修复 · Info，建议修复，不阻塞提交)")
      expect(devOut).toContain("命中项目级豁免清单（rule=java:S2068）的存量问题，已按 Info 处理，无需重复豁免")
    } finally { teardown(root) }
  })
})

// ── 视图：豁免反馈提示（无规则名 / 疑似行号漂移）──

describe("视图豁免反馈提示（无规则名 / 疑似行号漂移）", () => {
  test("h1. (rule+file) 命中清单但 line 不同 → verify_tool 视图渲染疑似行号漂移提示；line 一致命中降级不重复提示，且漂移提示不计入存量豁免统计", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID1)
      // 预置豁免清单：rule=java:S2068, file=src/Main.java, line=42
      await writeExemptions(wt, {
        version: 1,
        items: [{
          key: exemptionKeyOf("java:S2068", "src/Main.java", 42)!,
          rule: "java:S2068", file: "src/Main.java", line: 42,
          sourcePhase: "tool", dimension: "security", severity: "High",
          description: "硬编码密钥", exemptedAt: "t1", exemptedBy: "r1", changeId: CID1,
        }],
      })
      // 同 rule+file 但 line=100 的 tool 层 review 态 issue（verify_tool 待复核区块可见）
      rewriteItem(wt, CID1, (item: any) => {
        item.children.push({
          id: "issue:8", source: "openspec", externalId: "8", type: "issue",
          title: "硬编码密钥", description: "检测到硬编码密钥", phase: "review",
          suspended: false, currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-tool", dimension: "security", file: "src/Main.java", line: 100, rule: "java:S2068" },
          children: [], labels: [], severity: "High",
        })
      })
      const out = await status.execute({ change_id: CID1 }, ctx.toolR)
      expect(out).toContain("疑似行号漂移")
      expect(out).toContain("line=42")
      // 漂移提示不写 exempted_hit 标记 → 不计入存量豁免统计（无「存量豁免提示」汇总行）
      expect(out).not.toContain("存量豁免提示")
      // 对照：line=42 完全命中（exempted_hit 标记）的 issue 不出现漂移提示，仅原漂移提示保留
      rewriteItem(wt, CID1, (item: any) => {
        item.children.push({
          id: "issue:9", source: "openspec", externalId: "9", type: "issue",
          title: "硬编码密钥", description: "检测到硬编码密钥", phase: "review",
          suspended: false, currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-tool", dimension: "security", file: "src/Main.java", line: 42, rule: "java:S2068", exempted_hit: "java:S2068" },
          children: [], labels: [], severity: "Info",
        })
      })
      const out2 = await status.execute({ change_id: CID1 }, ctx.toolR)
      expect((out2.match(/疑似行号漂移/g) ?? []).length).toBe(1)
      // 命中降级 issue 计入存量豁免统计（仅统计 exempted_hit 标记），漂移提示不计入
      expect(out2).toContain("1 个命中项目级跨 change 豁免清单的存量问题")
    } finally { teardown(root) }
  })

  test("h2. tool 层 issue 无 rule（metadata 无 rule 字段）→ 视图渲染无规则名提示；有 rule 的 issue 不出现该提示", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID1)
      rewriteItem(wt, CID1, (item: any) => {
        item.children.push({
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "未使用变量", description: "检测到未使用变量", phase: "review",
          suspended: false, currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-tool", dimension: "maintainability", file: "src/App.java", line: 3 },
          children: [], labels: [], severity: "Low",
        })
      })
      const out = await status.execute({ change_id: CID1 }, ctx.toolR)
      expect(out).toContain("无规则名")
      // 对照：有 rule 的 tool 层 issue 不出现无规则名提示
      rewriteItem(wt, CID1, (item: any) => {
        item.children.push({
          id: "issue:8", source: "openspec", externalId: "8", type: "issue",
          title: "硬编码密钥", description: "检测到硬编码密钥", phase: "review",
          suspended: false, currentStep: null, tags: {},
          metadata: { source: "openspec-reviewer-tool", dimension: "security", file: "src/Main.java", line: 42, rule: "java:S2068" },
          children: [], labels: [], severity: "High",
        })
      })
      const out2 = await status.execute({ change_id: CID1 }, ctx.toolR)
      expect((out2.match(/无规则名/g) ?? []).length).toBe(1)
    } finally { teardown(root) }
  })
})

// ── g: 异常路径不落盘（清单写入与状态持久化原子性）──

describe("g. 异常路径不落盘（原子性）", () => {
  test("g1. 同批提交豁免裁定 + new_children 带非法 dimension 抛错 → 清单不生成", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID1)
      // tool reviewer 报 High issue → failed 回 implement
      await agent_submit.execute(
        { change_id: CID1, step_id: "verify_tool", verdict: "failed", new_children: [highIssue("7")] },
        ctx.toolR
      )
      const item1 = readItem(wt, CID1)
      expect(item1.phase).toBe("in_progress")
      // dev 豁免该 issue
      await agent_submit.execute(
        { change_id: CID1, step_id: "implement", verdict: "passed", exempt_issue_ids: ["7"], completed_task_ids: taskIdsOf(item1) },
        ctx.dev
      )
      // 同批提交：豁免裁定（dismissed）先执行（收集），随后 new_children 非法 dimension 校验抛错
      const err = await agent_submit.execute(
        {
          change_id: CID1, step_id: "verify_tool", verdict: "passed",
          exempt_adjudications: [{ issue_id: "7", action: "dismissed" }],
          new_children: [{ id: "8", title: "t", description: "d", severity: "High", dimension: "BAD_DIM" }],
        },
        ctx.toolR
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/dimension 非法/)
      // 异常路径不落盘：清单文件不生成，内存状态零变更（issue 未入库）
      expect(existsSync(exemptionsPath(wt))).toBe(false)
      const store = await readExemptions(wt)
      expect(store.items).toHaveLength(0)
      expect(readItem(wt, CID1).children.find((c: any) => c.externalId === "8")).toBeUndefined()
    } finally { teardown(root) }
  })
})
