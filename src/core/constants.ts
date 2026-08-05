import type { ReviewDimension, Dimension, Phase } from "./types.js"

export const STATE_DIR_NAME = ".opencode"
export const STATE_SUBDIR_NAME = ".orchestrate_state"
export const MAX_RETRIES = 5
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

export const PHASE_ORDER: Phase[] = ["task_analysis", "dev_impl", "review"]
