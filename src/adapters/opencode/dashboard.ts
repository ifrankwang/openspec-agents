import { createServer } from "node:http"
import type { Server } from "node:http"
import { readDashboardState } from "../../core/dashboard.ts"
import { getDashboardPage } from "../../dashboard/page.ts"

const BASE_PORT = 4519
const MAX_ATTEMPTS = 20

const servers = new Map<string, Server>()

export async function startDashboard(worktree: string): Promise<void> {
  if (servers.has(worktree)) return

  const pageHtml = getDashboardPage()

  // 端口占用自动递增：EADDRINUSE 走 server error 事件（异步），经 once("error") + await listen
  // 判定重试；其余启动期错误仅记录不中断。修复前 try/catch 同步捕获永不触发，换端口失效。
  for (let port = BASE_PORT; port < BASE_PORT + MAX_ATTEMPTS; port++) {
    try {
      const server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
          if (url.pathname === "/api/state") {
            try {
              const data = await readDashboardState(worktree)
              res.writeHead(200, { "content-type": "application/json;charset=utf-8" })
              res.end(JSON.stringify(data ?? { active: false }))
            } catch (err) {
              res.writeHead(500, { "content-type": "application/json;charset=utf-8" })
              res.end(JSON.stringify({ active: false, error: String(err) }))
            }
            return
          }
          res.writeHead(200, { "content-type": "text/html;charset=utf-8" })
          res.end(pageHtml)
        } catch (err) {
          console.error("[dashboard]", (err as Error).message)
          res.writeHead(500, { "content-type": "text/plain;charset=utf-8" })
          res.end("internal error")
        }
      })
      await new Promise<void>((resolve, reject) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            reject(err)
          } else {
            console.error("[dashboard]", err.message)
            resolve()
          }
        })
        server.listen(port, "127.0.0.1", () => resolve())
      })
      servers.set(worktree, server)
      console.log(`[dashboard] 编排进度看板 http://127.0.0.1:${port}`)
      return
    } catch {
      continue
    }
  }

  console.error(
    `[dashboard] 无法启动编排进度看板：端口 ${BASE_PORT}-${BASE_PORT + MAX_ATTEMPTS - 1} 均被占用`
  )
}
