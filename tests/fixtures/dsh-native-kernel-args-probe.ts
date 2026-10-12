/**
 * 子进程探针（由 tests/dsh-native-tools.test.ts 断言，不单独作为测试运行）：
 * 在独立进程里给内核模块装替身，观察 buildNativeToolExecutes 的包装器究竟把什么交给了内核。
 *
 * 为什么必须独立进程：bun 的 mock.module 在进程内全局生效，在测试文件里注册会泄漏到同一进程的
 * 其它测试文件（实测后续加载的 native-tools 也会拿到替身），故把探针放进独立进程运行。
 * stdout 只输出一行 JSON 数组：[{ tool, args, agent, worktree }]。
 */
import { mock } from "bun:test"
import { deepFreeze } from "../helpers"

interface ProbeCall {
  tool: string
  args: Record<string, unknown>
  agent: string
  worktree: string
  /** 内核收到的入参本身是否只读（调用方那份是深冻结的，内核必须拿到可写副本） */
  argsFrozen: boolean
  /** 入参里首个嵌套对象的冻结状态（null=本次调用无嵌套对象）：浅拷贝下仍为 true，深拷贝才是 false */
  firstNestedFrozen: boolean | null
}

const calls: ProbeCall[] = []

/** 内核替身：记录收到的参数与调用上下文。 */
function record(tool: string) {
  return async (args: Record<string, unknown>, ctx: { agent: string; worktree: string }): Promise<string> => {
    const nested = (args.exempt_adjudications as unknown[] | undefined)?.[0]
    calls.push({
      tool,
      args,
      agent: ctx.agent,
      worktree: ctx.worktree,
      argsFrozen: Object.isFrozen(args),
      firstNestedFrozen: nested === undefined ? null : Object.isFrozen(nested),
    })
    return `# ${tool}`
  }
}

mock.module("../../src/core/tools/lifecycle", () => ({
  initExecute: record("opx_orch_init"),
  setWorktreeExecute: record("opx_orch_set_worktree"),
  statusExecute: record("opx_status"),
  completeTaskGroupExecute: record("opx_orch_complete_task_group"),
  setUnattendedExecute: record("opx_orch_set_unattended"),
}))
mock.module("../../src/core/tools/submit", () => ({
  agentSubmitExecute: record("opx_agent_submit"),
}))

const { buildNativeToolExecutes, AGENT_ARG } = await import("../../src/adapters/deepseek-harness/native-tools")

/** 只有本插件实际读取字段的执行上下文。 */
function makeExec(cwd: string) {
  return {
    signal: new AbortController().signal,
    agent: { id: "s1", session: { id: "s1", header: { id: "s1", cwd } } },
  } as never
}

const executes = buildNativeToolExecutes(false, "/tmp")

await executes.opx_orch_init!(
  { change_id: "chg", task_group_id: "tg", [AGENT_ARG]: "openspec-developer" },
  makeExec("/Users/me/projA"),
)
await executes.opx_orch_set_worktree!(
  { change_id: "chg", worktree_path: "/w", [AGENT_ARG]: "openspec-reviewer-tool" },
  makeExec("/p"),
)
await executes.opx_agent_submit!(
  // 入参按 DSH 语义整份深冻结：适配层必须交出可写副本，且嵌套对象也要可写
  deepFreeze({
    change_id: "chg",
    verdict: "passed",
    exempt_adjudications: [{ issue_id: "#7" }],
    [AGENT_ARG]: "openspec-reviewer-tool",
  }),
  makeExec("/p"),
)
await executes.opx_status!({ change_id: "chg", [AGENT_ARG]: "openspec-developer" }, makeExec("/p"))

process.stdout.write(JSON.stringify(calls))
