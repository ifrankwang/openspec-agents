import { describe, expect, test } from "bun:test"
import { OpenspecOrchestratePlugin } from "../src/index"

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

  test("registers 12 opx_* tools", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const names = Object.keys(hooks.tool!)
    expect(names).toContain("opx_orch_init")
    expect(names).toContain("opx_orch_set_worktree")
    expect(names).toContain("opx_status")
    expect(names).toContain("opx_orch_complete_task_group")
    expect(names).toContain("opx_orch_set_unattended")
    expect(names).toContain("opx_arch_submit")
    expect(names).toContain("opx_dev_submit")
    expect(names).toContain("opx_tool_review_submit")
    expect(names).toContain("opx_task_review_submit")
    expect(names).toContain("opx_quality_review_submit")
    expect(names).toContain("opx_orch_resolve_review")
    expect(names).toContain("opx_arch_blocker")
    expect(names.length).toBe(12)
    for (const n of names) {
      expect(typeof hooks.tool![n].execute).toBe("function")
    }
  })

  test("config hook injects all 10 agents", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const config: Record<string, unknown> = { agent: {} }
    await hooks.config!(config as any)

    const agent = config.agent as Record<string, unknown>
    expect(agent["openspec-orchestrator"]).toBeDefined()
    expect(agent["openspec-architect"]).toBeDefined()
    expect(agent["openspec-developer"]).toBeDefined()
    expect(agent["openspec-reviewer-tool"]).toBeDefined()
    expect(agent["openspec-reviewer-task"]).toBeDefined()
    expect(agent["openspec-reviewer-style"]).toBeDefined()
    expect(agent["openspec-reviewer-architecture"]).toBeDefined()
    expect(agent["openspec-reviewer-performance"]).toBeDefined()
    expect(agent["openspec-reviewer-security"]).toBeDefined()
    expect(agent["openspec-reviewer-maintainability"]).toBeDefined()

    // Check orchestrator agent has correct mode
    const orch = agent["openspec-orchestrator"] as Record<string, unknown>
    expect(orch.mode).toBe("primary")

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
  })

  test("config hook preserves existing agents", async () => {
    const hooks = await OpenspecOrchestratePlugin(mockInput as any)
    const config: Record<string, unknown> = {
      agent: { "build": { description: "build", mode: "primary", prompt: "build" } },
    }
    await hooks.config!(config as any)
    const agent = config.agent as Record<string, unknown>
    expect(agent["build"]).toBeDefined()
    expect(agent["openspec-orchestrator"]).toBeDefined()
  })

})
