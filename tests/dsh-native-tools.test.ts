/**
 * DSH 原生工具插件测试：
 * - 工具注册（6 个 opx_* 工具、参数 schema 投影、输出为 markdown 文本）
 * - 参数校验（DSH schema DSL 投影的必填/enum/嵌套对象/数组语义）
 * - 会话目录解析（取 exec.agent.session.header.cwd；agent 调用缺失即报错不降级，非 agent 调用回落进程 cwd）
 * - 调用者身份路由（_agent 声明 / 缺省编排视角）
 * - cordis 插件加载契约（Config 为 Standard Schema、inject 声明 tools、apply 注册、命名导出形态）
 */
import { describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  buildNativeToolDefinitions,
  buildNativeToolExecutes,
  resolveToolContext,
  AGENT_ARG,
  OPX_TOOL_NAMES,
  type DshToolExec,
} from "../src/adapters/deepseek-harness/native-tools"
import { jsonSchemaToToolParameters } from "../src/adapters/deepseek-harness/schema-dsl"
import { statusSchema, agentSubmitSchema, orchInitSchema } from "../src/core/tools/schemas"
import { getStatePath } from "../src/core/state"

/**
 * `@deepseek-ai/dsh-tools` 在测试环境不可解析（由 DSH 安装目录在运行时提供，本项目不安装），
 * 以 identity 形态替换 defineTool：本组测试断言的是「交给 DSH 工具注册表的定义形状」，
 * defineTool 自身的归一化由真实 DSH 运行时验证。
 * schemastery 保持真实库（devDependency，版本与 DSH 运行时一致）——Config 的 Standard Schema
 * 契约只有用真实实现校验才有意义。
 */
mock.module("@deepseek-ai/dsh-tools", () => ({
  defineTool: (options: Record<string, unknown>) => options,
}))

/** 插件模块按需加载：必须在 mock.module 注册之后，故不在文件顶部静态 import。 */
let pluginModule: Promise<typeof import("../src/adapters/deepseek-harness/plugin")> | undefined
function loadPlugin() {
  return (pluginModule ??= import("../src/adapters/deepseek-harness/plugin"))
}

/** 构造一份最小 DSH 执行上下文（只有工具实际读取的字段）。 */
function makeExec(opts: { cwd?: string; origin?: string; aborted?: boolean } = {}): DshToolExec {
  const controller = new AbortController()
  if (opts.aborted) controller.abort()
  return {
    signal: controller.signal,
    agent: {
      id: "session-1",
      session: {
        id: "session-1",
        header: {
          id: "session-1",
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        },
      },
    },
  } as DshToolExec
}

/** 取某个工具的参数投影。 */
function paramsOf(definitions: ReturnType<typeof buildNativeToolDefinitions>, name: string) {
  const def = definitions.find((d) => d.name === name)
  if (!def) throw new Error(`未注册工具 ${name}`)
  return def.parameters
}

describe("DSH 原生工具插件 · 工具注册", () => {
  test("注册 6 个 opx_* 工具，名称与内核规格表一致", () => {
    const definitions = buildNativeToolDefinitions(false, "/tmp")
    expect(definitions.map((d) => d.name)).toEqual([...OPX_TOOL_NAMES])
    expect(definitions).toHaveLength(6)
    // 原生工具名不带 mcp__ 前缀
    for (const def of definitions) expect(def.name.startsWith("opx_")).toBe(true)
    // 描述非空（模型据此选工具）
    for (const def of definitions) expect(def.description.length).toBeGreaterThan(10)
  })

  test("每个工具附加 _agent 身份参数（子代理显式声明角色名）", () => {
    const definitions = buildNativeToolDefinitions(false, "/tmp")
    for (const def of definitions) {
      expect(def.parameters[AGENT_ARG]).toBeDefined()
      expect(def.parameters[AGENT_ARG]!.type).toBe("string")
      // 身份参数是可选的（缺省=编排主代理视角）
      expect(def.parameters[AGENT_ARG]!.required).toBeUndefined()
    }
  })

  test("输出声明为 markdown 文本（render 产出 text 内容块）", () => {
    const definitions = buildNativeToolDefinitions(false, "/tmp")
    for (const def of definitions) {
      expect(def.output.schema).toEqual({ type: "string" })
      expect(def.output.render({}, "# 标题")).toEqual([{ type: "text", text: "# 标题" }])
    }
  })
})

describe("DSH 原生工具插件 · 参数 schema 投影", () => {
  test("必填项投影为属性上的 required: true（DSH DSL 而非 JSON Schema 的 required 数组）", () => {
    const params = jsonSchemaToToolParameters(statusSchema)
    expect(params.change_id).toBeDefined()
    expect(params.change_id!.type).toBe("string")
    expect(params.change_id!.required).toBe(true)
  })

  test("可选参数不带 required 标记", () => {
    const params = jsonSchemaToToolParameters(statusSchema)
    expect(params[AGENT_ARG]?.required).toBeUndefined()
  })

  test("enum 取值原样投影到 DSH DSL", () => {
    const params = jsonSchemaToToolParameters(agentSubmitSchema)
    expect(params.verdict!.enum).toEqual(["passed", "failed"])
    expect(params.checkpoint_decision!.enum).toEqual(["continue", "giveup"])
  })

  test("嵌套对象投影为 object + properties + additionalProperties:false", () => {
    const params = jsonSchemaToToolParameters(agentSubmitSchema)
    const boundary = params.execution_boundary
    expect(boundary!.type).toBe("object")
    expect(boundary!.additionalProperties).toBe(false)
    expect(boundary!.properties!.allowed_directories!.type).toBe("array")
    // 内核 required 数组 → DSH 属性上的 required: true
    expect(boundary!.properties!.notes!.required).toBe(true)
    expect(boundary!.properties!.allowed_directories!.required).toBe(true)
  })

  test("数组投影保留 items", () => {
    const params = jsonSchemaToToolParameters(agentSubmitSchema)
    expect(params.new_children!.type).toBe("array")
    const item = params.new_children!.items!
    expect(item!.type).toBe("object")
    expect(item!.properties!.severity!.enum).toContain("Critical")
  })

  test("DSH 不支持的约束（minLength/minItems）降级为描述文本而非丢弃", () => {
    const params = jsonSchemaToToolParameters(statusSchema)
    expect(params.change_id!.description).toContain("minLength=1")
    const boundary = jsonSchemaToToolParameters(agentSubmitSchema).execution_boundary
    expect(boundary!.properties!.allowed_directories!.description).toContain("minItems=1")
  })

  test("参数投影复用内核 schema：改内核定义即改原生工具参数（单一事实源）", () => {
    // orchInitSchema 同时被原生工具与 MCP server 消费；此处断言投影结果与内核定义一致
    const params = jsonSchemaToToolParameters(orchInitSchema)
    expect(Object.keys(params)).toEqual([...Object.keys(orchInitSchema.properties!)])
    // orchInit 的入口字段是「二选一」（change 会话 或 独立审查会话），内核不设 required，
    // 由运行时互斥校验兜底；投影不得凭空把它们标成必填。
    const coreRequired = new Set(orchInitSchema.required ?? [])
    for (const key of Object.keys(params)) {
      if (key === AGENT_ARG) continue
      expect(Boolean(params[key]!.required)).toBe(coreRequired.has(key))
    }
    expect(params.mode!.enum).toEqual(["full", "simple"])
  })
})

describe("DSH 原生工具插件 · 会话目录解析", () => {
  test("取 exec.agent.session.header.cwd 作为 worktree（多项目下各自作用于各自项目）", () => {
    const ctx = resolveToolContext(makeExec({ cwd: "/Users/me/projA" }), {}, { processCwd: "/profiles/desktop" })
    expect(ctx.worktree).toBe("/Users/me/projA")
  })

  test("会话目录缺失时明确报错，不静默降级到进程 cwd（进程 cwd 是 DSH profile 目录）", () => {
    expect(() => resolveToolContext(makeExec({}), {}, { processCwd: "/profiles/desktop" })).toThrow(/项目目录/)
  })

  test("会话目录为空串同样报错", () => {
    expect(() => resolveToolContext(makeExec({ cwd: "" }), {}, { processCwd: "/profiles/desktop" })).toThrow(/项目目录/)
  })

  test("报错文案点明被拒绝的原因，不把进程 cwd 当作可用项目目录", () => {
    let message = ""
    try {
      resolveToolContext(makeExec({}), {}, { processCwd: "/profiles/desktop" })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("agent.session.header.cwd")
    // 文案必须点明「继续执行会把状态写进错误目录」并明确拒绝，调用方不可能误以为已经作用于项目
    expect(message).toContain("错误目录")
    expect(message).toContain("拒绝")
  })

  test("无 agent 上下文（非 agent 调用）时回落进程 cwd（与官方 dsh-tool-fs 兜底同口径）", () => {
    const ctx = resolveToolContext({ signal: new AbortController().signal }, {}, { processCwd: "/profiles/desktop" })
    expect(ctx.worktree).toBe("/profiles/desktop")
  })

  test("两个不同会话目录各自解析，互不串味", () => {
    const a = resolveToolContext(makeExec({ cwd: "/Users/me/projA" }), {}, { processCwd: "/p" })
    const b = resolveToolContext(makeExec({ cwd: "/Users/me/projB" }), {}, { processCwd: "/p" })
    expect(a.worktree).toBe("/Users/me/projA")
    expect(b.worktree).toBe("/Users/me/projB")
  })
})

describe("DSH 原生工具插件 · 调用者身份路由", () => {
  test("声明 _agent 时按声明值路由（非编排视角）", () => {
    const ctx = resolveToolContext(makeExec({ cwd: "/p" }), { [AGENT_ARG]: "openspec-developer" }, { processCwd: "/p" })
    expect(ctx.agent).toBe("openspec-developer")
    expect(ctx.orchestrator).toBe(false)
    expect(ctx.identityDeclared).toBe(true)
  })

  test("未声明 _agent 时按编排主代理视角路由（与 MCP 侧缺省口径一致）", () => {
    const ctx = resolveToolContext(makeExec({ cwd: "/p" }), {}, { processCwd: "/p" })
    expect(ctx.agent).toBe("primary")
    expect(ctx.orchestrator).toBe(true)
    expect(ctx.identityDeclared).toBe(false)
  })

  test("_agent 为空串视为未声明", () => {
    const ctx = resolveToolContext(makeExec({ cwd: "/p" }), { [AGENT_ARG]: "" }, { processCwd: "/p" })
    expect(ctx.orchestrator).toBe(true)
    expect(ctx.identityDeclared).toBe(false)
  })
})

describe("DSH 原生工具插件 · execute 包装", () => {
  test("会话目录缺失的调用直接失败，不静默作用于进程 cwd", async () => {
    const executes = buildNativeToolExecutes(false, "/tmp")
    await expect(
      executes.opx_status!({ change_id: "__nope__" }, makeExec({})),
    ).rejects.toThrow(/项目目录/)
  })

  test("已取消的调用不进入内核（协作式取消，DSH 同语义）", async () => {
    const executes = buildNativeToolExecutes(false, "/tmp")
    await expect(
      executes.opx_status!({ change_id: "__nope__" }, makeExec({ cwd: "/tmp", aborted: true })),
    ).rejects.toThrow()
  })

  test("私有身份参数 _agent 不进入内核参数（子进程探针，内核替身只在子进程内注册）", () => {
    const probe = spawnSync("bun", [join(import.meta.dir, "fixtures", "dsh-native-kernel-args-probe.ts")], {
      encoding: "utf-8",
    })
    expect(probe.status, probe.stderr).toBe(0)
    const calls = JSON.parse(probe.stdout.trim()) as {
      tool: string
      args: Record<string, unknown>
      agent: string
      worktree: string
    }[]

    expect(calls.map((c) => c.tool)).toEqual([
      "opx_orch_init", "opx_orch_set_worktree", "opx_agent_submit", "opx_status",
    ])
    // 内核参数里不得出现 _agent（内核校验的是纯业务 schema）
    for (const call of calls) expect(Object.keys(call.args)).not.toContain(AGENT_ARG)
    // 剔除 ≠ 丢弃：身份与项目目录都已解析进调用上下文，内核收到的是干净的业务参数
    expect(calls[0]!.args).toEqual({ change_id: "chg", task_group_id: "tg" })
    expect(calls[0]!.agent).toBe("openspec-developer")
    expect(calls[0]!.worktree).toBe("/Users/me/projA")
    expect(calls[1]!.args).toEqual({ change_id: "chg", worktree_path: "/w" })
    expect(calls[2]!.args).toEqual({ change_id: "chg", verdict: "passed" })
    expect(calls[3]!.args).toEqual({ change_id: "chg" })
  })

  test("会话目录决定状态查询落点：A 目录有状态、B 目录没有，两者互不干扰", async () => {
    const executes = buildNativeToolExecutes(false, "/tmp")
    const dirA = mkdtempSync(join(tmpdir(), "opx-session-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "opx-session-b-"))
    try {
      // A 目录落一份该 change 的状态：workItems 不含活跃任务组 → 命中「目录里读到了状态，但会话未就绪」
      const stateFile = getStatePath(dirA, "chg")
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify({ changeId: "chg", taskGroupId: "tg", workItems: [{ id: "task:other" }] }))

      const a = await executes.opx_status!({ change_id: "chg" }, makeExec({ cwd: dirA }))
      const b = await executes.opx_status!({ change_id: "chg" }, makeExec({ cwd: dirB }))

      // 两者的返回体不同：证明查询各自落在自己的会话目录，而不是都落到进程 cwd
      expect(a).toContain("找不到活跃任务组")
      expect(b).toContain("尚未初始化")
      expect(a).not.toBe(b)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})

/**
 * cordis 插件加载契约：这组断言覆盖「插件能否被 DSH 加载」这条路径。
 * 此前测试只 import 纯函数、从不加载 plugin.ts，导致 Config 声明错误与缺 inject 两个
 * 「插件加载即崩」的缺陷在 995 个用例全绿的情况下漏网。
 */
describe("DSH 原生工具插件 · cordis 加载契约", () => {
  test("导出形态为官方命名导出（Config/apply/inject/name），无 default 兜底歧义", async () => {
    const plugin = await loadPlugin()
    for (const key of ["Config", "apply", "inject", "name"] as const) {
      expect(plugin[key]).toBeDefined()
    }
    expect(plugin.name).toBe("openspec-opx-tools")
    expect(typeof plugin.apply).toBe("function")
    expect((plugin as { default?: unknown }).default).toBeUndefined()
  })

  test("Config 是 Standard Schema：validate({}) 返回默认值 unattended=true（防普通对象 Config 回归）", async () => {
    const { Config } = await loadPlugin()
    // cordis 直接取 Config["~standard"].validate（cordis/lib/index.js:956-962）；
    // 普通对象此处即为 undefined → 加载期 TypeError: ... reading 'validate'
    const standard = (Config as unknown as { "~standard"?: { version: number; validate: (v: unknown) => any } })["~standard"]
    expect(standard).toBeDefined()
    expect(standard!.version).toBe(1)

    const defaulted = standard!.validate({})
    expect(defaulted.issues).toBeUndefined()
    expect(defaulted.value).toEqual({ unattended: true })

    // 显式取值原样通过校验（默认值不覆盖用户显式配置）
    const explicit = standard!.validate({ unattended: false })
    expect(explicit.issues).toBeUndefined()
    expect(explicit.value).toEqual({ unattended: false })
  })

  test("导出 inject 且含 tools（防未声明 inject 导致访问 ctx.tools 抛错）", async () => {
    const { inject } = await loadPlugin()
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toContain("tools")
  })

  test("apply() 注册 6 个原生工具，注册定义含 name/description/parameters/execute", async () => {
    const { apply } = await loadPlugin()
    const registered: any[] = []
    const ctx = { tools: { register: (def: any) => { registered.push(def); return def } } }

    apply(ctx, { unattended: false })

    expect(registered).toHaveLength(6)
    expect(registered.map((def) => def.name)).toEqual([...OPX_TOOL_NAMES])
    for (const def of registered) {
      expect(typeof def.name).toBe("string")
      expect(typeof def.description).toBe("string")
      expect(def.description.length).toBeGreaterThan(10)
      expect(def.parameters).toBeDefined()
      expect(def.parameters[AGENT_ARG]).toBeDefined()
      expect(def.output).toBeDefined()
      expect(typeof def.execute).toBe("function")
    }
  })

  test("按 cordis 的加载路径（Config 校验 → inject 守卫 ctx → apply）可跑通", async () => {
    const plugin = await loadPlugin()
    // ① cordis resolveConfig：Config["~standard"].validate(config)
    const validated = (plugin.Config as unknown as {
      "~standard": { validate: (v: unknown) => { value?: { unattended: boolean }; issues?: unknown } }
    })["~standard"].validate({ unattended: true })
    expect(validated.issues).toBeUndefined()

    // ② cordis fiber 的 inject 守卫：未声明 inject 的属性访问即抛错（真实 DSH 语义）
    const registered: any[] = []
    const services: Record<string, unknown> = { tools: { register: (def: any) => registered.push(def) } }
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_target, prop: string) => {
        if (!plugin.inject.includes(prop)) throw new Error(`cannot get property "${prop}" without inject`)
        return services[prop]
      },
    })

    plugin.apply(ctx, validated.value ?? {})

    expect(registered).toHaveLength(6)
  })
})