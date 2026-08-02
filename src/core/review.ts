import type { TaskGroupState, IssueItem, Dimension, OrchestrateState, ReviewDimension } from "./types.js"
import { REVIEW_DIMENSIONS } from "./types.js"
import { MAX_RETRIES } from "./constants.js"
import { handleRetryCheckpoint, hasBlockingIssues } from "./derive.js"
import { writeState } from "./state.js"

export function mergeExecutionBoundary(tg: TaskGroupState, expansion: { allowed_directories?: string[]; allowed_packages?: string[] }): void {
  if (!tg.executionBoundary) return
  const { allowed_directories, allowed_packages } = expansion
  if (allowed_directories) {
    for (const dir of allowed_directories) {
      if (!tg.executionBoundary.allowed_directories.includes(dir)) {
        tg.executionBoundary.allowed_directories.push(dir)
      }
    }
  }
  if (allowed_packages) {
    for (const pkg of allowed_packages) {
      if (!tg.executionBoundary.allowed_packages.includes(pkg)) {
        tg.executionBoundary.allowed_packages.push(pkg)
      }
    }
  }
}

export function deduplicateAndAddIssues(
  issues: any[],
  existingIssues: IssueItem[],
  dimension: Dimension,
  sourcePhase: "tool" | "task" | "quality",
  nextIssueIdStart: number,
): { newIssues: IssueItem[]; nextIssueId: number; dedupedCount: number } {
  let nextIssueId = nextIssueIdStart
  let dedupedCount = 0
  const newIssues: IssueItem[] = []
  for (const iss of issues) {
    const isDuplicate = existingIssues.some(
      (existing) =>
        existing.dimension === dimension &&
        existing.sourcePhase === sourcePhase &&
        existing.file === iss.file &&
        existing.line === iss.line &&
        existing.description === iss.description &&
        (existing.status === "open" || existing.status === "submitted" || existing.status === "rejected")
    )
    if (isDuplicate) { dedupedCount++; continue }
    newIssues.push({
      id: String(nextIssueId++),
      dimension: dimension,
      severity: iss.severity,
      file: iss.file,
      line: iss.line,
      description: iss.description,
      suggestion: iss.suggestion || "",
      status: "open" as const,
      refixCount: 0,
      rootCauseGuess: null,
      exemptReason: null,
      rejectReason: null,
      sourcePhase,
      rule: iss.rule || undefined,
    })
  }
  return { newIssues, nextIssueId, dedupedCount }
}

export function applyReviewGate(
  issues: IssueItem[],
  fixedIds: string[],
  exemptIds: string[],
  rejectedIssueInputs: Array<{ issue_id: string; reason: string }>,
  dimension?: Dimension,
  sourcePhase?: string
): void {
  const filtered = dimension
    ? issues.filter((i) => (i.status === "submitted" || i.status === "exemption_requested") && i.dimension === dimension && i.sourcePhase === sourcePhase)
    : issues.filter((i) => (i.status === "submitted" || i.status === "exemption_requested") && i.sourcePhase === sourcePhase)

  const fixedSet = new Set(fixedIds)
  const exemptSet = new Set(exemptIds)
  const rejectedSet = new Set(rejectedIssueInputs.map((r) => r.issue_id))

  for (const id of fixedIds) {
    if (exemptSet.has(id)) throw new Error(`issue #${id} 同时出现在 fixed_issue_ids 和 exempt_issue_ids 中。`)
    if (rejectedSet.has(id)) throw new Error(`issue #${id} 同时出现在 fixed_issue_ids 和 rejected_issue_ids 中。`)
  }
  for (const id of exemptIds) {
    if (rejectedSet.has(id)) throw new Error(`issue #${id} 同时出现在 exempt_issue_ids 和 rejected_issue_ids 中。`)
  }

  const seenInRejected = new Set<string>()
  for (const r of rejectedIssueInputs) {
    if (seenInRejected.has(r.issue_id)) throw new Error(`rejected_issue_ids 中存在重复的 issue ID：${r.issue_id}。`)
    seenInRejected.add(r.issue_id)
  }

  for (const id of fixedIds) {
    const issue = issues.find((i) => i.id === id)
    if (issue && issue.status !== "submitted") {
      throw new Error(`issue #${id} 状态为 ${issue.status}，不可通过 fixed_issue_ids 标记 verified（仅 submitted 可标记）。`)
    }
  }
  for (const id of exemptIds) {
    const issue = issues.find((i) => i.id === id)
    if (issue && issue.status !== "exemption_requested") {
      throw new Error(`issue #${id} 状态为 ${issue.status}，不可通过 exempt_issue_ids 豁免（仅 exemption 可豁免）。`)
    }
  }

  const uncovered = filtered.filter((i) => !fixedSet.has(i.id) && !exemptSet.has(i.id) && !rejectedSet.has(i.id))
  if (uncovered.length > 0) {
    throw new Error(
      `以下 ${uncovered.length} 个活跃 issue（submitted/exemption）未被 fixed_issue_ids、exempt_issue_ids 或 rejected_issue_ids 覆盖：\n` +
      uncovered.map((i) => `- #${i.id}(${i.status})`).join("\n") +
      `\n所有活跃 issue 必须有明确裁定。`
    )
  }

  for (const id of fixedIds) {
    const issue = issues.find((i) => i.id === id)
    if (issue && issue.status === "submitted") {
      issue.status = "verified"
    }
  }
  for (const id of exemptIds) {
    const issue = issues.find((i) => i.id === id)
    if (issue && issue.status === "exemption_requested") {
      issue.status = "exempted"
      if (!issue.exemptReason) issue.exemptReason = "(由审核者豁免)"
    }
  }
  for (const r of rejectedIssueInputs) {
    const issue = issues.find((i) => i.id === r.issue_id)
    if (issue && (issue.status === "submitted" || issue.status === "exemption_requested")) {
      const wasSubmitted = issue.status === "submitted"
      issue.status = "rejected"
      issue.rejectReason = r.reason
      if (wasSubmitted) issue.refixCount++
    }
  }
}

export async function finalizeQualityPhase(
  state: OrchestrateState,
  tg: TaskGroupState,
  dimension: ReviewDimension,
  passed: boolean,
  worktree: string,
  dedupedCount = 0,
): Promise<string> {
  const dedupedSuffix = dedupedCount > 0 ? ` ${dedupedCount} 个重复 issue 已自动跳过。` : ""
  const allDims = [...REVIEW_DIMENSIONS] as ReviewDimension[]
  const nonPassedDims = allDims.filter(d => tg.phases.review.quality.progress[d] !== "passed")
  const allDispatchedDone = nonPassedDims.every(d => tg.phases.review.quality.progress[d] !== "pending")

  if (!allDispatchedDone) {
    return `[${dimension}] 已提交。职责已完成，请立即结束当前会话。${dedupedSuffix}`
  }

  const failedDims = nonPassedDims.filter(d => tg.phases.review.quality.progress[d] === "failed")
  const hasResidualBlocking = hasBlockingIssues(tg.issues, "quality")

  if (failedDims.length === 0 && !hasResidualBlocking) {
    await writeState(worktree, state)
    return `全部审查维度通过。职责已完成，请立即结束当前会话。${dedupedSuffix}`
  }

  const failedDesc = failedDims.length > 0
    ? `未通过维度：${failedDims.join("、")}。`
    : `存在残留的阻塞 issue。`
  const failedMsg = `[${dimension}] 审查未通过。职责已完成，请立即结束当前会话。\n\n${failedDesc}`

  const retryResult = handleRetryCheckpoint(tg, state.unattended)
  if (retryResult === null) {
    await writeState(worktree, state)
    return `${failedMsg}${dedupedSuffix}`
  }

  tg.status = "dev_impl"
  await writeState(worktree, state)
  return `${failedMsg}${dedupedSuffix}`
}
