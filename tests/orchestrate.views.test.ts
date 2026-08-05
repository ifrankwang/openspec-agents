/**
 * 验证各 agent 视图包含「操作指引」段。
 * 直接调用 view 函数，用最小 mock 数据断言输出。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { __setGitRunner } from "../src/core/git"
import {
  renderOrchestratorView,
  renderArchitectView,
  renderDeveloperView,
  renderToolReviewView,
  renderTaskReviewView,
  renderQualityReviewView,
  formatFilePath,
} from "../src/core/views"
import type { OrchestrateState, TaskGroupState, TaskItem, IssueItem, BlockerItem, ExecutionBoundary } from "../src/core/types"
import { REVIEW_DIMENSIONS } from "../src/core/types"

afterAll(() => { __setGitRunner(null) })

function mockTask(id: string, status: TaskItem["status"] = "open"): TaskItem {
  return { id, specTrace: "", title: `Task ${id}`, status, taskNumber: id, rejectReason: null }
}

function mockIssue(id: string): IssueItem {
  return {
    id, dimension: "architecture", sourcePhase: "quality",
    severity: "Low", file: "src/Test.java", line: 1,
    description: "test", suggestion: "fix",
    status: "open", refixCount: 0,
    rootCauseGuess: null, exemptReason: null, rejectReason: null,
  }
}

function mockState(overrides?: Partial<OrchestrateState>): OrchestrateState {
  return {
    changeId: "test-change",
    isolationNamespace: "a1b2c3",
    baseBranch: "main",
    taskGroups: [],
    taskGroupId: "1",
    status: "in_progress",
    orchestrateId: "test",
    createTime: Date.now(),
    ...overrides,
  } as OrchestrateState
}

function baseTg(overrides?: Partial<TaskGroupState>): TaskGroupState {
  return {
    id: "1",
    status: "task_analysis",
    tasks: [],
    blockers: [],
    issues: [],
    relevantSpecs: [],
    phases: {
      architect_review: { completed: false },
      review: {
        tool: { completed: false, testResults: "" },
        task: { completed: false },
        quality: { progress: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, "pending"])) as TaskGroupState["phases"]["review"]["quality"]["progress"], retryCount: 0, lastResolvedRetryCount: 0 },
      },
    },
    ...overrides,
  } as TaskGroupState
}

describe("视图「操作指引」段", () => {

  test("renderArchitectView 含操作指引及 Worktree", () => {
    const state = mockState()
    const tg = baseTg({ status: "task_analysis", tasks: [mockTask("1")] })
    const output = renderArchitectView(state, tg)
    expect(output).toContain("## Worktree")
    expect(output).toContain("(worktree 未就绪 — 请编排者先调用 opx_orch_set_worktree)")
    expect(output).toContain("## 操作指引")
    expect(output).toContain("交叉比对")
    expect(output).toContain("opx_arch_submit")
    expect(output).not.toContain("**隔离标识**")
    expect(output).not.toContain("建议端口")
  })

  test("renderDeveloperView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "dev_impl",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      executionBoundary: { allowed_directories: ["src"], allowed_packages: ["com"], notes: "" },
      tasks: [mockTask("1")],
    })
    const output = renderDeveloperView(state, tg, "openspec-developer")
    expect(output).toContain("## 操作指引")
    expect(output).toContain("opx_dev_submit")
    expect(output).toContain("Task (待完成)")
    expect(output).toContain("Skill 加载清单")
    expect(output).toContain("code-efficiency")
    expect(output).toContain("初始化仅是前置")
    expect(output).toContain("不可将初始化视为终点")
    expect(output).toContain("遵循所有已加载 skill")
    expect(output).toContain("api-test")
    expect(output).toContain("**变更范围**")
    expect(output).toContain("diff --name-only base..HEAD")
    expect(output).not.toContain("涉及 API 变更")
    expect(output).not.toContain("Task (待验证)")
    expect(output).not.toContain("Issue (已修复待验证)")
    expect(output).not.toContain("Issue (豁免裁定中)")
  })

  test("视图 Worktree 区块展示隔离标识与建议端口", () => {
    const state = mockState()
    const tg = baseTg({
      status: "dev_impl",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
    })
    const output = renderDeveloperView(state, tg, "openspec-developer")
    expect(output).toContain("## Worktree")
    expect(output).toContain("**隔离标识**: `a1b2c3`")
    expect(output).toContain("建议端口: 27059")
  })

  test("renderToolReviewView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
    })
    const output = renderToolReviewView(state, tg, "openspec-reviewer-tool")
    expect(output).toContain("## 操作指引")
    expect(output).toContain("质量门 skill")
    expect(output).toContain("opx_tool_review_submit")
    expect(output).toContain("变更范围")
    expect(output).toContain("**隔离标识**")
    expect(output).not.toContain("建议端口")
    expect(output).not.toContain("上轮变更文件")
  })

  test("renderTaskReviewView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      tasks: [mockTask("1", "submitted")],
      executionBoundary: { allowed_directories: ["src"], allowed_packages: ["com"], notes: "" },
    })
    const output = renderTaskReviewView(state, tg, "openspec-reviewer-task")
    expect(output).toContain("## 操作指引")
    expect(output).toContain("Task 产出验证")
    expect(output).toContain("opx_task_review_submit")
    expect(output).toContain("初始化仅是前置")
    expect(output).toContain("不可将初始化视为终点")
    expect(output).toContain("变更范围")
    expect(output).toContain("**隔离标识**")
    expect(output).toContain("建议端口")
    expect(output).not.toContain("Task (已驳回)")
    expect(output).not.toContain("上轮变更文件")
  })

  test("renderTaskReviewView 操作指引含隔离环境执行要求", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      tasks: [mockTask("1", "submitted")],
      executionBoundary: { allowed_directories: ["src"], allowed_packages: ["com"], notes: "" },
    })
    const output = renderTaskReviewView(state, tg, "openspec-reviewer-task")
    expect(output).toContain("隔离")
    expect(output).toContain("清理隔离环境")
    expect(output).toContain("禁止复用或清空共享开发库")
    expect(output).toContain("validation_steps")
    expect(output).toContain("隔离环境搭建/清理")
    expect(output).toContain("隔离环境无法正常搭建")
  })

  test("renderTaskReviewView 有 notes 时显示实施指引", () => {
    const state = mockState()
    const notes = "需要将文件类型拦截做成通用机制"
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      tasks: [mockTask("1", "submitted")],
      executionBoundary: { allowed_directories: ["src"], allowed_packages: ["com"], notes },
    })
    const output = renderTaskReviewView(state, tg, "openspec-reviewer-task")
    expect(output).toContain("## 实施指引")
    expect(output).toContain(notes)
    expect(output).toContain("校验实施内容是否遵循上方「实施指引」")
  })

  test("renderTaskReviewView 无 notes 时不显示实施指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      tasks: [mockTask("1", "submitted")],
      executionBoundary: null,
    })
    const output = renderTaskReviewView(state, tg, "openspec-reviewer-task")
    expect(output).not.toContain("## 实施指引")
    expect(output).not.toContain("校验实施内容是否遵循上方「实施指引」")
    expect(output).toContain("Task 产出验证")
  })

  test("renderQualityReviewView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      issues: [mockIssue("1")],
    })
    const output = renderQualityReviewView(state, tg, "openspec-reviewer-architecture")
    expect(output).toContain("## 操作指引")
    expect(output).toContain("opx_quality_review_submit")
    expect(output).toContain("按本维度审查标准")
    expect(output).toContain("变更范围")
    expect(output).not.toContain("**隔离标识**")
    expect(output).not.toContain("建议端口")
    expect(output).not.toContain("上轮变更文件")
  })

  test("renderQualityReviewView 含 tool-improvement skill 时展示工具改进子步骤", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      issues: [mockIssue("1")],
    })
    const output = renderQualityReviewView(state, tg, "openspec-reviewer-architecture")
    expect(output).toContain("优先判断此问题是否可通过工具配置统一解决")
    expect(output).toContain("[tool_eligible]")
    expect(output).toContain("java-quality-tool-improve")
  })

  test("renderQualityReviewView 无 tool-improvement skill 时走原始单行步骤 4", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      issues: [mockIssue("1")],
    })
    const output = renderQualityReviewView(state, tg, "")
    expect(output).toContain("新发现的本维度问题 → 报 issue")
    expect(output).not.toContain("优先判断此问题是否可通过工具配置统一解决")
    expect(output).not.toContain("[tool_eligible]")
  })
})

describe("一致性分析 sourcePhase 过滤", () => {
  function mockToolStyleIssue(id: string, severity = "Low"): IssueItem {
    return {
      id, dimension: "style", sourcePhase: "tool",
      severity, file: "src/Foo.java", line: 1,
      description: "tool style issue", suggestion: "fix",
      status: "open", refixCount: 0,
      rootCauseGuess: null, exemptReason: null, rejectReason: null,
    }
  }
  function mockQualityStyleIssue(id: string, severity = "Low"): IssueItem {
    return {
      id, dimension: "style", sourcePhase: "quality",
      severity, file: "src/Foo.java", line: 1,
      description: "quality style issue", suggestion: "fix",
      status: "open", refixCount: 0,
      rootCauseGuess: null, exemptReason: null, rejectReason: null,
    }
  }

  test("quality.style=passed + tool sourcePhase style issue 不报内部矛盾", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      issues: [mockToolStyleIssue("i1")],
    })
    tg.phases.review.quality.progress.style = "passed"
    const output = renderOrchestratorView(state, tg)
    expect(output).not.toContain("review 内部矛盾")
  })

  test("quality.style=passed + quality sourcePhase style issue 报内部矛盾", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      issues: [mockQualityStyleIssue("i1")],
    })
    tg.phases.review.quality.progress.style = "passed"
    const output = renderOrchestratorView(state, tg)
    expect(output).toContain("review 内部矛盾")
  })
})

describe("一致性分析建议文本", () => {
  const boundary = { allowed_directories: ["src"], allowed_packages: ["com"], notes: "" }

  function passAllReview(tg: TaskGroupState): void {
    tg.phases.architect_review.completed = true
    tg.phases.review.tool.completed = true
    tg.phases.review.task.completed = true
    for (const d of REVIEW_DIMENSIONS) tg.phases.review.quality.progress[d] = "passed"
  }

  test("检查项2：isReviewCompleted 但 status=dev_impl → 建议 complete_task_group 收尾（轻量，不再 recovery）", () => {
    const state = mockState()
    const tg = baseTg({ status: "dev_impl", executionBoundary: boundary })
    passAllReview(tg)
    const output = renderOrchestratorView(state, tg)
    expect(output).toContain("状态未推进")
    expect(output).toContain("opx_orch_complete_task_group")
    expect(output).not.toContain('recovery: { phase: "review"')
  })

  test("检查项4：completed 且维度 passed 遗留阻塞 issue → 建议 reopenIssues 重置", () => {
    const state = mockState()
    const tg = baseTg({ status: "completed", issues: [mockIssue("i1")] })
    passAllReview(tg)
    const output = renderOrchestratorView(state, tg)
    expect(output).toContain("review 内部矛盾")
    expect(output).toContain('recovery: { phase: "dev_impl", reopenIssues: true }')
  })

  test("检查项4：review 且维度 passed 遗留阻塞 issue → 建议 recovery 到 dev_impl（dev 修复重置进度）", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      executionBoundary: boundary,
      issues: [mockIssue("i1")],
    })
    passAllReview(tg)
    const output = renderOrchestratorView(state, tg)
    expect(output).toContain("review 内部矛盾")
    expect(output).toContain('recovery: { phase: "dev_impl"')
  })

  test("检查项4：dev_impl 且维度 passed 遗留阻塞 issue → 建议 recovery 到 dev_impl", () => {
    const state = mockState()
    const tg = baseTg({
      status: "dev_impl",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      executionBoundary: boundary,
      issues: [mockIssue("i1")],
    })
    passAllReview(tg)
    const output = renderOrchestratorView(state, tg)
    expect(output).toContain("review 内部矛盾")
    expect(output).toContain('recovery: { phase: "dev_impl"')
  })

  test("有异常时指引不再硬编码 recovery 工具名", () => {
    const state = mockState()
    const tg = baseTg({ status: "dev_impl", executionBoundary: boundary })
    passAllReview(tg)
    const output = renderOrchestratorView(state, tg)
    expect(output).toContain("按对应建议修复")
    expect(output).not.toContain("按 recovery 建议修复")
    expect(output).not.toContain("调用 opx_orch_init(recovery=...) 修复")
  })
})

describe("编排者视图结构", () => {
  test("编排者视图不含统计摘要段", () => {
    const state = mockState()
    const tg = baseTg({ status: "review", worktreePath: "/wt", branchName: "tg-1", baseRef: "base", tasks: [mockTask("1")], issues: [mockIssue("i1")] })
    const output = renderOrchestratorView(state, tg)
    expect(output).not.toContain("## Task 摘要")
    expect(output).not.toContain("## Issue 摘要")
  })

  test("编排者视图保留其余核心段落", () => {
    const state = mockState()
    const tg = baseTg({ status: "review", worktreePath: "/wt", branchName: "tg-1", baseRef: "base", tasks: [mockTask("1")], issues: [mockIssue("i1")] })
    const output = renderOrchestratorView(state, tg)
    expect(output).toContain("## 阶段进展")
    expect(output).toContain("## 审核进度")
    expect(output).toContain("## 一致性分析")
    expect(output).toContain("## 下一步")
  })
})

describe("formatFilePath 路径截断", () => {
  test("短路径不截断", () => {
    expect(formatFilePath("src/Foo.java", 10)).toBe("src/Foo.java:10")
  })
  test("长路径截断为末两段", () => {
    const longFile = "src/main/resources/db/migration/tenant/V1__init_schema.sql"
    const result = formatFilePath(longFile, 585)
    expect(result).toContain("...")
    expect(result).toContain("V1__init_schema.sql:585")
    expect(result.length).toBeLessThan(longFile.length + 4)
  })
  test("line=0 不附加行号", () => {
    expect(formatFilePath("src/Foo.java", 0)).toBe("src/Foo.java")
  })
  test("超长单段路径截断末尾", () => {
    const longSegment = "a".repeat(100)
    const result = formatFilePath(longSegment, 0, 60)
    expect(result.length).toBe(60)
    expect(result.endsWith("...")).toBe(true)
  })
  test("2 段路径超 maxLen 仍截断", () => {
    const result = formatFilePath("long_directory_name/quite_long_filename_to_display.sql", 100, 60)
    expect(result.length).toBeLessThanOrEqual(60)
    expect(result).toContain(":100")
  })
  test("恰好 maxLen 边界不截断", () => {
    const path58 = "a".repeat(58)
    const result = formatFilePath(path58, 1, 60)
    expect(result).toBe(`${path58}:1`)
  })
  test("超 maxLen 1 字符截断", () => {
    const path59 = "a".repeat(59)
    const result = formatFilePath(path59, 1, 60)
    expect(result.length).toBeLessThanOrEqual(60)
    expect(result.endsWith("...")).toBe(true)
  })
  test("formatFilePath 结果始终 ≤ maxLen", () => {
    const cases: [string, number][] = [
      ["src/Foo.java", 10],
      ["src/main/resources/db/migration/V1__init_schema.sql", 585],
      ["a/really/really/deeply/nested/path/to/file.sql", 42],
      ["single_long_file_name_that_exceeds_the_maximum_length.sql", 1],
      ["short/a.txt", 0],
    ]
    for (const [file, line] of cases) {
      const result = formatFilePath(file, line, 60)
      expect(result.length).toBeLessThanOrEqual(60)
    }
  })
})

describe("角色隔离与已验证 issue 过滤（回归）", () => {
  function makeIssue(id: string, sourcePhase: "tool" | "task" | "quality", status: IssueItem["status"]): IssueItem {
    return {
      id, dimension: "architecture", sourcePhase,
      severity: "Low", file: "src/Test.java", line: 1,
      description: `desc-${id}`, suggestion: "fix",
      status, refixCount: 0,
      rootCauseGuess: null, exemptReason: null, rejectReason: null,
    }
  }

  const reviewBase = {
    status: "review" as const,
    worktreePath: "/wt",
    branchName: "tg-1",
    baseRef: "base",
  }

  test("tool 视图不渲染 verified/exempted issue，只渲染待裁定项", () => {
    const state = mockState()
    const tg = baseTg({
      ...reviewBase,
      issues: [
        makeIssue("v1", "tool", "verified"),
        makeIssue("e1", "tool", "exempted"),
        makeIssue("s1", "tool", "submitted"),
      ],
    })
    const output = renderToolReviewView(state, tg, "openspec-reviewer-tool")
    expect(output).not.toContain("desc-v1")
    expect(output).not.toContain("desc-e1")
    expect(output).toContain("desc-s1")
    expect(output).toContain("待裁定 Issue（tool 层）")
  })

  test("task 视图不渲染 verified/exempted issue，只渲染待裁定项", () => {
    const state = mockState()
    const tg = baseTg({
      ...reviewBase,
      tasks: [mockTask("1", "submitted")],
      issues: [
        makeIssue("v1", "task", "verified"),
        makeIssue("e1", "task", "exempted"),
        makeIssue("s1", "task", "submitted"),
      ],
    })
    const output = renderTaskReviewView(state, tg, "openspec-reviewer-task")
    expect(output).not.toContain("desc-v1")
    expect(output).not.toContain("desc-e1")
    expect(output).toContain("desc-s1")
  })

  test("quality 视图不渲染 verified/exempted issue，只渲染待裁定项", () => {
    const state = mockState()
    const tg = baseTg({
      ...reviewBase,
      issues: [
        makeIssue("v1", "quality", "verified"),
        makeIssue("e1", "quality", "exempted"),
        makeIssue("s1", "quality", "submitted"),
      ],
    })
    const output = renderQualityReviewView(state, tg, "openspec-reviewer-architecture")
    expect(output).not.toContain("desc-v1")
    expect(output).not.toContain("desc-e1")
    expect(output).toContain("desc-s1")
  })

  test("角色隔离：各视图只展示自己角色的摘要", () => {
    const state = mockState()
    const tg = baseTg({
      ...reviewBase,
      tasks: [mockTask("1", "submitted")],
      agentSummaries: {
        "openspec-developer": "dev 摘要：完成 task 2 个",
        "openspec-reviewer-tool": "tool 摘要：确认修复 3 条，豁免 1 条",
      },
    })
    const devOut = renderDeveloperView(state, tg, "openspec-developer")
    expect(devOut).toContain("dev 摘要：完成 task 2 个")
    expect(devOut).not.toContain("tool 摘要")

    const toolOut = renderToolReviewView(state, tg, "openspec-reviewer-tool")
    expect(toolOut).toContain("tool 摘要：确认修复 3 条，豁免 1 条")
    expect(toolOut).not.toContain("dev 摘要")
  })

  test("角色隔离：quality 维度视图只展示自己维度的摘要", () => {
    const state = mockState()
    const tg = baseTg({
      ...reviewBase,
      tasks: [mockTask("1", "submitted")],
      agentSummaries: {
        "openspec-reviewer-style": "style 摘要：确认风格问题 3 条",
        "openspec-reviewer-architecture": "architecture 摘要：确认架构一致 2 处",
        "openspec-developer": "dev 摘要：完成 task 2 个",
      },
    })
    const output = renderQualityReviewView(state, tg, "openspec-reviewer-style")
    expect(output).toContain("style 摘要：确认风格问题 3 条")
    expect(output).not.toContain("architecture 摘要")
    expect(output).not.toContain("dev 摘要")
    expect(output).not.toContain("openspec-reviewer-architecture")
  })

  test("自身无摘要时视图不输出「上轮会话摘要」段", () => {
    const state = mockState()
    const tg = baseTg({
      ...reviewBase,
      agentSummaries: { "openspec-reviewer-tool": "tool 摘要：确认修复 3 条" },
    })
    const output = renderDeveloperView(state, tg, "openspec-developer")
    expect(output).not.toContain("上轮会话摘要")
    expect(output).not.toContain("tool 摘要")
  })
})

describe("视图 Worktree 约束语义", () => {
  const wtTg = {
    status: "dev_impl" as const,
    worktreePath: "/wt",
    branchName: "tg-1",
    baseRef: "base",
  }

  test("约束文本双面化表述：严禁直接修改主仓库/主分支路径", () => {
    const out = renderDeveloperView(mockState(), baseTg(wtTg), "openspec-developer")
    expect(out).toContain("严禁直接修改主仓库")
    expect(out).toContain("主分支路径下的文件")
  })

  test("推荐阅读文档相对 worktree 路径解析指引", () => {
    const out = renderArchitectView(mockState(), baseTg(wtTg))
    expect(out).toContain("以 worktree 路径为基准解析")
    expect(out).toContain("禁止从主仓库根目录解析")
  })

  test("worktree 未就绪时仍输出约束语义", () => {
    const out = renderDeveloperView(mockState(), baseTg({ status: "dev_impl" }), "openspec-developer")
    expect(out).toContain("worktree 未就绪")
  })
})

describe("主仓库 openspec 污染诊断渲染", () => {
  const wtTg = { status: "review" as const, worktreePath: "/wt", branchName: "tg-1", baseRef: "base" }

  test("传入污染信息时渲染醒目提示与文件清单", () => {
    const state = mockState()
    const tg = baseTg(wtTg)
    const output = renderOrchestratorView(state, tg, undefined, {
      repoRoot: "/main-repo",
      files: ["openspec/changes/foo/design.md", "openspec/changes/foo/tasks.md"],
    })
    expect(output).toContain("## ⚠️ 主仓库 openspec 污染")
    expect(output).toContain("/main-repo")
    expect(output).toContain("openspec/changes/foo/design.md")
    expect(output).toContain("openspec/changes/foo/tasks.md")
  })

  test("无污染时不渲染污染段", () => {
    const state = mockState()
    const tg = baseTg(wtTg)
    const output = renderOrchestratorView(state, tg, undefined, null)
    expect(output).not.toContain("主仓库 openspec 污染")
    expect(output).not.toContain("污染")
  })

  test("污染段不重复渲染 worktree 约束文本", () => {
    const state = mockState()
    const tg = baseTg(wtTg)
    const output = renderOrchestratorView(state, tg, undefined, { repoRoot: "/m", files: ["openspec/foo.md"] })
    expect(output).toContain("主仓库 openspec 污染")
    expect(output).not.toContain("严禁直接修改主仓库")
  })
})
