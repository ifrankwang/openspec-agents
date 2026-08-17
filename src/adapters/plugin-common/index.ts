/**
 * 多 agent 插件包共享生成器（DRY）：zcode 与 claude code 的官方插件机制格式同构——
 * 插件目录 + 清单目录内 plugin.json（组件目录 agents/skills/.mcp.json 等与清单目录同级，
 * 仅 plugin.json 放清单目录内）、MCP 模板变量 ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PROJECT_DIR}。
 * 差异仅为清单目录名，由各适配器以参数声明（manifestDirName）。
 *
 * 生成产物为一个完整插件目录：plugin.json 清单 + agents/*.md（从 assets/agents 转换、
 * 排除主代理模板、frontmatter 仅保留 name/description）+ skills/<名>/（含 orchestrator 与
 * reference/ 附属文件）+ assets/workflows/（task.yaml workflow 定义，bundle 内按部署深度
 * 逐级上溯探测读取）+ .mcp.json（stdio + 自包含 bundle 入口 + 当前项目 worktree + 默认
 * 无人值守）+ .mcp-server/cli.mjs 自包含 bundle（node 直接执行，不依赖 node_modules）。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, cpSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import * as yaml from "js-yaml"
import { parseAgentMd, resolve, EXCLUDED_AGENTS } from "../agent-md.ts"

export const PLUGIN_NAME = "openspec-agents"
export const PLUGIN_DESCRIPTION =
  "OpenSpec change 编排：opx_* 编排工具（MCP）+ 编排子代理 + orchestrator skill，非 OpenCode agent 默认无人值守"
/** plugin.json author（package.json 无 author 字段，取固定值）。 */
export const PLUGIN_AUTHOR = "openspec-agents maintainers"

function readPkgVersion(): string {
  return (JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as { version: string }).version
}

/**
 * 构建 MCP server 自包含 bundle（node cli.ts 直跑依赖 node_modules，插件安装后无此环境，
 * 故 bundle 单文件至插件包内，node 直接执行）。打包依赖本机 bun CLI（spawnSync("bun")）。
 */
function bundleMcpServer(pluginDir: string): void {
  const out = join(pluginDir, ".mcp-server", "cli.mjs")
  mkdirSync(join(pluginDir, ".mcp-server"), { recursive: true })
  // dashboard 页面资源随 bundle 同目录放置（page.ts 按此布局探测）
  cpSync(resolve("assets", "dashboard"), join(pluginDir, ".mcp-server", "dashboard"), { recursive: true })
  const result = spawnSync(
    "bun",
    [
      "build",
      resolve("src", "adapters", "mcp-common", "cli.ts"),
      "--outfile",
      out,
      "--target",
      "node",
      "--define",
      `__OPX_PKG_VERSION__="${readPkgVersion()}"`,
    ],
    { encoding: "utf-8", stdio: ["ignore", "ignore", "pipe"] },
  )
  if (result.status !== 0) {
    throw new Error(`MCP server bundle 失败：${result.stderr ?? result.error?.message ?? "未知错误"}`)
  }
}

/** 转换 agents：从 assets/agents/*.md 取子代理（排除主代理模板），frontmatter 仅保留 name/description。 */
function buildAgents(targetDir: string): string[] {
  const agentsRoot = resolve("assets", "agents")
  const injected: string[] = []
  for (const file of readdirSync(agentsRoot)) {
    if (!file.endsWith(".md")) continue
    if (EXCLUDED_AGENTS.has(file)) continue
    const { frontmatter, body } = parseAgentMd(readFileSync(join(agentsRoot, file), "utf-8"))
    const name = (frontmatter.name as string) ?? file.replace(/\.md$/, "")
    if (!name) continue
    const pluginFrontmatter: Record<string, unknown> = { name, description: frontmatter.description ?? "" }
  // plugin.json 省略 agents/skills/mcpServers 字段：官方按约定位置自动发现组件
  // （插件根 agents/、skills/、.mcp.json），省略后 `claude plugin validate` 通过且
  // `claude plugin details` 能发现全部组件；显式声明字符串字段反而报 Invalid input
  // （`./` 前缀写法实测对 agents 同样报错），故不声明。
  writeFileSync(
      join(targetDir, `${name}.md`),
      `---\n${yaml.dump(pluginFrontmatter)}---\n\n${body.trim()}\n`,
      "utf-8",
    )
    injected.push(name)
  }
  return injected
}

/** 复制 skills：整个 skill 目录（SKILL.md + reference/ 等附属文件），含 orchestrator skill。 */
function buildSkills(targetDir: string): string[] {
  const skillsRoot = resolve("assets", "skills")
  const injected: string[] = []
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const src = join(skillsRoot, entry.name)
    if (!existsSync(join(src, "SKILL.md"))) continue
    cpSync(src, join(targetDir, entry.name), { recursive: true })
    injected.push(entry.name)
  }
  return injected
}

export interface PluginPackageParams {
  /** 输出目录（如 dist/zcode-plugin/） */
  outDir: string
  /** 清单目录名（".zcode-plugin" | ".claude-plugin"），组件目录与清单目录同级 */
  manifestDirName: string
}

export interface PluginPackageResult {
  pluginDir: string
  version: string
  agents: string[]
  skills: string[]
}

/**
 * 生成官方插件包到 outDir：<manifestDirName>/plugin.json 清单、agents/*.md、skills/<名>/、
 * assets/workflows/、.mcp.json、.mcp-server/cli.mjs bundle。返回生成的组件清单供调用方/测试断言。
 */
export function buildPluginPackage({ outDir, manifestDirName }: PluginPackageParams): PluginPackageResult {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(join(outDir, manifestDirName), { recursive: true })
  mkdirSync(join(outDir, "agents"), { recursive: true })
  mkdirSync(join(outDir, "skills"), { recursive: true })

  const version = readPkgVersion()
  const agents = buildAgents(join(outDir, "agents"))
  const skills = buildSkills(join(outDir, "skills"))
  bundleMcpServer(outDir)
  // workflow 定义随包分发：bundle 内 TASK_WORKFLOW_PATH 按部署深度逐级上溯探测
  // assets/workflows/task.yaml，插件根（dist/cache 形态）上溯 1 级即命中
  cpSync(resolve("assets", "workflows"), join(outDir, "assets", "workflows"), { recursive: true })

  writeFileSync(
    join(outDir, manifestDirName, "plugin.json"),
    JSON.stringify(
      {
        name: PLUGIN_NAME,
        version,
        description: PLUGIN_DESCRIPTION,
        license: "MIT",
        author: { name: PLUGIN_AUTHOR },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  )

  // MCP server 声明：stdio + 默认无人值守；--worktree 指向当前打开项目根（官方模板变量
  // ${CLAUDE_PROJECT_DIR}，插件用户级安装后跨项目生效，不依赖进程 cwd 约定）；
  // server 入口为插件内自包含 bundle（${CLAUDE_PLUGIN_ROOT} 解析到安装后插件根）。
  writeFileSync(
    join(outDir, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          [PLUGIN_NAME]: {
            type: "stdio",
            command: "node",
            args: [
              "${CLAUDE_PLUGIN_ROOT}/.mcp-server/cli.mjs",
              "--transport",
              "stdio",
              "--worktree",
              "${CLAUDE_PROJECT_DIR}",
              "--unattended",
            ],
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  )

  return { pluginDir: outDir, version, agents, skills }
}
