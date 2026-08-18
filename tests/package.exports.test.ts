/**
 * package.json 发布形态测试（README 可执行性复核修复）：
 * opencode npm server 插件按 exports["./server"] 解析入口，缺失时退回 package main
 * （指向内核，导出大量非函数值）——opencode getLegacyPlugins 遇首个非函数导出即抛错、
 * 插件被静默跳过，导致 "plugin": ["openspec-agents"] 不生效。
 * 断言 ./server 子导出指向插件壳入口，且该入口全部导出均为 opencode 可接受的
 * 函数（或 { server: fn }）形态，保证插件按包名可被加载。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8")) as {
  main: string
  exports: Record<string, { import?: string; types?: string }>
}

/** 复刻 opencode getServerPlugin 判定：函数直取；对象取 server 函数字段。 */
function getServerPlugin(value: unknown): unknown {
  if (typeof value === "function") return value
  if (value && typeof value === "object" && "server" in value) {
    const server = (value as { server?: unknown }).server
    if (typeof server === "function") return server
  }
  return undefined
}

describe("package.json 发布形态", () => {
  test("./server 子导出指向 OpenCode 插件壳入口", () => {
    expect(pkg.exports["./server"]).toBeDefined()
    expect(pkg.exports["./server"]?.import).toBe("./src/adapters/opencode/index.ts")
    expect(pkg.exports["./server"]?.types).toBe("./src/adapters/opencode/index.ts")
  })

  test("./zcode 子导出指向 zcode 适配器（插件包生成器）", () => {
    expect(pkg.exports["./zcode"]).toBeDefined()
    expect(pkg.exports["./zcode"]?.import).toBe("./src/adapters/zcode/index.ts")
    expect(pkg.exports["./zcode"]?.types).toBe("./src/adapters/zcode/index.ts")
  })

  test("./deepseek-harness 与 ./dsh 子导出指向 DSH 适配器", () => {
    expect(pkg.exports["./deepseek-harness"]).toBeDefined()
    expect(pkg.exports["./deepseek-harness"]?.import).toBe("./src/adapters/deepseek-harness/index.ts")
    expect(pkg.exports["./deepseek-harness"]?.types).toBe("./src/adapters/deepseek-harness/index.ts")
    expect(pkg.exports["./dsh"]).toBeDefined()
    expect(pkg.exports["./dsh"]?.import).toBe("./src/adapters/deepseek-harness/index.ts")
    expect(pkg.exports["./dsh"]?.types).toBe("./src/adapters/deepseek-harness/index.ts")
  })

  test("插件壳入口全部导出均为 opencode 可接受的函数形态", async () => {
    const mod = (await import("../src/adapters/opencode/index.ts")) as Record<string, unknown>
    const entries = Object.values(mod)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(getServerPlugin(entry), "opencode 遇非函数导出即抛错并静默跳过插件").toBeDefined()
    }
  })
})
