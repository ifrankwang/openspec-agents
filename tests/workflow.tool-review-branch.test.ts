/**
 * verify_tool reviewer-tool 检查点增量三分支视图单测（D3）。
 *
 * 分支①（直提）：hasNonDocChange=false 且本层无待复核/待裁定 → 替换式最小视图
 * 分支②（仅处理待复核项）：hasNonDocChange=false 但有待复核/待裁定 → 不跑全量，仅处理待处理项
 * 分支③（全量）：hasNonDocChange=true → 维持现状全量指引
 * 附加：toolChanges 缺省（未预计算）→ 维持全量渲染（默认安全侧）
 */
import { describe, expect, test } from "bun:test"
import { renderWorkingView } from "./helpers-workflow"

function makeItem(overrides: Record<string, unknown> = {}): any {
  return {
    id: "task:1",
    source: "openspec",
    type: "task",
    title: "t",
    description: "d",
    phase: "review",
    suspended: false,
    currentStep: "verify_tool",
    tags: {},
    metadata: {},
    children: [],
    labels: [],
    ...overrides,
  }
}

function makeIssue(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: `issue:${id}`,
    externalId: id,
    source: "openspec",
    type: "issue",
    title: `issue ${id}`,
    description: `issue ${id} 描述`,
    phase: "todo",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" },
    children: [],
    labels: [],
    severity: "Low",
    ...overrides,
  }
}

describe("verify_tool reviewer-tool 三分支渲染", () => {
  test("分支① 直提：无变更 + 无待复核/待裁定 → 替换式最小视图（不渲染 worktree/变更范围，不展示 hash）", () => {
    const item = makeItem()
    const out = renderWorkingView(item, "verify_tool", "openspec-reviewer-tool", {
      toolChanges: { files: [], hasNonDocChange: false },
    })
    expect(out).toContain("# ✅ 当前轮到你执行")
    expect(out).toContain("无需运行全量工具检查")
    expect(out).toContain('opx_agent_submit({ step_id: "verify_tool", verdict: "passed" })')
    // 替换式最小视图：不渲染 worktree/变更范围区块（避免与既有 baseRef..HEAD 累计口径提示冲突）
    expect(out).not.toContain("## Worktree")
    expect(out).not.toContain("diff --name-only")
    // 不展示全量工具检查指引与 skill 清单
    expect(out).not.toContain("顺序运行全部确定性工具检查")
    expect(out).not.toContain("## Skill 加载清单")
    // 不展示 hash
    expect(out).not.toContain("cp-1")
    // 分支③证据区块不注入（口径正确性：仅分支③渲染）
    expect(out).not.toContain("本次变更证据（自上次工具检查）")
  })

  test("分支② 仅处理待复核项：无变更 + 本层待复核/待裁定 → 不跑全量，渲染待处理项清单", () => {
    const item = makeItem({
      children: [
        makeIssue("1", { phase: "review" }),
        makeIssue("2", {
          metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style", exempt_request: { requestedBy: "openspec-developer" } },
        }),
      ],
    })
    const out = renderWorkingView(item, "verify_tool", "openspec-reviewer-tool", {
      toolChanges: { files: [], hasNonDocChange: false },
    })
    expect(out).toContain("# ✅ 当前轮到你执行")
    expect(out).toContain("无需运行全量工具检查")
    // 待复核主区块 + 待裁定豁免区块均渲染
    expect(out).toContain("Issue (待复核)")
    expect(out).toContain("issue 1 描述")
    expect(out).toContain("Issue (待裁定是否可豁免)")
    expect(out).toContain("issue 2 描述")
    // 操作指引聚焦复核/裁定
    expect(out).toContain("recheck_adjudications")
    expect(out).toContain("exempt_adjudications")
    expect(out).not.toContain("顺序运行全部确定性工具检查")
    // 分支③证据区块不注入（口径正确性：仅分支③渲染）
    expect(out).not.toContain("本次变更证据（自上次工具检查）")
  })

  test("分支② 不分 severity 守卫：本层 Info 级 review 待复核 issue 也挡直提（走仅处理待复核项）", () => {
    const item = makeItem({
      children: [makeIssue("1", { phase: "review", severity: "Info" })],
    })
    const out = renderWorkingView(item, "verify_tool", "openspec-reviewer-tool", {
      toolChanges: { files: [], hasNonDocChange: false },
    })
    // 本层待复核判定不分 severity：Info 也算 active → 不触发直提分支
    expect(out).toContain("无需运行全量工具检查")
    expect(out).toContain("仅处理以下本层待复核 / 待裁定项")
    expect(out).toContain("Issue (待复核)")
    expect(out).toContain("issue 1 描述")
    expect(out).toContain("recheck_adjudications")
    // 不渲染直提分支文案（无待复核项时才直提）
    expect(out).not.toContain("无需运行全量工具检查，直接调用")
    // 不渲染全量工具检查指引
    expect(out).not.toContain("顺序运行全部确定性工具检查")
    // 分支③证据区块不注入（口径正确性：仅分支③渲染）
    expect(out).not.toContain("本次变更证据（自上次工具检查）")
  })

  test("分支③ 全量：有变更 → 维持现状全量指引（含 worktree/变更范围区块与全量检查指令）", () => {
    const item = makeItem()
    const out = renderWorkingView(item, "verify_tool", "openspec-reviewer-tool", {
      toolChanges: { files: ["src/a.ts"], hasNonDocChange: true },
    })
    expect(out).toContain("# ✅ 当前轮到你执行")
    expect(out).toContain("## Worktree")
    expect(out).toContain("顺序运行全部确定性工具检查（代码格式/架构约束/静态分析/单元测试编译/深度扫描）")
    expect(out).toContain("## Skill 加载清单")
    expect(out).not.toContain("无需运行全量工具检查")
    // 分支③证据区块：本次（自上次工具检查）增量口径文件清单 + 检查点区间 diff 命令（与 baseRef..HEAD 累计口径区分）
    expect(out).toContain("本次变更证据（自上次工具检查）")
    expect(out).toContain("`src/a.ts`")
    expect(out).toContain("git -C /wt diff")
    expect(out).toContain("base..HEAD")
    // 无检查点（首次进入）形态：基线兜底口径标注，与「变更范围」一致
    expect(out).toContain("本次区间以基线（base..HEAD）兜底")
    expect(out).toContain("首次进入，无上次工具检查记录")
    // 未提交变更查看提示（diff 命令仅覆盖已提交区间）
    expect(out).toContain("若存在未提交变更，另用 `git status` / `git diff` 查看工作区改动")
    // 裁量语义操作指引（task.yaml 追加句渲染：有变更分支审查证据后可免全量）
    expect(out).toContain("跳过全量工具检查")
    expect(out).toContain("仅注释/文档性")
  })

  test("分支③ 无检查点且无基线基准（边缘）：不渲染 diff 命令，仅渲染文件清单与口径标注", () => {
    const item = makeItem()
    const out = renderWorkingView(item, "verify_tool", "openspec-reviewer-tool", {
      tg: { worktreePath: "/wt", branchName: "b", baseRef: undefined },
      toolChanges: { files: ["src/a.ts"], hasNonDocChange: true },
    })
    expect(out).toContain("本次变更证据（自上次工具检查）")
    expect(out).toContain("无检查点且无基线基准，无法界定已提交变更区间")
    expect(out).toContain("`src/a.ts`")
    // 不渲染无效 diff 命令（避免 "(无基准)..HEAD" 形态坏命令）
    expect(out).not.toContain("git -C /wt diff")
    expect(out).not.toContain("(无基准)")
  })

  test("toolChanges 缺省（未预计算）→ 维持全量渲染（默认安全侧，不误伤既有视图）", () => {
    const item = makeItem()
    const out = renderWorkingView(item, "verify_tool", "openspec-reviewer-tool")
    expect(out).toContain("# ✅ 当前轮到你执行")
    expect(out).toContain("顺序运行全部确定性工具检查")
    expect(out).toContain("## Worktree")
    // toolChanges 缺省时分支③证据区块不注入（避免无检测结果时展示空证据）
    expect(out).not.toContain("本次变更证据（自上次工具检查）")
  })
})
