/**
 * 双轨对比测试（tasks 4.6）：同一 change 在 OpenCode 插件壳形态与 MCP 形态下
 * 跑相同工具序列（init → set_worktree → analyze submit → status 只读），
 * 断言两端状态文件一致（归一化动态字段：createdAt/updatedAt/worktree_path）。
 * 两形态共用同一套 core 执行器，状态机行为一致是插件壳兼容过渡的退出条件。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { setupWithFakeGit, teardown, makeOrchCtx, makeCtx } from "./helpers"
import { init, set_worktree, agent_submit, status } from "../src/adapters/opencode/tools"
import { startMcpServer } from "../src/adapters/mcp-common/index"

const CID = "dual-track"

const servers: Server[] = []
const clients: Client[] = []

afterAll(async () => {
  for (const c of clients) { try { await c.close() } catch {} }
  for (const s of servers) { try { s.close() } catch {} }
})

async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "dual-test", version: "0.0.1" })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

/** 归一化动态字段后比较状态文件：两端绝对路径/时间戳不同，语义内容必须一致。 */
function normalizeStateJson(raw: string): string {
  const state = JSON.parse(raw) as any
  delete state.createdAt
  delete state.updatedAt
  for (const w of state.workItems ?? []) {
    if (w.metadata) {
      delete w.metadata["worktree_path"]
    }
  }
  return JSON.stringify(state, null, 2)
}

describe("双轨对比：插件壳 vs MCP 形态状态机行为一致（tasks 4.6）", () => {
  test("同一 change 两端跑 init → set_worktree → analyze passed → status，状态文件一致", async () => {
    const rootPlugin = `/tmp/dual-plugin-${Date.now()}`
    const rootMcp = `/tmp/dual-mcp-${Date.now()}`
    try {
      // ── 插件壳形态：直接调用 tools.execute（与 OpenCode 插件壳同一条执行路径）──
      const { worktree: wtPlugin } = setupWithFakeGit(rootPlugin, CID)
      const orchCtx = makeOrchCtx(wtPlugin)
      const archCtx = makeCtx("openspec-architect", wtPlugin)
      await init.execute({ change_id: CID, task_group_id: "1" }, orchCtx)
      await set_worktree.execute({ change_id: CID }, orchCtx)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "passed",
          execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.example"], notes: "" },
        },
        archCtx
      )
      const pluginStatus = await status.execute({ change_id: CID }, orchCtx)

      // ── MCP 形态：经 HTTP 调同一套工具（子代理调用显式传 _agent；端口 0 由系统分配，取实际绑定端口连）──
      const { worktree: wtMcp } = setupWithFakeGit(rootMcp, CID)
      const { server, port } = await startMcpServer({ worktree: wtMcp, port: 0 })
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
      const mcpSubmit = await client.callTool({
        name: "opx_agent_submit",
        arguments: {
          change_id: CID, step_id: "analyze", verdict: "passed",
          execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.example"], notes: "" },
          _agent: "openspec-architect",
        },
      })
      expect((mcpSubmit as any).isError).toBeUndefined()
      const mcpStatus = await client.callTool({
        name: "opx_status",
        arguments: { change_id: CID },
      })
      const mcpStatusText = (mcpStatus.content as Array<{ text: string }>)[0].text

      // 两形态状态文件语义一致（时间戳/绝对路径归一化后全等）
      const statePlugin = readFileSync(join(wtPlugin, "openspec", "states", `${CID}.json`), "utf-8")
      const stateMcp = readFileSync(join(wtMcp, "openspec", "states", `${CID}.json`), "utf-8")
      expect(normalizeStateJson(statePlugin)).toBe(normalizeStateJson(stateMcp))

      // 两形态视图行为一致：analyze passed 后均推进到 implement 并分派 developer
      expect(pluginStatus).toContain("分派子代理：`openspec-developer`")
      expect(mcpStatusText).toContain("分派子代理：`openspec-developer`")
    } finally {
      teardown(rootPlugin)
      teardown(rootMcp)
    }
  })
})
