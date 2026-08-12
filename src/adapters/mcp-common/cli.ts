/**
 * MCP server 可执行入口（CLI）：
 * - --worktree <path> 主仓库根（默认 process.cwd()）
 * - --port <n> HTTP transport 端口（默认 4525）
 * - --transport http|stdio（默认 http）
 * - --unattended 默认无人值守（claude code / codex / zcode 适配器分发时开启）
 *
 * 运行：node <entry> --transport stdio --worktree . --unattended
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildMcpServer } from "./server.ts"
import { startMcpServer, DEFAULT_PORT } from "./index.ts"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"

interface CliOptions {
  worktree: string
  port: number
  transport: "http" | "stdio"
  unattended: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : ""
      if (val !== "") {
        args.set(key, val)
        i++
      } else {
        flags.add(key)
      }
    }
  }
  const transport = args.get("transport") === "stdio" ? "stdio" : "http"
  return {
    worktree: args.get("worktree") ?? process.cwd(),
    port: args.get("port") ? Number(args.get("port")) : DEFAULT_PORT,
    transport,
    unattended: flags.has("unattended"),
  }
}

export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv)
  if (opts.transport === "stdio") {
    const mcp = buildMcpServer(opts.worktree, { unattended: opts.unattended })
    await mcp.connect(new StdioServerTransport())
    return
  }
  startMcpServer(opts)
}

// 直接执行判定：realpath 归一化（macOS /tmp 与 /private/tmp 符号链接场景）
try {
  if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? "")) {
    void main(process.argv.slice(2))
  }
} catch {
  // 路径不可解析时静默跳过入口（作为库导入场景）
}
