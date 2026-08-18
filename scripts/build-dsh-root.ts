/**
 * 构建发布包根部的 DSH 资产：
 * - .mcp-server/cli.mjs（MCP server bundle）
 * - dsh/cordis.patch.yml（由 assets/agents 动态生成子代理工具行）
 * 供 `npm publish` 的 prepack 使用，使 @ifrankwang/openspec-agents 本身可直接作为
 * DeepSeek Harness bundle 安装：`dsh plugin add @ifrankwang/openspec-agents`。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { bundleMcpServer } from "../src/adapters/plugin-common/index.ts"
import { buildDshPatchContent } from "../src/adapters/deepseek-harness/index.ts"

const projectRoot = resolve(import.meta.dir, "..")
bundleMcpServer(projectRoot)
const dshDir = join(projectRoot, "dsh")
mkdirSync(dshDir, { recursive: true })
writeFileSync(join(dshDir, "cordis.patch.yml"), buildDshPatchContent(), "utf-8")
console.log(`[dsh] root MCP server bundle -> ${projectRoot}/.mcp-server/cli.mjs`)
console.log(`[dsh] root patch -> ${dshDir}/cordis.patch.yml`)
