import { readDashboardState } from "../../core/dashboard.js"
import { getDashboardPage } from "../../dashboard/page.js"

const BASE_PORT = 4519
const MAX_ATTEMPTS = 20

const servers = new Map<string, ReturnType<typeof Bun.serve>>()

export function startDashboard(worktree: string): void {
  if (servers.has(worktree)) return

  const pageHtml = getDashboardPage()

  for (let port = BASE_PORT; port < BASE_PORT + MAX_ATTEMPTS; port++) {
    try {
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        async fetch(req: Request): Promise<Response> {
          const url = new URL(req.url)

          if (url.pathname === "/api/state") {
            try {
              const data = await readDashboardState(worktree)
              return new Response(JSON.stringify(data ?? { active: false }), {
                headers: { "content-type": "application/json;charset=utf-8" },
              })
            } catch (err) {
              return new Response(
                JSON.stringify({ active: false, error: String(err) }),
                {
                  status: 500,
                  headers: { "content-type": "application/json;charset=utf-8" },
                }
              )
            }
          }

          return new Response(pageHtml, {
            headers: { "content-type": "text/html;charset=utf-8" },
          })
        },
        error(err: Error) {
          console.error("[dashboard]", err.message)
        },
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
