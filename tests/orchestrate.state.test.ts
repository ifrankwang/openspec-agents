import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readStateByChangeId } from "../src/core/state"

const CID = "legacy-state"

afterAll(() => {
  rmSync("/tmp/orchestrate-state-test", { recursive: true, force: true })
})

function statePath(root: string): string {
  const dir = join(root, ".opencode", ".orchestrate_state")
  mkdirSync(dir, { recursive: true })
  return join(dir, `${CID}.json`)
}

describe("state 兼容性", () => {
  test("旧 state 缺 tasks 时保留不兼容错误", async () => {
    const root = `/tmp/orchestrate-state-test/${Date.now()}`
    writeFileSync(statePath(root), JSON.stringify({ changeId: CID, taskGroups: [{ id: "1" }] }))

    await expect(readStateByChangeId(root, CID)).rejects.toThrow(/旧版本格式，不兼容当前版本/)
  })

  test("JSON 无法读取时返回空状态", async () => {
    const root = `/tmp/orchestrate-state-test/${Date.now()}-invalid`
    writeFileSync(statePath(root), "{")

    await expect(readStateByChangeId(root, CID)).resolves.toBeNull()
  })
})
