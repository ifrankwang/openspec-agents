/**
 * 通用 MCP Server 承载层测试：6 个 opx_* 工具注册、_agent 身份路由、
 * 默认无人值守（unattended-default）、副作用（poller）迁移至 server 进程。
 */
import { afterAll, describe, expect, test, spyOn } from "bun:test"
import { rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { setupWithFakeGit, teardown } from "./helpers"
import { startMcpServer } from "../src/adapters/mcp-common/index"
import * as poller from "../src/core/workflow/poller"

const CID = "mcp-test"

/** 源码形态无 --define 注入，PKG_VERSION 走读 package.json 回退分支——握手版本即验证该分支。 */
const PKG_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")) as { version: string }
).version

const servers: Server[] = []
const clients: Client[] = []

afterAll(async () => {
  for (const c of clients) { try { await c.close() } catch {} }
  for (const s of servers) { try { s.close() } catch {} }
})

async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

describe("MCP server 承载 6 个 opx_* 工具", () => {
  test("注册 6 个工具且参数 schema 为纯 JSON Schema 形态", async () => {
    const root = `/tmp/mcp-server-${Date.now()}`
    const { worktree } = setupWithFakeGit(root, CID)
    try {
      const { server, port } = await startMcpServer({ worktree, port: 0 })
      servers.push(server)
      const client = await connectClient(`http://127.0.0.1:${port}/mcp`)
      expect(client.getServerVersion()?.name).toBe("openspec-agents")
      expect(client.getServerVersion()?.version).toBe(PKG_VERSION)
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain("opx_orch_init")
      expect(names).toContain("opx_orch_set_worktree")
      expect(names).toContain("opx_status")
      expect(names).toContain("opx_orch_complete_task_group")
      expect(names).toContain("opx_orch_set_unattended")
      expect(names).toContain("opx_agent_submit")
      expect(tools.length).toBe(6)
      const initTool = tools.find((t) => t.name === "opx_orch_init")!
      expect(initTool.inputSchema.properties).toBeDefined()
      expect(initTool.inputSchema.properties["change_id"]).toBeDefined()
      expect(initTool.inputSchema.properties["_agent"]).toBeDefined()
    } finally {
      teardown(root)
    }
  })

  test("主代理视角（缺省 _agent）可初始化并拿到编排视图；子代理传 _agent 拿到角色视图", async () => {
    const root = `/tmp/mcp-role-${Date.now()}`
    const { worktree } = setupWithFakeGit(root, CID)
    try {
      const { server, port } = await startMcpServer({ worktree, port: 0 })
      servers.push(server)
      const client = await connectClient(`http://127.0.0.1:${port}/mcp`)

      const initRes = await client.callTool({
        name: "opx_orch_init",
        arguments: { change_id: CID, task_group_id: "1" },
      })
      const initText = (initRes.content as Array<{ text: string }>)[0].text
      expect(initText).toContain("编排会话已初始化")

      // 主代理缺省 _agent → 编排视角视图，且未声明身份时视图给出补传 `_agent` 的身份提示（MCP 首查死锁兜底）
      const orchView = await client.callTool({
        name: "opx_status",
        arguments: { change_id: CID },
      })
      const orchText = (orchView.content as Array<{ text: string }>)[0].text
      expect(orchText).toContain("编排进度")
      expect(orchText).toContain("`_agent` 参数")

      // 子代理身份：_agent 传 reviewer-tool → 路由到 tool 层执行视图（analyze 阶段下为门禁/等待视图）
      const subView = await client.callTool({
        name: "opx_status",
        arguments: { change_id: CID, _agent: "openspec-reviewer-tool" },
      })
      const subText = (subView.content as Array<{ text: string }>)[0].text
      expect(subText).not.toContain("编排进度")
      expect(subText).toContain("阶段门禁")

      // 越权校验仍生效：子代理调用独占工具被拒绝
      const denied = await client.callTool({
        name: "opx_orch_set_worktree",
        arguments: { change_id: CID, _agent: "openspec-reviewer-tool" },
      })
      expect((denied as any).isError).toBe(true)
      expect((denied.content as Array<{ text: string }>)[0].text).toContain("仅限编排者")
    } finally {
      teardown(root)
    }
  })

  test("MCP 子代理携带 _agent 首次查询即可拿到自身角色工作视图；未携带则得到编排视角 + 身份提示", async () => {
    const root = `/tmp/mcp-agent-route-${Date.now()}`
    const { worktree } = setupWithFakeGit(root, CID)
    try {
      const { server, port } = await startMcpServer({ worktree, port: 0 })
      servers.push(server)
      const client = await connectClient(`http://127.0.0.1:${port}/mcp`)

      await client.callTool({
        name: "opx_orch_init",
        arguments: { change_id: CID, task_group_id: "1" },
      })
      await client.callTool({
        name: "opx_orch_set_worktree",
        arguments: { change_id: CID },
      })
      // analyze 由架构师（_agent 传角色名）提交 passed → 推进到 implement 并分派 developer
      const submit = await client.callTool({
        name: "opx_agent_submit",
        arguments: {
          change_id: CID, step_id: "analyze", verdict: "passed",
          execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.example"], notes: "" },
          _agent: "openspec-architect",
        },
      })
      expect((submit as any).isError).toBeUndefined()

      // developer 子代理携带 _agent → 首次查询即拿到自身角色工作视图（非编排视角）
      const devView = await client.callTool({
        name: "opx_status",
        arguments: { change_id: CID, _agent: "openspec-developer" },
      })
      const devText = (devView.content as Array<{ text: string }>)[0].text
      expect(devText).toContain("# ✅ 当前轮到你执行")
      expect(devText).toContain("**阶段**: in_progress | **step**: `implement`")
      expect(devText).not.toContain("编排进度")

      // 物理 reviewer 身份（openspec-reviewer，quality 层）：同样按 _agent 路由到角色视图（非编排视角）
      const rvView = await client.callTool({
        name: "opx_status",
        arguments: { change_id: CID, _agent: "openspec-reviewer" },
      })
      const rvText = (rvView.content as Array<{ text: string }>)[0].text
      expect(rvText).not.toContain("编排进度")
      expect(rvText).toContain("阶段门禁")

      // 未携带 _agent → 编排视角视图 + 补传身份提示
      const orchView = await client.callTool({
        name: "opx_status",
        arguments: { change_id: CID },
      })
      const orchText = (orchView.content as Array<{ text: string }>)[0].text
      expect(orchText).toContain("编排进度")
      expect(orchText).toContain("`_agent` 参数")
    } finally {
      teardown(root)
    }
  })
})

describe("默认无人值守（unattended-default）", () => {
  test("server 带 --unattended 启动：会话初始化后 state.unattended 自动置 true", async () => {
    const root = `/tmp/mcp-unatt-${Date.now()}`
    const { worktree } = setupWithFakeGit(root, CID)
    try {
      const { server, port } = await startMcpServer({ worktree, port: 0, unattended: true })
      servers.push(server)
      const client = await connectClient(`http://127.0.0.1:${port}/mcp`)
      await client.callTool({
        name: "opx_orch_init",
        arguments: { change_id: CID, task_group_id: "1" },
      })
      const state = JSON.parse(
        readFileSync(join(worktree, "openspec", "states", `${CID}.json`), "utf-8")
      ) as { unattended?: boolean }
      expect(state.unattended).toBe(true)
    } finally {
      teardown(root)
    }
  })

  test("server 不带 unattended：不自动开启", async () => {
    const root = `/tmp/mcp-att-${Date.now()}`
    const { worktree } = setupWithFakeGit(root, CID)
    try {
      const { server, port } = await startMcpServer({ worktree, port: 0 })
      servers.push(server)
      const client = await connectClient(`http://127.0.0.1:${port}/mcp`)
      await client.callTool({
        name: "opx_orch_init",
        arguments: { change_id: CID, task_group_id: "1" },
      })
      const state = JSON.parse(
        readFileSync(join(worktree, "openspec", "states", `${CID}.json`), "utf-8")
      ) as { unattended?: boolean }
      expect(state.unattended).toBeUndefined()
    } finally {
      teardown(root)
    }
  })
})

describe("副作用迁移", () => {
  test("MCP server 进程承载 poller（已初始化 worktree 启动轮询）", async () => {
    const root = `/tmp/mcp-poll-${Date.now()}`
    const { worktree } = setupWithFakeGit(root, CID)
    mkdirSync(join(worktree, "openspec", "states"), { recursive: true })
    writeFileSync(
      join(worktree, "openspec", "states", "context.json"),
      JSON.stringify({ changeId: CID, taskGroupId: "1" })
    )
    const spy = spyOn(poller, "startPolling")
    try {
      const { server } = await startMcpServer({ worktree, port: 0 })
      servers.push(server)
      await new Promise((r) => setTimeout(r, 100))
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      teardown(root)
    }
  })
})
