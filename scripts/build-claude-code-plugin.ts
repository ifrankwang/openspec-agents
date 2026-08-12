/**
 * Claude Code 插件包生成 CLI：bun run claude:plugin
 * 生成 dist/claude-code-plugin/ 插件包 + 仓库根 .claude-plugin/marketplace.json，
 * 供 Claude Code CLI `claude plugin marketplace add + claude plugin install` 或会话内
 * `/plugin marketplace add + /plugin install` 安装。
 */
import {
  buildClaudeCodePlugin,
  writeClaudeCodeMarketplace,
  CLAUDE_CODE_PLUGIN_DIR,
} from "../src/adapters/claude-code/index.ts"

const result = buildClaudeCodePlugin()
writeClaudeCodeMarketplace(CLAUDE_CODE_PLUGIN_DIR)
console.log(`Claude Code 插件包已生成：${result.pluginDir}`)
console.log(`agents: ${result.agents.length}（排除主代理模板）; skills: ${result.skills.length}; version: ${result.version}`)
console.log("安装（CLI，--scope project 写入 .claude/settings.json 团队共享）：")
console.log("  claude plugin marketplace add ./ --scope project")
console.log("  claude plugin install openspec-orchestrate --scope project")
console.log("或会话内：/plugin marketplace add ./ → /plugin install openspec-orchestrate；卸载 /plugin uninstall openspec-orchestrate")
