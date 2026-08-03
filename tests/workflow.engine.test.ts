import { describe, expect, test } from "bun:test"
import { loadWorkflow } from "../src/core/workflow/loader"
import {
  createInitialWorkItem, isTerminalPhase, isBlockingSeverity,
  effectiveMaxRetries, getStepVerdict, adjudicateStep, recommendAgents,
  applyAgentVerdict, stepCanPass, phaseStepsAllPassed, childReachedPhase,
  forwardGatePassed, rollbackChildren, hasUnresolvedChildren,
  checkpointTriggered, applyCheckpointContinue, applyCheckpointGiveup,
  applyTransition, recommendForItem,
} from "../src/core/workflow/engine"
import type { WorkItem } from "../src/core/workflow/types"

const BASE_YAML = `
id: task-flow
name: Task Flow
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
          on_pass: verify
          on_fail: analyze
  - name: review
    steps:
      - id: verify
        agents: [reviewer]
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

describe("1. WorkItem 数据模型", () => {
  test("createInitialWorkItem 产出初始状态", () => {
    const item = createInitialWorkItem({ id: "i1", source: "openspec", type: "task", title: "T", description: "d" })
    expect(item.phase).toBe("todo")
    expect(item.suspended).toBe(false)
    expect(item.children).toEqual([])
    expect(item.tags).toEqual({})
  })

  test("task 挂载 issue 子项，children 独立 phase 不影响父 tags", () => {
    const parent = makeItem()
    const issue = createInitialWorkItem({ id: "c", source: "openspec", type: "issue", title: "I", description: "d" })
    parent.children.push(issue)
    expect(parent.children[0].phase).toBe("todo")
    expect(parent.tags).toEqual({})
  })

  test("终态判定", () => {
    expect(isTerminalPhase("done")).toBe(true)
    expect(isTerminalPhase("cancelled")).toBe(true)
    expect(isTerminalPhase("review")).toBe(false)
  })

  test("blocking severity 判定", () => {
    expect(isBlockingSeverity("Critical")).toBe(true)
    expect(isBlockingSeverity("Low")).toBe(true)
    expect(isBlockingSeverity("Info")).toBe(false)
  })
})

describe("2. workflow YAML loader", () => {
  test("合法 YAML 加载，transition 目标可解析", () => {
    const wf = loadWorkflow(BASE_YAML)
    expect(wf.id).toBe("task-flow")
    expect(wf.max_retries).toBe(3)
    expect(wf.phases.length).toBe(3)
    expect(wf.stepMap.size).toBe(3)
    expect(wf.stepMap.get("implement")?.step.transitions.on_pass).toBe("verify")
    expect(wf.stepMap.get("verify")?.step.transitions.on_pass).toBe("done")
  })

  test("非法 YAML 报错：缺少必需字段", () => {
    expect(() => loadWorkflow(`id: x\nphases:\n  - name: todo\n    steps:\n      - id: s1\n        agents: [a]\n`))
      .toThrow()
    expect(() => loadWorkflow(`id: x\nmax_retries: 0\nphases: []`)).toThrow()
    expect(() => loadWorkflow(`id: x\nmax_retries: 3\nphases: []`)).toThrow()
  })

  test("非法 YAML 报错：transition 目标不存在", () => {
    const bad = `
id: x
max_retries: 1
phases:
  - name: todo
    steps:
      - id: s1
        agents: [a]
        transitions:
          on_pass: missing_step
          on_fail: s1
`
    expect(() => loadWorkflow(bad)).toThrow(/missing_step/)
  })

  test("非法 YAML 报错：非法 phase 名 / 重复 step id", () => {
    const badPhase = `
id: x
max_retries: 1
phases:
  - name: wrong
    steps:
      - id: s1
        agents: [a]
`
    expect(() => loadWorkflow(badPhase)).toThrow(/wrong/)
    const dupStep = `
id: x
max_retries: 1
phases:
  - name: todo
    steps:
      - id: s1
        agents: [a]
  - name: in_progress
    steps:
      - id: s1
        agents: [b]
`
    expect(() => loadWorkflow(dupStep)).toThrow(/重复/)
  })

  test("非法 YAML 报错：语法错误", () => {
    expect(() => loadWorkflow(":: not yaml :")).toThrow()
  })

  test("done/halt 作为合法特殊目标", () => {
    const wf = loadWorkflow(BASE_YAML)
    expect(wf.stepMap.get("verify")?.step.transitions.on_pass).toBe("done")
  })
})

describe("3. tag 裁决与裁决缓存", () => {
  test("全 passed 且非 always_run → 跳过（推荐空），沿 on:pass", () => {
    const wf = loadWorkflow(BASE_YAML)
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    expect(adjudicateStep(item, wf.stepMap.get("analyze")!.step)).toBe("passed")
    expect(recommendAgents(item, wf.stepMap.get("analyze")!.step)).toEqual([])
  })

  test("部分 failed → 仅重派 failed", () => {
    const wf = loadWorkflow(`
id: x
max_retries: 1
phases:
  - name: review
    steps:
      - id: multi
        agents: [a, b, c]
        transitions:
          on_pass: done
          on_fail: multi
`)
    const item = makeItem({ phase: "review", currentStep: "multi" })
    applyAgentVerdict(item, "multi", "a", "passed")
    applyAgentVerdict(item, "multi", "b", "failed")
    expect(adjudicateStep(item, wf.stepMap.get("multi")!.step)).toBe("failed")
    expect(recommendAgents(item, wf.stepMap.get("multi")!.step)).toEqual(["b", "c"])
  })

  test("全部 pending → 正常分派全部", () => {
    const wf = loadWorkflow(`
id: x
max_retries: 1
phases:
  - name: review
    steps:
      - id: multi
        agents: [a, b]
        transitions:
          on_pass: done
          on_fail: multi
`)
    const item = makeItem({ phase: "review", currentStep: "multi" })
    expect(recommendAgents(item, wf.stepMap.get("multi")!.step)).toEqual(["a", "b"])
  })

  test("always_run 无视缓存强制全部执行", () => {
    const wf = loadWorkflow(`
id: x
max_retries: 1
phases:
  - name: review
    steps:
      - id: always
        agents: [a, b]
        always_run: true
        transitions:
          on_pass: done
          on_fail: always
`)
    const item = makeItem({ phase: "review", currentStep: "always" })
    applyAgentVerdict(item, "always", "a", "passed")
    applyAgentVerdict(item, "always", "b", "passed")
    expect(adjudicateStep(item, wf.stepMap.get("always")!.step)).toBe("passed")
    expect(recommendAgents(item, wf.stepMap.get("always")!.step)).toEqual(["a", "b"])
  })
})

describe("4. children 联动与门禁", () => {
  const wf = loadWorkflow(BASE_YAML)

  test("step 通过要求全部 children 终态", () => {
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    item.children.push(child({ phase: "done" }))
    expect(stepCanPass(item, wf.stepMap.get("analyze")!.step)).toBe(true)

    const item2 = makeItem()
    applyAgentVerdict(item2, "analyze", "architect", "passed")
    item2.children.push(child({ phase: "review" }))
    expect(stepCanPass(item2, wf.stepMap.get("analyze")!.step)).toBe(false)
  })

  test("D1: Info 级 children 不阻塞 stepCanPass（仅 Low+ children 要求终态）", () => {
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    item.children.push(child({ phase: "review", severity: "Info" }))
    expect(stepCanPass(item, wf.stepMap.get("analyze")!.step)).toBe(true)
  })

  test("D1: Low+ children 未终态仍阻塞 stepCanPass", () => {
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    item.children.push(child({ phase: "todo", severity: "Low" }))
    expect(stepCanPass(item, wf.stepMap.get("analyze")!.step)).toBe(false)
  })

  test("正向 gate 拦截未到位 children", () => {
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    item.children.push(child({ phase: "todo" }))
    expect(forwardGatePassed(item, wf, "in_progress")).toBe(false)
  })

  test("反向回退终态 child 保持", () => {
    const item = makeItem()
    item.children.push(child({ id: "done-c", phase: "done" }))
    item.children.push(child({ id: "cancelled-c", phase: "cancelled" }))
    rollbackChildren(item)
    expect(item.children[0].phase).toBe("done")
    expect(item.children[1].phase).toBe("cancelled")
  })

  test("反向回退 review 中间态不强制改", () => {
    const item = makeItem()
    item.children.push(child({ id: "review-c", phase: "review" }))
    rollbackChildren(item)
    expect(item.children[0].phase).toBe("review")
  })

  test("反向回退未提交 child 置为 todo", () => {
    const item = makeItem()
    item.children.push(child({ id: "todo-c", phase: "in_progress" }))
    rollbackChildren(item)
    expect(item.children[0].phase).toBe("todo")
  })

  test("children 未到终态则 step 保持 pending", () => {
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    item.children.push(child({ phase: "in_progress" }))
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("blocked")
    expect(rec.blockedReason).toContain("children")
  })

  test("childReachedPhase 达到目标 phase", () => {
    expect(childReachedPhase(child({ phase: "done" }), "in_progress")).toBe(true)
    expect(childReachedPhase(child({ phase: "todo" }), "in_progress")).toBe(false)
    expect(childReachedPhase(child({ phase: "in_progress" }), "in_progress")).toBe(true)
  })
})

describe("5. 重试检查点", () => {
  const wf = loadWorkflow(BASE_YAML)
  const step = wf.stepMap.get("implement")!.step

  test("首次进入（retryCount=0）不触发", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    expect(checkpointTriggered(item, wf, step)).toBe(false)
  })

  test("retryCount 为 effective_max_retries 整数倍且存在未解决 children → 触发", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.metadata["_retryCount"] = 3
    item.children.push(child({ phase: "todo" }))
    expect(checkpointTriggered(item, wf, step)).toBe(true)
  })

  test("未到整数倍不触发", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.metadata["_retryCount"] = 2
    item.children.push(child({ phase: "todo" }))
    expect(checkpointTriggered(item, wf, step)).toBe(false)
  })

  test("step 级 max_retries 覆盖 workflow 级", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.metadata["_retryCount"] = 3
    item.children.push(child({ phase: "todo" }))
    expect(effectiveMaxRetries(wf, step)).toBe(3)
  })

  test("continue 重置 step tag 并回退 parent", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    applyAgentVerdict(item, "implement", "developer", "failed")
    applyCheckpointContinue(item, step)
    expect(getStepVerdict(item, "implement", "developer")).toBe("pending")
    expect(item.metadata["_checkpoint"]).toBe(false)
  })

  test("giveup 强制取消未解决 children 并将 step 标记 completed", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.children.push(child({ id: "c-a", phase: "todo" }))
    item.children.push(child({ id: "c-b", phase: "review" }))
    item.children.push(child({ id: "c-c", phase: "done" }))
    applyCheckpointGiveup(item, step)
    expect(item.children.find((c) => c.id === "c-a")?.phase).toBe("cancelled")
    expect(item.children.find((c) => c.id === "c-b")?.phase).toBe("cancelled")
    expect(item.children.find((c) => c.id === "c-c")?.phase).toBe("done")
    expect(adjudicateStep(item, step)).toBe("passed")
    expect(item.metadata["_checkpoint"]).toBe(false)
  })

  test("recommendForItem 呈现检查点", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.metadata["_retryCount"] = 3
    item.children.push(child({ phase: "todo" }))
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("checkpoint")
    expect(rec.checkpoint?.retryCount).toBe(3)
  })
})

describe("6. suspended 调度跳过", () => {
  const wf = loadWorkflow(BASE_YAML)

  test("暂停项不被调度", () => {
    const item = makeItem({ suspended: true, metadata: { suspend_reason: "blocker" } })
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("suspended")
    expect(rec.agents).toEqual([])
  })

  test("applyTransition halt 置 suspended 且保留当前列", () => {
    const wf2 = loadWorkflow(`
id: x
max_retries: 1
phases:
  - name: todo
    steps:
      - id: s1
        agents: [a]
        transitions:
          on_pass: halt
          on_fail: s1
`)
    const item = makeItem({ currentStep: "s1" })
    const r = applyTransition(item, wf2, "pass")
    expect(r.target).toBe("halt")
    expect(item.suspended).toBe(true)
    expect(item.metadata["suspend_reason"]).toBe("halt")
    expect(item.phase).toBe("todo")
  })

  test("done 终态推进", () => {
    const item = makeItem({ phase: "review", currentStep: "verify" })
    const r = applyTransition(item, wf, "pass")
    expect(r.target).toBe("done")
    expect(item.phase).toBe("done")
  })
})

describe("7. transition 推进", () => {
  const wf = loadWorkflow(BASE_YAML)

  test("同 phase 切换 currentStep", () => {
    const wf = loadWorkflow(`
id: x
max_retries: 1
phases:
  - name: todo
    steps:
      - id: s1
        agents: [a]
        transitions:
          on_pass: s2
          on_fail: s1
      - id: s2
        agents: [b]
        transitions:
          on_pass: done
          on_fail: s1
`)
    const item = makeItem({ currentStep: "s1" })
    const r = applyTransition(item, wf, "pass")
    expect(r.advanced).toBe(true)
    expect(item.currentStep).toBe("s2")
    expect(item.phase).toBe("todo")
  })

  test("跨 phase 正向推进需门禁通过", () => {
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    const r = applyTransition(item, wf, "pass")
    expect(r.advanced).toBe(true)
    expect(item.phase).toBe("in_progress")
    expect(item.currentStep).toBe("implement")
  })

  test("跨 phase 正向门禁拦截（children 未到位）", () => {
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    item.children.push(child({ phase: "todo" }))
    const r = applyTransition(item, wf, "pass")
    expect(r.advanced).toBe(false)
    expect(item.phase).toBe("todo")
  })

  test("反向回退调用 rollbackChildren 并递增 retryCount", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.children.push(child({ id: "c-todo", phase: "in_progress" }))
    item.children.push(child({ id: "c-done", phase: "done" }))
    const r = applyTransition(item, wf, "fail")
    expect(r.advanced).toBe(true)
    expect(item.phase).toBe("todo")
    expect(item.currentStep).toBe("analyze")
    expect(item.children.find((c) => c.id === "c-todo")?.phase).toBe("todo")
    expect(item.children.find((c) => c.id === "c-done")?.phase).toBe("done")
    expect(item.metadata["_retryCount"]).toBe(1)
  })
})

describe("8. fail 跨 phase 回退：目标 step 裁决重置（死锁修复）", () => {
  const wf = loadWorkflow(BASE_YAML)

  test("review failed 回退 implement：developer tag 重置 → 引擎重新分派 developer", () => {
    const item = makeItem({ phase: "review", currentStep: "verify" })
    // 模拟前置轮次：developer 已在 implement 提交 passed
    applyAgentVerdict(item, "implement", "developer", "passed")
    applyAgentVerdict(item, "verify", "reviewer", "failed")
    const r = applyTransition(item, wf, "fail")
    expect(r.advanced).toBe(true)
    expect(item.phase).toBe("in_progress")
    expect(item.currentStep).toBe("implement")
    // fix1：目标 step（implement）裁决重置为 pending
    expect(getStepVerdict(item, "implement", "developer")).toBe("pending")
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("recommend")
    expect(rec.agents).toContain("developer")
  })

  test("implement on_fail: analyze：architect tag 重置 → 引擎重新分派 architect", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    // 模拟前置轮次：architect 已在 analyze 提交 passed
    applyAgentVerdict(item, "analyze", "architect", "passed")
    applyAgentVerdict(item, "implement", "developer", "failed")
    const r = applyTransition(item, wf, "fail")
    expect(r.advanced).toBe(true)
    expect(item.phase).toBe("todo")
    expect(item.currentStep).toBe("analyze")
    expect(getStepVerdict(item, "analyze", "architect")).toBe("pending")
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("recommend")
    expect(rec.agents).toContain("architect")
  })

  test("同 phase on_fail 走切 step 分支，保持既有裁决缓存不清 tag", () => {
    const item = makeItem()
    applyAgentVerdict(item, "analyze", "architect", "passed")
    const r = applyTransition(item, wf, "fail")
    expect(r.advanced).toBe(true)
    expect(item.phase).toBe("todo")
    expect(item.currentStep).toBe("analyze")
    expect(getStepVerdict(item, "analyze", "architect")).toBe("passed")
  })

  test("只清目标 step 的 tags，不影响其它 step", () => {
    const item = makeItem({ phase: "review", currentStep: "verify" })
    applyAgentVerdict(item, "implement", "developer", "passed")
    applyAgentVerdict(item, "verify", "reviewer", "failed")
    const r = applyTransition(item, wf, "fail")
    expect(r.advanced).toBe(true)
    // verify（来源 step）与 implement（目标 step）之外的 step tags 不受影响
    expect(getStepVerdict(item, "verify", "reviewer")).toBe("failed")
  })
})
