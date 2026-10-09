/**
 * OpenCode V2 插件壳行为测试：setup 内按域注册 MCP server 与 skill，并把子代理写成
 * 项目内 `.opencode/agents/*.md`。
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import * as yaml from "js-yaml"
import plugin, { OPENCODE_PLUGIN_ID } from "../src/adapters/opencode/index"
import { toV2Permissions } from "../src/adapters/opencode/permissions"
import { agentsTargetDir } from "../src/adapters/opencode/agents"
import * as poller from "../src/core/workflow/poller"

let projectRoot: string

beforeEach(() => {
  projectRoot = `/tmp/test-plugin-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`
  mkdirSync(projectRoot, { recursive: true })
})
afterEach(() => {
  try { rmSync(projectRoot, { recursive: true, force: true }) } catch {}
})

/** 记录各域 transform 编辑动作的最小 ctx 替身。 */
function createCtx(directory: string) {
  const mcpServers: Record<string, any> = {}
  const skills: any[] = []
  const ctx = {
    location: { directory },
    mcp: {
      transform: async (cb: (e: any) => void) => {
        cb({ set: (name: string, cfg: any) => { mcpServers[name] = cfg }, remove: () => {} })
      },
    },
    skill: {
      transform: async (cb: (e: any) => void) => {
        cb({ add: (s: any) => skills.push(s) })
      },
    },
  }
  return { ctx: ctx as any, mcpServers, skills }
}

function parseAgentFile(file: string) {
  const raw = readFileSync(file, "utf-8")
  const end = raw.indexOf("---", 3)
  return {
    frontmatter: yaml.load(raw.slice(3, end)) as Record<string, any>,
    body: raw.slice(end + 3),
    raw,
  }
}

describe("OpenCode V2 插件壳", () => {
  test("默认导出为 { id, setup } 形态", () => {
    expect(plugin.id).toBe(OPENCODE_PLUGIN_ID)
    expect(plugin.id).toBe("openspec-agents")
    expect(typeof plugin.setup).toBe("function")
  })

  test("setup 经 mcp 域注册 opx server（stdio bundle + 当前项目根）", async () => {
    const { ctx, mcpServers } = createCtx(projectRoot)
    await plugin.setup(ctx)

    const entry = mcpServers["opx"]
    expect(entry).toBeDefined()
    expect(entry.type).toBe("local")
    expect(entry.command[0]).toBe("node")
    expect(entry.command[1]).toMatch(/\.mcp-server[/\\]cli\.mjs$/)
    expect(entry.command).toContain("--transport")
    expect(entry.command).toContain("stdio")
    expect(entry.command[entry.command.indexOf("--worktree") + 1]).toBe(projectRoot)
    expect(entry.command).toContain("--unattended")
    expect(entry.command).toContain("--strip-opx-prefix")
  })

  test("setup 经 skill 域注册随包 skill（含 orchestrator，content 去 frontmatter）", async () => {
    const { ctx, skills } = createCtx(projectRoot)
    await plugin.setup(ctx)

    expect(skills.length).toBeGreaterThan(0)
    const ids = skills.map((s) => s.id)
    expect(ids).toContain("orchestrator")
    for (const s of skills) {
      expect(s.path).toMatch(/[/\\]SKILL\.md$/)
      expect(s.content.length).toBeGreaterThan(0)
      // content 为去 frontmatter 的正文，不含 frontmatter 分隔符
      expect(s.content.startsWith("---")).toBe(false)
      expect(typeof s.name).toBe("string")
    }
  })

  test("setup 把 3 个子代理写成项目 .opencode/agents/*.md（V2 原生字段）", async () => {
    const { ctx } = createCtx(projectRoot)
    await plugin.setup(ctx)

    const dir = agentsTargetDir(projectRoot)
    for (const name of ["openspec-main", "openspec-developer", "openspec-reviewer"]) {
      const file = join(dir, `${name}.md`)
      expect(existsSync(file), `${name} 未投放`).toBe(true)
      const { frontmatter, body } = parseAgentFile(file)
      expect(typeof frontmatter.description).toBe("string")
      expect(["primary", "subagent", "all"]).toContain(frontmatter.mode)
      expect(frontmatter.steps).toBe(200)
      // V1 字段名不出现在 V2 agent 文件中
      expect(frontmatter.permission).toBeUndefined()
      expect(frontmatter.prompt).toBeUndefined()
      expect(frontmatter.maxSteps).toBeUndefined()
      expect(Array.isArray(frontmatter.permissions)).toBe(true)
      expect(body.trim().length).toBeGreaterThan(100)
    }
  })

  test("主代理 permissions 完成 V2 动作名映射（bash→shell、task→subagent、write 去重入 edit）", async () => {
    const { ctx } = createCtx(projectRoot)
    await plugin.setup(ctx)

    const { frontmatter } = parseAgentFile(join(agentsTargetDir(projectRoot), "openspec-main.md"))
    const perms = frontmatter.permissions as { action: string; resource: string; effect: string }[]
    const has = (a: string, r: string, e: string) =>
      perms.some((p) => p.action === a && p.resource === r && p.effect === e)

    expect(has("shell", "git *", "allow")).toBe(true)
    expect(has("shell", "*", "deny")).toBe(true)
    expect(has("subagent", "openspec-*", "allow")).toBe(true)
    expect(has("edit", "*", "deny")).toBe(true)
    expect(has("skill", "*", "allow")).toBe(true)
    // read 先宽后窄：通配 deny 在前，路径 allow 在后
    expect(has("read", "*", "deny")).toBe(true)
    expect(has("read", "openspec/states/*", "allow")).toBe(true)
    // lsp 在 V2 无对应行为，整项丢弃
    expect(perms.some((p) => p.action === "lsp")).toBe(false)
    // write/edit 映射到同一动作后不产生重复规则
    const editDeny = perms.filter((p) => p.action === "edit" && p.effect === "deny")
    expect(editDeny).toHaveLength(1)
  })

  test("重复执行 setup 幂等（文件带生成标记，随版本刷新）", async () => {
    const { ctx } = createCtx(projectRoot)
    await plugin.setup(ctx)
    const file = join(agentsTargetDir(projectRoot), "openspec-main.md")
    const first = readFileSync(file, "utf-8")

    await plugin.setup(ctx)
    expect(readFileSync(file, "utf-8")).toBe(first)
    expect(existsSync(file)).toBe(true)
  })

  test("用户手工改写过的同名 agent 文件不被覆盖", async () => {
    const dir = agentsTargetDir(projectRoot)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "openspec-main.md")
    const custom = '---\ndescription: 我自己维护的编排主代理\nmode: primary\n---\n\n我自己写的正文。\n'
    writeFileSync(file, custom, "utf-8")

    const { ctx } = createCtx(projectRoot)
    await plugin.setup(ctx)

    expect(readFileSync(file, "utf-8")).toBe(custom)
  })

  test("插件壳不启动 poller（dashboard/collector 副作用归 MCP server 进程）", async () => {
    const spy = spyOn(poller, "startPolling")
    try {
      const { ctx } = createCtx(projectRoot)
      await plugin.setup(ctx)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe("permission → V2 有序规则数组", () => {
  test("字符串形态展开为通配 resource", () => {
    expect(toV2Permissions({ edit: "allow" })).toEqual([
      { action: "edit", resource: "*", effect: "allow" },
    ])
  })

  test("对象形态保持子键声明顺序", () => {
    expect(toV2Permissions({ read: { "*": "deny", "src/**": "allow" } })).toEqual([
      { action: "read", resource: "*", effect: "deny" },
      { action: "read", resource: "src/**", effect: "allow" },
    ])
  })

  test("动作名重命名：bash/task/write/patch", () => {
    const out = toV2Permissions({ bash: "allow", task: "allow", write: "deny", patch: "deny" })
    expect(out).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
    ])
  })

  test("lsp 丢弃、非法值忽略、非对象输入返回空", () => {
    expect(toV2Permissions({ lsp: "deny" })).toEqual([])
    expect(toV2Permissions({ edit: "maybe" })).toEqual([])
    expect(toV2Permissions(undefined)).toEqual([])
    expect(toV2Permissions("nope")).toEqual([])
  })

  test("映射后重复规则去重保留首条", () => {
    const out = toV2Permissions({ edit: "deny", write: "deny", patch: "deny" })
    expect(out).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
  })
})