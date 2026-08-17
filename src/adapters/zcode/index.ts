/**
 * zcode 适配器：ZCode 官方插件包生成（Plugin 机制，zcode.z.ai/en/docs/plugin）。
 * 复用共享生成器 src/adapters/plugin-common/，差异参数：清单目录 .zcode-plugin/。
 *
 * 与 claude code / codex 的文件分发形态不同：zcode 不再写 ~/.zcode 与项目 .zcode/config.json，
 * 插件安装/启用/禁用/卸载均为 GUI 动作，子代理为插件只读形态。
 *
 * 已知限制（接入文档注明）：
 * - zcode 自定义子代理为 Beta，子代理提问能力未经官方确认——默认无人值守规避；
 * - GUI 安装动作为人工步骤，本适配器仅保证生成结构与官方 schema 一致。
 */
import { resolve } from "../agent-md.ts"
import {
  buildPluginPackage,
  type PluginPackageResult,
} from "../plugin-common/index.ts"

/** 默认插件包输出目录（dist/ 已 gitignore，生成物不入库）。 */
export const ZCODE_PLUGIN_DIR = resolve("dist", "zcode-plugin")
const MANIFEST_DIR_NAME = ".zcode-plugin"

export type ZcodePluginBuildResult = PluginPackageResult

/**
 * 生成 ZCode 官方插件包到 outDir（默认 dist/zcode-plugin/）：
 * .zcode-plugin/plugin.json 清单、agents/*.md、skills/<名>/、assets/workflows/、.mcp.json、
 * .mcp-server/cli.mjs bundle。
 * 返回生成的组件清单供调用方/测试断言。
 */
export function buildZcodePlugin(outDir: string = ZCODE_PLUGIN_DIR): ZcodePluginBuildResult {
  return buildPluginPackage({ outDir, manifestDirName: MANIFEST_DIR_NAME })
}
