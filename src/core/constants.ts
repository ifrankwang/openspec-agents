import type { ReviewDimension, ReviewLayer } from "./types.js"
import type { WorkItem } from "./workflow/types.js"

export const STATE_DIR_NAME = ".opencode"
export const STATE_SUBDIR_NAME = ".orchestrate_state"
export const SEVERITY_LEVELS = ["Critical", "High", "Medium", "Low", "Info"] as const
export const BLOCKING_SEVERITIES = ["Critical", "High", "Medium", "Low"] as const

export const ORCHESTRATOR_AGENT = "openspec-orchestrator"

export const DIMENSION_AGENT_MAP: Record<ReviewDimension, string> = {
  style: "openspec-reviewer-style",
  architecture: "openspec-reviewer-architecture",
  performance: "openspec-reviewer-performance",
  security: "openspec-reviewer-security",
  maintainability: "openspec-reviewer-maintainability",
}

/** agent → quality 维度反查（DIMENSION_AGENT_MAP 值反向映射），未命中返回 undefined。 */
export function agentToReviewDimension(agent: string): ReviewDimension | undefined {
  return (Object.keys(DIMENSION_AGENT_MAP) as ReviewDimension[]).find((d) => DIMENSION_AGENT_MAP[d] === agent)
}

/** agent → issue 报源层（tool/task/quality）：tool/task reviewer 直接映射，quality reviewer 经维度反查命中即 quality。其余 agent 返回 undefined。 */
export function agentToReviewLayer(agent: string | undefined): ReviewLayer | undefined {
  if (!agent) return undefined
  if (agent === "openspec-reviewer-tool") return "tool"
  if (agent === "openspec-reviewer-task") return "task"
  if (agentToReviewDimension(agent)) return "quality"
  return undefined
}

/** 安全读取 issue child 的报源 agent（metadata.source），非 string 返回 undefined。 */
export function readIssueSource(child: WorkItem): string | undefined {
  return typeof child.metadata["source"] === "string" ? child.metadata["source"] : undefined
}

/** 从 child.metadata 解析 issue 报源层：source 反推 → 旧 source_phase 兼容历史 state → 缺省 tool。 */
export function reviewLayerFromMetadata(child: WorkItem): ReviewLayer {
  const source = readIssueSource(child)
  const bySource = agentToReviewLayer(source)
  if (bySource) return bySource
  const rawPhase = child.metadata["source_phase"]
  return rawPhase === "tool" || rawPhase === "task" || rawPhase === "quality" ? rawPhase : "tool"
}
