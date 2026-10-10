/**
 * DSH 运行时包的类型声明（ambient）。
 *
 * `@deepseek-ai/*` 由 DSH 安装目录在运行时提供（DSH 进程自身解析 node_modules），本项目
 * 不把它们作为运行期/打包依赖——原生工具插件 bundle 把它们标记为 external，打包后仍从 DSH 进程解析。
 * 例外：`@deepseek-ai/schemastery` 另以 devDependency 固定为 DSH 运行时同版本，供插件测试用
 * 真实 Standard Schema 实现校验 Config；它同样不参与打包（仅在测试进程内解析）。
 * 此处只按官方公开的类型形状声明本地所需的最小子集，使 typecheck 可在无 DSH 安装的环境通过。
 *
 * 本文件不写任何顶层 export/import（保持为全局脚本文件），否则其中的 `declare module`
 * 会被 TypeScript 当作模块增强而非 ambient 声明。
 *
 * 形状依据（DSH 0.2.0-rc.2 源码）：
 * - defineTool 与 schema DSL：dsh-tools/lib/types/schema.js:274
 * - ctx.tools.register：dsh-tools/README.zh.md:41-57
 * - exec 上下文字段：dsh-tools/lib/types/index.js:790-802（token/callId/rootCallId/name/signal/
 *   agent/parent/schema/arguments）
 * - Agent：dsh-agent 的 Agent 接口声明（id/options/session/inbox/status/ctx）
 * - SessionHeader：dsh-session 的 SessionHeader 声明（id/cwd/parentSession/origin/agentPreset/...）
 * - schemastery 的 Standard Schema 接口：schemastery/src/index.ts:154、290（`~standard` getter）
 */

declare module "@deepseek-ai/schemastery" {
  /** Standard Schema 的校验问题项（失败时返回）。 */
  export interface SchemaIssue {
    readonly message: string
    readonly path?: readonly unknown[]
  }

  /** Standard Schema v1 的校验结果：成功带 value，失败带 issues。 */
  export interface SchemaResult<T = any> {
    readonly value?: T
    readonly issues?: readonly SchemaIssue[]
  }

  /**
   * schemastery schema 节点。本项目只消费两处：
   * - `~standard`：cordis 校验插件 Config 的唯一入口（cordis/lib/index.js:956-962 取
   *   `Config["~standard"].validate`，故 Config 必须是本类型而非普通对象）；
   * - 链式约束 `default`：给未提供的配置项注入默认值。
   */
  export interface Schema<T = any> {
    readonly "~standard": {
      readonly version: 1
      readonly vendor: "schemastery"
      validate(value: unknown): SchemaResult<T>
    }
    default(value: T): Schema<T>
    required(): Schema<T>
    description(text: string): Schema<T>
  }

  /**
   * 根导出即 schemastery 的 `Schema` 本身（可调用/可 new，带 schema 工厂静态方法）。
   * 这里以工厂对象表达本项目用到的最小集合。
   */
  export const Schema: {
    object<T extends Record<string, any> = Record<string, any>>(dict: { [K in keyof T]: Schema<T[K]> }): Schema<T>
    boolean(): Schema<boolean>
    number(): Schema<number>
    string(): Schema<string>
    array<T>(inner: Schema<T>): Schema<T[]>
    dict<T>(inner: Schema<T>): Schema<Record<string, T>>
    any<T = any>(): Schema<T>
    const<T>(value: T): Schema<T>
  }
  export default Schema
}

declare module "@deepseek-ai/dsh-tools" {
  /** DSH 会话头（dsh-session 的 SessionHeader）。 */
  export interface DshSessionHeader {
    readonly id: string
    readonly cwd?: string
    readonly parentSession?: string
    readonly origin?: "subagent"
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }

  export interface DshSession {
    readonly id: string
    readonly header: DshSessionHeader
  }

  /** DSH 运行时 Agent（本项目只读 id 与 session）。 */
  export interface DshAgent {
    readonly id: string
    readonly session: DshSession
  }

  /**
   * 工具执行上下文。本项目只消费 `signal` 与 `agent` 两处：
   * - agent.session.header.cwd 是会话项目目录的唯一来源（原生工具解析 worktree 的依据）。
   * - signal 是协作式取消信号。
   */
  export interface ToolExecution {
    token: symbol
    callId: string
    rootCallId?: string
    name: string
    signal: AbortSignal
    agent?: DshAgent
    parent?: DshAgent
    arguments?: unknown
  }

  /** DSH 工具内容块（模型可见的返回体）。 */
  export interface ToolContentBlock {
    type: "text"
    text: string
  }

  /**
   * DSH 统一 schema DSL 的 value schema / 参数 schema 根。
   * 官方按「未知 key 即作者错误」的封闭词汇编译，这里以开放索引签名表达，
   * 使本项目投影出的强类型 value schema 可直接赋值。
   */
  export interface ValueSchemaSpec {
    [key: string]: unknown
  }
  export type ParameterSchemaSpec = Record<string, ValueSchemaSpec>

  export interface ToolOutput<Args = any> {
    schema: ValueSchemaSpec
    render: (args: Args, value: any) => ToolContentBlock[]
  }

  export interface ToolDefinition<Args = any> {
    name: string
    description: string
    parameters: ParameterSchemaSpec
    output: ToolOutput<Args>
    execute(args: Args, exec: ToolExecution): unknown
  }

  export function defineTool<Args = any>(options: {
    name: string
    description: string
    parameters: ParameterSchemaSpec
    output: ToolOutput<Args>
    execute(args: Args, exec: ToolExecution): unknown
    timeoutMs?: number
    deferLoading?: boolean
    presentCall?: (args: Args) => unknown
    presentResult?: (args: Args, result: unknown) => unknown
    isConcurrencySafe?: (args: Args) => boolean
  }): ToolDefinition<Args>

  /** 工具注册表服务（本项目只用 register）。 */
  export interface ToolRegistry {
    register(definition: ToolDefinition): unknown
  }
}

declare module "@deepseek-ai/cordis" {
  /** 本项目插件只用到 ctx.tools；其余 cordis 服务不消费。 */
  export interface Context {
    tools: import("@deepseek-ai/dsh-tools").ToolRegistry
    [key: string]: any
  }
}