// types
export type {
  OrchestrateState, TaskGroupState, TaskItem, IssueItem, BlockerItem,
  ExecutionBoundary, ValidationStep, QualityLayerProgress,
  Phase, BuildPhaseTarget, OrchestrateStatus, TaskStatus, IssueStatus,
  ReviewDimension, Dimension, BlockerStatus,
} from "./types.js"
export { CODE_DIMENSIONS, REVIEW_DIMENSIONS, TASK_STATUSES, ISSUE_STATUSES } from "./types.js"

// tools
export type { ToolContext, ToolResult } from "./tools/types.js"
export type {
  InitParams, SetWorktreeParams, UnattendedParams,
  AgentSubmitParams,
} from "./tools/types.js"
export {
  initExecute, setWorktreeExecute, statusExecute, completeTaskGroupExecute, setUnattendedExecute,
} from "./tools/lifecycle.js"
export { agentSubmitExecute } from "./tools/submit.js"

// state
export {
  readStateByWorktree, readStateByChangeId, writeState,
  getStateDir, getStatePath, upgradeWorkItemsFromTaskGroups,
} from "./state.js"

// git
export {
  runGit, runGitChecked, __setGitRunner,
  getCurrentHead, getCurrentBranch, getMergeBase,
  isWorktreeClean, markTaskGroupCheckboxesComplete,
  mergeBranchToTarget, discoverDiskWorktrees,
} from "./git.js"
export type { GitRunner } from "./git.js"

// tasks-md
export type { ParsedTask } from "./tasks-md.js"
export {
  parseAllTaskGroupsFromMd, parseTasksMdForGroup, extractRelevantSpecsFromTasks,
  parseSpecTrace,
} from "./tasks-md.js"

// derive
export {
  assertOrchestrator, assertAgent,
  findTaskGroup, hasBlockingIssues, isBlockingIssue, isStatusUnresolved,
  createEmptyQualityProgress, blockingIssues, taskGroupFromWorkItem,
} from "./derive.js"

// views
export {
  renderSkillSuggestions, renderEfficiencySteps, renderWorktreeSection,
  renderAgentSummaries, formatFilePath, renderTaskItem, formatSeverity,
} from "./views.js"

// dashboard
export { readDashboardState } from "./dashboard.js"

// constants
export {
  STATE_DIR_NAME, STATE_SUBDIR_NAME, MAX_RETRIES,
  SEVERITY_LEVELS, BLOCKING_SEVERITIES,
  ORCHESTRATOR_AGENT, DIMENSION_AGENT_MAP, PHASE_ORDER,
} from "./constants.js"
