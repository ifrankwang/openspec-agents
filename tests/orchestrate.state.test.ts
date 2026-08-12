import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readStateByChangeId, writeState } from "../src/core/state"
import { generateIsolationNamespace } from "../src/core/namespace"
import type { OrchestrateState } from "../src/core/types"

const CID = "legacy-state"

afterAll(() => {
  rmSync("/tmp/orchestrate-state-test", { recursive: true, force: true })
  rmSync("/tmp/orchestrate-writestate-test", { recursive: true, force: true })
})

function statePath(root: string): string {
  const dir = join(root, "openspec", "states")
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

  test("旧 state 缺 isolationNamespace 时自动补全", async () => {
    const root = `/tmp/orchestrate-state-test/${Date.now()}-ns`
    writeFileSync(
      statePath(root),
      JSON.stringify({
        changeId: CID,
        taskGroupId: "1",
        baseBranch: "main",
        taskGroups: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    )

    const state = await readStateByChangeId(root, CID)
    expect(state).not.toBeNull()
    expect(state!.isolationNamespace).toBe(generateIsolationNamespace(CID))
  })
})

describe("writeState worktree 回写", () => {
  const base = `/tmp/orchestrate-writestate-test/writestate-${Date.now()}`
  const mainRepo = join(base, "main")
  const worktreeDir = join(base, "worktree")

  function makeSampleState(changeId: string): OrchestrateState {
    return {
      changeId,
      isolationNamespace: "a1b2c3",
      taskGroupId: "1",
      baseBranch: "main",
      taskGroups: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  function readStateFromDisk(root: string, changeId: string): Record<string, unknown> | null {
    const p = join(root, "openspec", "states", `${changeId}.json`)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>
  }

  beforeEach(() => {
    mkdirSync(mainRepo, { recursive: true })
    mkdirSync(worktreeDir, { recursive: true })
    const gitdir = join(mainRepo, ".git", "worktrees", "test")
    mkdirSync(join(mainRepo, ".git"), { recursive: true })
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitdir}`)
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  test("worktree 中 writeState 写到主仓库的 {changeId}.json", async () => {
    const state = makeSampleState("wt-write-1")
    await writeState(worktreeDir, state)

    const inMain = readStateFromDisk(mainRepo, "wt-write-1")
    expect(inMain).not.toBeNull()
    expect(inMain?.changeId).toBe("wt-write-1")

    const inWorktree = join(worktreeDir, "openspec", "states", "wt-write-1.json")
    expect(existsSync(inWorktree)).toBe(false)
  })

  test("普通目录（.git 为目录）writeState 写原路径", async () => {
    const normalDir = join(base, "normal")
    mkdirSync(join(normalDir, ".git"), { recursive: true })

    const state = makeSampleState("wt-write-2")
    await writeState(normalDir, state)

    const inNormal = readStateFromDisk(normalDir, "wt-write-2")
    expect(inNormal).not.toBeNull()
    expect(inNormal?.changeId).toBe("wt-write-2")
  })
})
