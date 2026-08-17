/**
 * ZCode 插件包生成 CLI：bun run zcode:plugin
 * 生成 dist/zcode-plugin/ 插件包 + 仓库根 marketplace.json，供 ZCode GUI「Add marketplace → Install」安装。
 */
import { buildZcodePlugin, writeZcodeMarketplace, ZCODE_PLUGIN_DIR } from "../src/adapters/zcode/index.ts"

const result = buildZcodePlugin()
writeZcodeMarketplace(ZCODE_PLUGIN_DIR)
console.log(`ZCode 插件包已生成：${result.pluginDir}`)
console.log(`agents: ${result.agents.length}（排除主代理模板）; skills: ${result.skills.length}; version: ${result.version}`)
console.log("安装：ZCode 设置 → 插件 → Create → Add marketplace → 选仓库根目录（marketplace.json 所在目录）→ Install openspec-agents")
