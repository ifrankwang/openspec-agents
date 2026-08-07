import type { WorkItem } from "./types.js"
import { tagKey } from "./types.js"
import { clearStepTags, isTerminalPhase } from "./engine.js"
import { DIMENSION_AGENT_MAP, reviewLayerFromMetadata } from "../constants.js"
import { REVIEW_DIMENSIONS } from "../types.js"
import type { Dimension, ReviewLayer } from "../types.js"
import { issueChildrenOf } from "../task-children.js"

export interface ResetReviewTagsInput {
  fixedSourcePhases: string[]
  exemptSourcePhases: string[]
  touchedQualityDims: string[]
}

/** 解析 child 的 issue 归因字段（报源层/dimension/file/line），缺省 tool/style/""/0。
 *  报源层由 metadata.source 经 agentToReviewLayer 反推，source_phase 仅作历史 state 兜底。 */
export function resolveChildIssueFields(child: WorkItem): {
  sourcePhase: ReviewLayer
  dimension: Dimension
  file: string
  line: number
} {
  const sourcePhase = reviewLayerFromMetadata(child)
  const dimension = (REVIEW_DIMENSIONS as readonly string[]).includes(child.metadata["dimension"] as string)
    ? (child.metadata["dimension"] as Dimension)
    : "style"
  return {
    sourcePhase,
    dimension,
    file: typeof child.metadata["file"] === "string" ? child.metadata["file"] : "",
    line: typeof child.metadata["line"] === "number" ? child.metadata["line"] : 0,
  }
}

/**
 * dev 提交后按 issue 归因分层重置 review 验证标记（旧 review.ts devSubmitExecute:298-318 分层重置的精确复刻）。
 * - 任一 fixed（代码变更）→ 清 verify_tool（tool 层确定性检查须基于最新代码重跑）
 * - fixed 中属 task 层 → 额外清 verify_task
 * - exempt 属 task 层 → 清 verify_tool + verify_task
 * - exempt 属 tool 层 → 清 verify_tool
 * - fixed 中属 quality 层且维度 dim → 只清 verify_quality 中 DIMENSION_AGENT_MAP[dim] 对应 agent 的 tag
 * - exempt 不清 quality 维度 tag：豁免=接受现状、不修改代码，已 passed 维度无需重审
 * - 豁免不改代码（exempt 无 tool/task 层）→ 不清 verify_tool/verify_task
 */
export function resetReviewTagsOnFix(item: WorkItem, input: ResetReviewTagsInput): void {
  const fixed = new Set(input.fixedSourcePhases)
  const exempt = new Set(input.exemptSourcePhases)

  if (fixed.size > 0) {
    clearStepTags(item, "verify_tool")
    if (fixed.has("task")) clearStepTags(item, "verify_task")
  }

  if (exempt.has("task")) {
    clearStepTags(item, "verify_tool")
    clearStepTags(item, "verify_task")
  } else if (exempt.has("tool")) {
    clearStepTags(item, "verify_tool")
  }

  for (const d of input.touchedQualityDims) {
    const agent = DIMENSION_AGENT_MAP[d as Dimension]
    if (agent) {
      delete item.tags[tagKey("verify_quality", agent)]
    }
  }
}

/**
 * new_children 入库前去重（旧 deduplicateAndAddIssues 语义）：
 * 与「未终结态（非 done/cancelled）」的既有 issue child 按 (报源层/dimension/file/line/description) 比对，
 * 命中即丢弃并计数；已终态 child 不参与判重（允许 reviewer 重报已关闭问题）。
 * 比对集仅限 issue child——task child 的 description 可能与新 issue 恰好相同，混入会误吞新报。
 */
export function dedupeNewChildren(item: WorkItem, newChildren: WorkItem[]): { accepted: WorkItem[]; dedupedCount: number } {
  const keyOf = (child: WorkItem): string => {
    const f = resolveChildIssueFields(child)
    return [f.sourcePhase, f.dimension, f.file, f.line, child.description].join("\u0000")
  }
  const accepted: WorkItem[] = []
  let dedupedCount = 0
  const existing = issueChildrenOf(item)
  for (const nc of newChildren) {
    const key = keyOf(nc)
    const duplicate = existing.some((child) => !isTerminalPhase(child.phase) && keyOf(child) === key)
    if (duplicate) {
      dedupedCount++
      continue
    }
    accepted.push(nc)
  }
  return { accepted, dedupedCount }
}
