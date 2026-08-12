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
  test("returns Hooks with config + tool", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    expect(hooks).toBeDefined()
    expect(typeof hooks.config).toBe("function")
    expect(hooks.tool).toBeDefined()
  })

  test("registers 6 opx_* tools", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const names = Object.keys(hooks.tool!)
    expect(names).toContain("opx_orch_init")
    expect(names).toContain("opx_orch_set_worktree")
    expect(names).toContain("opx_status")
    expect(names).toContain("opx_orch_complete_task_group")
    expect(names).toContain("opx_orch_set_unattended")
    expect(names).toContain("opx_agent_submit")
    expect(names.length).toBe(6)
    for (const n of names) {
      expect(typeof hooks.tool![n].execute).toBe("function")
    }
  })

  test("config hook injects all 10 agents", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const config: Record<string, unknown> = { agent: {} }
    await hooks.config!(config as any)

    const agent = config.agent as Record<string, unknown>
    expect(agent["openspec-main"]).toBeDefined()
    expect(agent["openspec-architect"]).toBeDefined()
    expect(agent["openspec-developer"]).toBeDefined()
    expect(agent["openspec-reviewer-tool"]).toBeDefined()
    expect(agent["openspec-reviewer-task"]).toBeDefined()
    expect(agent["openspec-reviewer-style"]).toBeDefined()
    expect(agent["openspec-reviewer-architecture"]).toBeDefined()
    expect(agent["openspec-reviewer-performance"]).toBeDefined()
    expect(agent["openspec-reviewer-security"]).toBeDefined()
    expect(agent["openspec-reviewer-maintainability"]).toBeDefined()

    // 主代理（openspec-main）承载编排者职责：mode=primary，可加载 skill
    const main = agent["openspec-main"] as Record<string, unknown>
    expect(main.mode).toBe("primary")
    expect((main.permission as Record<string, unknown>).skill).toBe("allow")

    // Check reviewer agents have prompt body
    const style = agent["openspec-reviewer-style"] as Record<string, unknown>
    expect(typeof style.prompt).toBe("string")
    expect((style.prompt as string).length).toBeGreaterThan(100)
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
