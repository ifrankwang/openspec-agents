import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
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

const workItemState = {
  changeId: "dash-workitems",
  isolationNamespace: "ns-1",
  taskGroupId: "tg-1",
  baseBranch: "main",
  createdAt: "2026-07-13T10:00:00.000Z",
  updatedAt: "2026-07-13T10:05:00.000Z",
  taskGroups: [
    {
      id: "tg-1",
      name: "用户登录",
      taskCount: 1,
      status: "dev_impl",
      worktreePath: null,
      branchName: null,
      baseRef: null,
      executionBoundary: null,
      relevantSpecs: [],
      phases: {
        architect_review: { completed: true },
        review: { retryCount: 0, lastResolvedRetryCount: 0, tool: { completed: false }, task: { completed: false }, quality: { progress: {} } },
      },
      tasks: [],
      issues: [],
      blockers: [],
    },
  ],
  workItems: [
    {
      id: "task:tg-1",
      source: "openspec",
      externalId: "tg-1",
      type: "task",
      title: "用户登录",
      description: "实现登录功能，含 SQL 注入修复与命名规范统一，涉及认证、鉴权与单元测试三部分。",
      phase: "in_progress",
      suspended: true,
      currentStep: "implement",
      tags: { "analyze:openspec-architect": "passed", "implement:openspec-developer": "passed" },
      metadata: { source: "openspec", suspend_reason: "等待用户确认接口契约", _retryCount: 2 },
      children: [
        {
          id: "issue:10",
          source: "openspec",
          externalId: "10",
          type: "issue",
          title: "SQL 注入",
          description: "SQL 注入",
          phase: "review",
          suspended: false,
          currentStep: "verify_tool",
          tags: {},
          metadata: {},
          children: [],
          labels: [],
          severity: "Critical",
        },
      ],
      labels: ["openspec-change"],
    },
    {
      id: "ado:123",
      source: "ado",
      externalId: "123",
      type: "issue",
      title: "循环内重复查询数据库",
      description: "建议批量处理或加缓存",
      phase: "review",
      suspended: false,
      currentStep: "verify_quality",
      tags: { "verify_quality:openspec-reviewer-performance": "failed" },
      metadata: { _retryCount: 1 },
      children: [],
      labels: ["performance"],
      severity: "High",
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
    writeState("dash-workitems", workItemState)
    const result = await readDashboardState(TMP, "dash-workitems")
    expect(result).not.toBeNull()
    const r = result!
    expect(r.active).toBe(true)
    expect(r.changeId).toBe("dash-workitems")
    expect(r.currentTaskGroupId).toBe("tg-1")
    expect(r.baseBranch).toBe("main")
    expect(r.workItems).toHaveLength(2)
    expect(r.workItemCards).toHaveLength(2)

    const task = r.workItemCards.find((c) => c.type === "task")!
    expect(task.phase).toBe("in_progress")
    expect(task.suspended).toBe(true)
    expect(task.suspendReason).toBe("等待用户确认接口契约")
    expect(task.currentStep).toBe("implement")
    expect(task.agentVerdicts).toEqual([
      { stepId: "analyze", agentKey: "openspec-architect", verdict: "passed" },
      { stepId: "implement", agentKey: "openspec-developer", verdict: "passed" },
    ])

    const issue = r.workItemCards.find((c) => c.type === "issue")!
    expect(issue.source).toBe("ado")
    expect(issue.phase).toBe("review")
    expect(issue.severity).toBe("High")
  })

  test("workItems 原始透传保留内部 metadata，卡片投影剥离下划线字段", async () => {
    writeState("dash-workitems", workItemState)
    const r = (await readDashboardState(TMP, "dash-workitems"))!
    // workItems 为单轨事实源原始透传：内部 metadata（_retryCount）保留
    const raw = r.workItems.find((w: any) => w.id === "task:tg-1")
    expect(raw.metadata["_retryCount"]).toBe(2)
    expect(raw.metadata["suspend_reason"]).toBe("等待用户确认接口契约")
    // 卡片投影剥离下划线内部字段
    const card = r.workItemCards.find((c) => c.type === "task")!
    expect(card).not.toHaveProperty("_retryCount")
    expect(card.suspendReason).toBe("等待用户确认接口契约")
  })

  test("HTTP server returns state JSON", async () => {
    writeState("dash-workitems", workItemState)
    try {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async () => {
          const data = await readDashboardState(TMP, "dash-workitems")
          return new Response(JSON.stringify(data ?? { active: false }), {
            headers: { "content-type": "application/json" },
          })
        },
      })

      const res = await fetch(server.url)
      const json = await res.json()
      expect(json.active).toBe(true)
      expect(json.changeId).toBe("dash-workitems")
      expect(json.workItems).toHaveLength(2)
      expect(json.workItemCards).toHaveLength(2)
      const task = json.workItemCards.find((c: any) => c.type === "task")
      expect(task.phase).toBe("in_progress")
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
    writeState("dash-workitems", workItemState)
    const r = await readDashboardState(TMP, "dash-workitems")
    const cards = r!.workItemCards

    const task = cards.find((c: any) => c.type === "task")!
    expect(task.id).toBe("task:tg-1")
    expect(task.title).toBe("用户登录")
    expect(task.description).toContain("SQL 注入")
    expect(task.labels).toEqual(["openspec-change"])
    // task 卡片 children 投影子 issue 的关键字段
    const child = task.children.find((c: any) => c.id === "issue:10")!
    expect(child.type).toBe("issue")
    expect(child.phase).toBe("review")
    expect(child.severity).toBe("Critical")

    const issue = cards.find((c: any) => c.type === "issue")!
    expect(issue.id).toBe("ado:123")
    expect(issue.phase).toBe("review")
    expect(issue.currentStep).toBe("verify_quality")
    expect(issue.agentVerdicts).toEqual([
      { stepId: "verify_quality", agentKey: "openspec-reviewer-performance", verdict: "failed" },
    ])
  })

  test("workItemCards projection exposes renderable card fields", async () => {
    writeState("dash-workitems", workItemState)
    const r = await readDashboardState(TMP, "dash-workitems")
    expect(r!.workItems).toHaveLength(2)
    expect(r!.workItemCards).toHaveLength(2)

    const task = r!.workItemCards.find((c) => c.type === "task")!
    expect(task.id).toBe("task:tg-1")
    expect(task.title).toBe("用户登录")
    expect(task.phase).toBe("in_progress")
    expect(task.suspended).toBe(true)
    expect(task.suspendReason).toBe("等待用户确认接口契约")
    expect(task.currentStep).toBe("implement")
    expect(task.source).toBe("openspec")
    expect(task.labels).toEqual(["openspec-change"])
    expect(task.agentVerdicts).toEqual([
      { stepId: "analyze", agentKey: "openspec-architect", verdict: "passed" },
      { stepId: "implement", agentKey: "openspec-developer", verdict: "passed" },
    ])
    expect(task.children).toHaveLength(1)
    const child = task.children[0]
    expect(child.id).toBe("issue:10")
    expect(child.type).toBe("issue")
    expect(child.phase).toBe("review")
    expect(child.severity).toBe("Critical")

    const issue = r!.workItemCards.find((c) => c.type === "issue")!
    expect(issue.source).toBe("ado")
    expect(issue.severity).toBe("High")
    expect(issue.agentVerdicts).toEqual([
      { stepId: "verify_quality", agentKey: "openspec-reviewer-performance", verdict: "failed" },
    ])
  })

  test("underscore-prefixed metadata is not exposed", async () => {
    writeState("dash-workitems", workItemState)
    const r = await readDashboardState(TMP, "dash-workitems")
    const card = r!.workItemCards.find((c) => c.type === "task")!
    expect(card).not.toHaveProperty("metadata")
    expect(card).not.toHaveProperty("_retryCount")
    expect(card.suspendReason).toBe("等待用户确认接口契约")
  })

  test("children 投影包含 type=task 子任务（子任务进度可见）", async () => {
    const state = structuredClone(workItemState)
    const taskItem = state.workItems.find((w: any) => w.id === "task:tg-1")
    taskItem.children.push({
      id: "1", source: "openspec", externalId: "1.1", type: "task",
      title: "登录接口", description: "登录接口", phase: "review",
      suspended: false, currentStep: null, tags: {}, metadata: {}, children: [], labels: [],
    })
    writeState("dash-task-child", state)
    const r = await readDashboardState(TMP, "dash-task-child")
    const card = r!.workItemCards.find((c) => c.type === "task")!
    const taskChild = card.children.find((c: any) => c.id === "1")!
    expect(taskChild.type).toBe("task")
    expect(taskChild.phase).toBe("review")
    expect(taskChild.title).toBe("登录接口")
  })

  test("readDashboardState without changeId exposes workItemCards", async () => {
    const dir = join(TMP, "enum-" + Date.now())
    mkdirSync(join(dir, ".opencode", ".orchestrate_state"), { recursive: true })
    writeFileSync(
      join(dir, ".opencode", ".orchestrate_state", "dash-workitems.json"),
      JSON.stringify(workItemState, null, 2)
    )
    const data = await readDashboardState(dir)
    expect(data!.workItemCards).toHaveLength(2)
  })

  test("empty workItems yields empty workItemCards", async () => {
    const empty = structuredClone(workItemState)
    empty.workItems = []
    empty.taskGroups = []
    writeState("dash-empty", empty)
    const r = await readDashboardState(TMP, "dash-empty")
    expect(r!.workItems).toEqual([])
    expect(r!.workItemCards).toEqual([])
  })

  test("index.html contains 5-column keys with Chinese labels", () => {
    const html = readFileSync(join(import.meta.dir, "..", "assets", "dashboard", "index.html"), "utf-8")
    const columns: Array<[string, string]> = [
      ["todo", "待办"],
      ["in_progress", "处理中"],
      ["review", "审核中"],
      ["done", "完成"],
      ["cancelled", "已取消"],
    ]
    for (const [key, label] of columns) {
      expect(html).toContain(key)
      expect(html).toContain(label)
    }
  })

  test("index.html contains WorkItem detail modal structure and functions", () => {
    const html = readFileSync(join(import.meta.dir, "..", "assets", "dashboard", "index.html"), "utf-8")
    // 弹窗 DOM：遮罩/对话框/关闭按钮，位于 #dashboard 之外（防止被轮询重绘清除）
    expect(html).toContain('id="wiModal"')
    expect(html).toContain("modal-overlay")
    expect(html).toContain("modal-dialog")
    expect(html).toContain('id="wiBody"')
    expect(html).toContain("modal-close")
    // 详情渲染 / 递归查找 / 关闭相关函数
    expect(html).toContain("function renderDetail")
    expect(html).toContain("function findWorkItem")
    expect(html).toContain("function closeDetail")
    expect(html).toContain("function openDetail")
    // 卡片渲染输出 data-id，供点击查询详情
    expect(html).toContain('data-id="${esc(c.id)}"')
    // 弹窗不在 #dashboard 内部，避免被 innerHTML 重绘清除
    const dashIdx = html.indexOf('<main id="dashboard">')
    const modalIdx = html.indexOf('id="wiModal"')
    expect(modalIdx).toBeGreaterThan(dashIdx)
  })
})
