// types
export {
  WORK_ITEM_PHASES, WORK_ITEM_TYPES, VERDICTS, SEVERITY_LEVELS, BLOCKING_SEVERITIES,
  INTERNAL_METADATA_PREFIX, tagKey, isInternalMetadataKey, stepAgentIds,
} from "./types.js"
export type {
  WorkItemPhase, WorkItemType, Verdict, Severity,
  WorkItem, WorkItemWriteback, StepConfig, StepAgent, PhaseConfig, StepTransitions,
  WorkflowConfig, StepAdjudication,
} from "./types.js"

// loader
export { loadWorkflow, findStepByWorkItemPhase } from "./loader.js"
export type { LoadedWorkflow } from "./loader.js"

// engine
export {
  createInitialWorkItem, isTerminalPhase, isBlockingSeverity, isInfoSeverity,
  effectiveMaxRetries, getStepVerdict, adjudicateStep, recommendAgents,
  applyAgentVerdict, clearStepTags, stepCanPass, phaseStepsAllPassed,
  childReachedPhase, forwardGatePassed, rollbackChildren, hasUnresolvedChildren,
  checkpointTriggered, applyCheckpointContinue, applyCheckpointGiveup,
  incrementRetry, suspendItem, applyTransition, isForwardTransition,
  recommendForItem,
} from "./engine.js"
export type {
  EngineRecommendation, TransitionResult, TransitionDirection,
} from "./engine.js"

// submit
export { submitForStep, routeExempt, adjudicateExempt, adjudicateRecheck, assertSubmitRouting, EXEMPT_REQUEST_KEY } from "./submit.js"
export type {
  SubmitInput, SubmitResult, ExemptRouteResult, AdjudicationResult, RecheckAdjudicationResult,
} from "./submit.js"

// reset（review 分层重置 + new_children 去重）
export {
  resetReviewTagsOnFix, dedupeNewChildren, resolveChildIssueFields,
} from "./reset.js"
export type { ResetReviewTagsInput } from "./reset.js"

// status（工作流动态视图）
export { renderWorkflowStatusView } from "./status.js"
export type { WorkflowStatusViewOptions } from "./status.js"

// writeback
export { enqueueWriteback, flushWritebacks, retryPendingWritebacks, setWritebackHandler } from "./writeback.js"
export type { WritebackHandler } from "./writeback.js"

// collector
export { OpenSpecCollector, AdoCollector, registerCollector, getCollectors, __resetCollectors } from "./collector.js"
export type { CollectorAdapter, OpenSpecCollectorOptions, OpenSpecChangeRef } from "./collector.js"

// poller
export { pollOnce, pollAdapter, startPolling, __resetPoller } from "./poller.js"
export type { PollOnceResult, PollAdapterResult } from "./poller.js"
