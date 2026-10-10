/**
 * DeepSeek Harness (DSH) 适配器测试：生成 DSH bundle 插件包，
 * 校验 package.json（dsh.bundle.patch + 原生工具插件 exports）、cordis.patch.yml、
 * 原生工具插件 bundle 与 skills。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const TMP_ROOT = "/tmp/deepseek-harness-test"

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

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
      // DSH 原生子代理工具：每个 assets/agents 子代理生成一个 dsh-tool-subagent 行
      // （物理收敛为 developer / reviewer 两个，主代理模板不生成工具）
      expect(patch).toContain("@deepseek-ai/dsh-tool-subagent")
      expect(patch).toContain("openspec-subagent-developer")
      expect(patch).toContain("openspec-subagent-reviewer")
      expect(patch).toContain("toolName: openspec_reviewer")
      // 子代理 persona 中的工具接入说明同步为原生工具名（无 mcp__ 前缀）
      expect(patch).toContain("`opx_status`")
      expect(patch).toContain("`opx_agent_submit`")
      expect(patch).not.toContain("mcp__opx__")
      // 权限并集：两个物理 agent frontmatter 均为 edit: allow → denyEditTools 不设写工具过滤
      expect(patch).not.toContain("toolFilter:")
      expect(patch.match(/id: openspec-subagent-/g)?.length).toBe(result.agents.length)
      expect(patch.match(/id: openspec-subagent-/g)?.length).toBe(2)

      // agents：与其它插件包一致保留子代理 markdown（DSH 同时通过 subagent 工具加载）
      expect(result.agents).toEqual(expect.arrayContaining(["openspec-developer", "openspec-reviewer"]))
      expect(result.agents).toHaveLength(2)
      expect(result.agents).not.toContain("openspec-main")
      expect(existsSync(join(pluginDir, "agents", "openspec-reviewer.md"))).toBe(true)

      // skills：orchestrator 与 reference/ 附属文件递归复制
      expect(result.skills).toContain("orchestrator")
      expect(existsSync(join(pluginDir, "skills", "orchestrator", "SKILL.md"))).toBe(true)
      expect(existsSync(join(pluginDir, "skills", "java-quality-gate", "reference", "pmd-rules.md"))).toBe(true)

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
    expect(generated).toContain("@deepseek-ai/dsh-tool-subagent")
    expect(generated).toContain("openspec-subagent-developer")
    expect(generated).toContain("openspec-subagent-reviewer")
    expect(generated).toContain("toolName: openspec_reviewer")
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
