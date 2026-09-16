/**
 * 任务组收尾/收口测试（change 分支模型）：
 * - 非最后任务组：门禁 → 勾选 → scope_end → completed_at；无合并、无销毁（变更保留在 change 分支）
 * - 最后任务组两段式收口：
 *   1) 前置漂移检查：基准分支已推进（base 非 change 分支祖先）→ blocked + 回退 verify_cleanup
 *      （completed_at 不写、worktree/分支保留、无合并命令），重新收尾验证通过后重放 → 合并成功 → 清理
 *   2) 漂移通过 → mergeBranchToTarget：update-ref CAS 推进断言改 change 模型（change/{changeId} 源分支）
 *   3) 合并成功 → 销毁 worktree + 删分支 → completed_at
 * - 补救链物理成功：git worktree remove 失败时经文件系统兜底删除 + prune，分支正常删除，无残留警告
 * - 完全残留：目录被只读父目录锁死无法删除时，收口不阻断（completed_at 照写），返回体给出残留警告区块
 *   与人工处理命令，metadata.cleanup_residual 落盘，且不执行 branch -D
 * - 无分支引用时仅做 worktree 侧清理：目录消失即成功，不执行 branch -D、无残留警告
 * - is-ancestor 幂等：人工/外部已把 change 并入基准后重调，短路后走清理收尾
 *
 * 运行：bun test tests/orchestrate.complete-cleanup.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test"
import { chmodSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner, mergeBranchToTarget } from "../src/core/git"
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

/** change 模型常驻 worktree 路径：.worktree/{changeId}/ws */
function wtPathOf(wt: string): string {
  return join(wt, ".worktree", CID, "ws")
}

/** 读当前 task WorkItem（落盘 JSON）。 */
function taskItemOf(wt: string): any {
  return readState(wt, CID)!.workItems.find((w: any) => w.id === "task:1")
}

function writeStateFile(wt: string, mutate: (state: any) => void): void {
  const statePath = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(statePath, "utf-8"))
  mutate(state)
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

/** 收尾验证重放（漂移/冲突回退后）：developer 提交 verify_cleanup passed → done。 */
async function repassCleanup(wt: string): Promise<void> {
  await agent_submit.execute(
    { change_id: CID, step_id: "verify_cleanup", verdict: "passed" },
    makeCtx(DEV, wt),
  )
}

describe("非最后任务组：完成不合并、不销毁", () => {

  test("存在未收口的其它任务组 → completed_at 写入但无合并命令，worktree 与 change 分支保留", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 构造组 2 已激活（tags 非空 + 子任务非 todo）→ 组 1 不是最后一个收口任务组
      writeStateFile(wt, (state) => {
        const g2 = state.workItems.find((w: any) => w.id === "task:2")
        g2.tags["implement:openspec-developer"] = "pending"
        g2.children[0].phase = "in_progress"
      })

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(out).toContain("任务组已完成")
      expect(out).toContain("统一收口合并")
      expect(out).not.toContain("任务组已完成并合并到")
      // 无合并、无销毁：completed_at 写入，worktree 与分支保留，零合并命令
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(existsSync(wtPathOf(wt))).toBe(true)
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.includes("merge-tree"))).toBe(false)
      // 任务组 scope 端点已标记（勾选提交后的 change 分支 tip）
      expect(taskItemOf(wt).metadata["scope_start_oid"]).toBeDefined()
      expect(taskItemOf(wt).metadata["scope_end_oid"]).toBeDefined()
    } finally { teardown(root) }
  })
})

describe("最后任务组两段式收口：漂移 blocked → 回退 → 重新收尾验证 → 重放合并", () => {

  test("基准分支漂移 → blocked + 回退 verify_cleanup，重放后合并成功并清理", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 主仓库检出非目标分支 → 目标分支无人检出，走 worktreeless 合并原路径
      fakeGit.currentBranch = "develop"
      // 漂移注入：基准 tip 不再是 change 分支祖先（多 change 并行推进了基准分支）
      fakeGit.isAncestorPairs.set(`main change/${CID}`, false)

      const blocked = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      // blocked 事实文案：无「请分派 X」流转指令，结尾指引重新查询 opx_status
      expect(blocked).toContain("blocked")
      expect(blocked).toContain("漂移")
      expect(blocked).toContain("重新查询 opx_status 获取分派指引")
      // 禁止任何「请分派 X」流转指令
      expect(blocked).not.toContain("请分派")
      // 回退落点：状态回退到 verify_cleanup，completed_at 不写，scope_end 撤销
      const rolled = taskItemOf(wt)
      expect(rolled.phase).toBe("review")
      expect(rolled.currentStep).toBe("verify_cleanup")
      expect(rolled.metadata["completed_at"]).toBeUndefined()
      expect(rolled.metadata["scope_end_oid"]).toBeUndefined()
      // worktree 与 change 分支保留，未执行任何合并（无半成品）
      expect(existsSync(wtPathOf(wt))).toBe(true)
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)

      // dev 在 worktree 内合入基准分支最新代码并重新完成收尾验证 → done
      await repassCleanup(wt)
      expect(taskItemOf(wt).phase).toBe("done")

      // 验收后重放：反向（base→change）true、正向（change→base）false → 合并成功 → 清理
      fakeGit.isAncestorPairs.set(`main change/${CID}`, true)
      const ok = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(ok).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      // update-ref CAS 推进（change 模型）：源分支为 change/{changeId}
      const mergeSha = fakeGit.commitShas[fakeGit.commitShas.length - 1]
      expect(fakeGit.branchOids.get("main")).toBe(mergeSha)
      expect(fakeGit.refUpdates).toEqual([
        { ref: "refs/heads/main", newOid: mergeSha, oldOid: "abc123def456" },
      ])
      expect(fakeGit.mergeCommitBranches).toContain(`change/${CID}`)
      // worktree 与 change 分支已销毁
      expect(existsSync(wtPathOf(wt))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(true)
    } finally { teardown(root) }
  })
})

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

      // 收口成功且带兜底补救说明，无残留警告
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

describe("收口清理：目录完全残留时不阻断收口", () => {

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
      // 收口不被阻断：合并成功消息 + 残留警告区块 + 人工处理命令
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
      // 清空分支引用：模拟仅剩 worktree 路径的收口场景
      writeStateFile(wt, (state) => {
        state.workItems.find((w: any) => w.id === "task:1").metadata["branch_name"] = null
      })

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(out).toContain("任务组已完成")
      expect(out).toContain("兜底删除")
      expect(out).not.toContain("清理残留")
      // 分支删除不应出现（branch_name 为 null）
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(taskItemOf(wt).metadata["cleanup_residual"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("收口裸合并：worktreeless 底层命令（不触碰任何工作目录）", () => {

  test("合并成功：目标分支 tip 推进到双父合并提交，全程无 checkout 命令", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 主仓库检出非目标分支 → 目标分支无人检出，走 worktreeless 原路径
      fakeGit.currentBranch = "develop"
      fakeGit.branchOids.set("main", "target0000000000000000000000000000000001")
      fakeGit.branchOids.set(`change/${CID}`, "source000000000000000000000000000000001")

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(out).toContain("任务组已完成并合并到")
      // tip 推进到 commit-tree 生成的合并提交，CAS 旧值记录在案
      const mergeSha = fakeGit.commitShas[fakeGit.commitShas.length - 1]
      expect(fakeGit.branchOids.get("main")).toBe(mergeSha)
      expect(fakeGit.refUpdates).toEqual([
        { ref: "refs/heads/main", newOid: mergeSha, oldOid: "target0000000000000000000000000000000001" },
      ])
      // 合并提交为双父：目标分支旧 tip + 源分支 tip
      const mergeCommit = fakeGit.commitTreeCalls[fakeGit.commitTreeCalls.length - 1]
      expect(mergeCommit.parents).toEqual([
        "target0000000000000000000000000000000001",
        "source000000000000000000000000000000001",
      ])
      expect(fakeGit.mergeCommitBranches).toContain(`change/${CID}`)
      // 全程无 checkout（旧实现会先在主仓库 checkout 目标分支）
      expect(fakeGit.callSites.some((s) => s.args[0] === "checkout")).toBe(false)
    } finally { teardown(root) }
  })

  test("冲突零副作用：回退 verify_cleanup、目标分支 tip 不动、无合并提交与 ref 推进，重放后完成收口", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 主仓库检出非目标分支 → 目标分支无人检出，merge-tree 试算冲突零副作用
      fakeGit.currentBranch = "develop"
      fakeGit.branchOids.set("main", "target0000000000000000000000000000000001")
      fakeGit.mergeTreeConflictOnNext = true

      const blocked = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(blocked).toContain("blocked")
      expect(blocked).toContain("冲突")
      expect(blocked).toContain("未产生任何变更")
      expect(blocked).toContain("重新查询 opx_status 获取分派指引")
      // 目标分支引用分毫未动：无合并提交、无 ref 推进
      expect(fakeGit.branchOids.get("main")).toBe("target0000000000000000000000000000000001")
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
      expect(fakeGit.callSites.some((s) => s.args[0] === "checkout")).toBe(false)
      // 冲突轮回退到 verify_cleanup，不写 completed_at，worktree 与分支保留
      expect(taskItemOf(wt).metadata["completed_at"]).toBeUndefined()
      expect(taskItemOf(wt).currentStep).toBe("verify_cleanup")
      expect(fakeGit.worktrees.has(wtPathOf(wt))).toBe(true)

      // dev 重新完成收尾验证（解决冲突并回归通过）后重调：完成收口
      await repassCleanup(wt)
      const ok = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(ok).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
    } finally { teardown(root) }
  })

  test("重试幂等：change 分支已并入基准（is-ancestor 命中）→ 跳过合并提交，直接继续收口清理", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      fakeGit.sourceIsAncestor = true

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(out).toContain("任务组已完成并合并到")
      // 未产生合并提交与 ref 推进（无空合并提交）
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
      expect(fakeGit.callLog.some((l) => l.includes("merge-tree"))).toBe(false)
      // 收口清理照常执行
      expect(fakeGit.worktrees.has(wtPathOf(wt))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(true)
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
    } finally { teardown(root) }
  })
})

describe("收尾合并检出检测（mergeBranchToTarget 按目标分支检出状态分流；单元层不受 change 模型影响）", () => {

  /** 断言零变更命令：merge-tree 为内存只读试算不算变更；真实变更动作（merge/update-ref/commit-tree/restore/add）不得出现。 */
  function assertNoMutatingCommand(fakeGit: FakeGitRunner): void {
    for (const s of fakeGit.callSites) {
      expect(["merge", "update-ref", "commit-tree", "restore", "add"]).not.toContain(s.args[0])
    }
  }

  test("无人检出（主仓库检出非目标分支）→ worktreeless 原路径：commit-tree 双父 + update-ref CAS 推进", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.currentBranch = "develop"
      fakeGit.branchOids.set("main", "target0000000000000000000000000000000001")
      fakeGit.branchOids.set("feature", "source000000000000000000000000000000001")

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: true, conflict: false })
      const mergeSha = fakeGit.commitShas[fakeGit.commitShas.length - 1]
      expect(fakeGit.refUpdates).toEqual([
        { ref: "refs/heads/main", newOid: mergeSha, oldOid: "target0000000000000000000000000000000001" },
      ])
      expect(fakeGit.mergeCommitBranches).toContain("feature")
      expect(fakeGit.mergedBranches).toEqual([])
    } finally { teardown(root) }
  })

  test("主仓库检出且干净 → 先 merge-tree 试算再真实 merge --no-ff，不走 update-ref/commit-tree", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.branchOids.set("feature", "source000000000000000000000000000000001")

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: true, conflict: false })
      // 命令序列：merge-tree 试算先于真实 merge，真实 merge 以 --no-ff 携带源分支
      const mergeTreeIdx = fakeGit.callLog.findIndex((l) => l.includes("merge-tree"))
      const mergeIdx = fakeGit.callLog.findIndex((l) => l.startsWith("checked:merge "))
      expect(mergeTreeIdx).toBeGreaterThanOrEqual(0)
      expect(mergeIdx).toBeGreaterThan(mergeTreeIdx)
      expect(fakeGit.mergedBranches).toEqual(["feature"])
      // 真实合并路径不产生合并提交对象与分支指针 CAS 推进（由 git merge 自身推进）
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
    } finally { teardown(root) }
  })

  test("主仓库脏且与合并写入重合 → blockedMessage 列重合文件、零变更命令", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.statusPorcelainOutput.set(wt, "M  src/App.java\n M docs/notes.md")
      fakeGit.mergeWrittenOut = "src/App.java"

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r.success).toBe(false)
      expect(r.conflict).toBe(false)
      expect(r.blockedMessage).toContain("src/App.java")
      // 未重合的脏文件不进重合清单
      expect(r.blockedMessage).not.toContain("docs/notes.md")
      expect(r.blockedMessage).toContain("`git merge feature`")
      assertNoMutatingCommand(fakeGit)
    } finally { teardown(root) }
  })

  test("主仓库脏但与合并写入无重合（未暂存）→ 真实 merge 成功、不触碰暂存区", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.statusPorcelainOutput.set(wt, " M src/unrelated.java")

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: true, conflict: false })
      expect(fakeGit.mergedBranches).toEqual(["feature"])
      // 未暂存路径无需暂存区绕行
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:restore"))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:add"))).toBe(false)
    } finally { teardown(root) }
  })

  test("主仓库完整暂存且无重合 → restore --staged → merge → add 无损还原", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.statusPorcelainOutput.set(wt, "M  staged-file.txt")

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: true, conflict: false })
      expect(fakeGit.mergedBranches).toEqual(["feature"])
      // 命令顺序：restore --staged 先于 merge，add 兜底还原在后且携带暂存文件
      const restoreIdx = fakeGit.callLog.findIndex((l) => l.startsWith("checked:restore --staged"))
      const mergeIdx = fakeGit.callLog.findIndex((l) => l.startsWith("checked:merge "))
      const addLines = fakeGit.callLog.map((l, i) => ({ l, i })).filter(({ l, i }) => l.startsWith("checked:add") && i > mergeIdx)
      expect(restoreIdx).toBeGreaterThanOrEqual(0)
      expect(mergeIdx).toBeGreaterThan(restoreIdx)
      expect(addLines.length).toBeGreaterThanOrEqual(1)
      expect(addLines.some(({ l }) => l.includes("staged-file.txt"))).toBe(true)
    } finally { teardown(root) }
  })

  test("主仓库完整暂存但真实 merge 失败 → merge --abort 兜底 + add 仍还原暂存态、返回 conflict", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.statusPorcelainOutput.set(wt, "M  staged-file.txt")
      fakeGit.forceMergeFailure = true

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r.success).toBe(false)
      expect(r.conflict).toBe(true)
      expect(fakeGit.callLog.some((l) => l.includes("merge --abort"))).toBe(true)
      expect(fakeGit.callLog.some((l) => l.startsWith("checked:add") && l.includes("staged-file.txt"))).toBe(true)
    } finally { teardown(root) }
  })

  test("主仓库部分暂存（同文件既有已暂存又有未暂存改动）→ blockedMessage、零变更命令", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.statusPorcelainOutput.set(wt, "MM partial-file.txt")
      fakeGit.unstagedDeltaOut = "partial-file.txt"

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r.success).toBe(false)
      expect(r.conflict).toBe(false)
      expect(r.blockedMessage).toContain("部分暂存")
      expect(r.blockedMessage).toContain("`git merge feature`")
      assertNoMutatingCommand(fakeGit)
    } finally { teardown(root) }
  })

  test("其它 linked worktree 检出目标分支 → blockedMessage 带该工作树路径、零 git 变更命令", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      const userWt = "/tmp/user-owned-wt-checkout"
      fakeGit.currentBranch = "develop"
      fakeGit.worktrees.set(userWt, { branch: "main", path: userWt })

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r.success).toBe(false)
      expect(r.conflict).toBe(false)
      expect(r.blockedMessage).toContain(userWt)
      expect(r.blockedMessage).toContain("`git merge feature`")
      expect(r.blockedMessage).toContain(`\`git worktree remove ${userWt}\``)
      assertNoMutatingCommand(fakeGit)
    } finally { teardown(root) }
  })

  test("主仓库检出且干净但 merge-tree 冲突 → 零副作用返回 conflict，不执行真实 merge", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.mergeTreeConflictOnNext = true

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: false, conflict: true })
      expect(fakeGit.mergedBranches).toEqual([])
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
    } finally { teardown(root) }
  })

  test("真实 merge 失败（竞态）→ merge --abort 兜底后按 conflict 形态返回", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.forceMergeFailure = true

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: false, conflict: true })
      expect(fakeGit.callLog.some((l) => l.includes("merge --abort"))).toBe(true)
      expect(fakeGit.refUpdates.length).toBe(0)
    } finally { teardown(root) }
  })

  test("流程级：合并写入重合 blocked（主仓库前置拦截，不回退）→ 用户 commit 后重试成功", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)

      fakeGit.statusPorcelainOutput.set(wt, "M  src/App.java")
      fakeGit.mergeWrittenOut = "src/App.java"
      const out1 = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(out1).toContain("blocked")
      expect(out1).toContain("src/App.java")
      // 零副作用：completed_at 未写、worktree 保留、状态未回退（主仓库前置拦截不改变任务组状态）
      expect(taskItemOf(wt).metadata["completed_at"]).toBeUndefined()
      expect(taskItemOf(wt).currentStep).toBeNull()
      expect(existsSync(wtPathOf(wt))).toBe(true)

      // 用户 commit 掉重合文件后重试 → 成功收口
      fakeGit.statusPorcelainOutput.delete(wt)
      const out2 = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(out2).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(existsSync(wtPathOf(wt))).toBe(false)
    } finally { teardown(root) }
  })
})
