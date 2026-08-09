/**
 * detectChanges（工具层检查点增量检测）单测。
 *
 * 覆盖（D2）：
 * 1. 有检查点：diff 检查点..HEAD
 * 2. 无检查点（用 base_ref 兜底）
 * 3. 纯 openspec 文档变更 → hasNonDocChange=false
 * 4. 已提交代码变更 / 未提交代码变更（status --porcelain）→ hasNonDocChange=true
 * 5. git 不可用降级（diff/status 失败）→ hasNonDocChange=true
 * 6. 首个 commit 无父提交场景（base_ref 为空 / 检查点与 base_ref 均缺失）→ 降级全量
 */
import { describe, expect, test, afterAll } from "bun:test"
import { __setGitRunner, detectChanges } from "../src/core/git"
import { FakeGitRunner } from "./helpers"

const BASE_REF = "base000000000000000000000000000000000001"

function fresh(): FakeGitRunner {
  const fake = new FakeGitRunner()
  __setGitRunner(fake)
  return fake
}

afterAll(() => { __setGitRunner(null) })

describe("detectChanges 有检查点", () => {
  test("diff 检查点..HEAD 含代码 → hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.diffNameOnlyByRange.set("cp1..HEAD", "src/a.ts\nsrc/b.ts")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual(["src/a.ts", "src/b.ts"])
    expect(r.hasNonDocChange).toBe(true)
  })

  test("diff 检查点..HEAD 空（无已提交变更）+ 无未提交 → hasNonDocChange=false", async () => {
    fresh()
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual([])
    expect(r.hasNonDocChange).toBe(false)
  })
})

describe("detectChanges 无检查点", () => {
  test("用 base_ref 兜底（diff baseRef..HEAD 含代码）→ hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.diffNameOnlyByRange.set(`${BASE_REF}..HEAD`, "src/a.ts")
    const r = await detectChanges("/wt", { checkpoint: undefined, baseRef: BASE_REF })
    expect(r.files).toEqual(["src/a.ts"])
    expect(r.hasNonDocChange).toBe(true)
  })

  test("检查点与 base_ref 均缺失 → 无法界定区间，降级全量", async () => {
    fresh()
    const r = await detectChanges("/wt", { checkpoint: undefined, baseRef: undefined })
    expect(r.hasNonDocChange).toBe(true)
  })

  test("base_ref 为空字符串（首个 commit 无父提交 / merge-base 为空）→ 降级全量", async () => {
    fresh()
    const r = await detectChanges("/wt", { checkpoint: undefined, baseRef: "" })
    expect(r.hasNonDocChange).toBe(true)
  })
})

describe("detectChanges 文档 vs 变更判定", () => {
  test("纯 openspec 文档变更 → hasNonDocChange=false（openspec/ 下算文档不算变更）", async () => {
    const fake = fresh()
    fake.diffNameOnlyByRange.set("cp1..HEAD", "openspec/changes/cid/design.md\nopenspec/changes/cid/tasks.md")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual(["openspec/changes/cid/design.md", "openspec/changes/cid/tasks.md"])
    expect(r.hasNonDocChange).toBe(false)
  })

  test("已提交变更含 openspec 与代码混合 → hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.diffNameOnlyByRange.set("cp1..HEAD", "openspec/changes/cid/design.md\nsrc/a.ts")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.hasNonDocChange).toBe(true)
  })
})

describe("detectChanges 未提交变更", () => {
  test("未提交代码变更（status --porcelain）→ hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.statusPorcelainOutput.set("/wt", " M src/foo.ts")
    const r = await detectChanges("/wt", { checkpoint: undefined, baseRef: BASE_REF })
    expect(r.files).toEqual(["src/foo.ts"])
    expect(r.hasNonDocChange).toBe(true)
  })

  test("未提交 openspec 文档变更被过滤 → hasNonDocChange=false", async () => {
    const fake = fresh()
    fake.statusPorcelainOutput.set("/wt", " M openspec/changes/cid/tasks.md")
    const r = await detectChanges("/wt", { checkpoint: undefined, baseRef: BASE_REF })
    expect(r.files).toEqual([])
    expect(r.hasNonDocChange).toBe(false)
  })
})

describe("detectChanges 已提交 + 未提交变更混合合并", () => {
  test("已提交含代码 + 未提交仅 openspec → files 取已提交来源、hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.diffNameOnlyByRange.set("cp1..HEAD", "src/a.ts")
    fake.statusPorcelainOutput.set("/wt", " M openspec/changes/cid/tasks.md")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual(["src/a.ts"])
    expect(r.hasNonDocChange).toBe(true)
  })

  test("已提交仅 openspec + 未提交含代码 → files 合并两来源路径、hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.diffNameOnlyByRange.set("cp1..HEAD", "openspec/changes/cid/design.md")
    fake.statusPorcelainOutput.set("/wt", " M src/foo.ts")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual(["openspec/changes/cid/design.md", "src/foo.ts"])
    expect(r.hasNonDocChange).toBe(true)
  })

  test("两来源均仅 openspec 文档 → hasNonDocChange=false", async () => {
    const fake = fresh()
    fake.diffNameOnlyByRange.set("cp1..HEAD", "openspec/changes/cid/design.md")
    fake.statusPorcelainOutput.set("/wt", " M openspec/changes/cid/tasks.md")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual(["openspec/changes/cid/design.md"])
    expect(r.hasNonDocChange).toBe(false)
  })

  test("两来源均无变更（diff 空 + status 空）→ hasNonDocChange=false", async () => {
    const fake = fresh()
    fake.diffNameOnlyByRange.set("cp1..HEAD", "")
    fake.statusPorcelainOutput.set("/wt", "")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual([])
    expect(r.hasNonDocChange).toBe(false)
  })
})

describe("detectChanges status --porcelain rename 条目", () => {
  test("rename 目标在 openspec/ 下 → 过滤为文档（不误判为变更）", async () => {
    const fake = fresh()
    fake.statusPorcelainOutput.set("/wt", "R  openspec/changes/cid/old.md -> openspec/changes/cid/new.md")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual([])
    expect(r.hasNonDocChange).toBe(false)
  })

  test("rename 目标在代码路径 → 解析为变更、hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.statusPorcelainOutput.set("/wt", "R  openspec/changes/cid/old.md -> src/main/java/com/t/App.java")
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.files).toEqual(["src/main/java/com/t/App.java"])
    expect(r.hasNonDocChange).toBe(true)
  })
})

describe("detectChanges git 不可用降级", () => {
  test("diff 失败（如仓库损坏/非 git 目录）→ 降级 hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.failDiff = true
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.hasNonDocChange).toBe(true)
  })

  test("status --porcelain 失败 → 降级 hasNonDocChange=true", async () => {
    const fake = fresh()
    fake.failStatus = true
    const r = await detectChanges("/wt", { checkpoint: "cp1", baseRef: BASE_REF })
    expect(r.hasNonDocChange).toBe(true)
  })
})
