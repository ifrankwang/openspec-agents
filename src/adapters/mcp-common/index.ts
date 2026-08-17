/**
 * MCP Server 启动入口：HTTP transport（node:http）承载 6 个 opx_* 工具，
 * 并承载 dashboard/collector/poller 副作用（原 OpenCode 插件壳职责迁移至此）。
 * 非 OpenCode agent（claude code / codex / zcode）经 MCP client 接入同一套编排状态机。
 */
import { createServer, type Server } from "node:http"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { buildMcpServer } from "./server.ts"
import { startDashboard } from "../opencode/dashboard.ts"
import { OpenSpecCollector, AdoCollector, registerCollector, startPolling } from "../../core/workflow/index.ts"
import { readContextFromWorktree } from "../../core/state.ts"

export interface McpServerOptions {
  worktree: string
  port?: number
  hostname?: string
  /** 默认无人值守（非 OpenCode agent 默认开启，spec: unattended-default）。 */
  unattended?: boolean
}

export const DEFAULT_PORT = 4525
const MAX_PORT_ATTEMPTS = 20

/** 启动 dashboard/collector/poller 副作用（原插件壳职责，单一宿主 = MCP server 进程）。 */
function startSideEffects(worktree: string): void {
  try {
    void startDashboard(worktree)
    // 注册内置收集器（OpenSpec + ADO 占位）并启动定时拉取；worktree 为动态上下文在此注入。
    registerCollector(new OpenSpecCollector({ openspecDir: join(worktree, "openspec") }))
    registerCollector(new AdoCollector())
    // 仅已初始化（存在 context.json 上下文指针）的 worktree 启动轮询
    void readContextFromWorktree(worktree).then((ctx) => {
      if (ctx?.changeId && ctx?.taskGroupId) {
        startPolling(worktree)
      }
    })
  } catch {
    // dashboard/调度启动失败不影响编排功能
  }
}

/**
 * 启动 MCP server（Streamable HTTP）。会话管理：mcp-session-id 关联 transport（官方推荐模式）。
 * unattended=true 时默认开启无人值守（非 OpenCode agent 适配器分发）。
 * 返回实际绑定端口（server.address().port，port 为 0 或端口被占用换绑时以返回值为准）。
 */
export async function startMcpServer(opts: McpServerOptions): Promise<{ server: Server; port: number }> {
  const mcp = buildMcpServer(opts.worktree, { unattended: opts.unattended })
  startSideEffects(opts.worktree)

  const port = opts.port ?? DEFAULT_PORT
  const hostname = opts.hostname ?? "127.0.0.1"
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? hostname}`)
    if (url.pathname === "/mcp") {
      const sessionId = Array.isArray(req.headers["mcp-session-id"])
        ? req.headers["mcp-session-id"][0]
        : req.headers["mcp-session-id"]
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined
      if (!transport) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
        try {
          await mcp.connect(transport)
        } catch (err) {
          res.writeHead(500, { "content-type": "text/plain;charset=utf-8" })
          res.end(`MCP transport connect 失败：${(err as Error).message}`)
          return
        }
      }
      await transport.handleRequest(req, res)
      // session id 在首次 handleRequest 时才生成：生成后注册映射，后续请求复用同一 transport
      if (transport.sessionId && !transports.has(transport.sessionId)) {
        transports.set(transport.sessionId, transport)
        transport.onclose = () => {
          transports.delete(transport.sessionId ?? "")
        }
      }
      return
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json;charset=utf-8" })
      res.end(JSON.stringify({ name: "openspec-agents", status: "ok" }))
      return
    }
    res.writeHead(405, { "content-type": "text/plain;charset=utf-8" })
    res.end("Method Not Allowed")
  })

  let started = false
  for (let p = port; p < port + MAX_PORT_ATTEMPTS; p++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            reject(err)
          } else {
            console.error("[mcp]", err.message)
            resolve()
          }
        })
        server.listen(p, hostname, () => resolve())
      })
      started = true
      console.log(`[mcp] openspec-agents MCP server http://${hostname}:${p}/mcp（worktree: ${opts.worktree}）`)
      break
    } catch {
      continue
    }
  }
  if (!started) {
    throw new Error(`无法启动 MCP server：端口 ${port}-${port + MAX_PORT_ATTEMPTS - 1} 均被占用`)
  }
  const addr = server.address()
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : 0
  return { server, port: actualPort }
}

/** 命令行入口：node dist/... --worktree <path> [--port <n>] */
export function runCli(argv: string[]): void {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : ""
      args.set(key, val)
      if (val !== "") i++
    }
  }
  const worktree = args.get("worktree") ?? process.cwd()
  const port = args.get("port") ? Number(args.get("port")) : DEFAULT_PORT
  const unattended = args.has("unattended")
  startMcpServer({ worktree, port, unattended })
}
