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
  /** 收尾合并「合并将写入文件清单」输出（diff --name-only --no-renames <ref> <treeOid> 形态）。 */
  mergeWrittenOut = ""
  /** 收口纯文档漂移直通判定用三点区间漂移清单（diff --name-only --no-renames <src>...<tgt> 形态）。
   *  默认空 = 基准侧无净变化 = 纯文档直通；需要回退语义的用例须显式注入非文档文件。 */
  driftDiffOut = ""
  /** 暂存-工作区差异输出（diff --name-only -- <paths> 形态；非空 = 部分暂存）。 */
  unstagedDeltaOut = ""
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
  /** 强制 runChecked 侧 worktree remove 失败（收尾清理补救链测试用）。 */
  failWorktreeRemove = false
  /** merge-base --is-ancestor 结果：未按 (source,target) 参数对命中时的全局兜底值。 */
  sourceIsAncestor = false
  /** merge-base --is-ancestor 结果按 (source, target) 参数对配置：key 为 `${source} ${target}`（已去 refs/heads/ 前缀）。
   *  支持收口重试序列（漂移检查 base→change 与合并幂等检查 change→base 分别配置）；
   *  未命中时按 branchParents fork 链推导（worktree add -b / git branch 建分支时登记），仍无结论回退 sourceIsAncestor。 */
  isAncestorPairs = new Map<string, boolean>()
  /** 分支 fork 源登记（branch -> fork 源 ref）：建分支动作（worktree add -b / git branch）时写入，供 is-ancestor 推导。 */
  branchParents = new Map<string, string>()
  /** merge-tree 冲突注入（一次性）：true 时下一次 merge-tree 返回退出码 1。 */
  mergeTreeConflictOnNext = false
  /** 分支 tip oid（rev-parse <branch> 与 update-ref CAS 旧值校验共用）；未配置时取 defaultBranchOid。 */
  branchOids = new Map<string, string>()
  defaultBranchOid = "abc123def456"
  /** update-ref 成功记录（含 CAS 旧值），收尾合并推进断言用。 */
  refUpdates: { ref: string; newOid: string; oldOid: string }[] = []
  /** commit-tree 调用记录（tree/parents/message），合并提交双父断言用。 */
  commitTreeCalls: { tree: string; parents: string[]; message: string }[] = []
  /** commit-tree 消息命中 "Merge branch '<branch>'" 时记录分支名，收尾合并断言用。 */
  mergeCommitBranches: string[] = []
  /** 结构化调用记录（run/runChecked 通用），断言某命令是否以特定目录为目标。 */
  callSites: { dir: string; args: string[]; checked: boolean }[] = []
  /** 本地分支集合（rev-parse --verify refs/heads/<name> 与 for-each-ref refs/heads 判定源）。 */
  localBranches = new Set<string>(["main", "master"])

  async run(worktree: string, args: string[]): Promise<string> {
    this.callLog.push(args.join(" "))
    this.callSites.push({ dir: worktree, args, checked: false })
    const cmd = args[0]
    const rest = args.slice(1)

    if (cmd === "worktree") {
      if (rest[0] === "list") {
        // porcelain 形态（收尾合并检出检测用）：主仓库条目始终存在，检出分支取 currentBranch；
        // linked worktree 条目取 worktrees map。非 porcelain 形态保持旧输出（discoverDiskWorktrees 解析用）。
        if (rest.includes("--porcelain")) {
          const blocks = [
            `worktree ${worktree}\nHEAD ${this.defaultBranchOid}\nbranch refs/heads/${this.currentBranch}`,
          ]
          for (const [p, info] of this.worktrees) {
            blocks.push(`worktree ${p}\nHEAD ${this.defaultBranchOid}\nbranch refs/heads/${info.branch}`)
          }
          return blocks.join("\n\n")
        }
        return Array.from(this.worktrees.entries())
          .map(([p, info]) => `${p} abc123 [${info.branch}]`)
          .join("\n")
      }
      if (rest[0] === "add") {
        const branchIdx = rest.indexOf("-b")
        // 两种形态：`add -b <branch> <path> <fork>`（建分支并检出）与 `add <path> <branch>`（检出既有分支）
        const branch = branchIdx >= 0 ? rest[branchIdx + 1] : rest[2] ?? ""
        const wtPath = branchIdx >= 0 ? rest[branchIdx + 2] : rest[1] ?? ""
        const fork = branchIdx >= 0 ? rest[branchIdx + 3] ?? null : null
        if (branch && wtPath) {
          this.worktrees.set(wtPath, { branch, path: wtPath })
          this.localBranches.add(branch)
          if (fork) this.branchParents.set(branch, fork.replace(/^refs\/heads\//, ""))
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
    if (cmd === "for-each-ref" && rest.some((a) => a.includes("refs/heads"))) {
      return Array.from(this.localBranches).join("\n")
    }
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
      // 分支/ref 名直查（收尾合并 CAS 旧值与源 tip 解析）；未配置回退缺省 oid
      const refName = rest[0] && !rest[0].startsWith("-") ? rest[0].replace(/^refs\/heads\//, "") : ""
      if (refName && this.branchOids.has(refName)) return this.branchOids.get(refName)!
      return this.defaultBranchOid
    }

    if (cmd === "write-tree") {
      const sha = `tree${String(this.treeCount++).padStart(4, "0")}0000000000000000000000000000`
      this.treeShas.push(sha)
      return sha
    }
    if (cmd === "commit-tree") {
      const sha = `poll${String(this.commitCount++).padStart(4, "0")}0000000000000000000000000000`
      this.commitShas.push(sha)
      const parents: string[] = []
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "-p") parents.push(rest[i + 1])
      }
      const msgIdx = rest.indexOf("-m")
      const message = msgIdx >= 0 ? rest[msgIdx + 1] : ""
      this.commitTreeCalls.push({ tree: rest[0], parents, message })
      const merged = message.match(/^Merge branch '(.+)'$/)
      if (merged) this.mergeCommitBranches.push(merged[1])
      return sha
    }
    if (cmd === "diff") {
      if (rest[0] === "--cached") return this.cachedDiffOut
      // 收尾合并两个新形态独立匹配（不误撞 diffOut 恒返回，也不误撞 reconcileMainPollution
      // 的 `diff --name-only <ref> <ref> -- <files>` 两 ref 带 -- 尾参形态）：
      // - 合并写入清单：--name-only --no-renames <ref> <treeOid>（无 .. 区间、无 -- 尾参、恰两个位置 ref）
      // - 暂存-工作区差异：--name-only -- <paths>（-- 前无位置 ref）
      const dashIdx = rest.indexOf("--")
      const posArgs = rest.filter((a) => !a.startsWith("-"))
      const refsBeforeDash = dashIdx >= 0 ? rest.slice(0, dashIdx).filter((a) => !a.startsWith("-")) : posArgs
      if (rest.includes("--name-only") && dashIdx === -1 && posArgs.length === 2 && !rest.some((a) => a.includes(".."))) {
        return this.mergeWrittenOut
      }
      if (rest.includes("--name-only") && dashIdx >= 0 && refsBeforeDash.length === 0) {
        return this.unstagedDeltaOut
      }
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
  ): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
    this.callLog.push(`checked:${args.join(" ")}`)
    this.callSites.push({ dir: worktree, args, checked: true })
    const cmd = args[0]

    // 本地分支存在性校验（独立审查入口）：refs/heads/<name> 命中 localBranches 才算存在
    if (cmd === "rev-parse" && args[1] === "--verify") {
      const branch = args[2]?.replace(/^refs\/heads\//, "") ?? ""
      return this.localBranches.has(branch)
        ? { success: true, stdout: this.defaultBranchOid, stderr: "", exitCode: 0 }
        : { success: false, stdout: "", stderr: `fatal: refs/heads/${branch}: not a valid ref`, exitCode: 128 }
    }

    if (cmd === "diff") {
      if (this.failDiff) return { success: false, stdout: "", stderr: "fatal: diff 失败", exitCode: 1 }
      // 工具检查点增量检测（detectChanges）走 `<range>..HEAD` 形态；避免误撞既有 diffOut 恒返回逻辑
      const rangeArg = args.find((a) => a.endsWith("..HEAD"))
      if (args.includes("--name-only") && rangeArg) {
        const out = this.diffNameOnlyByRange.get(rangeArg) ?? this.diffNameOnlyDefault
        return { success: true, stdout: out, stderr: "", exitCode: 0 }
      }
      // 收口漂移清单（listBranchDriftFiles）：--name-only + 恰一个含 `...` 的三点区间位置参数。
      // 与既有形态互不误撞：`..HEAD` 形态用 endsWith("..HEAD") 匹配、run 侧 mergeWrittenOut 形态显式
      // 排除含 `..` 的参数，三点区间（target 为分支名，不会以 "..HEAD" 结尾）均不会命中二者，防回归。
      const driftArgs = args.filter((a) => a.includes("..."))
      if (args.includes("--name-only") && driftArgs.length === 1) {
        return { success: true, stdout: this.driftDiffOut, stderr: "", exitCode: 0 }
      }
      return { success: true, stdout: this.diffOut, stderr: "", exitCode: 0 }
    }
    if (cmd === "status" && args.includes("--porcelain")) {
      if (this.failStatus) return { success: false, stdout: "", stderr: "fatal: status 失败", exitCode: 1 }
      if (this.statusPorcelainOutput.has(worktree)) {
        return { success: true, stdout: this.statusPorcelainOutput.get(worktree)!, stderr: "", exitCode: 0 }
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
        ? { success: false, stdout: "", stderr: `fatal: '${ref}' is not a valid branch name`, exitCode: 1 }
        : { success: true, stdout: "", stderr: "", exitCode: 0 }
    }

    // 收尾裸合并三件套（mergeBranchToTarget）：is-ancestor 幂等检查 / merge-tree 内存试算 / update-ref CAS 推进
    if (cmd === "merge-base" && args[1] === "--is-ancestor") {
      const source = (args[2] ?? "").replace(/^refs\/heads\//, "")
      const target = (args[3] ?? "").replace(/^refs\/heads\//, "")
      const pair = this.isAncestorPairs.get(`${source} ${target}`)
      let isAncestor: boolean
      if (pair !== undefined) {
        isAncestor = pair
      } else if (source === target) {
        isAncestor = true
      } else {
        // fork 链推导：从 target 沿建分支登记的 parent 上溯，命中 source 即祖先
        let p = target
        isAncestor = false
        for (let i = 0; i < 32 && this.branchParents.has(p); i++) {
          p = this.branchParents.get(p)!
          if (p === source) { isAncestor = true; break }
        }
        if (!isAncestor) isAncestor = this.sourceIsAncestor
      }
      return isAncestor
        ? { success: true, stdout: "", stderr: "", exitCode: 0 }
        : { success: false, stdout: "", stderr: "", exitCode: 1 }
    }
    if (cmd === "merge-tree") {
      if (this.mergeTreeConflictOnNext) {
        this.mergeTreeConflictOnNext = false
        return { success: false, stdout: "", stderr: "CONFLICT (content): Merge conflict in stub.txt", exitCode: 1 }
      }
      const sha = `tree${String(this.treeCount++).padStart(4, "0")}0000000000000000000000000000`
      this.treeShas.push(sha)
      return { success: true, stdout: sha, stderr: "", exitCode: 0 }
    }
    if (cmd === "update-ref") {
      const ref = args[1]
      const newOid = args[2]
      const oldOid = args[3]
      const branch = ref.replace(/^refs\/heads\//, "")
      const current = this.branchOids.get(branch) ?? this.defaultBranchOid
      if (oldOid !== current) {
        return { success: false, stdout: "", stderr: `cannot lock ref '${ref}': is at ${current} but expected ${oldOid}`, exitCode: 1 }
      }
      this.branchOids.set(branch, newOid)
      this.refUpdates.push({ ref, newOid, oldOid })
      // 合并成功登记祖先关系（源分支此后已并入目标）：commit-tree 消息携带源分支名
      const lastMerge = this.commitTreeCalls[this.commitTreeCalls.length - 1]
      const merged = lastMerge?.message.match(/^Merge branch '(.+)'$/)
      if (merged) this.isAncestorPairs.set(`${merged[1]} ${branch}`, true)
      return { success: true, stdout: "", stderr: "", exitCode: 0 }
    }

    if (cmd === "merge") {
      if (this.forceMergeFailure) {
        return { success: false, stdout: "", stderr: "merge failed", exitCode: 1 }
      }
      if (this.mergeConflictOnNext) {
        this.mergeConflictOnNext = false
        return { success: false, stdout: "", stderr: "merge conflict", exitCode: 1 }
      }
      const source = args[args.length - 1]
      this.mergedBranches.push(source)
      // 真实合并成功登记祖先关系（源分支此后已并入目标分支=当前检出分支）
      if (source && !source.startsWith("-")) {
        this.isAncestorPairs.set(`${source} ${this.currentBranch}`, true)
      }
      return { success: true, stdout: "", stderr: "", exitCode: 0 }
    }

    if (cmd === "status") {
      if (args.some((a) => a.startsWith("openspec"))) {
        return { success: true, stdout: this.worktreeOpenspecDirty.has(worktree) ? "M  openspec/changes/cid/tasks.md" : "", stderr: "", exitCode: 0 }
      }
      return { success: true, stdout: this.dirtyPaths.has(worktree) ? "M  some-file.txt" : "", stderr: "", exitCode: 0 }
    }
    if (cmd === "commit") {
      if (this.failCommit) return { success: false, stdout: "", stderr: "fatal: commit 失败", exitCode: 1 }
      // 模拟真实 git：commit 成功清空该 worktree 的脏状态，防止「测试绿但真实行为已变」的假阴性
      this.worktreeOpenspecDirty.delete(worktree)
      this.dirtyPaths.delete(worktree)
      return { success: true, stdout: "", stderr: "", exitCode: 0 }
    }
    if (cmd === "add") {
      if (this.failAdd) return { success: false, stdout: "", stderr: "fatal: add 失败", exitCode: 1 }
      return { success: true, stdout: "", stderr: "", exitCode: 0 }
    }
    if (cmd === "checkout" || cmd === "restore") return { success: true, stdout: "", stderr: "", exitCode: 0 }

    // 建分支（不检出）：`branch <name> <start-point>`——登记本地分支与 fork 源（is-ancestor 推导用）
    if (cmd === "branch" && args[1] !== "-D") {
      const name = args[1] ?? ""
      const start = (args[2] ?? "").replace(/^refs\/heads\//, "")
      if (name) {
        this.localBranches.add(name)
        if (start) this.branchParents.set(name, start)
      }
      return { success: true, stdout: "", stderr: "", exitCode: 0 }
    }

    if (cmd === "worktree" && args[1] === "remove") {
      if (this.failWorktreeRemove) return { success: false, stdout: "", stderr: "fatal: worktree remove 失败", exitCode: 1 }
      this.worktrees.delete(args[2])
      return { success: true, stdout: "", stderr: "", exitCode: 0 }
    }

    if (cmd === "worktree" && args[1] === "prune") return { success: true, stdout: "", stderr: "", exitCode: 0 }

    if (cmd === "branch" && args[1] === "-D") return { success: true, stdout: "", stderr: "", exitCode: 0 }

    return { success: true, stdout: "", stderr: "", exitCode: 0 }
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
