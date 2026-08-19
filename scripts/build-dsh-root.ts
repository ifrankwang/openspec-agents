/**
 * 构建发布包根部的 DSH 资产：
 * - .mcp-server/cli.mjs（MCP server bundle）
 * - dsh/cordis.patch.yml（由 assets/agents 动态生成子代理工具行）
 * 供 `npm publish` 的 prepack 使用，使 @ifrankwang/openspec-agents 本身可直接作为
 * DeepSeek Harness bundle 安装：`dsh plugin add @ifrankwang/openspec-agents`。
 * 同时供 scripts/sync.ts 在检测到 link 安装时重建根产物（link 安装直接读本仓库根产物）。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { bundleMcpServer } from "../src/adapters/plugin-common/index.ts"
import { buildDshPatchContent } from "../src/adapters/deepseek-harness/index.ts"

/** 重建 DSH 根产物（.mcp-server/cli.mjs + dsh/cordis.patch.yml）。幂等，可直接重复调用。 */
export function buildDshRootAssets(projectRoot: string): void {
  bundleMcpServer(projectRoot)
  const dshDir = join(projectRoot, "dsh")
  mkdirSync(dshDir, { recursive: true })
  writeFileSync(join(dshDir, "cordis.patch.yml"), buildDshPatchContent(), "utf-8")
  console.log(`[dsh] root MCP server bundle -> ${projectRoot}/.mcp-server/cli.mjs`)
  console.log(`[dsh] root patch -> ${dshDir}/cordis.patch.yml`)
}

if (import.meta.main) {
  buildDshRootAssets(resolve(import.meta.dir, ".."))
}
