/**
 * DeepSeek Harness (DSH) 适配器测试：生成 DSH bundle 插件包，
 * 校验 package.json（dsh.bundle.patch + 原生工具插件 exports）、cordis.patch.yml、
 * 原生工具插件 bundle 与 skills。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { rmSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as yaml from "js-yaml"

const TMP_ROOT = "/tmp/deepseek-harness-test"

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

/** DSH entry-list 方言的 `!!js` 标签：结构断言只关心节点位置，按标量文本接收。 */
const DSH_PATCH_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (data: string) => data }),
])

/** patch 是 YAML：注释行里的示例文字不是引用，抽取前先剔除（否则注释中的省略号会被当成路径）。 */
function stripYamlComments(yamlText: string): string {
  return yamlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
}

/**
 * 抽取文本中「本包内相对路径」的引用。cordis patch 以两种形态引用本包：
 * `./node_modules/<包名>/<rel>`（文件系统路径，如 skill 根）与 `<包名>/<rel>`（cordis 裸包名 + 子路径
 * import，如原生工具插件入口）。两种形态统一归一为包内相对路径，供交叉校验逐一断言产物中真实存在。
 */
function collectPackagePathRefs(text: string, packageName: string): string[] {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const refs = new Set<string>()
  for (const pattern of [`\\./node_modules/${escaped}/([^'"\\s\\]]+)`, `${escaped}/([^'"\\s\\]]+)`]) {
    for (const match of text.matchAll(new RegExp(pattern, "g"))) refs.add(match[1]!)
  }
  return [...refs]
}

describe("deepseek-harness 适配器", () => {
  test("生成 DSH bundle 插件包（package.json/cordis.patch.yml/skills/原生工具插件 bundle）", async () => {
    const {
      buildDeepSeekHarnessPlugin, DSH_PLUGIN_NAME,
      DSH_NATIVE_TOOLS_EXPORTS_KEY, DSH_NATIVE_TOOLS_ROW_NAME, DSH_NATIVE_TOOLS_ROW_ID,
    } = await import("../src/adapters/deepseek-harness/index")
    const pluginDir = join(TMP_ROOT, "dsh-plugin")
    rmSync(pluginDir, { recursive: true, force: true })
    try {
      const result = buildDeepSeekHarnessPlugin(pluginDir)

      // package.json：DSH bundle 通过 dsh.bundle.patch 声明 patch 层；
      // cordis 以裸包名 + 子路径 import 原生工具插件，Node 要求该子路径在 exports 中显式声明
      const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"))
      expect(pkg.name).toBe(DSH_PLUGIN_NAME)
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml")
      expect(pkg.exports[DSH_NATIVE_TOOLS_EXPORTS_KEY]).toBe("./.dsh-plugin/opx-tools.mjs")

      // cordis.patch.yml：挂载本包自有的原生工具插件 + DSH 官方 skill 根
      const patch = readFileSync(join(pluginDir, "cordis.patch.yml"), "utf-8")
      // 原生工具插件行：id / 裸包名子路径 / 默认无人值守
      expect(patch).toContain(`id: ${DSH_NATIVE_TOOLS_ROW_ID}`)
      expect(patch).toContain(`name: '${DSH_NATIVE_TOOLS_ROW_NAME}'`)
      expect(patch).toMatch(new RegExp(`${DSH_NATIVE_TOOLS_ROW_ID}[\\s\\S]*?unattended: true`))
      // 子路径是「包名 + / 子路径」而非「包名 + ./ 子路径」：后者会被当成包名 `pkg.` 而解析失败
      expect(DSH_NATIVE_TOOLS_ROW_NAME.startsWith(`${DSH_PLUGIN_NAME}/`)).toBe(true)
      // 编排工具改由原生插件承载，不再经 MCP client 桥接（其 worktree 固定在启动参数上，与项目无关）
      expect(patch).not.toContain("@deepseek-ai/dsh-mcp-client")
      expect(patch).not.toContain(".mcp-server/cli.mjs")
      expect(patch).not.toContain("--strip-opx-prefix")
      // DSH 官方 skill 根
      expect(patch).toContain("@deepseek-ai/dsh-skill-filesystem")
      expect(patch).toContain(`./node_modules/${DSH_PLUGIN_NAME}/assets/skills`)
      expect(patch).toContain("providerName: openspec-filesystem")
      // DSH 原生子代理：每个 assets/agents 子代理生成一行 Agent Preset 声明
      // + 一行 dsh-tool-subagent（以 agentPreset 引用前者）
      // （物理收敛为 developer / reviewer 两个，主代理模板不生成工具）
      expect(patch).toContain("@deepseek-ai/dsh-agent-preset")
      expect(patch).toContain("@deepseek-ai/dsh-tool-subagent")
      expect(patch).toContain("openspec-preset-developer")
      expect(patch).toContain("openspec-preset-reviewer")
      expect(patch).toContain("openspec-subagent-developer")
      expect(patch).toContain("openspec-subagent-reviewer")
      expect(patch).toContain("toolName: openspec_reviewer")
      expect(patch).toContain("agentPreset: openspec-reviewer")
      expect(patch).toContain("agentPreset: openspec-developer")
      // 子代理角色提示词随 preset 的 persona 插件下发（原生工具名，无 mcp__ 前缀）
      expect(patch).toContain("@deepseek-ai/dsh-persona")
      expect(patch).toContain("`opx_status`")
      expect(patch).toContain("`opx_agent_submit`")
      expect(patch).not.toContain("mcp__opx__")
      // DSH 0.2.1 起 dsh-tool-subagent 不再接受 persona/toolFilter/后台模式配置，
      // 旧字段留在 patch 里会让插件加载直接抛迁移错误
      expect(patch).not.toContain("toolFilter:")
      expect(patch).not.toContain("enableRunInBackground")
      expect(patch).not.toContain("backgroundMode")
      expect(patch).not.toMatch(/\bpersona:/)
      // 每个物理子代理 = 一行 preset + 一行 subagent 工具
      expect(patch.match(/id: openspec-preset-/g)?.length).toBe(result.agents.length)
      expect(patch.match(/id: openspec-subagent-/g)?.length).toBe(result.agents.length)
      expect(patch.match(/id: openspec-subagent-/g)?.length).toBe(2)

      // agents：与其它插件包一致保留子代理 markdown（DSH 同时通过 subagent 工具加载）
      expect(result.agents).toEqual(expect.arrayContaining(["openspec-developer", "openspec-reviewer"]))
      expect(result.agents).toHaveLength(2)
      expect(result.agents).not.toContain("openspec-main")
      expect(existsSync(join(pluginDir, "agents", "openspec-reviewer.md"))).toBe(true)

      // skills：orchestrator 与 reference/ 附属文件递归复制到 patch 引用的 skill 根 assets/skills
      // （包根 skills/ 与 patch 引用不一致，历史缺陷即产物写在包根，这里同时锁住唯一落位）
      expect(result.skills).toContain("orchestrator")
      expect(existsSync(join(pluginDir, "assets", "skills", "orchestrator", "SKILL.md"))).toBe(true)
      expect(existsSync(join(pluginDir, "assets", "skills", "java-quality-gate", "reference", "pmd-rules.md"))).toBe(true)
      expect(existsSync(join(pluginDir, "skills"))).toBe(false)

      // assets/workflows：task.yaml 随包分发且与源码一致
      const bundledWorkflow = readFileSync(join(pluginDir, "assets", "workflows", "task.yaml"), "utf-8")
      const sourceWorkflow = readFileSync(join(import.meta.dir, "..", "assets", "workflows", "task.yaml"), "utf-8")
      expect(bundledWorkflow).toBe(sourceWorkflow)

      // 原生工具插件 bundle：产物存在，且官方包保持 external（由 DSH 安装目录的 node_modules
      // 在运行时提供，不随本包分发）。不直接 import——测试环境无 DSH 安装，external 解析必然失败，
      // 这正是期望形态（与旧 MCP bundle 的自包含形态不同）。
      const nativeTools = join(pluginDir, ".dsh-plugin", "opx-tools.mjs")
      expect(existsSync(nativeTools)).toBe(true)
      const bundleSource = readFileSync(nativeTools, "utf-8")
      expect(bundleSource).toContain('from "@deepseek-ai/dsh-tools"')
      // 插件以 cordis 插件形态导出（name + apply），而非可直接执行的 CLI
      expect(bundleSource).toContain("openspec-opx-tools")
      expect(bundleSource).toContain("opx_orch_init")
    } finally {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  })

  /**
   * 交叉校验（本次缺陷的回归锁）：patch 与清单引用的每一个本包内路径，构建产物都必须落在同一位置。
   * 历史缺陷正是两侧各说各话——patch 引用 assets/skills，产物却写在包根 skills/；旧测试只分别断言
   * 「patch 文本含 assets/skills」与「包根存在 skills/…」，从未断言二者指的是同一个位置，
   * 于是一方写错也全绿，直到用户重启 DSH 后 skill 全部加载不上才暴露。
   */
  /**
   * 结构锁：DSH 0.2.1 起子代理角色与工具集只能由 Agent Preset 表达，
   * `dsh-tool-subagent` 的 persona/toolFilter/后台模式配置在加载期即抛迁移错误。
   * 这里解析生成物本身，确保「preset 声明 ↔ 工具引用」自洽且旧字段不会回流。
   */
  test("子代理 preset 与委派工具引用自洽（DSH 0.2.1 Agent Preset 形态）", async () => {
    const { buildDshPatchContent } = await import("../src/adapters/deepseek-harness/index")
    const entries = yaml.load(buildDshPatchContent(), { schema: DSH_PATCH_YAML_SCHEMA }) as Array<{
      insert?: Array<{ id: string; name: string; config: Record<string, any> }>
    }>
    const rows = entries.flatMap((entry) => entry.insert ?? [])
    const presetRows = rows.filter((row) => row.name === "@deepseek-ai/dsh-agent-preset")
    const toolRows = rows.filter((row) => row.name === "@deepseek-ai/dsh-tool-subagent")
    expect(presetRows).toHaveLength(2)
    expect(toolRows).toHaveLength(2)

    const presetIds = new Set(presetRows.map((row) => row.config.id))
    for (const tool of toolRows) {
      // 被引用的 preset 必须已声明，且声明行排在工具行之前（工具行加载时校验引用）
      expect(presetIds.has(tool.config.agentPreset)).toBe(true)
      const presetRow = presetRows.find((row) => row.config.id === tool.config.agentPreset)!
      expect(rows.indexOf(presetRow)).toBeLessThan(rows.indexOf(tool))
      // 已移除字段不得出现在工具配置中（否则 DSH 0.2.1 加载即抛错）
      for (const legacyKey of ["persona", "toolFilter", "enableRunInBackground", "backgroundMode"]) {
        expect(tool.config).not.toHaveProperty(legacyKey)
      }
    }
    for (const preset of presetRows) {
      const pluginNames = (preset.config.plugins as Array<{ name: string }>).map((plugin) => plugin.name)
      // 角色提示词进 persona 插件，工具面包含读写与搜索
      expect(pluginNames).toContain("@deepseek-ai/dsh-persona")
      expect(pluginNames).toContain("@deepseek-ai/dsh-tool-fs")
      expect(pluginNames).toContain("@deepseek-ai/dsh-tool-fs-search")
      expect(pluginNames).toContain("@deepseek-ai/dsh-tool-skill")
    }
  })

  test("cross-check：patch/清单引用的本包内路径在构建产物中真实存在", async () => {
    const { buildDeepSeekHarnessPlugin, DSH_PLUGIN_NAME, DSH_NATIVE_TOOLS_EXPORTS_KEY } = await import(
      "../src/adapters/deepseek-harness/index"
    )
    const pluginDir = join(TMP_ROOT, "dsh-path-crosscheck")
    rmSync(pluginDir, { recursive: true, force: true })
    try {
      buildDeepSeekHarnessPlugin(pluginDir)
      const rootDir = join(import.meta.dir, "..")

      // A. patch 中引用本包内路径的地方（自动抽取，新增引用一并纳入校验）
      const patchRefs = collectPackagePathRefs(
        stripYamlComments(readFileSync(join(pluginDir, "cordis.patch.yml"), "utf-8")),
        DSH_PLUGIN_NAME,
      )
      // 抽取结果须非空且覆盖两处已知引用，防止抽取逻辑退化成「零引用全绿」
      expect(patchRefs).toEqual(expect.arrayContaining(["assets/skills", ".dsh-plugin/opx-tools.mjs"]))
      for (const rel of patchRefs) {
        expect(existsSync(join(pluginDir, rel)), `patch 引用了 ${rel}，但构建产物中没有该路径`).toBe(true)
      }

      // B. 清单（package.json）中引用本包内路径的地方：DSH 按 dsh.bundle.patch 找 patch 文件，
      // cordis 按 exports 子路径解析原生工具插件入口
      const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"))
      for (const rel of [pkg.dsh?.bundle?.patch, pkg.exports?.[DSH_NATIVE_TOOLS_EXPORTS_KEY]] as string[]) {
        expect(existsSync(join(pluginDir, rel)), `清单引用了 ${rel}，但构建产物中没有该路径`).toBe(true)
      }

      // C. bundle 运行时从部署位置（<插件根>/.dsh-plugin/）逐级上溯探测读取的目录：
      // 用真实部署位置调用探测函数，才能发现「产物落位与运行时预期不一致」；
      // 同一份 patch 还服务 npm 根包形态，故这些相对路径也须被根包 files 白名单覆盖。
      const bundleUrl = pathToFileURL(join(pluginDir, ".dsh-plugin", "opx-tools.mjs")).href
      const { resolveTaskWorkflowPath } = await import("../src/core/workflow/loader")
      const { resolveSkillScanRoot } = await import("../src/skills/scan")
      expect(resolveTaskWorkflowPath(bundleUrl)).toBe(join(pluginDir, "assets", "workflows", "task.yaml"))
      expect(resolveSkillScanRoot(bundleUrl)).toBe(join(pluginDir, "assets", "skills"))
      // workflow 文件集合与源码一致（缺任一文件 loader 启动即抛错）
      expect(readdirSync(join(pluginDir, "assets", "workflows")).sort()).toEqual(
        readdirSync(join(rootDir, "assets", "workflows")).sort(),
      )

      const rootFiles: string[] = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8")).files
      for (const rel of patchRefs) {
        expect(
          rootFiles.some((f) => rel === f || rel.startsWith(`${f}/`)),
          `patch 引用的 ${rel} 未被根包 package.json 的 files 白名单覆盖，npm 形态的发布包里不会有它`,
        ).toBe(true)
      }
    } finally {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  })

  test("根 package.json 声明 DSH bundle（npm 直接安装路径）", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"))
    expect(pkg.dsh?.bundle?.patch).toBe("./dsh/cordis.patch.yml")
    expect(pkg.files).toContain("dsh")
    expect(pkg.files).toContain(".dsh-plugin")
    // 根包作为 DSH bundle 安装时，cordis 同样以裸包名 + 子路径 import 原生工具插件
    expect(pkg.exports["./.dsh-plugin/opx-tools.mjs"]).toBe("./.dsh-plugin/opx-tools.mjs")
    // dsh/cordis.patch.yml 是构建产物（prepack 生成），不要求仓库内已存在；
    // 这里直接验证生成器内容，确保 npm 发布时会带上原生工具插件与子代理工具。
    const { buildDshPatchContent, DSH_NATIVE_TOOLS_ROW_ID } = await import("../src/adapters/deepseek-harness/index")
    const generated = buildDshPatchContent()
    expect(generated).toContain(DSH_NATIVE_TOOLS_ROW_ID)
    expect(generated).toContain("@deepseek-ai/dsh-agent-preset")
    expect(generated).toContain("@deepseek-ai/dsh-tool-subagent")
    expect(generated).toContain("openspec-preset-developer")
    expect(generated).toContain("openspec-preset-reviewer")
    expect(generated).toContain("openspec-subagent-developer")
    expect(generated).toContain("openspec-subagent-reviewer")
    expect(generated).toContain("toolName: openspec_reviewer")
    expect(generated).toContain("agentPreset: openspec-reviewer")
  })

  test("sync-targets 包含 deepseek-harness 目标", async () => {
    const { SYNC_TARGETS } = await import("../scripts/sync-targets")
    const target = SYNC_TARGETS.find((t) => t.harness === "deepseek-harness")
    expect(target).toBeDefined()
    expect(target?.kind).toBe("dsh-profile")
    expect(target?.build).toBe("deepseek-harness")
    expect(target?.packageName).toBe("@ifrankwang/openspec-agents")
    expect(target?.cacheRoots).toContain("~/.dsh/profiles")
  })
})
