// types
export {
  WORK_ITEM_PHASES, WORK_ITEM_TYPES, VERDICTS, SEVERITY_LEVELS, BLOCKING_SEVERITIES,
  INTERNAL_METADATA_PREFIX, tagKey, isInternalMetadataKey, stepAgentIds,
} from "./types.ts"
export type {
  WorkItemPhase, WorkItemType, Verdict, Severity,
  WorkItem, WorkItemWriteback, StepConfig, StepAgent, PhaseConfig, StepTransitions,
  WorkflowConfig, StepAdjudication,
} from "./types.ts"

// loader
export { loadWorkflow, findStepByWorkItemPhase } from "./loader.ts"
export type { LoadedWorkflow } from "./loader.ts"

// engine
export {
  createInitialWorkItem, isTerminalPhase, isBlockingSeverity, isInfoSeverity,
  effectiveMaxRetries, getStepVerdict, adjudicateStep, recommendAgents,
  applyAgentVerdict, clearStepTags, stepCanPass, phaseStepsAllPassed,
  childReachedPhase, forwardGatePassed, rollbackChildren, hasUnresolvedChildren,
  checkpointTriggered, applyCheckpointContinue, applyCheckpointGiveup,
  incrementRetry, suspendItem, applyTransition, isForwardTransition,
  recommendForItem,
} from "./engine.ts"
export type {
  EngineRecommendation, TransitionResult, TransitionDirection,
} from "./engine.ts"

// submit
export { submitForStep, adjudicateExempt, adjudicateRecheck, assertSubmitRouting, EXEMPT_REQUEST_KEY } from "./submit.ts"
export type {
  SubmitInput, SubmitResult, AdjudicationResult, RecheckAdjudicationResult,
} from "./submit.ts"

// reset（review 分层重置 + new_children 去重）
export {
  resetReviewTagsOnFix, dedupeNewChildren, resolveChildIssueFields,
} from "./reset.ts"
export type { ResetReviewTagsInput } from "./reset.ts"

// status（工作流动态视图）
export { renderWorkflowStatusView } from "./status.ts"
export type { WorkflowStatusViewOptions } from "./status.ts"

// writeback
export { enqueueWriteback, flushWritebacks, retryPendingWritebacks, setWritebackHandler } from "./writeback.ts"
export type { WritebackHandler } from "./writeback.ts"

// collector
export { OpenSpecCollector, AdoCollector, registerCollector, getCollectors, __resetCollectors } from "./collector.ts"
export type { CollectorAdapter, OpenSpecCollectorOptions, OpenSpecChangeRef } from "./collector.ts"

// poller
export { pollOnce, pollAdapter, startPolling, __resetPoller } from "./poller.ts"
export type { PollOnceResult, PollAdapterResult } from "./poller.ts"
