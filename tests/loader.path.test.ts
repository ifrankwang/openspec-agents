/**
 * resolveTaskWorkflowPath 逐级上溯探测的纯函数测试（不依赖真实仓库布局）：
 * - 源码形态：<tmp>/src/core/workflow/ 上溯 3 级命中 <tmp>/assets/workflows/task.yaml
 * - 插件根形态（dist/cache 修复后）：<tmp>/plugin/.mcp-server/ 上溯 1 级命中 <tmp>/plugin/assets/workflows/task.yaml
 * - 全缺失形态：上溯到文件系统根仍未命中，抛错且信息含「workflow 文件缺失」
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveTaskWorkflowPath } from "../src/core/workflow/loader"

const TMP_ROOT = mkdtempSync(join(tmpdir(), "opx-loader-path-"))

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

/** 构造 moduleDir 下的模块文件与 root 下的 assets/workflows/task.yaml，返回期望路径。 */
function setupForm(root: string, moduleDir: string, moduleFile: string): string {
  mkdirSync(moduleDir, { recursive: true })
  writeFileSync(join(moduleDir, moduleFile), "// module\n")
  const wfDir = join(root, "assets", "workflows")
  mkdirSync(wfDir, { recursive: true })
  const expected = join(wfDir, "task.yaml")
  writeFileSync(expected, "id: task\n")
  return expected
}

describe("resolveTaskWorkflowPath 逐级上溯探测", () => {
  test("源码形态：src/core/workflow/ 上溯 3 级命中仓库根 assets/workflows/task.yaml", () => {
    const root = join(TMP_ROOT, "src-form")
    const moduleDir = join(root, "src", "core", "workflow")
    const expected = setupForm(root, moduleDir, "module.ts")
    expect(resolveTaskWorkflowPath(pathToFileURL(join(moduleDir, "module.ts")).href)).toBe(expected)
  })

  test("插件根形态：plugin/.mcp-server/ 上溯 1 级命中插件根 assets/workflows/task.yaml", () => {
    const root = join(TMP_ROOT, "plugin-form")
    const moduleDir = join(root, ".mcp-server")
    const expected = setupForm(root, moduleDir, "cli.mjs")
    expect(resolveTaskWorkflowPath(pathToFileURL(join(moduleDir, "cli.mjs")).href)).toBe(expected)
  })

  test("全缺失形态：上溯到文件系统根未命中时抛错且信息含「workflow 文件缺失」", () => {
    const moduleDir = join(TMP_ROOT, "missing-form")
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, "module.ts"), "// module\n")
    expect(() => resolveTaskWorkflowPath(pathToFileURL(join(moduleDir, "module.ts")).href)).toThrow(
      /workflow 文件缺失/,
    )
  })
})
