/**
 * DeepSeek Harness (DSH) 适配器：生成 DSH bundle 插件包。
 *
 * DSH 的插件形态不是 Claude/Codex/ZCode 的 plugin.json，而是 npm 包 +
 * package.json 中 `dsh.bundle.patch` 指向的 cordis patch 文件。本适配器复用
 * plugin-common 的 assets 构建，生成一个可直接用 `dsh plugin --profile <name> add <dir>`
 * 安装的 bundle 包。
 *
 * 生成的 patch 挂载两类能力：
 * - 本包自有的 `openspec-opx-tools` cordis 插件：6 个 opx_* 编排工具注册为 DSH 原生工具，
 *   每次调用从 `exec.agent.session.header.cwd` 取会话项目目录。多项目共用同一插件进程时
 *   各自作用于各自项目（MCP 形态因 worktree 固定在进程启动参数上而做不到，见 patch 注释）。
 * - DSH 官方能力：`@deepseek-ai/dsh-skill-filesystem`（skill 根）、`@deepseek-ai/dsh-tool-subagent`
 *   （每个 assets/agents 子代理一个 DSH 原生 subagent 工具）。opx_* 工具不再经
 *   `@deepseek-ai/dsh-mcp-client` 桥接——原生插件已直接注册工具，patch 内不挂 MCP client。
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as yaml from "js-yaml"
import { parseAgentMd, resolve, EXCLUDED_AGENTS } from "../agent-md.ts"
import {
  PLUGIN_DESCRIPTION,
  bundleDshNativeTools,
  buildAgents,
  buildSkills,
  copyWorkflows,
  copyLicense,
  readPkgVersion,
  type PluginPackageResult,
} from "../plugin-common/index.ts"

/** DSH bundle 的 npm 包名（与项目发布包一致，便于 `dsh plugin add` 与 sync 识别）。 */
export const DSH_PLUGIN_NAME = "@ifrankwang/openspec-agents"

/** DSH bundle 包的作者署名（与各插件包 plugin.json 的 author 保持一致）。 */
export const PLUGIN_AUTHOR_STRING = "ifrankwang"

/** 默认插件包输出目录（dist/ 已 gitignore，生成物不入库）。 */
export const DEEP_SEEK_HARNESS_PLUGIN_DIR = resolve("dist", "deepseek-harness-plugin")
/** 简写别名，便于与 `dsh` 缩写保持一致。 */
export const DSH_PLUGIN_DIR = DEEP_SEEK_HARNESS_PLUGIN_DIR

const MANIFEST_PATCH_FILENAME = "cordis.patch.yml"

/** DSH 原生工具插件 bundle 在包内的相对路径（bundle 产物目录 + 文件名）。 */
export const DSH_NATIVE_TOOLS_RELATIVE_PATH = ".dsh-plugin/opx-tools.mjs"
/**
 * bundle package.json 中声明的 exports 子路径（Node 要求深层路径显式导出，
 * 直接 import 深层路径报 ERR_PACKAGE_PATH_NOT_EXPORTED）。
 */
export const DSH_NATIVE_TOOLS_EXPORTS_KEY = "./.dsh-plugin/opx-tools.mjs"
/**
 * cordis patch 的 insert.name：裸包名 + 子路径，二者之间是 `/` 而非 `./`——
 * loader 走 Node 的裸包名解析，`pkg./x` 会被当成包名 `pkg.` 而 ERR_MODULE_NOT_FOUND。
 */
export const DSH_NATIVE_TOOLS_ROW_NAME = `${DSH_PLUGIN_NAME}${DSH_NATIVE_TOOLS_EXPORTS_KEY.slice(1)}`
/** cordis patch 中挂载原生工具插件的 insert 行 id。 */
export const DSH_NATIVE_TOOLS_ROW_ID = "openspec-opx-tools"

/** 原生工具插件与 skill 根的基础 patch；子代理工具行由 buildDshPatchContent 动态追加。 */
const DSH_BASE_PATCH_YAML = `# DeepSeek Harness (DSH) bundle patch: expose OpenSpec orchestration tools and skills.
# The patch is applied as a bundle layer under dsh.profile.bundles.
# baseUrl 指向 profile 根目录；bundle 安装后位于 profile 的 node_modules 下，
# 因此从这里引用 node_modules/@ifrankwang/openspec-agents/... 是稳定的。
#
# openspec-opx-tools：本包自有的 cordis 插件，把 6 个 opx_* 编排工具注册为 DSH 原生工具。
# 工具在 DSH 进程内执行，每次调用从 exec.agent.session.header.cwd 取会话项目目录，
# 因此「单 profile 装一份插件、多项目共用同一进程」下各项目互不干扰——这正是 MCP 形态做不到的
# （MCP server 是子进程，worktree 只能由启动参数固定一份，与用户打开的项目无关）。
- insert:
    - id: ${DSH_NATIVE_TOOLS_ROW_ID}
      name: '${DSH_NATIVE_TOOLS_ROW_NAME}'
      config:
        unattended: true
    - id: openspec-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: openspec-filesystem
        includeDefaultRoots: false
        customSkillDirs:
          - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('./node_modules/${DSH_PLUGIN_NAME}/assets/skills', baseUrl))"
`

interface DshSubagentEntry {
  id: string
  name: string
  config: Record<string, unknown>
}

/** 将 openspec-architect 转换为 openspec_architect 这类 DSH 工具名后缀。 */
function dshAgentSuffix(name: string): string {
  return name.replace(/^openspec-/, "").replace(/-/g, "_")
}

/** 根据 agent.md frontmatter 判断是否应禁止 DSH 子代理的写文件类工具。 */
function denyEditTools(frontmatter: Record<string, unknown>): boolean {
  const permission = frontmatter.permission as Record<string, unknown> | undefined
  const edit = permission?.edit
  if (edit === "deny") return true
  if (edit && typeof edit === "object") {
    const rule = edit as Record<string, unknown>
    // edit 规则按通配整体 deny 但对 *.md 单独放行时，不能整体禁止写工具
    return rule["*"] === "deny" && rule["*.md"] !== "allow"
  }
  return false
}

/** DSH 子代理 persona 前置的工具接入说明，避免子代理在首次 opx_status 前用 shell 全盘搜索工具。 */
const DSH_SUBAGENT_TOOL_ACCESS_PREAMBLE = `## DSH 工具接入（必读）

- 本流程的 opx_* 工具在 DSH 中以 \`opx_*\` 原生工具形式出现（注册在本插件包内，无 \`mcp__\` 前缀），子代理通常只需要：
  - \`opx_status\`
  - \`opx_agent_submit\`
- 调用工具时必须携带 \`_agent\` 参数传自身角色名（如 \`openspec-developer\`），否则身份无法判定、会被按编排主代理视角处理。
- 如果当前工具列表中没有这些工具，请立即调用 \`dev_tool_search\` 搜索 \`opx\`，或一次性解锁：
  \`\`\`json
  {"toolNames": ["opx_status", "opx_agent_submit"]}
  \`\`\`
  如果计划使用 \`todo_write\` 跟踪任务，也请在同一轮一并解锁。
- 严禁使用 \`find\` / \`which\` / \`grep\` 等 shell 命令搜索 \`opx\`、\`openspec\`、MCP 配置或安装路径；工具未出现是因为尚未解锁，不是未安装。
- 解锁后第一件事是调用 \`opx_status\` 获取上下文，不要先探查仓库或读取状态文件。
`

/** 从 assets/agents/*.md 收集 DSH 子代理工具（跳过主代理模板）。 */
function collectDshSubagentEntries(): DshSubagentEntry[] {
  const agentsRoot = resolve("assets", "agents")
  const entries: DshSubagentEntry[] = []
  for (const file of readdirSync(agentsRoot)) {
    if (!file.endsWith(".md")) continue
    if (EXCLUDED_AGENTS.has(file)) continue
    const { frontmatter, body } = parseAgentMd(readFileSync(join(agentsRoot, file), "utf-8"))
    const name = (frontmatter.name as string) ?? file.replace(/\.md$/, "")
    if (!name) continue
    const description = (frontmatter.description as string) ?? ""
    const persona = [DSH_SUBAGENT_TOOL_ACCESS_PREAMBLE, description, body.trim()].filter(Boolean).join("\n\n")
    const suffix = dshAgentSuffix(name)
    entries.push({
      id: `openspec-subagent-${suffix}`,
      name: "@deepseek-ai/dsh-tool-subagent",
      config: {
        provider: "spawn",
        toolName: `openspec_${suffix}`,
        persona,
        enableRunInBackground: false,
        backgroundMode: "one-shot",
        ...(denyEditTools(frontmatter)
          ? { toolFilter: { deny: ["write", "edit", "apply_patch", "str_replace_editor"] } }
          : {}),
      },
    })
  }
  return entries
}

/** 生成完整的 DSH cordis patch 内容：基础原生工具插件行 + skill 根 + 每个子代理一个 DSH 原生 subagent 工具。 */
export function buildDshPatchContent(): string {
  const subagents = collectDshSubagentEntries()
  if (subagents.length === 0) return DSH_BASE_PATCH_YAML
  const subagentsYaml = yaml
    .dump(subagents, { lineWidth: -1 })
    .split("\n")
    .map((line) => (line ? `    ${line}` : line))
    .join("\n")
  return `${DSH_BASE_PATCH_YAML.trimEnd()}\n${subagentsYaml}\n`
}

export type DeepSeekHarnessPluginBuildResult = PluginPackageResult

/**
 * 生成 DeepSeek Harness bundle 插件包到 outDir（默认 dist/deepseek-harness-plugin/）：
 * package.json（含 dsh.bundle.patch）、cordis.patch.yml、.dsh-plugin/opx-tools.mjs bundle、
 * assets/skills/、assets/workflows/。
 *
 * 返回生成的组件清单供调用方/测试断言；DSH 原生不消费 Markdown agent 文件，
 * 但为保持与其它插件包一致仍会复制 agents/ 目录。
 */
export function buildDeepSeekHarnessPlugin(outDir: string = DEEP_SEEK_HARNESS_PLUGIN_DIR): DeepSeekHarnessPluginBuildResult {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(join(outDir, "agents"), { recursive: true })
  mkdirSync(join(outDir, "skills"), { recursive: true })
  mkdirSync(join(outDir, "assets"), { recursive: true })
  mkdirSync(join(outDir, ".dsh-plugin"), { recursive: true })

  const version = readPkgVersion()
  // DSH 通过上方 subagent 工具消费 agent 定义；agents/ 目录仍保留原始 markdown 供参考/审计。
  const agents = buildAgents(join(outDir, "agents"))
  const skills = buildSkills(join(outDir, "skills"))
  bundleDshNativeTools(outDir)
  copyWorkflows(outDir)
  copyLicense(outDir)

  writeFileSync(
    join(outDir, "package.json"),
    JSON.stringify(
      {
        name: DSH_PLUGIN_NAME,
        version,
        description: PLUGIN_DESCRIPTION,
        type: "module",
        private: true,
        author: PLUGIN_AUTHOR_STRING,
        license: "MIT",
        // cordis 以裸包名 + 子路径 import 原生工具插件；Node 要求该子路径在 exports 中显式声明
        // （深层路径直接 import 报 ERR_PACKAGE_PATH_NOT_EXPORTED）。
        exports: {
          [DSH_NATIVE_TOOLS_EXPORTS_KEY]: `./${DSH_NATIVE_TOOLS_RELATIVE_PATH}`,
        },
        dsh: {
          bundle: {
            patch: `./${MANIFEST_PATCH_FILENAME}`,
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  )

  writeFileSync(join(outDir, MANIFEST_PATCH_FILENAME), buildDshPatchContent(), "utf-8")

  return { pluginDir: outDir, version, agents, skills }
}

/** `dsh` 缩写的构建函数别名。 */
export const buildDshPlugin = buildDeepSeekHarnessPlugin
