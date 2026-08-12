/**
 * 内核 Provider 契约：agent 无关的工具注册、参数 schema、context 注入、agent/skill 注入与用户交互回调。
 * 各 agent 适配层（opencode / claude-code / codex / zcode / MCP server）实现本接口接入同一套编排状态机。
 * 本文件 MUST NOT import 任何 agent 专有 API（@opencode-ai/* 等）。
 */

/** 纯 JSON Schema（draft-07 子集），工具参数统一用该形态定义，MCP 与各 agent 原生机制均可消费。 */
export interface JSONSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null"
  description?: string
  properties?: Record<string, JSONSchema>
  items?: JSONSchema
  required?: string[]
  enum?: readonly (string | number | boolean)[]
  default?: unknown
  minLength?: number
  minItems?: number
  minimum?: number
  maximum?: number
  additionalProperties?: boolean
  [key: string]: unknown
}

/** 工具 context 注入：适配层在调用工具执行器时透传。 */
export interface RuntimeToolContext {
  worktree: string
  agent: string
  /** 编排视角角色判定：true 表示调用者承担编排者职责（各 agent 主代理），替代 agent 名硬编码。 */
  orchestrator?: boolean
  remote?: boolean
}

/** 工具执行结果。 */
export interface RuntimeToolResult {
  content: string
  isError?: boolean
}

/** 工具定义：描述 + 纯 JSON Schema 参数 + 执行器。 */
export interface RuntimeTool {
  description: string
  args: JSONSchema
  execute(args: Record<string, unknown>, ctx: RuntimeToolContext): Promise<RuntimeToolResult | string>
}

/** 工具注册表：工具名 → 定义。 */
export type ToolRegistry = Record<string, RuntimeTool>

/** 运行时配置注入：agent/skill 注入指令与可选 dashboard 配置。 */
export interface IRuntimeConfig {
  /** 分发的 agent 定义根目录（各适配器按自身注入格式消费）。 */
  agentsDir?: string
  /** 分发的 skill 根目录列表（各适配器按自身发现机制注册）。 */
  skillsDirs?: string[]
  /** 可选编排进度看板。 */
  dashboard?: { port?: number; hostname?: string }
}

/**
 * agent 无关运行时提供者：各 agent 适配层实现该接口接入编排内核。
 * - tools：注册 6 个 opx_* 工具（参数为纯 JSON Schema）
 * - initialize：适配器会话初始化（如非 OpenCode agent 默认开启无人值守）
 * - ask：用户交互回调（无人值守/环境不支持时返回 null，调用方自行裁决）
 * - injectAgents / injectSkills：按各 agent 原生机制注入 agent 定义与 skill 路径
 */
export interface IRuntimeProvider {
  readonly id: string
  readonly tools: ToolRegistry
  readonly config?: IRuntimeConfig
  initialize?(input: unknown): Promise<void> | void
  ask?(message: string): Promise<string | null>
  injectAgents?(target: unknown): void
  injectSkills?(target: unknown): void
}
