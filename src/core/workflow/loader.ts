import { readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import type {
  WorkflowConfig,
  PhaseConfig,
  StepConfig,
  StepAgent,
  StepTransitions,
  WorkItemPhase,
  WorkflowCommon,
} from "./types.ts"
import { WORK_ITEM_PHASES, stepAgentIds } from "./types.ts"
import { DIMENSION_AGENT_MAP } from "../constants.ts"
import type { OrchestrateState } from "../types.ts"

const SPECIAL_TRANSITIONS = ["done", "halt"] as const
const PHASE_NAMES = new Set<string>(WORK_ITEM_PHASES)
const QUALITY_REVIEW_STEP_ID = "verify_quality"

export interface LoadedWorkflow extends WorkflowConfig {
  stepMap: Map<string, { step: StepConfig; phase: PhaseConfig }>
}

/**
 * 定位 assets/workflows/<fileName>：源码（src/core/workflow/ 上溯 3 级=仓库根）、插件包 dist 形态
 * （dist/zcode-plugin/.mcp-server/ 上溯 1 级=插件根）与 ZCode 缓存嵌套形态
 * （cache/<marketplace>/<plugin>/<version>/.mcp-server/ 上溯 1 级=版本目录）部署深度不同，
 * 故从模块所在目录逐级上溯探测，首个命中即采用（首中即用）。
 * bundle 单文件合并后 import.meta.url 指向部署位置（cli.mjs），源码形态指向本文件自身，两者自然成立。
 */
function resolveWorkflowFilePath(moduleUrl: string, fileName: string): string {
  const startDir = dirname(fileURLToPath(moduleUrl))
  let dir = startDir
  let probed = 0
  for (;;) {
    const candidate = pathResolve(dir, "assets", "workflows", fileName)
    if (existsSync(candidate)) return candidate
    probed++
    const parent = dirname(dir)
    if (parent === dir) break // 到达文件系统根
    dir = parent
  }
  throw new Error(`workflow 文件缺失：从 ${startDir} 上溯 ${probed} 级未找到 assets/workflows/${fileName}`)
}

export function resolveTaskWorkflowPath(moduleUrl: string): string {
  return resolveWorkflowFilePath(moduleUrl, "task.yaml")
}

// 模块加载期求值，workflow 缺失即启动抛错（fail-fast）：opx_* 工具全部依赖 workflow，缺失时
// server 无可用性，启动即抛比首次调用才报错更早且可读（可读错误替代原生 ENOENT）。
export const TASK_WORKFLOW_PATH = resolveTaskWorkflowPath(import.meta.url)
/** simple 流程文件（implement → quality_review → done），与 task.yaml 同目录随插件 bundle 分发。 */
export const SIMPLE_WORKFLOW_PATH = resolveWorkflowFilePath(import.meta.url, "task-simple.yaml")

/**
 * 按 state.mode 选择 workflow 文件：simple → task-simple.yaml，其余（full 或旧 state 缺 mode）→ task.yaml。
 * 旧 state 无 mode 字段一律按 full 处理（读时兜底，不写回），与 D2 固化语义一致。
 */
export function resolveWorkflowPath(state: Pick<OrchestrateState, "mode">): string {
  return state.mode === "simple" ? SIMPLE_WORKFLOW_PATH : TASK_WORKFLOW_PATH
}

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
