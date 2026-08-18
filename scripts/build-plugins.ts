/**
 * 统一插件包构建脚本（非用户面向，供 CI 与 sync 内部调用）。
 * 构建 Claude Code / Codex / ZCode / DeepSeek Harness 插件包到 dist/<harness>-plugin/。
 * 不在本仓库生成任何 marketplace.json。
 */
import { buildClaudeCodePlugin, CLAUDE_CODE_PLUGIN_DIR } from "../src/adapters/claude-code/index.ts"
import { buildCodexPlugin, CODEX_PLUGIN_DIR } from "../src/adapters/codex/index.ts"
import { buildZcodePlugin, ZCODE_PLUGIN_DIR } from "../src/adapters/zcode/index.ts"
import { buildDeepSeekHarnessPlugin, DEEP_SEEK_HARNESS_PLUGIN_DIR } from "../src/adapters/deepseek-harness/index.ts"

const results = {
  claude: buildClaudeCodePlugin(CLAUDE_CODE_PLUGIN_DIR),
  codex: buildCodexPlugin(CODEX_PLUGIN_DIR),
  zcode: buildZcodePlugin(ZCODE_PLUGIN_DIR),
  "deepseek-harness": buildDeepSeekHarnessPlugin(DEEP_SEEK_HARNESS_PLUGIN_DIR),
}

for (const [name, r] of Object.entries(results)) {
  console.log(`[${name}] plugin package -> ${r.pluginDir} (agents: ${r.agents.length}, skills: ${r.skills.length}, version: ${r.version})`)
}
