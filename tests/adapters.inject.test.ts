/**
 * 多适配器注入测试：claude-code / zcode 官方插件包生成、codex agent 定义注入、
 * MCP 配置分发、默认无人值守。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const TMP_ROOT = "/tmp/adapter-inject-test"

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("物理 agent 定义收敛（权限并集）", () => {
  test("assets/agents 仅剩 main 模板 + developer/reviewer 两个子代理，permission 取并集 edit: allow", async () => {
    const { parseAgentMd, resolve } = await import("../src/adapters/agent-md")
    const { readdirSync } = await import("node:fs")
    const agentsDir = resolve("assets", "agents")
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()
    expect(files).toEqual(["openspec-developer.md", "openspec-main.md", "openspec-reviewer.md"])

    for (const name of ["openspec-developer", "openspec-reviewer"]) {
      const { readFileSync } = await import("node:fs")
      const { frontmatter } = parseAgentMd(readFileSync(join(agentsDir, `${name}.md`), "utf-8"))
      const permission = frontmatter.permission as Record<string, unknown>
      expect(permission.edit).toBe("allow")
      expect(permission.bash).toBe("allow")
    }
    // architect 身份的 question 工具并入 developer 物理权限
    const devFm = parseAgentMd(readFileSync(join(agentsDir, "openspec-developer.md"), "utf-8")).frontmatter
    expect((devFm.permission as Record<string, unknown>).question).toBe("allow")
  })
})

/** 本机有 claude CLI 时接入官方校验器门禁；无 CLI 环境跳过（测试保持可移植）。 */
function claudeValidate(target: string): { status: number; output: string } {
  const r = spawnSync("claude", ["plugin", "validate", target], { encoding: "utf-8" })
  return { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

function hasClaudeCli(): boolean {
  return spawnSync("claude", ["--version"], { encoding: "utf-8" }).status === 0
}

function freshRepo(name: string): string {
  const repo = join(TMP_ROOT, name)
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  return repo
}

describe("claude-code 适配器", () => {
  test("生成 Claude Code 官方插件包（plugin.json/agents/skills/.mcp.json）", async () => {
    const { buildClaudeCodePlugin } = await import("../src/adapters/claude-code/index")
    const pluginDir = join(TMP_ROOT, "claude-code-plugin")
    rmSync(pluginDir, { recursive: true, force: true })
    try {
      const result = buildClaudeCodePlugin(pluginDir)

      // plugin.json：name 匹配官方 kebab-case、version 为 semver、author 为对象；
      // agents/skills/mcpServers 省略（官方按约定位置自动发现，显式声明反而 Invalid input）
      const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf-8"))
      expect(manifest.name).toMatch(/^[a-z0-9][a-z0-9-]{0,127}$/)
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(manifest.agents).toBeUndefined()
      expect(manifest.skills).toBeUndefined()
      expect(manifest.mcpServers).toBeUndefined()
      expect(manifest.author).toEqual({ name: expect.any(String) })

      // agents：子代理全量注入（物理收敛为 developer / reviewer 两个），排除主代理模板，
      // frontmatter 仅保留 name/description
      expect(result.agents).toEqual(expect.arrayContaining(["openspec-developer", "openspec-reviewer"]))
      expect(result.agents).toHaveLength(2)
      expect(result.agents).not.toContain("openspec-main") // 主代理是 claude code 本体，不注入
      const reviewerMd = readFileSync(join(pluginDir, "agents", "openspec-reviewer.md"), "utf-8")
      expect(reviewerMd.startsWith("---\nname: openspec-reviewer\n")).toBe(true)
      expect(reviewerMd).not.toContain("mode:")
      expect(reviewerMd).not.toContain("permission:")

      // skills：orchestrator skill 与 reference/ 附属文件递归复制
      expect(result.skills).toContain("orchestrator")
      expect(existsSync(join(pluginDir, "skills", "orchestrator", "SKILL.md"))).toBe(true)
      expect(existsSync(join(pluginDir, "skills", "java-quality-gate", "reference", "pmd-rules.md"))).toBe(true)

      // assets/workflows：task.yaml 随包分发且与源码一致（bundle 逐级上溯探测读取）
      const bundledWorkflow = readFileSync(join(pluginDir, "assets", "workflows", "task.yaml"), "utf-8")
      const sourceWorkflow = readFileSync(join(import.meta.dir, "..", "assets", "workflows", "task.yaml"), "utf-8")
      expect(bundledWorkflow).toBe(sourceWorkflow)

      // .mcp.json：stdio + 自包含 bundle 入口 + 当前项目 worktree + 默认无人值守（官方模板变量）
      const mcp = JSON.parse(readFileSync(join(pluginDir, ".mcp.json"), "utf-8"))
      const entry = mcp.mcpServers["opx"]
      expect(entry.type).toBe("stdio")
      expect(entry.command).toBe("node")
      expect(entry.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/.mcp-server/cli.mjs")
      expect(entry.args).toContain("--transport")
      expect(entry.args).toContain("stdio")
      expect(entry.args).toContain("--worktree")
      expect(entry.args).toContain("${CLAUDE_PROJECT_DIR}")
      expect(entry.args).toContain("--unattended")
      expect(entry.args).toContain("--strip-opx-prefix")

      // MCP server bundle：产物存在且可被 node 解析（结构正确性边界，不实际启动 server）
      expect(existsSync(join(pluginDir, ".mcp-server", "cli.mjs"))).toBe(true)
      await import(pathToFileURL(join(pluginDir, ".mcp-server", "cli.mjs")).href)

      // claude plugin validate 门禁（本机有 claude CLI 时）
      if (hasClaudeCli()) {
        const pluginCheck = claudeValidate(pluginDir)
        expect(pluginCheck.status, `plugin.json 校验失败：\n${pluginCheck.output}`).toBe(0)
      }
    } finally {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  })
})

describe("codex 适配器", () => {
  test("注入子代理定义到 .codex/agents/*.toml 与 MCP 配置（TOML，stdio + 默认无人值守）", async () => {
    const { injectCodexAgents, injectCodexMcp, removeCodexInjection } = await import("../src/adapters/codex/index")
    const repo = freshRepo("codex")
    try {
      const agents = injectCodexAgents(repo)
      expect(agents).toContain("openspec-developer")
      expect(agents).not.toContain("openspec-main")
      const devToml = readFileSync(join(repo, ".codex", "agents", "openspec-developer.toml"), "utf-8")
      expect(devToml).toContain('description = "')
      expect(devToml).toContain("[instructions]")
      expect(devToml).toContain("apply_patch")

      // 物理 agent 收敛为 developer + reviewer 两个；已删除的 openspec-architect 死条目不再生成 TOML
      expect(agents).toHaveLength(2)
      expect(agents).toContain("openspec-reviewer")
      expect(existsSync(join(repo, ".codex", "agents", "openspec-architect.toml"))).toBe(false)
      // reviewer 白名单：审查者可直改文档/注释（apply_patch）；developer 条目不变
      const reviewerToml = readFileSync(join(repo, ".codex", "agents", "openspec-reviewer.toml"), "utf-8")
      expect(reviewerToml).toContain('tools = ["read", "grep", "glob", "ls", "bash", "apply_patch", "web"]')
      const devToolsLine = devToml.split("\n").find((l) => l.startsWith("tools = "))
      expect(devToolsLine).toBe('tools = ["read", "grep", "glob", "ls", "bash", "apply_patch", "web"]')

      injectCodexMcp(repo, "/abs/path/mcp-server.js")
      const cfg = readFileSync(join(repo, ".codex", "config.toml"), "utf-8")
      expect(cfg).toContain("[mcp_servers.opx]")
      expect(cfg).toContain('command = "node"')
      expect(cfg).toContain("--unattended")
      expect(cfg).toContain("--strip-opx-prefix")
    } finally {
      removeCodexInjection(repo)
    }
  })

  test("生成 Codex 官方插件包（plugin.json/agents/skills/.mcp.json）", async () => {
    const { buildCodexPlugin } = await import("../src/adapters/codex/index")
    const pluginDir = join(TMP_ROOT, "codex-plugin")
    rmSync(pluginDir, { recursive: true, force: true })
    try {
      const result = buildCodexPlugin(pluginDir)
      const manifest = JSON.parse(readFileSync(join(pluginDir, ".codex-plugin", "plugin.json"), "utf-8"))
      expect(manifest.name).toMatch(/^[a-z0-9][a-z0-9-]{0,127}$/)
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(manifest.skills).toBe("./skills/")
      expect(manifest.mcpServers).toBe("./.mcp.json")
      expect(manifest.interface?.displayName).toBeTruthy()
      expect(result.agents).toContain("openspec-developer")
      expect(result.agents).not.toContain("openspec-main")

      const mcp = JSON.parse(readFileSync(join(pluginDir, ".mcp.json"), "utf-8"))
      const entry = mcp.mcpServers["opx"]
      expect(entry.command).toBe("node")
      expect(entry.args[0]).toBe("./.mcp-server/cli.mjs")
      expect(entry.args).toContain("--unattended")
      expect(entry.args).toContain("--strip-opx-prefix")

      expect(existsSync(join(pluginDir, ".mcp-server", "cli.mjs"))).toBe(true)
      await import(pathToFileURL(join(pluginDir, ".mcp-server", "cli.mjs")).href)
    } finally {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  })
})

describe("zcode 适配器", () => {
  test("生成 ZCode 官方插件包（plugin.json/agents/skills/.mcp.json）", async () => {
    const { buildZcodePlugin } = await import("../src/adapters/zcode/index")
    const pluginDir = join(TMP_ROOT, "zcode-plugin")
    rmSync(pluginDir, { recursive: true, force: true })
    try {
      const result = buildZcodePlugin(pluginDir)

      // plugin.json：name 匹配官方正则、version 为 semver、author 为对象；
      // agents/skills/mcpServers 省略（与 claude code 同构，官方按约定位置自动发现）
      const manifest = JSON.parse(readFileSync(join(pluginDir, ".zcode-plugin", "plugin.json"), "utf-8"))
      expect(manifest.name).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/)
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(manifest.agents).toBeUndefined()
      expect(manifest.skills).toBeUndefined()
      expect(manifest.mcpServers).toBeUndefined()
      expect(manifest.author).toEqual({ name: expect.any(String) })

      // agents：子代理全量注入（物理收敛为 developer / reviewer 两个），排除主代理模板，
      // frontmatter 仅保留 name/description
      expect(result.agents).toEqual(expect.arrayContaining(["openspec-developer", "openspec-reviewer"]))
      expect(result.agents).toHaveLength(2)
      expect(result.agents).not.toContain("openspec-main")
      const devMd = readFileSync(join(pluginDir, "agents", "openspec-developer.md"), "utf-8")
      expect(devMd.startsWith("---\nname: openspec-developer\n")).toBe(true)
      expect(devMd).not.toContain("mode:")
      expect(devMd).not.toContain("permission:")

      // skills：orchestrator skill 与 reference/ 附属文件递归复制
      expect(result.skills).toContain("orchestrator")
      expect(existsSync(join(pluginDir, "skills", "orchestrator", "SKILL.md"))).toBe(true)
      expect(existsSync(join(pluginDir, "skills", "java-quality-gate", "reference", "pmd-rules.md"))).toBe(true)

      // assets/workflows：task.yaml 随包分发且与源码一致（bundle 逐级上溯探测读取）
      const bundledWorkflow = readFileSync(join(pluginDir, "assets", "workflows", "task.yaml"), "utf-8")
      const sourceWorkflow = readFileSync(join(import.meta.dir, "..", "assets", "workflows", "task.yaml"), "utf-8")
      expect(bundledWorkflow).toBe(sourceWorkflow)

      // .mcp.json：stdio + 自包含 bundle 入口 + 当前项目 worktree + 默认无人值守
      const mcp = JSON.parse(readFileSync(join(pluginDir, ".mcp.json"), "utf-8"))
      const entry = mcp.mcpServers["opx"]
      expect(entry.type).toBe("stdio")
      expect(entry.command).toBe("node")
      expect(entry.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/.mcp-server/cli.mjs")
      expect(entry.args).toContain("--transport")
      expect(entry.args).toContain("stdio")
      expect(entry.args).toContain("--worktree")
      expect(entry.args).toContain("${CLAUDE_PROJECT_DIR}")
      expect(entry.args).toContain("--unattended")
      expect(entry.args).toContain("--strip-opx-prefix")

      // MCP server bundle：产物存在且可被 node 解析（结构正确性边界，不实际启动 server）
      expect(existsSync(join(pluginDir, ".mcp-server", "cli.mjs"))).toBe(true)
      await import(pathToFileURL(join(pluginDir, ".mcp-server", "cli.mjs")).href)

    } finally {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  })

  test("bundle 冒烟：stdio 握手 serverInfo.version 与 package.json 一致（--define 注入生效）", async () => {
    const { buildZcodePlugin } = await import("../src/adapters/zcode/index")
    const pluginDir = join(TMP_ROOT, "zcode-plugin-smoke")
    rmSync(pluginDir, { recursive: true, force: true })
    const worktree = join(TMP_ROOT, "zcode-worktree")
    mkdirSync(worktree, { recursive: true })
    try {
      const result = buildZcodePlugin(pluginDir)
      // stdio 启动 bundle 并完成 MCP 握手：若 --define 注入未生效，bundle 内版本号回退分支
      // 读不到源码相对路径的 package.json 会直接崩、握手失败——通过即证明注入生效。
      const client = new Client({ name: "smoke-client", version: "0.0.1" })
      await client.connect(
        new StdioClientTransport({
          command: "node",
          args: [join(pluginDir, ".mcp-server", "cli.mjs"), "--transport", "stdio", "--worktree", worktree],
          stderr: "pipe",
        }),
      )
      try {
        const serverInfo = client.getServerVersion()
        expect(serverInfo?.name).toBe("openspec-agents")
        expect(serverInfo?.version).toBe(result.version)
      } finally {
        await client.close()
      }
    } finally {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  })

  test("bundle 形态 dashboard 页面资源来自 bundle 同目录（非源码回退）", async () => {
    const { buildZcodePlugin } = await import("../src/adapters/zcode/index")
    const pluginDir = join(TMP_ROOT, "zcode-plugin-dash")
    rmSync(pluginDir, { recursive: true, force: true })
    const worktree = join(TMP_ROOT, "zcode-dash-worktree")
    mkdirSync(worktree, { recursive: true })
    try {
      buildZcodePlugin(pluginDir)
      // 在 bundle 同目录页面注入标记：能拿到该标记即证明页面来自 bundle 而非源码回退
      const marker = `<!--bundle-marker-${Date.now()}-->`
      appendFileSync(join(pluginDir, ".mcp-server", "dashboard", "index.html"), marker)

      const proc = spawn(
        "node",
        [join(pluginDir, ".mcp-server", "cli.mjs"), "--transport", "http", "--worktree", worktree],
        { stdio: "ignore" },
      )
      try {
        const deadline = Date.now() + 10000
        let html: string | null = null
        while (Date.now() < deadline && !html) {
          for (let port = 4519; port < 4519 + 20; port++) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/`)
              const text = await res.text()
              if (res.ok && text.includes(marker)) {
                html = text
                break
              }
            } catch {
              // 端口未就绪/非本进程服务，跳过
            }
          }
          if (!html) await new Promise((r) => setTimeout(r, 200))
        }
        expect(html, "10s 内未在 4519-4538 端口命中 bundle 页面").not.toBeNull()
      } finally {
        proc.kill()
      }
    } finally {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  })
})
