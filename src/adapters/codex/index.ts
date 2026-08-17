/**
 * codex 适配器：官方插件包生成（.codex-plugin/plugin.json + agents/skills/.mcp.json），
 * 以及兼容手动 agent 定义注入（.codex/agents/*.toml）、MCP 配置分发（config.toml，TOML 格式）、
 * 默认无人值守（MCP server 启动参数 --unattended）。
 *
 * 已知限制（接入文档注明）：
 * - codex 的 request_user_input 工具仅根线程（主代理）可用，且普通模式需 feature flag
 *   （--experimental-auto-plan / request_user_input 相关 flag）开启，codex exec 不可用；
 * - 子代理无法向用户提问 → 默认无人值守，需拍板事项由主代理依据 orchestrator skill 自行裁决。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { parseAgentMd, resolve, EXCLUDED_AGENTS } from "../agent-md.ts"
import { buildPluginPackage, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_AUTHOR, type PluginPackageResult } from "../plugin-common/index.ts"

/** codex agent 工具白名单（按职责收敛，审查/分析角色不含写文件工具）。 */
const AGENT_TOOLS: Record<string, string[]> = {
  "openspec-architect": ["read", "grep", "glob", "ls", "bash", "web"],
  "openspec-developer": ["read", "grep", "glob", "ls", "bash", "apply_patch", "web"],
  default: ["read", "grep", "glob", "ls", "bash"],
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** 生成 codex agent TOML（.codex/agents/*.toml）。 */
function toAgentToml(name: string, description: string, body: string, tools: string[]): string {
  const lines: string[] = [
    `description = "${tomlEscape(description)}"`,
    `tools = [${tools.map((t) => `"${t}"`).join(", ")}]`,
    "",
    "[instructions]",
    `body = """`,
    body.trim(),
    `"""`,
    "",
  ]
  return lines.join("\n")
}

/** 注入子代理定义到 .codex/agents/*.toml（目标仓库根目录）。返回注入的 agent 名列表。 */
export function injectCodexAgents(repoRoot: string): string[] {
  const agentsRoot = resolve("assets", "agents")
  if (!existsSync(agentsRoot)) return []
  const targetDir = join(repoRoot, ".codex", "agents")
  mkdirSync(targetDir, { recursive: true })
  const injected: string[] = []
  for (const file of readdirSync(agentsRoot)) {
    if (!file.endsWith(".md")) continue
    if (EXCLUDED_AGENTS.has(file)) continue
    const md = readFileSync(join(agentsRoot, file), "utf-8")
    const { frontmatter, body } = parseAgentMd(md)
    const name = (frontmatter.name as string) ?? file.replace(/\.md$/, "")
    if (!name) continue
    const tools = AGENT_TOOLS[name] ?? AGENT_TOOLS.default
    writeFileSync(
      join(targetDir, `${name}.toml`),
      toAgentToml(name, (frontmatter.description as string) ?? "", body, tools),
      "utf-8",
    )
    injected.push(name)
  }
  return injected
}

/**
 * 分发 MCP 注册配置到 .codex/config.toml（TOML，合并既有配置）。
 * serverEntry 为 MCP server 可执行入口（node 脚本路径），stdio transport + 默认无人值守。
 */
export function injectCodexMcp(repoRoot: string, serverEntry: string): void {
  const target = join(repoRoot, ".codex", "config.toml")
  mkdirSync(dirname(target), { recursive: true })
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : ""
  const block = [
    `[mcp_servers.openspec-agents]`,
    `command = "node"`,
    `args = ["${tomlEscape(serverEntry)}", "--transport", "stdio", "--worktree", ".", "--unattended"]`,
  ].join("\n")
  // 已存在同名 server 块则整体替换，否则追加
  const re = /\[mcp_servers\.openspec-agents\][\s\S]*?(?=\n\[|\n*$)/m
  const next = re.test(existing) ? existing.replace(re, block) : `${existing.trimEnd()}\n\n${block}\n`
  writeFileSync(target, next, "utf-8")
}

/** 清理注入产物（测试/卸载用）。 */
export function removeCodexInjection(repoRoot: string): void {
  try { rmSync(join(repoRoot, ".codex", "agents"), { recursive: true, force: true }) } catch {}
  try { rmSync(join(repoRoot, ".codex", "config.toml"), { recursive: true, force: true }) } catch {}
}

/** Codex 官方插件包默认输出目录（dist/ 已 gitignore，生成物不入库）。 */
export const CODEX_PLUGIN_DIR = resolve("dist", "codex-plugin")

/**
 * 生成 Codex 官方插件包到 outDir（默认 dist/codex-plugin/）：
 * .codex-plugin/plugin.json 清单、agents/*.md、skills/<名>/、assets/workflows/、
 * .mcp.json、.mcp-server/cli.mjs bundle。
 *
 * 与 Claude/ZCode 插件包共用 plugin-common 的组件复制与 MCP bundle 构建，
 * 差异仅在清单目录名、plugin.json 字段和 .mcp.json 的路径/模板变量。
 */
export function buildCodexPlugin(outDir: string = CODEX_PLUGIN_DIR): PluginPackageResult {
  const result = buildPluginPackage({ outDir, manifestDirName: ".codex-plugin" })

  // Codex 官方 plugin.json：可声明 skills/mcpServers，interface 用于商店展示。
  writeFileSync(
    join(outDir, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: PLUGIN_NAME,
        version: result.version,
        description: PLUGIN_DESCRIPTION,
        author: { name: PLUGIN_AUTHOR },
        license: "MIT",
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        interface: {
          displayName: "OpenSpec Agents",
          shortDescription: "OpenSpec change orchestration for Codex",
          longDescription: PLUGIN_DESCRIPTION,
          developerName: "ifrankwang",
          category: "Developer Tools",
          capabilities: ["Read", "Write"],
          defaultPrompt: ["Run the OpenSpec change orchestration workflow."],
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  )

  // Codex 插件 MCP 使用相对插件根的路径；--worktree . 指向 Codex 当前工作区。
  writeFileSync(
    join(outDir, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          [PLUGIN_NAME]: {
            command: "node",
            args: [
              "./.mcp-server/cli.mjs",
              "--transport",
              "stdio",
              "--worktree",
              ".",
              "--unattended",
            ],
            cwd: ".",
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  )

  return result
}
