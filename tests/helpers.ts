import { __setGitRunner, type GitRunner } from "../src/core/git"
import { __setMustDoIndex, EMPTY_MUST_DO_INDEX } from "../src/core/tools/gate"
import type { ToolContext } from "../src/core/tools/types"
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, cpSync } from "node:fs"
import { join } from "node:path"

// ─── Fake Git ───

export class FakeGitRunner implements GitRunner {
  worktrees = new Map<string, { branch: string; path: string }>()
  baseRef = "base000000000000000000000000000000000001"
  dirtyPaths = new Set<string>()
  mergedBranches: string[] = []
  mergeConflictOnNext = false
  forceMergeFailure = false
  revListCount = 0
  currentBranch = "main"
  callLog: string[] = []
  pollutionFiles = new Map<string, string[]>()
  worktreeOpenspecDirty = new Set<string>()
  cachedDiffOut = ""
  diffOut = ""
  treeShas: string[] = []
  commitShas: string[] = []
  mainAheadCount = 0
  private treeCount = 0
  private commitCount = 0
  /** rev-parse HEAD 的可配置 sha 序列（工具检查点增量检测用）：非空时按调用顺序逐次返回，耗尽后停留末位。 */
  headShas: string[] = []
  private headIdx = 0
  /** diff --name-only <range>..HEAD 按 range 配置输出（key 为完整 "<range>..HEAD" 字符串）。 */
  diffNameOnlyByRange = new Map<string, string>()
  /** diff --name-only 未按 range 命中时的缺省输出。 */
  diffNameOnlyDefault = ""
  /** 强制 diff 失败（git 不可用降级测试用）。 */
  failDiff = false
  /** status --porcelain 按 worktree 配置输出（detectChanges 未提交变更测试用）。 */
  statusPorcelainOutput = new Map<string, string>()
  /** 强制 status 失败（git 不可用降级测试用）。 */
  failStatus = false
  /** 强制 runChecked 侧 add 失败（自动提交失败路径测试用）。 */
  failAdd = false
  /** 强制 runChecked 侧 commit 失败（自动提交失败路径测试用）。 */
  failCommit = false

  async run(worktree: string, args: string[]): Promise<string> {
    this.callLog.push(args.join(" "))
    const cmd = args[0]
    const rest = args.slice(1)

    if (cmd === "worktree") {
      if (rest[0] === "list") {
        return Array.from(this.worktrees.entries())
          .map(([p, info]) => `${p} abc123 [${info.branch}]`)
          .join("\n")
      }
      if (rest[0] === "add") {
        const branchIdx = rest.indexOf("-b")
        const branch = branchIdx >= 0 ? rest[branchIdx + 1] : ""
        const wtPath = branchIdx >= 0 ? rest[branchIdx + 2] : ""
        if (branch && wtPath) {
          this.worktrees.set(wtPath, { branch, path: wtPath })
          mkdirSync(wtPath, { recursive: true })
          const srcOpenspec = join(worktree, "openspec")
          const destOpenspec = join(wtPath, "openspec")
          if (existsSync(srcOpenspec)) {
            cpSync(srcOpenspec, destOpenspec, { recursive: true })
          }
        }
        return ""
      }
      if (rest[0] === "remove") {
        this.worktrees.delete(rest[1])
        return ""
      }
    }

    if (cmd === "merge-base") return this.baseRef
    if (cmd === "rev-list" && rest[0] === "--count") {
      if (rest[1] && /^[0-9a-f]{7,}\.\./.test(rest[1])) return String(this.mainAheadCount)
      return String(this.revListCount)
    }
    if (cmd === "rev-parse") {
      if (rest[0] === "--abbrev-ref" && rest[1] === "HEAD") return this.currentBranch
      if (rest[0] === "HEAD" && this.headShas.length > 0) {
        const sha = this.headShas[Math.min(this.headIdx, this.headShas.length - 1)]
        this.headIdx++
        return sha
      }
      return "abc123def456"
    }

    if (cmd === "write-tree") {
      const sha = `tree${String(this.treeCount++).padStart(4, "0")}0000000000000000000000000000`
      this.treeShas.push(sha)
      return sha
    }
    if (cmd === "commit-tree") {
      const sha = `poll${String(this.commitCount++).padStart(4, "0")}0000000000000000000000000000`
      this.commitShas.push(sha)
      return sha
    }
    if (cmd === "diff") {
      if (rest[0] === "--cached") return this.cachedDiffOut
      return this.diffOut
    }

    if (cmd === "status" && rest[0] === "--porcelain") {
      const scopeArg = rest.find((r) => r.startsWith("openspec"))
      if (scopeArg) {
        const changeMatch = scopeArg.match(/^openspec\/changes\/([^/]+)/)
        if (changeMatch) {
          const key = `${worktree}-${changeMatch[1]}`
          const files = this.pollutionFiles.get(key)
          if (files && files.length > 0) return files.map((f) => `M  ${f}`).join("\n")
        }
        if (this.dirtyPaths.has(`${worktree}-openspec`)) return "M  openspec/changes/foo/tasks.md"
        return ""
      }
      if (this.worktreeOpenspecDirty.has(worktree)) return "M  openspec/changes/cid/tasks.md"
      return this.dirtyPaths.has(worktree) ? "M  some-file.txt" : ""
    }

    if (cmd === "add" || cmd === "commit" || cmd === "checkout") return ""
    if (cmd === "branch" && rest[0] === "-D") return ""

    return ""
  }

  async runChecked(
    worktree: string,
    args: string[]
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    this.callLog.push(`checked:${args.join(" ")}`)
    const cmd = args[0]

    if (cmd === "diff") {
      if (this.failDiff) return { success: false, stdout: "", stderr: "fatal: diff 失败" }
      // 工具检查点增量检测（detectChanges）走 `<range>..HEAD` 形态；避免误撞既有 diffOut 恒返回逻辑
      const rangeArg = args.find((a) => a.endsWith("..HEAD"))
      if (args.includes("--name-only") && rangeArg) {
        const out = this.diffNameOnlyByRange.get(rangeArg) ?? this.diffNameOnlyDefault
        return { success: true, stdout: out, stderr: "" }
      }
      return { success: true, stdout: this.diffOut, stderr: "" }
    }
    if (cmd === "status" && args.includes("--porcelain")) {
      if (this.failStatus) return { success: false, stdout: "", stderr: "fatal: status 失败" }
      if (this.statusPorcelainOutput.has(worktree)) {
        return { success: true, stdout: this.statusPorcelainOutput.get(worktree), stderr: "" }
      }
    }

    if (cmd === "check-ref-format") {
      // 支持两种形态：`check-ref-format refs/heads/<name>` 与 `check-ref-format --branch <name>`。
      // --branch 形态拒绝前导 `-`（git branch 创建亦拒绝），plain ref 形态放行（贴近真实 git）。
      const useBranchFlag = args.includes("--branch")
      const ref = args[args.length - 1]
      const branch = useBranchFlag ? ref : ref.replace(/^refs\/heads\//, "")
      const invalid =
        branch.length === 0 ||
        /\s/.test(branch) ||
        /[~^:?*[\\]/.test(branch) ||
        /[\u0000-\u001f\u007f]/.test(branch) ||
        /\.\./.test(branch) ||
        branch.startsWith(".") || branch.endsWith(".") ||
        branch.startsWith("/") || branch.endsWith("/") || branch.includes("//") ||
        branch.split("/").some((c) => c.endsWith(".lock")) ||
        (useBranchFlag && branch.startsWith("-")) ||
        /@{/.test(branch)
      return invalid
        ? { success: false, stdout: "", stderr: `fatal: '${ref}' is not a valid branch name` }
        : { success: true, stdout: "", stderr: "" }
    }

    if (cmd === "merge") {
      if (this.forceMergeFailure) {
        return { success: false, stdout: "", stderr: "merge failed" }
      }
      if (this.mergeConflictOnNext) {
        this.mergeConflictOnNext = false
        return { success: false, stdout: "", stderr: "merge conflict" }
      }
      this.mergedBranches.push(args[args.length - 1])
      return { success: true, stdout: "", stderr: "" }
    }

    if (cmd === "status") {
      if (args.some((a) => a.startsWith("openspec"))) {
        return { success: true, stdout: this.worktreeOpenspecDirty.has(worktree) ? "M  openspec/changes/cid/tasks.md" : "", stderr: "" }
      }
      return { success: true, stdout: this.dirtyPaths.has(worktree) ? "M  some-file.txt" : "", stderr: "" }
    }
    if (cmd === "commit") {
      if (this.failCommit) return { success: false, stdout: "", stderr: "fatal: commit 失败" }
      // 模拟真实 git：commit 成功清空该 worktree 的脏状态，防止「测试绿但真实行为已变」的假阴性
      this.worktreeOpenspecDirty.delete(worktree)
      this.dirtyPaths.delete(worktree)
      return { success: true, stdout: "", stderr: "" }
    }
    if (cmd === "add") {
      if (this.failAdd) return { success: false, stdout: "", stderr: "fatal: add 失败" }
      return { success: true, stdout: "", stderr: "" }
    }
    if (cmd === "checkout" || cmd === "restore") return { success: true, stdout: "", stderr: "" }

    if (cmd === "worktree" && args[1] === "remove") {
      this.worktrees.delete(args[2])
      return { success: true, stdout: "", stderr: "" }
    }

    if (cmd === "branch" && args[1] === "-D") return { success: true, stdout: "", stderr: "" }

    return { success: true, stdout: "", stderr: "" }
  }
}

export function createFakeGit(): FakeGitRunner {
  return new FakeGitRunner()
}

// ─── Workspace Setup ───

export function setupWorkspace(tmpRoot: string, changeId: string): string {
  const dir = join(tmpRoot, "workspace")
  mkdirSync(join(dir, "openspec", "changes", changeId), { recursive: true })

  // 存量测试兼容：默认注入空 skill 索引使质量门必做清单门禁（gate.ts）豁免（解析不到质量门 skill）。
  // 新增门禁用例在本文件或新测试中显式注入构造索引 / 真实索引（scanSkillTags()）验证门禁行为。
  __setMustDoIndex(EMPTY_MUST_DO_INDEX)

  const tasksMd = `## 1. First Task Group

- [ ] 1.1 Task one [spec:spec-a]
- [ ] 1.2 Task two [spec:spec-b]
- [ ] 1.3 Task three [spec:spec-a#section-1]

## 2. Second Task Group

- [ ] 2.1 Another task [spec:spec-b]
- [ ] 2.2 Yet another [spec:spec-c]

## 3. Third Task Group

- [ ] 3.1 Final task [spec:spec-a]
`
  writeFileSync(join(dir, "openspec", "changes", changeId, "tasks.md"), tasksMd, "utf-8")
  return dir
}

// ─── Context Factory ───

export function makeCtx(
  agent: string,
  worktree: string,
  overrides?: Partial<ToolContext>
): ToolContext {
  return {
    agent,
    worktree,
    ...overrides,
  }
}

/** 编排视角上下文：各 agent 主代理承担编排者职责（替代旧 openspec-orchestrator 独立角色）。 */
export function makeOrchCtx(
  worktree: string,
  overrides?: Partial<ToolContext>
): ToolContext {
  return makeCtx("primary", worktree, { orchestrator: true, ...overrides })
}

// ─── State Reader ───

export function readState(worktree: string, changeId: string): Record<string, unknown> | null {
  const p = join(worktree, "openspec", "states", `${changeId}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>
}

// ─── Test Fixture Setup ───

export function setupWithFakeGit(tmpRoot: string, changeId: string): { worktree: string; fakeGit: FakeGitRunner } {
  const worktree = setupWorkspace(tmpRoot, changeId)
  const fakeGit = createFakeGit()
  __setGitRunner(fakeGit)
  return { worktree, fakeGit }
}

export function teardown(tmpRoot: string): void {
  __setGitRunner(null)
  __setMustDoIndex(null)
  if (existsSync(tmpRoot)) {
    for (const entry of readdirSync(tmpRoot)) {
      try { rmSync(join(tmpRoot, entry), { recursive: true, force: true }) } catch {}
    }
  }
}

// ─── Simple 模式构造 ───

/**
 * simple 模式一次性构造（变更组 2+ 流程测试共用，避免重复样板）：
 * opx_orch_init(mode: "simple") 固化 mode → opx_orch_set_worktree。
 * 注：lifecycle 的初始 step 模式感知（组 3.1）落地后，init 直接把活跃 task WorkItem 落为
 * simple 初始态（phase=in_progress、currentStep=implement），无需再手工改写。
 */
export async function initSimpleWorktree(
  wt: string,
  changeId: string,
  taskGroupId = "1",
): Promise<void> {
  const { init, set_worktree } = await import("../src/adapters/opencode/tools")
  const orch = makeOrchCtx(wt)
  await init.execute({ change_id: changeId, task_group_id: taskGroupId, mode: "simple" }, orch)
  await set_worktree.execute({ change_id: changeId }, orch)
}
