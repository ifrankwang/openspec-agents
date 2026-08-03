/**
 * workItems 迁移测试：旧格式 state（无 workItems、有 taskGroups）经 readStateByChangeId
 * 自动升级为 workItems 并落盘；幂等、空 taskGroups、磁盘写入。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readStateByChangeId } from "../src/core/state"
import type { WorkItem } from "../src/core/workflow/types"

const CID = "migration-test"

afterAll(() => {
  rmSync("/tmp/state-migration-test", { recursive: true, force: true })
})

function statePath(root: string, changeId = CID): string {
  const dir = join(root, ".opencode", ".orchestrate_state")
  mkdirSync(dir, { recursive: true })
  return join(dir, `${changeId}.json`)
}

function readDiskState(root: string, changeId = CID): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(root, changeId), "utf-8")) as Record<string, unknown>
}

function makeIssue(id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, dimension: "style", sourcePhase: "quality", severity: "Low",
    file: "x.java", line: 1, description: `Issue ${id}`, suggestion: "Fix",
    status, refixCount: 0, rootCauseGuess: null, exemptReason: null, rejectReason: null,
    ...extra,
  }
}

function makeGroup(id: string, status: string, issues: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    id, name: `Group ${id}`, taskCount: issues.length,
    worktreePath: null, branchName: null, baseRef: null, executionBoundary: null,
    relevantSpecs: [], status,
    phases: {
      architect_review: { completed: status !== "task_analysis" },
      review: {
        retryCount: 0, lastResolvedRetryCount: 0,
        tool: { completed: false }, task: { completed: false },
        quality: { progress: { style: "pending", architecture: "pending", performance: "pending", security: "pending", maintainability: "pending" } },
      },
    },
    tasks: [], issues, blockers: [],
  }
}

function makeLegacyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    changeId: CID,
    isolationNamespace: "ns-migration",
    taskGroupId: "1",
    baseBranch: "main",
    taskGroups: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("state.workItems 迁移", () => {
  test("旧格式（无 workItems）自动升级：phase/currentStep/children issue 映射正确", async () => {
    const root = `/tmp/state-migration-test/upgrade-${Date.now()}`
    const issues = [
      makeIssue("1", "verified"),
      makeIssue("2", "submitted"),
      makeIssue("3", "open", { severity: "High" }),
      makeIssue("4", "exempted", { dimension: "architecture", severity: "Info" }),
    ]
    writeFileSync(statePath(root), JSON.stringify(makeLegacyState({
      taskGroups: [makeGroup("1", "review", issues)],
    })))

    const state = await readStateByChangeId(root, CID)
    expect(state).not.toBeNull()
    expect(state!.workItems).toBeDefined()
    expect(state!.workItems!.length).toBe(1)

    const task = state!.workItems![0]
    expect(task.id).toBe("task:1")
    expect(task.source).toBe("openspec")
    expect(task.externalId).toBe("1")
    expect(task.type).toBe("task")
    expect(task.title).toBe("Group 1")
    expect(task.description).toBe("Group 1")
    expect(task.phase).toBe("review")
    expect(task.suspended).toBe(false)
    expect(task.currentStep).toBe("verify_tool")
    expect(task.labels).toEqual(["openspec-change"])
    expect(task.metadata).toEqual({ source: "openspec", tasks: [] })

    expect(task.children.length).toBe(4)
    const byId = (id: string): WorkItem => task.children.find((c) => c.id === `issue:${id}`)!
    expect(byId("1").phase).toBe("done")        // verified → done
    expect(byId("2").phase).toBe("review")      // submitted → review（待裁定）
    expect(byId("3").phase).toBe("todo")        // open → todo
    expect(byId("4").phase).toBe("cancelled")   // exempted → cancelled
    expect(byId("3").severity).toBe("High")     // severity 保留
    expect(byId("4").severity).toBe("Info")
    expect(byId("1").title).toBe("Issue 1")
    expect(byId("1").description).toBe("Issue 1")
  })

  test("各 taskGroup 状态映射为对应 phase/currentStep", async () => {
    const root = `/tmp/state-migration-test/status-${Date.now()}`
    writeFileSync(statePath(root), JSON.stringify(makeLegacyState({
      taskGroups: [
        makeGroup("1", "task_analysis"),
        makeGroup("2", "dev_impl"),
        makeGroup("3", "review"),
        makeGroup("4", "completed"),
      ],
    })))

    const state = await readStateByChangeId(root, CID)
    const workItems = state!.workItems!
    expect(workItems.map((w) => w.phase)).toEqual(["todo", "in_progress", "review", "done"])
    expect(workItems.map((w) => w.currentStep)).toEqual(["analyze", "implement", "verify_tool", null])
  })

  test("幂等：已含 workItems 的 state 读取后不被覆盖", async () => {
    const root = `/tmp/state-migration-test/idempotent-${Date.now()}`
    const existing: WorkItem = {
      id: "custom:1",
      source: "openspec",
      externalId: "custom",
      type: "task",
      title: "自定义 WorkItem",
      description: "不应被 taskGroups 覆盖",
      phase: "todo",
      suspended: false,
      currentStep: null,
      tags: {},
      metadata: {},
      children: [],
      labels: [],
    }
    writeFileSync(statePath(root), JSON.stringify(makeLegacyState({
      taskGroups: [makeGroup("1", "review", [makeIssue("1", "verified")])],
      workItems: [existing],
    })))

    const state = await readStateByChangeId(root, CID)
    expect(state!.workItems).toEqual([existing])
  })

  test("空 taskGroups → workItems 为空数组", async () => {
    const root = `/tmp/state-migration-test/empty-${Date.now()}`
    writeFileSync(statePath(root), JSON.stringify(makeLegacyState({ taskGroups: [] })))

    const state = await readStateByChangeId(root, CID)
    expect(state!.workItems).toEqual([])
  })

  test("升级后磁盘文件写入了 workItems", async () => {
    const root = `/tmp/state-migration-test/disk-${Date.now()}`
    writeFileSync(statePath(root), JSON.stringify(makeLegacyState({
      taskGroups: [makeGroup("1", "review", [makeIssue("1", "verified")])],
    })))

    await readStateByChangeId(root, CID)

    const disk = readDiskState(root)
    expect(Array.isArray(disk.workItems)).toBe(true)
    expect((disk.workItems as WorkItem[]).length).toBe(1)
    expect((disk.workItems as WorkItem[])[0].id).toBe("task:1")
  })

  test("exemption_requested issue 迁移为 child 时带 exempt_request metadata（reason 透传）", async () => {
    const root = `/tmp/state-migration-test/exempt-${Date.now()}`
    const issues = [
      makeIssue("1", "exemption_requested", { exemptReason: "第三方库限制" }),
    ]
    writeFileSync(statePath(root), JSON.stringify(makeLegacyState({
      taskGroups: [makeGroup("1", "review", issues)],
    })))

    const state = await readStateByChangeId(root, CID)
    const child = state!.workItems![0].children.find((c) => c.id === "issue:1")!
    expect(child.phase).toBe("todo")
    expect(child.metadata["exempt_request"]).toEqual({
      requestedBy: "openspec-reviewer-style", // sourcePhase=quality → DIMENSION_AGENT_MAP[style]
      reason: "第三方库限制",
    })
  })
})
