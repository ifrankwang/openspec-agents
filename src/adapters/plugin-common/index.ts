/**
 * 多 agent 插件包共享生成器（DRY）：zcode 与 claude code 的官方插件机制格式同构——
 * 插件目录 + 清单目录内 plugin.json（组件目录 agents/skills/.mcp.json 等与清单目录同级，
 * 仅 plugin.json 放清单目录内）、MCP 模板变量 ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PROJECT_DIR}、
 * marketplace.json 按相对路径 source 分发。差异仅为清单目录名与 marketplace 文件位置，
 * 由各适配器以参数声明（manifestDirName / marketplaceFile）。
 *
 * 生成产物为一个完整插件目录：plugin.json 清单 + agents/*.md（从 assets/agents 转换、
 * 排除主代理模板、frontmatter 仅保留 name/description）+ skills/<名>/（含 orchestrator 与
 * reference/ 附属文件）+ assets/workflows/（task.yaml workflow 定义，bundle 内按部署深度
 * 逐级上溯探测读取）+ .mcp.json（stdio + 自包含 bundle 入口 + 当前项目 worktree + 默认
 * 无人值守）+ .mcp-server/cli.mjs 自包含 bundle（node 直接执行，不依赖 node_modules）。
 * 配套 marketplace.json（相对路径 source），用户本地安装即生效，Disable/Uninstall 整体消失。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, cpSync } from "node:fs"
import { join, relative, dirname, basename } from "node:path"
import { spawnSync } from "node:child_process"
import * as yaml from "js-yaml"
import { parseAgentMd, resolve, EXCLUDED_AGENTS } from "../agent-md.ts"

export const PLUGIN_NAME = "openspec-agents"
export const PLUGIN_DESCRIPTION =
  "OpenSpec change 编排：opx_* 编排工具（MCP）+ 编排子代理 + orchestrator skill，非 OpenCode agent 默认无人值守"
export const MARKETPLACE_NAME = "openspec-agents-marketplace"
/** plugin.json author（package.json 无 author 字段，取固定值）。 */
export const PLUGIN_AUTHOR = "openspec-agents maintainers"
/** marketplace.json 顶层 owner.name（claude/zcode 校验器均要求必填）。 */
export const MARKETPLACE_OWNER = "openspec-agents"

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

export interface PluginMarketplaceParams {
  /** 已生成的插件目录（含 <manifestDirName>/plugin.json） */
  pluginDir: string
  /** marketplace.json 输出位置 */
  marketplaceFile: string
  /** 清单目录名（与构建插件包时的 manifestDirName 一致） */
  manifestDirName: string
}

/**
 * 生成 marketplace.json 到 marketplaceFile。
 * source 用相对路径字符串（官方最常见形态：marketplace 所在仓库内子目录），
 * 用户「Add marketplace」选 marketplace 所在目录即可，source 解析到本机生成的插件目录
 * （产物不入库，clone 后需先本地生成）；团队分发需在目标环境先运行对应
 * bun run <agent>:plugin 生成产物后本地安装，github source 分发为未来评估项。
 *
 * source 相对 marketplace root（仓库根）解析而非 marketplace 文件所在目录：
 * zcode 的 marketplace.json 在仓库根（<root>/marketplace.json），claude code 的在
 * 仓库根 .claude-plugin/ 子目录（<root>/.claude-plugin/marketplace.json）。以
 * basename(dirname(marketplaceFile)) 是否等于清单目录名区分两种布局取 root。
 */
export function writePluginMarketplace({ pluginDir, marketplaceFile, manifestDirName }: PluginMarketplaceParams): void {
  const manifest = JSON.parse(readFileSync(join(pluginDir, manifestDirName, "plugin.json"), "utf-8")) as {
    version: string
  }
  const marketplaceDir = dirname(marketplaceFile)
  const marketplaceRoot = basename(marketplaceDir) === manifestDirName ? dirname(marketplaceDir) : marketplaceDir
  const source = `./${relative(marketplaceRoot, pluginDir)}`
  mkdirSync(marketplaceDir, { recursive: true })
  writeFileSync(
    marketplaceFile,
    JSON.stringify(
      {
        name: MARKETPLACE_NAME,
        description: "openspec-agents 官方插件市场：OpenSpec change 编排插件",
        owner: { name: MARKETPLACE_OWNER },
        plugins: [
          {
            name: PLUGIN_NAME,
            source,
            description: PLUGIN_DESCRIPTION,
            version: manifest.version,
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  )
}
