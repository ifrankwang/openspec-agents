import { readFileSync } from "node:fs"
import { join } from "node:path"
import yaml from "js-yaml"
import type {
  WorkflowConfig,
  PhaseConfig,
  StepConfig,
  StepAgent,
  StepTransitions,
  WorkItemPhase,
  WorkflowCommon,
} from "./types.js"
import { WORK_ITEM_PHASES, stepAgentIds } from "./types.js"
import { DIMENSION_AGENT_MAP } from "../constants.js"

const SPECIAL_TRANSITIONS = ["done", "halt"] as const
const PHASE_NAMES = new Set<string>(WORK_ITEM_PHASES)
const QUALITY_REVIEW_STEP_ID = "verify_quality"

export interface LoadedWorkflow extends WorkflowConfig {
  stepMap: Map<string, { step: StepConfig; phase: PhaseConfig }>
}

export const TASK_WORKFLOW_PATH = join(import.meta.dir, "..", "..", "..", "assets", "workflows", "task.yaml")

const workflowFileCache = new Map<string, LoadedWorkflow>()

/** 读取 workflow YAML 文件并解析，进程内按路径缓存（submit / status 共用）。 */
export function loadWorkflowFile(filePath: string): LoadedWorkflow {
  let wf = workflowFileCache.get(filePath)
  if (!wf) {
    wf = loadWorkflow(readFileSync(filePath, "utf-8"))
    workflowFileCache.set(filePath, wf)
  }
  return wf
}

interface RawStep {
  id?: unknown
  agents?: unknown
  always_run?: unknown
  max_retries?: unknown
  instructions?: unknown
  constraints?: unknown
  transitions?: unknown
}

interface RawPhase {
  name?: unknown
  steps?: unknown
}

interface RawWorkflow {
  id?: unknown
  name?: unknown
  max_retries?: unknown
  phases?: unknown
  common?: unknown
}

function fail(message: string): never {
  throw new Error(message)
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`workflow 配置非法：${path} 必须是非空字符串，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function expectPositiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`workflow 配置非法：${path} 必须是正整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string")) {
    fail(`workflow 配置非法：${path} 必须是非空字符串数组，收到 ${JSON.stringify(value)}`)
  }
  return value as string[]
}

/** agents 对象数组解析：每个元素须含非空 id 与非空字符串数组 capability_tags（agent 级 capability_tags 必填）。 */
function expectAgentList(value: unknown, path: string): StepAgent[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`workflow 配置非法：${path} 必须是非空对象数组（每个元素含 id 与 capability_tags），收到 ${JSON.stringify(value)}`)
  }
  return value.map((v, i) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      fail(`workflow 配置非法：${path}[${i}] 必须是对象（含 id 与 capability_tags），收到 ${JSON.stringify(v)}`)
    }
    const a = v as { id?: unknown; capability_tags?: unknown }
    return {
      id: expectString(a.id, `${path}[${i}].id`),
      capability_tags: expectStringArray(a.capability_tags, `${path}[${i}].capability_tags`),
    }
  })
}

function expectOptionalPositiveInt(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  return expectPositiveInt(value, path)
}

function expectOptionalNonEmptyStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    fail(`workflow 配置非法：${path} 必须是非空字符串数组，收到 ${JSON.stringify(value)}`)
  }
  return value as string[]
}

/** common 块解析：instructions / constraints 可选非空字符串数组（全缺省时降级 undefined）。 */
function parseCommon(raw: unknown, workflowId: string): WorkflowCommon | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`workflow "${workflowId}" 配置非法：common 必须是对象`)
  }
  const c = raw as { instructions?: unknown; constraints?: unknown }
  const instructions = expectOptionalNonEmptyStringArray(c.instructions, "common.instructions")
  const constraints = expectOptionalNonEmptyStringArray(c.constraints, "common.constraints")
  if (instructions === undefined && constraints === undefined) return undefined
  return { instructions, constraints }
}

/** verify_quality 双源一致性校验：存在该 step 时，agents 的 id 集合须等于质量维度 agent 映射值集合（改一处不同步即不一致）。 */
function assertQualityAgentsConsistent(workflowId: string, stepMap: Map<string, { step: StepConfig; phase: PhaseConfig }>): void {
  const qualityStep = stepMap.get(QUALITY_REVIEW_STEP_ID)
  if (!qualityStep) return
  const declared = new Set(stepAgentIds(qualityStep.step))
  const expected = new Set(Object.values(DIMENSION_AGENT_MAP))
  if (declared.size !== expected.size || ![...expected].every((a) => declared.has(a))) {
    fail(
      `workflow "${workflowId}" 配置非法：${QUALITY_REVIEW_STEP_ID}.agents（${JSON.stringify([...declared])}）与质量维度 agent 映射（${JSON.stringify([...expected])}）不一致，两处须保持同一集合`
    )
  }
}

function parseTransitions(raw: unknown, stepId: string, validStepIds: Set<string>): StepTransitions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`workflow 配置非法：step "${stepId}" 的 transitions 必须是对象`)
  }
  const t = raw as Record<string, unknown>
  const out: Partial<StepTransitions> = {}
  for (const key of ["on_pass", "on_fail"] as const) {
    const target = t[key]
    if (typeof target !== "string" || target === "") {
      fail(`workflow 配置非法：step "${stepId}" 的 transitions.${key} 必须是非空字符串`)
    }
    if (!SPECIAL_TRANSITIONS.includes(target as (typeof SPECIAL_TRANSITIONS)[number]) && !validStepIds.has(target)) {
      fail(
        `workflow 配置非法：step "${stepId}" 的 transitions.${key} 目标 "${target}" 不存在（既非已声明 step id，也非 done/halt 特殊值）`
      )
    }
    out[key] = target as StepTransitions[typeof key]
  }
  return out as StepTransitions
}

export function loadWorkflow(yamlText: string): LoadedWorkflow {
  let raw: unknown
  try {
    raw = yaml.load(yamlText)
  } catch (err) {
    fail(`workflow YAML 解析失败：${(err as Error).message}`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("workflow 配置非法：顶层必须是 YAML 映射对象")
  }
  const wf = raw as RawWorkflow
  const id = expectString(wf.id, "id")
  const maxRetries = expectPositiveInt(wf.max_retries, "max_retries")
  const name = typeof wf.name === "string" && wf.name.trim() !== "" ? wf.name : undefined

  if (!Array.isArray(wf.phases) || wf.phases.length === 0) {
    fail(`workflow "${id}" 配置非法：phases 必须是非空数组`)
  }

  const phases: PhaseConfig[] = []
  const stepMap = new Map<string, { step: StepConfig; phase: PhaseConfig }>()
  const rawTransitions = new Map<string, unknown>()
  const seenPhaseNames = new Set<string>()
  const allStepIds = new Set<string>()

  for (const [phaseIdx, rawPhase] of wf.phases.entries()) {
    if (typeof rawPhase !== "object" || rawPhase === null || Array.isArray(rawPhase)) {
      fail(`workflow "${id}" 配置非法：phases[${phaseIdx}] 必须是对象`)
    }
    const rp = rawPhase as RawPhase
    const phaseName = expectString(rp.name, `phases[${phaseIdx}].name`)
    if (!PHASE_NAMES.has(phaseName)) {
      fail(
        `workflow "${id}" 配置非法：phases[${phaseIdx}].name "${phaseName}" 不是合法 phase（合法值：${WORK_ITEM_PHASES.join(", ")}）`
      )
    }
    if (seenPhaseNames.has(phaseName)) {
      fail(`workflow "${id}" 配置非法：phase "${phaseName}" 重复声明`)
    }
    seenPhaseNames.add(phaseName)
    const phase: PhaseConfig = { name: phaseName as WorkItemPhase, steps: [] }

    if (!Array.isArray(rp.steps) || rp.steps.length === 0) {
      fail(`workflow "${id}" 配置非法：phase "${phaseName}" 的 steps 必须是非空数组`)
    }
    for (const [stepIdx, rawStep] of rp.steps.entries()) {
      if (typeof rawStep !== "object" || rawStep === null || Array.isArray(rawStep)) {
        fail(`workflow "${id}" 配置非法：phase "${phaseName}" steps[${stepIdx}] 必须是对象`)
      }
      const rs = rawStep as RawStep
      const stepId = expectString(rs.id, `phase "${phaseName}" steps[${stepIdx}].id`)
      if (allStepIds.has(stepId)) {
        fail(`workflow "${id}" 配置非法：step id "${stepId}" 重复声明`)
      }
      allStepIds.add(stepId)
      rawTransitions.set(stepId, rs.transitions)
      const agents = expectAgentList(rs.agents, `step "${stepId}" 的 agents`)
      const step: StepConfig = {
        id: stepId,
        agents,
        always_run: typeof rs.always_run === "boolean" ? rs.always_run : undefined,
        max_retries: expectOptionalPositiveInt(rs.max_retries, `step "${stepId}" 的 max_retries`),
        instructions: expectOptionalNonEmptyStringArray(rs.instructions, `step "${stepId}" 的 instructions`),
        constraints: expectOptionalNonEmptyStringArray(rs.constraints, `step "${stepId}" 的 constraints`),
        transitions: { on_pass: "done", on_fail: "halt" },
      }
      phase.steps.push(step)
      stepMap.set(stepId, { step, phase })
    }
    phases.push(phase)
  }

  for (const { step } of stepMap.values()) {
    step.transitions = parseTransitions(rawTransitions.get(step.id), step.id, allStepIds)
  }

  assertQualityAgentsConsistent(id, stepMap)

  return { id, name, max_retries: maxRetries, phases, stepMap, common: parseCommon(wf.common, id) }
}

export function findStepByWorkItemPhase(
  workflow: LoadedWorkflow,
  phase: WorkItemPhase,
): { step: StepConfig; phase: PhaseConfig } | null {
  for (const entry of workflow.stepMap.values()) {
    if (entry.phase.name === phase) return entry
  }
  return null
}
