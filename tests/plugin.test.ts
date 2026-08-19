import { describe, expect, test, spyOn } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenspecOrchestratePlugin } from "../src/index"
import * as poller from "../src/core/workflow/poller"

const mockInput = {
  directory: "/tmp/test-consumer",
  worktree: "/tmp/test-consumer",
  client: {} as any,
  project: { id: "test", name: "test", type: "local", directory: "/tmp/test-consumer", branch: null, extra: null, projectID: "test" } as any,
  serverUrl: new URL("http://localhost"),
  experimental_workspace: { register() {} } as any,
  $: {} as any,
}

describe("OpenspecOrchestratePlugin", () => {
  test("returns Hooks with config hook only（直载工具注册已移除）", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    expect(hooks).toBeDefined()
    expect(typeof hooks.config).toBe("function")
    // BREAKING（组 5.1）：直载工具注册移除，插件壳不再返回 tool 注册表
    expect(hooks.tool).toBeUndefined()
  })

  test("config hook 注入 MCP server 配置（无直载工具注册）", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const config: Record<string, unknown> = { agent: {} }
    await hooks.config!(config as any)

    // 注入 opencode config 的 mcp 段（官方形态 { mcp: { <name>: { type: "local", command: [...] } } }）
    const mcp = config.mcp as { opx: { type: string; command: string[] } }
    expect(mcp).toBeDefined()
    const entry = mcp["opx"]
    expect(entry).toBeDefined()
    expect(entry.type).toBe("local")
    expect(entry.command[0]).toBe("node")
    // stdio bundle 入口：包内 .mcp-server/cli.mjs（resolve 相对包根）
    expect(entry.command[1]).toMatch(/\.mcp-server[/\\]cli\.mjs$/)
    expect(entry.command).toContain("--transport")
    expect(entry.command).toContain("stdio")
    expect(entry.command).toContain("--worktree")
    // --worktree 指向当前项目根（input.worktree）
    expect(entry.command[entry.command.indexOf("--worktree") + 1]).toBe(mockInput.worktree)
    expect(entry.command).toContain("--unattended")
    expect(entry.command).toContain("--strip-opx-prefix")
  })

  test("config hook 保留既有 mcp 配置（追加 opx server 不覆盖）", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const config: Record<string, unknown> = {
      mcp: { "existing-server": { type: "local", command: ["npx", "foo"] } },
    }
    await hooks.config!(config as any)
    const mcp = config.mcp as Record<string, unknown>
    expect(mcp["existing-server"]).toBeDefined()
    expect((mcp["opx"] as { command: string[] }).command[1]).toMatch(/\.mcp-server[/\\]cli\.mjs$/)
  })

  test("config hook injects 2 physical subagents + main template", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const config: Record<string, unknown> = { agent: {} }
    await hooks.config!(config as any)

    const agent = config.agent as Record<string, unknown>
    expect(agent["openspec-main"]).toBeDefined()
    expect(agent["openspec-developer"]).toBeDefined()
    expect(agent["openspec-reviewer"]).toBeDefined()
    // 物理 agent 已收敛：9 个逻辑身份由 openspec-developer / openspec-reviewer 两个物理子代理承载
    expect(Object.keys(agent).filter((n) => n.startsWith("openspec-"))).toHaveLength(3)

    // 主代理（openspec-main）承载编排者职责：mode=primary，可加载 skill
    const main = agent["openspec-main"] as Record<string, unknown>
    expect(main.mode).toBe("primary")
    expect((main.permission as Record<string, unknown>).skill).toBe("allow")

    // Check both physical subagents have prompt body and merged permission
    const dev = agent["openspec-developer"] as Record<string, unknown>
    expect(typeof dev.prompt).toBe("string")
    expect((dev.prompt as string).length).toBeGreaterThan(100)
    const reviewer = agent["openspec-reviewer"] as Record<string, unknown>
    expect(typeof reviewer.prompt).toBe("string")
    expect((reviewer.prompt as string).length).toBeGreaterThan(100)
    expect((reviewer.permission as Record<string, unknown>).edit).toBe("allow")
  })

  test("config hook injects bundled skills path", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const config: Record<string, unknown> = {}
    await hooks.config!(config as any)

    const skills = config.skills as Record<string, unknown> | undefined
    expect(skills).toBeDefined()
    const paths = skills!.paths as string[]
    expect(paths).toBeDefined()
    expect(paths.length).toBeGreaterThanOrEqual(1)
    expect(paths[0]).toMatch(/assets\/skills$/)
    expect(paths).not.toContain(expect.stringMatching(/\.agents\/skills$/))
    expect(paths).not.toContain(expect.stringMatching(/\.opencode\/skills$/))
  })

  test("config hook preserves existing agents", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const config: Record<string, unknown> = {
      agent: { "build": { description: "build", mode: "primary", prompt: "build" } },
    }
    await hooks.config!(config as any)
    const agent = config.agent as Record<string, unknown>
    expect(agent["build"]).toBeDefined()
    expect(agent["openspec-main"]).toBeDefined()
  })

  test("插件壳不再启动 poller（dashboard/collector 副作用已迁移至 MCP server 进程）", async () => {
    const root = `/tmp/test-plugin-nocontext-${Date.now()}`
    mkdirSync(root, { recursive: true })
    const spy = spyOn(poller, "startPolling")
    try {
      await OpenspecOrchestratePlugin({ ...mockInput, worktree: root } as any)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("已初始化 worktree（存在 context.json）→ 插件壳仍不启动 poller（副作用归 MCP server）", async () => {
    const root = `/tmp/test-plugin-ctx-${Date.now()}`
    mkdirSync(join(root, "openspec", "states"), { recursive: true })
    writeFileSync(
      join(root, "openspec", "states", "context.json"),
      JSON.stringify({ changeId: "c1", taskGroupId: "1" })
    )
    const spy = spyOn(poller, "startPolling")
    try {
      await OpenspecOrchestratePlugin({ ...mockInput, worktree: root } as any)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

})
