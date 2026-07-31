// types
export type {
  OrchestrateState, TaskGroupState, TaskItem, IssueItem, BlockerItem,
  ExecutionBoundary, Phases, ReviewPhaseData, ReviewLayerData,
  SimplePhaseData, ValidationStep, QualityLayerProgress,
  Phase, BuildPhaseTarget, OrchestrateStatus, TaskStatus, IssueStatus,
  ReviewDimension, Dimension, DimensionVerdict, BlockerStatus,
} from "./types.js"
export { CODE_DIMENSIONS, REVIEW_DIMENSIONS, TASK_STATUSES, ISSUE_STATUSES } from "./types.js"

// tools
export type { ToolContext, ToolResult } from "./tools/types.js"
export type {
  InitParams, SetWorktreeParams, UnattendedParams,
  ArchSubmitParams, ArchBlockerParams, DevSubmitParams,
  ToolReviewParams, TaskReviewParams, QualityReviewParams, ResolveReviewParams,
} from "./tools/types.js"
export {
  initExecute, setWorktreeExecute, statusExecute, completeTaskGroupExecute, setUnattendedExecute,
} from "./tools/lifecycle.js"
export {
  archSubmitExecute, archBlockerExecute, devSubmitExecute,
  toolReviewSubmitExecute, taskReviewSubmitExecute, qualityReviewSubmitExecute,
  resolveReviewExecute,
} from "./tools/review.js"

// state
export {
  readStateByWorktree, readStateByChangeId, writeState,
  getStateDir, getStatePath,
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
  assertOrchestrator, assertAgent, assertPassWithIssues,
  findTaskGroup, deriveStatus, isReviewCompleted, allTasksVerified,
  deriveCurrentAgents, hasBlockingIssues, isBlockingIssue, isStatusUnresolved,
  handleRetryCheckpoint, computeRequiredDims, dimsWithPendingAction,
  createEmptyPhases, createEmptyQualityProgress, phasesAllEmpty,
} from "./derive.js"

// review
export {
  applyReviewGate, finalizeQualityPhase, deduplicateAndAddIssues, mergeExecutionBoundary,
} from "./review.js"

// views
export {
  renderOrchestratorView, renderArchitectView, renderDeveloperView,
  renderToolReviewView, renderTaskReviewView, renderQualityReviewView,
  formatFilePath, taskSummary, issueSummary, renderTaskItem,
  renderIssueItem, renderLayerIssues, sortIssuesByCategory,
} from "./views.js"

// dashboard
export { readDashboardState } from "./dashboard.js"

// constants
export {
  STATE_DIR_NAME, STATE_SUBDIR_NAME, MAX_RETRIES,
  SEVERITY_LEVELS, BLOCKING_SEVERITIES,
  ORCHESTRATOR_AGENT, DIMENSION_AGENT_MAP, AGENT_TO_SUBMIT_TOOL, PHASE_ORDER,
} from "./constants.js"
