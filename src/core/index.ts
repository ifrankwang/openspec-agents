// types
export type {
  OrchestrateState, TaskGroupState, TaskItem, IssueItem, BlockerItem,
  ExecutionBoundary, ValidationStep, QualityLayerProgress,
  Phase, BuildPhaseTarget, OrchestrateStatus, TaskStatus, IssueStatus,
  ReviewDimension, Dimension, BlockerStatus,
} from "./types.ts"
export { CODE_DIMENSIONS, REVIEW_DIMENSIONS, TASK_STATUSES, ISSUE_STATUSES } from "./types.ts"

// provider 契约（agent 无关）
export type { JSONSchema, RuntimeTool, RuntimeToolContext, RuntimeToolResult, ToolRegistry, IRuntimeConfig, IRuntimeProvider } from "./provider.ts"

// tools
export type { ToolContext, ToolResult } from "./tools/types.ts"
export type {
  InitParams, SetWorktreeParams, UnattendedParams,
  AgentSubmitParams,
} from "./tools/types.ts"
export {
  initExecute, setWorktreeExecute, statusExecute, completeTaskGroupExecute, setUnattendedExecute,
} from "./tools/lifecycle.ts"
export { agentSubmitExecute } from "./tools/submit.ts"

// tool 参数 schema（纯 JSON Schema）
export {
  executionBoundarySchema, boundaryExpansionSchema, taskVerifyItem, validationStepSchema,
  blockerItem, exemptAdjudicationItem, recheckAdjudicationItem, checkpointSkipReasonItem,
  newChildIssueItem, recoverySchema,
  orchInitSchema, setWorktreeSchema, statusSchema, completeTaskGroupSchema,
  setUnattendedSchema, agentSubmitSchema, TOOL_SCHEMAS,
} from "./tools/schemas.ts"

// state
export {
  readStateByWorktree, readStateByChangeId, writeState,
  getStateDir, getStatePath, upgradeWorkItemsFromTaskGroups,
} from "./state.ts"

// git
export {
  runGit, runGitChecked, __setGitRunner,
  getCurrentHead, getCurrentBranch, getMergeBase,
  isWorktreeClean, markTaskGroupCheckboxesComplete,
  mergeBranchToTarget, discoverDiskWorktrees,
} from "./git.ts"
export type { GitRunner } from "./git.ts"

// tasks-md
export type { ParsedTask } from "./tasks-md.ts"
export {
  parseAllTaskGroupsFromMd, parseTasksMdForGroup, extractRelevantSpecsFromTasks,
  parseSpecTrace,
} from "./tasks-md.ts"

// derive
export {
  assertOrchestrator, assertAgent,
  findTaskGroup, hasBlockingIssues, isBlockingIssue, isStatusUnresolved,
  createEmptyQualityProgress, blockingIssues, taskGroupFromWorkItem,
} from "./derive.ts"

// views
export {
  renderSkillSuggestions, renderEfficiencySteps, renderWorktreeSection,
  renderAgentSummaries, formatFilePath, renderTaskItem, formatSeverity,
} from "./views.ts"

// dashboard
export { readDashboardState } from "./dashboard.ts"

// constants
export {
  STATE_DIR_NAME, STATE_SUBDIR_NAME,
  SEVERITY_LEVELS, BLOCKING_SEVERITIES,
  DIMENSION_AGENT_MAP,
} from "./constants.ts"
