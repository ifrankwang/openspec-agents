/**
 * DeepSeek Harness (DSH) 适配器测试：生成 DSH bundle 插件包，
 * 校验 package.json（dsh.bundle.patch）、cordis.patch.yml、MCP bundle 与 skills。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const TMP_ROOT = "/tmp/deepseek-harness-test"

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("deepseek-harness 适配器", () => {
  test("生成 DSH bundle 插件包（package.json/cordis.patch.yml/skills/.mcp-server）", async () => {
    const { buildDeepSeekHarnessPlugin, DSH_PLUGIN_NAME } = await import("../src/adapters/deepseek-harness/index")
    const pluginDir = join(TMP_ROOT, "dsh-plugin")
    rmSync(pluginDir, { recursive: true, force: true })
    try {
      const result = buildDeepSeekHarnessPlugin(pluginDir)

      // package.json：DSH bundle 通过 dsh.bundle.patch 声明 patch 层
      const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"))
      expect(pkg.name).toBe(DSH_PLUGIN_NAME)
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml")

      // cordis.patch.yml：插入 DSH 官方 MCP client 与 skill filesystem
      const patch = readFileSync(join(pluginDir, "cordis.patch.yml"), "utf-8")
      expect(patch).toContain("@deepseek-ai/dsh-mcp-client")
        expect(patch).toContain("serverName: opx")
        expect(patch).toContain("--strip-opx-prefix")
      expect(patch).toContain("@deepseek-ai/dsh-skill-filesystem")
      expect(patch).toContain("./node_modules/@ifrankwang/openspec-agents/.mcp-server/cli.mjs")
      expect(patch).toContain("./node_modules/@ifrankwang/openspec-agents/assets/skills")
      expect(patch).toContain("providerName: openspec-filesystem")
      // DSH 原生子代理工具：每个 assets/agents 子代理生成一个 dsh-tool-subagent 行
      expect(patch).toContain("@deepseek-ai/dsh-tool-subagent")
      expect(patch).toContain("openspec-subagent-architect")
      expect(patch).toContain("toolName: openspec_architect")
      expect(patch).toContain("toolFilter:")
      expect(patch.match(/id: openspec-subagent-/g)?.length).toBe(result.agents.length)

      // agents：与其它插件包一致保留子代理 markdown（DSH 同时通过 subagent 工具加载）
      expect(result.agents).toContain("openspec-architect")
      expect(result.agents).not.toContain("openspec-main")
      expect(existsSync(join(pluginDir, "agents", "openspec-architect.md"))).toBe(true)

      // skills：orchestrator 与 reference/ 附属文件递归复制
      expect(result.skills).toContain("orchestrator")
      expect(existsSync(join(pluginDir, "skills", "orchestrator", "SKILL.md"))).toBe(true)
      expect(existsSync(join(pluginDir, "skills", "java-quality-gate", "reference", "pmd-rules.md"))).toBe(true)

      // assets/workflows：task.yaml 随包分发且与源码一致
      const bundledWorkflow = readFileSync(join(pluginDir, "assets", "workflows", "task.yaml"), "utf-8")
      const sourceWorkflow = readFileSync(join(import.meta.dir, "..", "assets", "workflows", "task.yaml"), "utf-8")
      expect(bundledWorkflow).toBe(sourceWorkflow)

      // MCP server bundle：产物存在且可被 node 解析（结构正确性边界，不实际启动 server）
      expect(existsSync(join(pluginDir, ".mcp-server", "cli.mjs"))).toBe(true)
      await import(pathToFileURL(join(pluginDir, ".mcp-server", "cli.mjs")).href)
    } finally {
      rmSync(pluginDir, { recursive: true, force: true })
    }
  })

  test("根 package.json 声明 DSH bundle（npm 直接安装路径）", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"))
    expect(pkg.dsh?.bundle?.patch).toBe("./dsh/cordis.patch.yml")
    expect(pkg.files).toContain("dsh")
    expect(pkg.files).toContain(".mcp-server")
    // dsh/cordis.patch.yml 是构建产物（prepack 生成），不要求仓库内已存在；
    // 这里直接验证生成器内容，确保 npm 发布时会带上 DSH 子代理工具。
    const { buildDshPatchContent } = await import("../src/adapters/deepseek-harness/index")
    const generated = buildDshPatchContent()
    expect(generated).toContain("@deepseek-ai/dsh-tool-subagent")
    expect(generated).toContain("openspec-subagent-architect")
    expect(generated).toContain("toolName: openspec_architect")
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
