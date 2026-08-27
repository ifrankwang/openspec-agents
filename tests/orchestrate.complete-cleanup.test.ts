/**
 * 任务组收尾清理测试（opx_orch_complete_task_group 清理段）：
 * - 补救链物理成功：git worktree remove 失败时经文件系统兜底删除 + prune，分支正常删除，无残留警告
 * - 完全残留：目录被只读父目录锁死无法删除时，收尾不阻断（completed_at 照写），返回体给出残留警告区块
 *   与人工处理命令，metadata.cleanup_residual 落盘，且不执行 branch -D
 * - 无分支引用时仅做 worktree 侧清理：目录消失即成功，不执行 branch -D、无残留警告
 *
 * 运行：bun test tests/orchestrate.complete-cleanup.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test"
import { chmodSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { agent_submit, complete_task_group } from "../src/adapters/opencode/tools"
import {
  makeCtx, makeOrchCtx, setupWithFakeGit, teardown, initSimpleWorktree, readState,
  type FakeGitRunner,
} from "./helpers"

const CID = "cleanup-e2e"
const DEV = "openspec-developer"
const REVIEWER = "openspec-reviewer"

afterAll(() => { __setGitRunner(null) })

function fresh(): { root: string; wt: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/cleanupe2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree: wt, fakeGit } = setupWithFakeGit(root, CID)
  return { root, wt, fakeGit }
}

function wtPathOf(wt: string): string {
  return join(wt, ".worktree", CID, "task-group-1")
}

/** 读当前 task WorkItem（落盘 JSON）。 */
function taskItemOf(wt: string): any {
  return readState(wt, CID)!.workItems.find((w: any) => w.id === "task:1")
}

function writeStateFile(wt: string, mutate: (item: any) => void): void {
  const statePath = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(statePath, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

/** simple 模式推到 done：implement passed → quality_review passed（全任务验证）。 */
async function driveToDone(wt: string): Promise<void> {
  await agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
    makeCtx(DEV, wt),
  )
  await agent_submit.execute(
    { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
    makeCtx(REVIEWER, wt),
  )
}

describe("收尾清理：git remove 失败的补救链", () => {

  test("failWorktreeRemove + 真实桩目录存在 → 兜底删除生效、prune 与删分支均执行、无残留警告", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      const path = wtPathOf(wt)
      // FakeGit 的 worktree add 已建目录；再补一个真实文件构成非空桩目录
      expect(existsSync(path)).toBe(true)
      writeFileSync(join(path, "marker.txt"), "stub")

      fakeGit.failWorktreeRemove = true
      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      // 收尾成功且带兜底补救说明，无残留警告
      expect(out).toContain("任务组已完成并合并到")
      expect(out).toContain("兜底删除")
      expect(out).not.toContain("清理残留")
      // 桩目录确实从磁盘消失，默认布局的两级空父目录一并清扫
      expect(existsSync(path)).toBe(false)
      expect(existsSync(join(wt, ".worktree", CID))).toBe(false)
      // callLog 含 prune 与 branch -D
      expect(fakeGit.callLog.some((l) => l.includes("worktree prune"))).toBe(true)
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(true)
      // completed_at 写入且无 cleanup_residual
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(taskItemOf(wt).metadata["cleanup_residual"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("收尾清理：目录完全残留时不阻断收尾", () => {

  test("父目录只读使 fs 兜底删除也失败 → 残留警告区块 + cleanup_residual 落盘 + 不执行 branch -D", async () => {
    // chmod 权限语义仅 POSIX 有效
    if (process.platform === "win32") return

    const { root, wt, fakeGit } = fresh()
    const groupDir = join(wt, ".worktree", CID)
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      expect(existsSync(wtPathOf(wt))).toBe(true)
      // 锁死叶子目录的父目录，使 fs 兜底删除在最后一步 rmdir 时失败
      chmodSync(groupDir, 0o555)

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      // 收尾不被阻断：合并成功消息 + 残留警告区块 + 人工处理命令
      expect(out).toContain("任务组已完成并合并到")
      expect(out).toContain("worktree 清理残留")
      expect(out).toContain(`\`${wtPathOf(wt)}\``)
      expect(out).toContain("rm -rf")
      expect(out).toContain("git worktree prune")
      // 目录仍残留
      expect(existsSync(wtPathOf(wt))).toBe(true)

      // completed_at 已写入，残留信息落盘供人工排查
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(taskItemOf(wt).metadata["cleanup_residual"]["worktree_path"]).toBe(wtPathOf(wt))
      expect(Array.isArray(taskItemOf(wt).metadata["cleanup_residual"]["errors"])).toBe(true)
      expect(taskItemOf(wt).metadata["cleanup_residual"]["errors"].length).toBeGreaterThan(0)
      // 目录未消失 → 分支删除被跳过
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)
    } finally {
      try { chmodSync(groupDir, 0o755) } catch {}
      teardown(root)
    }
  })

  test("无 branch_name 时仅做 worktree 侧清理（目录消失即成功，不删分支）", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 清空分支引用：模拟仅剩 worktree 路径的收尾场景
      writeStateFile(wt, (item) => { item.metadata["branch_name"] = null })

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(out).toContain("任务组已完成并合并到")
      expect(out).toContain("兜底删除")
      expect(out).not.toContain("清理残留")
      // 分支删除不应出现（branch_name 为 null）
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(taskItemOf(wt).metadata["cleanup_residual"]).toBeUndefined()
    } finally { teardown(root) }
  })
})
