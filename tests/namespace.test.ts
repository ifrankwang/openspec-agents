import { describe, expect, test } from "bun:test"
import { generateIsolationNamespace, derivePortFromNamespace } from "../src/core/namespace"

describe("generateIsolationNamespace", () => {
  test("同 changeId 结果确定", () => {
    expect(generateIsolationNamespace("change-abc")).toBe(generateIsolationNamespace("change-abc"))
  })

  test("不同 changeId 结果不同", () => {
    expect(generateIsolationNamespace("change-abc")).not.toBe(generateIsolationNamespace("change-def"))
  })

  test("输出为 6 位小写 hex", () => {
    const ns = generateIsolationNamespace("change-abc")
    expect(ns).toMatch(/^[0-9a-f]{6}$/)
  })
})

describe("derivePortFromNamespace", () => {
  test("输出在 [20000, 50000) 区间", () => {
    for (const ns of ["a1b2c3", "000000", "ffffff", "123456"]) {
      const port = derivePortFromNamespace(ns)
      expect(port).toBeGreaterThanOrEqual(20000)
      expect(port).toBeLessThan(50000)
    }
  })

  test("确定性", () => {
    expect(derivePortFromNamespace("a1b2c3")).toBe(derivePortFromNamespace("a1b2c3"))
  })

  test("不同 namespace 通常派生不同端口", () => {
    expect(derivePortFromNamespace("a1b2c3")).not.toBe(derivePortFromNamespace("111111"))
  })
})
