/**
 * claude code 适配器：Claude Code 官方插件包生成（Plugin 机制，code.claude.com/docs/en/plugins）。
 * 复用共享生成器 src/adapters/plugin-common/，差异参数：清单目录 .claude-plugin/。
 *
 * 与 zcode 同构的官方插件形态：安装/启用/禁用/卸载均为 CLI 或会话内命令
 * （claude plugin marketplace add + claude plugin install，或 /plugin marketplace add + /plugin install），
 * 插件安装后复制到本地缓存，子代理为插件只读形态。
 *
 * 已知限制（接入文档注明）：
 * - 插件子代理为 read-only，不支持 hooks/mcpServers/permissionMode frontmatter（本项目子代理
 *   本就只读，无冲突）；
 * - claude plugin install / 会话内 /plugin install 为人工步骤，本适配器仅保证生成结构与官方
 *   schema 一致。
 */
import { resolve } from "../agent-md.ts"
import {
  buildPluginPackage,
  type PluginPackageResult,
} from "../plugin-common/index.ts"

/** 默认插件包输出目录（dist/ 已 gitignore，生成物不入库）。 */
export const CLAUDE_CODE_PLUGIN_DIR = resolve("dist", "claude-code-plugin")
const MANIFEST_DIR_NAME = ".claude-plugin"

export type ClaudeCodePluginBuildResult = PluginPackageResult

/**
 * 生成 Claude Code 官方插件包到 outDir（默认 dist/claude-code-plugin/）：
 * .claude-plugin/plugin.json 清单、agents/*.md、skills/<名>/、assets/workflows/、.mcp.json、
 * .mcp-server/cli.mjs bundle。
 * 返回生成的组件清单供调用方/测试断言。
 */
export function buildClaudeCodePlugin(outDir: string = CLAUDE_CODE_PLUGIN_DIR): ClaudeCodePluginBuildResult {
  return buildPluginPackage({ outDir, manifestDirName: MANIFEST_DIR_NAME })
}
