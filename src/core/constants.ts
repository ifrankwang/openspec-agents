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

export const AGENT_TO_SUBMIT_TOOL: Record<string, string> = {
  "openspec-architect": "opx_arch_submit",
  "openspec-developer": "opx_dev_submit",
  "openspec-reviewer-tool": "opx_tool_review_submit",
  "openspec-reviewer-task": "opx_task_review_submit",
  "openspec-reviewer-style": "opx_quality_review_submit",
  "openspec-reviewer-architecture": "opx_quality_review_submit",
  "openspec-reviewer-performance": "opx_quality_review_submit",
  "openspec-reviewer-security": "opx_quality_review_submit",
  "openspec-reviewer-maintainability": "opx_quality_review_submit",
}

export const PHASE_ORDER: Phase[] = ["task_analysis", "dev_impl", "review"]
