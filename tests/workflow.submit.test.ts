import { describe, expect, test } from "bun:test"
import {
  loadWorkflow, submitForStep, routeExempt, adjudicateExempt,
  enqueueWriteback, flushWritebacks, retryPendingWritebacks, setWritebackHandler,
} from "../src/core/workflow"
import type { WorkItem } from "../src/core/workflow/types"

const SUBMIT_YAML = `
id: submit-flow
name: Submit Flow
max_retries: 3
phases:
  - name: todo
    steps:
      - id: analyze
        agents: [architect]
        transitions:
          on_pass: implement
          on_fail: analyze
  - name: in_progress
    steps:
      - id: implement
        agents: [developer]
        transitions:
          on_pass: approve
          on_fail: analyze
  - name: review
    steps:
      - id: approve
        agents: [reviewer, designer]
        transitions:
          on_pass: done
          on_fail: implement
`

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w1",
    source: "openspec",
    type: "task",
    title: "T1",
    description: "d",
    phase: "todo",
    suspended: false,
    currentStep: "analyze",
    tags: {},
    metadata: {},
    children: [],
    labels: [],
    ...overrides,
  }
}

function child(overrides: Partial<WorkItem> = {}): WorkItem {
  return makeItem({ id: "c1", type: "issue", severity: "Low", ...overrides })
}

describe("1. submitForStep 路由与归属校验", () => {
  const WF = loadWorkflow(SUBMIT_YAML)

  test("合法提交：agent 属 step.agents → tag 更新 passed，stepAdjudication=passed", () => {
    const item = makeItem()
    const r = submitForStep(item, WF, { stepId: "analyze", agentKey: "architect", verdict: "passed" })
    expect(item.tags["analyze:architect"]).toBe("passed")
    expect(r.stepAdjudication).toBe("passed")
    expect(r.advanced).toBe(true)
    expect(r.transitionTarget).toBe("implement")
  })

  test("stepId 未在 stepMap 声明 → 抛错", () => {
    const item = makeItem()
    expect(() => submitForStep(item, WF, { stepId: "missing", agentKey: "architect", verdict: "passed" })).toThrow(/路由失败/)
  })

  test("越权提交：agent 不属 step.agents → 抛错且零状态变更", () => {
    const item = makeItem()
    item.children.push(child({ id: "c1", phase: "in_progress" }))
    const snapshot = JSON.stringify(item)
    expect(() => submitForStep(item, WF, { stepId: "analyze", agentKey: "reviewer", verdict: "passed" })).toThrow(/越权/)
    expect(JSON.stringify(item)).toBe(snapshot)
  })

  test("提交非 currentStep 的 stepId → 抛错且零状态变更", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    const snapshot = JSON.stringify(item)
    expect(() => submitForStep(item, WF, { stepId: "analyze", agentKey: "architect", verdict: "passed" })).toThrow(/不一致/)
    expect(JSON.stringify(item)).toBe(snapshot)
  })

  test("currentStep=null 提交任意 step → 放行不抛错", () => {
    const item = makeItem({ currentStep: null })
    const r = submitForStep(item, WF, { stepId: "analyze", agentKey: "architect", verdict: "passed" })
    expect(r.stepAdjudication).toBe("passed")
  })
})

describe("2. children 联动更新", () => {
  const WF = loadWorkflow(SUBMIT_YAML)

  test("fixed child 置为 done", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.children.push(child({ id: "c1", phase: "in_progress" }))
    const r = submitForStep(item, WF, { stepId: "implement", agentKey: "developer", verdict: "passed", fixedIds: ["c1"] })
    expect(item.children[0].phase).toBe("done")
    expect(r.childrenUpdated).toContain("c1")
  })

  test("exempt child：metadata.exempt_request 标记，phase/tags 不变，不推进", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.children.push(child({ id: "c1", phase: "in_progress" }))
    const r = submitForStep(item, WF, { stepId: "implement", agentKey: "developer", verdict: "passed", exemptIds: ["c1"] })
    expect(item.children[0].metadata["exempt_request"]).toEqual({ requestedBy: "developer" })
    expect(item.children[0].phase).toBe("in_progress")
    expect(item.children[0].tags).toEqual({})
    expect(r.advanced).toBe(false)
  })

  test("newChildren 写入且同 id 去重", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    const c1 = child({ id: "c1" })
    const c2 = child({ id: "c2" })
    submitForStep(item, WF, { stepId: "implement", agentKey: "developer", verdict: "passed", newChildren: [c1, c2] })
    expect(item.children.map((c) => c.id)).toEqual(["c1", "c2"])
    const c3 = child({ id: "c3" })
    submitForStep(item, WF, { stepId: "implement", agentKey: "developer", verdict: "passed", newChildren: [c1, c3] })
    expect(item.children.map((c) => c.id)).toEqual(["c1", "c2", "c3"])
  })
})

describe("3. gate 与推进", () => {
  const WF = loadWorkflow(SUBMIT_YAML)

  test("step passed + children 终态 → 沿 on:pass 跨 phase 推进", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.children.push(child({ id: "c1", phase: "done" }))
    const r = submitForStep(item, WF, { stepId: "implement", agentKey: "developer", verdict: "passed" })
    expect(r.advanced).toBe(true)
    expect(r.transitionTarget).toBe("approve")
    expect(item.phase).toBe("review")
    expect(item.currentStep).toBe("approve")
  })

  test("step 全 passed（多 agent）+ children 终态 → 沿 on:pass 推进到终态", () => {
    const item = makeItem({ phase: "review", currentStep: "approve" })
    item.children.push(child({ id: "c1", phase: "done" }))
    const r1 = submitForStep(item, WF, { stepId: "approve", agentKey: "reviewer", verdict: "passed" })
    expect(r1.stepAdjudication).toBe("pending")
    expect(r1.advanced).toBe(false)
    expect(item.currentStep).toBe("approve")
    const r2 = submitForStep(item, WF, { stepId: "approve", agentKey: "designer", verdict: "passed" })
    expect(r2.stepAdjudication).toBe("passed")
    expect(r2.advanced).toBe(true)
    expect(r2.transitionTarget).toBe("done")
    expect(item.phase).toBe("done")
    expect(item.currentStep).toBeNull()
  })

  test("step failed → 沿 on:fail 回退（rollbackChildren + retryCount 递增）", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.children.push(child({ id: "c-todo", phase: "in_progress" }))
    item.children.push(child({ id: "c-done", phase: "done" }))
    const r = submitForStep(item, WF, { stepId: "implement", agentKey: "developer", verdict: "failed" })
    expect(r.stepAdjudication).toBe("failed")
    expect(r.advanced).toBe(true)
    expect(item.phase).toBe("todo")
    expect(item.currentStep).toBe("analyze")
    expect(item.children.find((c) => c.id === "c-todo")?.phase).toBe("todo")
    expect(item.children.find((c) => c.id === "c-done")?.phase).toBe("done")
    expect(item.metadata["_retryCount"]).toBe(1)
  })
})

describe("4. routeExempt 路由", () => {
  const WF = loadWorkflow(SUBMIT_YAML)

  test("metadata.source 命中 review step 的 agents → routed + targetStepId", () => {
    const item = makeItem()
    item.children.push(child({ id: "i1", metadata: { source: "reviewer" } }))
    const r = routeExempt(item, WF, "i1")
    expect(r.routed).toBe(true)
    expect(r.targetStepId).toBe("approve")
  })

  test("无匹配 → routed=false + 提示 orchestrator 手动处理", () => {
    const item = makeItem()
    item.children.push(child({ id: "i1", metadata: { source: "manager" } }))
    const r = routeExempt(item, WF, "i1")
    expect(r.routed).toBe(false)
    expect(r.reason).toContain("手动")
  })

  test("issue 不存在或缺少 metadata.source → routed=false", () => {
    const item = makeItem()
    expect(routeExempt(item, WF, "nope").routed).toBe(false)
    item.children.push(child({ id: "i1", metadata: {} }))
    expect(routeExempt(item, WF, "i1").routed).toBe(false)
  })
})

describe("5. adjudicateExempt 裁定", () => {
  const WF = loadWorkflow(SUBMIT_YAML)

  test("dismissed → cancelled", () => {
    const item = makeItem()
    item.children.push(child({ id: "i1", metadata: { source: "reviewer" } }))
    const r = adjudicateExempt(item, WF, { issueId: "i1", agentKey: "reviewer", action: "dismissed" })
    expect(r.childPhase).toBe("cancelled")
    expect(item.children[0].phase).toBe("cancelled")
  })

  test("rejected → todo（清除 exempt_request 标记）", () => {
    const item = makeItem()
    item.children.push(child({ id: "i1", metadata: { source: "reviewer", exempt_request: { requestedBy: "reviewer" } } }))
    const r = adjudicateExempt(item, WF, { issueId: "i1", agentKey: "reviewer", action: "rejected" })
    expect(r.childPhase).toBe("todo")
    expect(item.children[0].phase).toBe("todo")
    expect(item.children[0].metadata["exempt_request"]).toBeUndefined()
  })

  test("属于该 step agents 的裁定者也可裁定", () => {
    const item = makeItem()
    item.children.push(child({ id: "i1", metadata: { source: "reviewer" } }))
    const r = adjudicateExempt(item, WF, { issueId: "i1", agentKey: "designer", action: "dismissed" })
    expect(r.childPhase).toBe("cancelled")
  })

  test("白名单外裁定者抛错且不产生状态变更", () => {
    const item = makeItem()
    item.children.push(child({ id: "i1", metadata: { source: "reviewer" } }))
    expect(() => adjudicateExempt(item, WF, { issueId: "i1", agentKey: "manager", action: "dismissed" })).toThrow(/白名单/)
    expect(item.children[0].phase).toBe("todo")
  })
})

describe("6. writeback 写回队列", () => {
  test("enqueue 后 flush 成功记录 lastSuccess", async () => {
    const item = makeItem()
    setWritebackHandler(async () => {})
    enqueueWriteback(item, "sync", { hello: "world" })
    expect(item.writeback?.lastAttempt).toBeDefined()
    const r = await flushWritebacks()
    expect(r.succeeded).toContain("w1")
    expect(item.writeback?.lastSuccess).toBeDefined()
    expect(item.writeback?.error).toBeUndefined()
  })

  test("注入失败 handler → 记录 error（保留 lastAttempt）+ retryPendingWritebacks 返回 true", async () => {
    const item = makeItem()
    setWritebackHandler(async () => {
      throw new Error("boom")
    })
    enqueueWriteback(item, "sync", {})
    const r = await flushWritebacks()
    expect(r.failed).toContain("w1")
    expect(item.writeback?.error).toBe("boom")
    expect(item.writeback?.lastAttempt).toBeDefined()
    expect(retryPendingWritebacks(item)).toBe(true)
  })

  test("写回成功项 retryPendingWritebacks 返回 false", async () => {
    const item = makeItem()
    setWritebackHandler(async () => {})
    enqueueWriteback(item, "sync", {})
    await flushWritebacks()
    expect(retryPendingWritebacks(item)).toBe(false)
  })

  test("失败→重试成功：error 被清除且 retryPendingWritebacks 返回 false", async () => {
    const item = makeItem()
    setWritebackHandler(async () => {
      throw new Error("boom")
    })
    enqueueWriteback(item, "sync", {})
    await flushWritebacks()
    expect(item.writeback?.error).toBe("boom")
    expect(retryPendingWritebacks(item)).toBe(true)

    setWritebackHandler(async () => {})
    enqueueWriteback(item, "sync", {})
    const r = await flushWritebacks()
    expect(r.succeeded).toContain("w1")
    expect(item.writeback?.error).toBeUndefined()
    expect(retryPendingWritebacks(item)).toBe(false)
  })
})
