import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { readDashboardState } from "../src/core/dashboard"

const TMP = join("/tmp", "dash-test-" + Date.now())
const STATE_DIR = join(TMP, ".opencode", ".orchestrate_state")

function writeState(changeId: string, data: unknown) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(join(STATE_DIR, `${changeId}.json`), JSON.stringify(data, null, 2))
}

const mockState = {
  changeId: "dash-change-001",
  taskGroupId: "tg-1",
  baseBranch: "main",
  createdAt: "2026-07-13T10:00:00.000Z",
  updatedAt: "2026-07-13T10:05:00.000Z",
  taskGroups: [
    {
      id: "tg-1",
      name: "用户登录",
      taskCount: 2,
      status: "dev_impl",
      worktreePath: "/tmp/.worktree/task-group-user-login",
      branchName: "task-group/user-login",
      relevantSpecs: ["auth/login"],
      executionBoundary: {
        allowed_directories: ["src"],
        allowed_packages: ["com.example"],
        notes: "",
      },
      lastFilesChanged: ["AuthController.java"],
      phases: {
        architect_review: { completed: true },
        review: {
          retryCount: 0,
          lastResolvedRetryCount: 0,
          tool: { completed: false },
          task: { completed: false },
          quality: {
            progress: {
              style: "pending",
              architecture: "pending",
              performance: "pending",
              security: "pending",
              maintainability: "pending",
            },
            
          },
        },
      },
      tasks: [
        { id: "1", title: "登录接口", taskNumber: "1.1", specTrace: "spec.md", status: "open", rejectReason: null },
        { id: "2", title: "单元测试", taskNumber: "1.2", specTrace: "spec.md", status: "verified", rejectReason: null },
      ],
      issues: [
        { id: "10", dimension: "security", severity: "Critical", file: "Auth.java", line: 12, description: "SQL 注入", suggestion: "用参数化", rootCauseGuess: "直接拼 SQL", status: "open", refixCount: 1, rejectReason: null, exemptReason: null, sourcePhase: "quality" },
        { id: "11", dimension: "style", severity: "Info", file: "Config.java", line: 3, description: "命名不规范", suggestion: null, rootCauseGuess: null, status: "verified", refixCount: 0, rejectReason: null, exemptReason: null, sourcePhase: "tool" },
      ],
      blockers: [
        { id: "b1", sourceRole: "openspec-developer", taskId: "1", category: "external_dependency", description: "依赖服务不可用", evidence: "HTTP 503", attemptedActions: "重试请求", options: ["提供服务地址"], status: "awaiting_user", userResponse: null, architectConclusion: null },
      ],
    },
  ],
}

let server: ReturnType<typeof Bun.serve> | null = null

describe("Dashboard", () => {
  beforeAll(() => {
    mkdirSync(TMP, { recursive: true })
  })

  afterAll(() => {
    if (server) server.stop()
    rmSync(TMP, { recursive: true, force: true })
  })

  test("readDashboardState returns null when no state", async () => {
    const emptyDir = join(TMP, "empty-" + Date.now())
    mkdirSync(emptyDir, { recursive: true })
    const result = await readDashboardState(emptyDir)
    expect(result).toBeNull()
  })

  test("readDashboardState returns projection with correct fields", async () => {
    writeState("dash-change-001", mockState)
    const result = await readDashboardState(TMP, "dash-change-001")
    expect(result).not.toBeNull()
    const r = result!
    expect(r.active).toBe(true)
    expect(r.changeId).toBe("dash-change-001")
    expect(r.currentTaskGroupId).toBe("tg-1")
    expect(r.baseBranch).toBe("main")
    expect(r.taskGroups).toHaveLength(1)

    const tg = r.taskGroups[0]
    expect(tg.status).toBe("dev_impl")
    expect(tg.lifecycle).toBe("in_progress")
    expect(tg.tasks).toHaveLength(2)
    expect(tg.issues).toHaveLength(2)
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.phases.review.retryCount).toBe(0)
    expect(tg.blockers).toHaveLength(1)
    expect(tg.lastFilesChanged).toEqual(["AuthController.java"])
    expect(tg.reviewCompleted).toBe(false)
  })

  test("review completion requires no unresolved Issue or Blocker", async () => {
    const completeReview = structuredClone(mockState)
    completeReview.taskGroups[0].phases.review.tool.completed = true
    completeReview.taskGroups[0].phases.review.task.completed = true
    completeReview.taskGroups[0].phases.review.quality.progress = {
      style: "passed",
      architecture: "passed",
      performance: "passed",
      security: "passed",
      maintainability: "passed",
    }

    writeState("review-gates", completeReview)
    expect((await readDashboardState(TMP, "review-gates"))!.taskGroups[0].reviewCompleted).toBe(false)

    completeReview.taskGroups[0].issues[0].status = "verified"
    writeState("review-gates", completeReview)
    expect((await readDashboardState(TMP, "review-gates"))!.taskGroups[0].reviewCompleted).toBe(false)

    completeReview.taskGroups[0].blockers[0].status = "resolved"
    writeState("review-gates", completeReview)
    expect((await readDashboardState(TMP, "review-gates"))!.taskGroups[0].reviewCompleted).toBe(true)
  })

  test("HTTP server returns state JSON", async () => {
    writeState("dash-change-001", mockState)
    try {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async () => {
          const data = await readDashboardState(TMP, "dash-change-001")
          return new Response(JSON.stringify(data ?? { active: false }), {
            headers: { "content-type": "application/json" },
          })
        },
      })

      const res = await fetch(server.url)
      const json = await res.json()
      expect(json.active).toBe(true)
      expect(json.changeId).toBe("dash-change-001")
      expect(json.taskGroups[0].lifecycle).toBe("in_progress")
    } finally {
      server?.stop()
      server = null
    }
  })

  test("readDashboardState without changeId scans directory and returns first", async () => {
    writeState("dash-change-001", mockState)
    const data = await readDashboardState(TMP)
    expect(data).not.toBeNull()
  })

  test("HTTP server returns active:false when no state", async () => {
    const emptyDir = join(TMP, "empty-" + Date.now())
    mkdirSync(emptyDir, { recursive: true })
    try {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async () => {
          const data = await readDashboardState(emptyDir)
          return new Response(JSON.stringify(data ?? { active: false }), {
            headers: { "content-type": "application/json" },
          })
        },
      })

      const res = await fetch(server.url)
      const json = await res.json()
      expect(json.active).toBe(false)
    } finally {
      server?.stop()
      server = null
    }
  })

  test("task and issue fields projected correctly", async () => {
    writeState("type-test", mockState)
    const r = await readDashboardState(TMP, "type-test")
    const tg = r!.taskGroups[0]

    const t1 = tg.tasks.find((t: any) => t.id === "1")!
    expect(t1.title).toBe("登录接口")
    expect(t1.status).toBe("open")

    const i1 = tg.issues.find((i: any) => i.id === "10")!
    expect(i1.severity).toBe("Critical")
    expect(i1.refixCount).toBe(1)
    expect(i1.sourcePhase).toBe("quality")

    const i2 = tg.issues.find((i: any) => i.id === "11")!
    expect(i2.sourcePhase).toBe("tool")
    expect(tg.blockers[0].status).toBe("awaiting_user")
  })
})
