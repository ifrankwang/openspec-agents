/**
 * package.json 发布形态测试（OpenCode V2）：
 * opencode 按 exports["./server"] 解析插件入口（V2 实测：入口命中 ./server 子导出，
 * 非 package main、也非 exports["."]），插件壳须默认导出 { id, setup }。
 * 断言 ./server 子导出指向插件壳入口，且入口默认导出具备 V2 要求的 id + setup，
 * 保证按包名配置 "plugins": ["openspec-agents"] 可被加载。
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

/** 复刻 opencode V2 插件判定：取默认导出，要求具备稳定 id 与 setup。 */
function getV2Plugin(mod: unknown): { id: unknown; setup: unknown } | undefined {
  const def = (mod as { default?: unknown })?.default
  if (!def || typeof def !== "object") return undefined
  const { id, setup } = def as { id?: unknown; setup?: unknown }
  if (typeof id !== "string" || typeof setup !== "function") return undefined
  return { id, setup }
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

  test("插件壳入口默认导出为 V2 { id, setup } 形态", async () => {
    const mod = await import("../src/adapters/opencode/index.ts")
    const entry = getV2Plugin(mod)
    expect(entry, "opencode V2 要求默认导出 { id, setup }").toBeDefined()
    expect(entry!.id).toBe("openspec-agents")
  })

  test("旧 V1 具名导出不再存在（插件壳仅默认导出）", async () => {
    const mod = (await import("../src/adapters/opencode/index.ts")) as Record<string, unknown>
    expect(mod.OpenspecOrchestratePlugin).toBeUndefined()
  })
})
