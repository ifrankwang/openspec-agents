/**
 * 构建发布包根部（包根）的产物，供两类消费方使用：
 * - `.mcp-server/cli.mjs`（MCP server bundle）：OpenCode 插件的 MCP 入口
 *   （src/adapters/opencode/index.ts 以包根 `.mcp-server/cli.mjs` 启动 stdio server）。
 * - `.dsh-plugin/opx-tools.mjs`（DSH 原生工具插件 bundle，cordis 以裸包名 + 子路径 import）
 *   + `dsh/cordis.patch.yml`（挂载本包原生工具插件 + 动态生成的子代理工具行）。
 *
 * 两类产物的消费方与用途互不相同，不可互相替代，故必须同时产出。本函数供 `npm publish`
 * 的 prepack（package.json 的 prepack = bun run build:dsh）使用，使发布包同时可直接被
 * OpenCode 加载与作为 DeepSeek Harness bundle 安装（`dsh plugin add @ifrankwang/openspec-agents`）；
 * 也供 scripts/sync.ts 在同步前重建根产物（OpenCode 源码缓存同步与 DSH link 安装都直接读本仓库根产物）。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { bundleMcpServer, bundleDshNativeTools } from "../src/adapters/plugin-common/index.ts"
import { buildDshPatchContent } from "../src/adapters/deepseek-harness/index.ts"

/**
 * 重建包根产物（.mcp-server/cli.mjs + .dsh-plugin/opx-tools.mjs + dsh/cordis.patch.yml）。
 * 幂等，可直接重复调用。
 */
export function buildRootArtifacts(projectRoot: string): void {
  const mcpEntry = bundleMcpServer(projectRoot)
  bundleDshNativeTools(projectRoot)
  const dshDir = join(projectRoot, "dsh")
  mkdirSync(dshDir, { recursive: true })
  writeFileSync(join(dshDir, "cordis.patch.yml"), buildDshPatchContent(), "utf-8")
  console.log(`[root] MCP server bundle (OpenCode 入口) -> ${mcpEntry}`)
  console.log(`[dsh] root native tools plugin bundle -> ${projectRoot}/.dsh-plugin/opx-tools.mjs`)
  console.log(`[dsh] root patch -> ${dshDir}/cordis.patch.yml`)
}

if (import.meta.main) {
  buildRootArtifacts(resolve(import.meta.dir, ".."))
}
