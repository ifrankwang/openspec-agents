import path from "path"
import { execFile } from "node:child_process"
import { readFile, writeFile, stat, rm } from "node:fs/promises"

/** 判断路径是否存在于磁盘（fs 层判断，git 命令结果不作为存在性依据）。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export interface GitRunner {
  run(worktree: string, args: string[]): Promise<string>
  runChecked(
    worktree: string,
    args: string[]
  ): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>
}

function execGit(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 } as any, (err: Error | null, stdout: string, stderr: string) => {
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        exitCode: err ? (err as any).code || 1 : 0,
      })
    })
  })
}

const defaultRunner: GitRunner = {
  async run(worktree, args) {
    try {
      const { stdout } = await execGit(["-C", worktree, ...args])
      return stdout.trim()
    } catch {
      return ""
    }
  },
  async runChecked(worktree, args) {
    const { stdout, stderr, exitCode } = await execGit(["-C", worktree, ...args])
    return { success: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
  },
}

let gitRunner: GitRunner = defaultRunner

export function __setGitRunner(r: GitRunner | null): void {
  gitRunner = r ?? defaultRunner
}

export async function runGit(worktree: string, args: string[]): Promise<string> {
  return gitRunner.run(worktree, args)
}

export async function runGitChecked(
  worktree: string,
  args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
  return gitRunner.runChecked(worktree, args)
}

/** worktree 清理结果：成功判定以目录从磁盘真实消失为准，不信任单条 git 命令的退出码。 */
export interface WorktreeRemovalResult {
  /** 目录最终是否已从磁盘消失。 */
  dirResolved: boolean
  /** 目录是否经文件系统兜底删除后才消失（true 表示主路径未直接达成，发生了补救）。 */
  dirResolvedByFallback: boolean
  /** worktree prune 是否执行成功（幽灵管理记录清理）。 */
  pruned: boolean
  /** 分支删除结果：null=未指定分支或因目录残留被跳过；true/false=删除断言结果。 */
  branchDeleted: boolean | null
  /** 各环节失败原因聚合（人类可读），全部成功时为空数组。 */
  errors: string[]
}

/**
 * 删除任务组 worktree 并清理关联管理记录（收尾清理与 set_worktree 复用失败重建共用）。
 *
 * 序列：
 * 1. 目录不存在 → 直接 prune（清理只残留管理记录的幽灵 worktree）；
 * 2. 目录存在 → `git worktree remove --force`；命令失败或目录仍在磁盘时走补救链：
 *    fs 递归删除 + prune（prune 失败仅记入 errors，不阻断）；
 * 3. 目录确认消失后才 `git branch -D`；仍残留则跳过删分支并记入 errors，
 *    防止孤儿分支掩盖问题、以及向不完整状态发出被 git 拒绝的命令。
 *
 * @param repoRoot 主仓库根路径（worktree 管理命令的 -C 目标）
 * @param wtPath 待删除的 worktree 路径
 * @param opts.branchName 关联分支名；缺省/null 时只做 worktree 侧清理
 */
export async function removeTaskGroupWorktree(
  repoRoot: string,
  wtPath: string,
  opts: { branchName?: string | null } = {},
): Promise<WorktreeRemovalResult> {
  const result: WorktreeRemovalResult = { dirResolved: false, dirResolvedByFallback: false, pruned: false, branchDeleted: null, errors: [] }

  if (!(await pathExists(wtPath))) {
    const pruneRes = await runGitChecked(repoRoot, ["worktree", "prune"])
    if (pruneRes.success) result.pruned = true
    else result.errors.push(`worktree prune 失败：${pruneRes.stderr}`)
    result.dirResolved = true
  } else {
    const rmRes = await runGitChecked(repoRoot, ["worktree", "remove", wtPath, "--force"])
    if (!rmRes.success) result.errors.push(`git worktree remove 失败：${rmRes.stderr}`)
    if (await pathExists(wtPath)) {
      // 补救链：fs 物理删除目录 + prune 清理残留管理记录
      try {
        await rm(wtPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch (e) {
        result.errors.push(`文件系统兜底删除 "${wtPath}" 失败：${e instanceof Error ? e.message : String(e)}`)
      }
      const pruneRes = await runGitChecked(repoRoot, ["worktree", "prune"])
      if (pruneRes.success) result.pruned = true
      else result.errors.push(`worktree prune 失败：${pruneRes.stderr}`)
      if (!(await pathExists(wtPath))) {
        result.dirResolved = true
        result.dirResolvedByFallback = true
      }
    } else {
      result.dirResolved = true
    }
  }

  if (!result.dirResolved) {
    if (opts.branchName) {
      result.errors.push(`目录 "${wtPath}" 未能删除，跳过分支 "${opts.branchName}" 的删除以保留排查线索`)
    }
    return result
  }
  if (opts.branchName) {
    const branchRes = await runGitChecked(repoRoot, ["branch", "-D", opts.branchName])
    if (branchRes.success) result.branchDeleted = true
    else {
      result.branchDeleted = false
      result.errors.push(`删除分支 "${opts.branchName}" 失败：${branchRes.stderr}`)
    }
  }
  return result
}

export async function getCurrentHead(worktree: string): Promise<string> {
  return runGit(worktree, ["rev-parse", "HEAD"])
}

export async function getCurrentBranch(worktree: string): Promise<string> {
  const branch = (await runGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
  if (branch === "HEAD") throw new Error("当前处于 detached HEAD 状态，无法自动推断 base_branch。请显式传入 base_branch 参数。")
  return branch
}

export async function getMergeBase(worktree: string, baseBranch: string): Promise<string> {
  return runGit(worktree, ["merge-base", "HEAD", baseBranch])
}

export async function isWorktreeClean(worktree: string): Promise<boolean> {
  const out = await runGit(worktree, ["status", "--porcelain"])
  return out.length === 0
}

export async function markTaskGroupCheckboxesComplete(
  worktree: string,
  changeId: string,
  taskGroupId: string
): Promise<void> {
  const tasksMdPath = path.join(worktree, "openspec", "changes", changeId, "tasks.md")
  let content: string
  try {
    content = await readFile(tasksMdPath, "utf-8")
  } catch {
    return
  }
  const lines = content.split("\n")
  let inGroup = false
  let modified = false
  const result: string[] = []
  for (const line of lines) {
    const groupMatch = line.match(/^##\s+(\d+)\./)
    if (groupMatch) {
      inGroup = groupMatch[1] === taskGroupId
      result.push(line)
      continue
    }
    if (inGroup && /^-\s+\[\s\]\s+/.test(line)) {
      result.push(line.replace(/^(-\s+)\[\s\](\s+)/, "$1[x]$2"))
      modified = true
    } else {
      result.push(line)
    }
  }
  if (!modified) return
  await writeFile(tasksMdPath, result.join("\n"))
  const addResult = await runGitChecked(worktree, ["add", tasksMdPath])
  if (!addResult.success) {
    throw new Error(`git add tasks.md 失败：${addResult.stderr}`)
  }
  const commitResult = await runGitChecked(worktree, ["commit", "-m", "docs(tasks): mark completed task checkboxes"])
  if (!commitResult.success) {
    throw new Error(`git commit tasks.md 失败：${commitResult.stderr}`)
  }
}

/**
 * 收尾裸合并：将任务组分支合并进基础分支，全程不触碰任何工作目录（worktreeless 底层命令）。
 *
 * 主仓库工作区状态（当前分支、未提交改动、index）不受影响；冲突时目标分支引用未动、磁盘无半成品。
 * 序列：
 * 1. `merge-base --is-ancestor` 幂等检查：源分支已是目标分支祖先（如人工解决冲突后重调）直接成功，
 *    不产生空合并提交；
 * 2. `merge-tree --write-tree`（需 git ≥ 2.38）内存试算合并树：退出码 1 = 冲突，直接返回；
 * 3. `commit-tree` 生成双父合并提交，`update-ref` 以试算前目标分支 oid 作旧值校验推进（CAS，防并发覆盖）。
 *
 * @param repoDir 仓库内任意目录（底层命令不读取工作区，不影响 HEAD/index）
 */
export async function mergeBranchToTarget(
  repoDir: string,
  sourceBranch: string,
  targetBranch: string
): Promise<{ success: boolean; conflict: boolean }> {
  const ancestor = await runGitChecked(repoDir, ["merge-base", "--is-ancestor", sourceBranch, targetBranch])
  if (ancestor.success) return { success: true, conflict: false }
  // is-ancestor 退出码 1 = 尚未并入（继续合并）；其余为分支缺失等真实错误
  if (ancestor.exitCode !== 1) {
    throw new Error(`无法判断 "${sourceBranch}" 是否已并入 "${targetBranch}"：${ancestor.stderr}`)
  }

  const mergeTree = await runGitChecked(repoDir, ["merge-tree", "--write-tree", "--messages", targetBranch, sourceBranch])
  if (!mergeTree.success) {
    // merge-tree 退出码 1 = 冲突；其余为分支缺失等真实错误
    if (mergeTree.exitCode !== 1) {
      throw new Error(`无法试算 "${sourceBranch}" → "${targetBranch}" 的合并：${mergeTree.stderr}`)
    }
    return { success: false, conflict: true }
  }
  const treeOid = mergeTree.stdout.split("\n")[0].trim()
  if (!treeOid) throw new Error("merge-tree 未返回树对象，无法生成合并提交。")

  const targetOid = (await runGit(repoDir, ["rev-parse", targetBranch])).trim()
  const sourceOid = (await runGit(repoDir, ["rev-parse", sourceBranch])).trim()
  if (!targetOid || !sourceOid) {
    throw new Error(`无法解析分支 OID：target="${targetOid}" source="${sourceOid}"`)
  }
  const commitOid = (await runGit(repoDir, [
    "commit-tree", treeOid, "-p", targetOid, "-p", sourceOid, "-m", `Merge branch '${sourceBranch}'`,
  ])).trim()
  if (!commitOid) throw new Error("git commit-tree 失败：无法创建合并提交。")

  const updateRef = await runGitChecked(repoDir, ["update-ref", `refs/heads/${targetBranch}`, commitOid, targetOid])
  if (!updateRef.success) {
    throw new Error(`基础分支 "${targetBranch}" 已被并发推进，合并提交未写入（update-ref 旧值校验失败）：${updateRef.stderr}`)
  }
  return { success: true, conflict: false }
}

export async function discoverDiskWorktrees(worktree: string): Promise<{ branch: string; path: string }[]> {
  const result: { branch: string; path: string }[] = []
  const wtList = await runGit(worktree, ["worktree", "list"])
  for (const line of wtList.split("\n")) {
    const m = line.match(/^(\S+)\s+[0-9a-f]+\s+\[(.+?)\]/)
    if (m) {
      const branch = m[2].trim()
      if (branch.startsWith("task-group/")) {
        result.push({ branch, path: m[1].trim() })
      }
    }
  }
  return result
}

/**
 * 从 git worktree 的 .git 文件中解析主仓库根路径。
 *
 * Git worktree 的 .git 是一个文本文件，内容为 `gitdir: /path/to/main/.git/worktrees/...`。
 * 切割 `/.git/worktrees/` 得到主仓库路径。
 *
 * @param worktreePath - worktree 的绝对路径
 * @returns 主仓库根路径
 * @throws 无法解析 .git 文件或 gitdir 行时抛出错误
 */
export async function discoverRepoRoot(worktreePath: string): Promise<string> {
  const gitFile = path.join(worktreePath, ".git")
  let content: string
  try {
    content = await readFile(gitFile, "utf-8")
  } catch {
    throw new Error(`无法读取 ${gitFile}，请确认该路径是一个有效的 git worktree。`)
  }
  const match = content.match(/^gitdir:\s*(.+)$/m)
  if (!match) {
    throw new Error(`无法从 ${gitFile} 解析 gitdir 行。文件内容：${content.slice(0, 200)}`)
  }
  const gitdir = match[1].trim()
  const idx = gitdir.indexOf("/.git/worktrees/")
  if (idx === -1) {
    throw new Error(`无法从 gitdir "${gitdir}" 推导主仓库路径，缺少 "/.git/worktrees/" 标记。`)
  }
  return gitdir.slice(0, idx)
}

/**
 * 解析 `git status --porcelain` / `git diff --name-only` 输出为文件路径列表。
 * 兼容 rename 条目（`R old -> new`）与引号包裹路径。
 */
function parsePorcelainPaths(out: string): string[] {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean)
  return lines.map((l) => {
    let f = l.replace(/^\S+\s+/, "")
    if (f.includes(" -> ")) f = f.split(" -> ").pop()!.trim()
    return f.replace(/^"+|"+$/g, "")
  })
}

/**
 * 检测主仓库下 openspec 文档是否存在未提交变更（修改/新增/改名），用于编排者视图的主分支污染诊断。
 * 兼容两种形态：`.git` 为目录（入参即主仓库，repoRoot 取自身）与 `.git` 为文件（走 discoverRepoRoot）。
 * 无法解析主仓库路径或主仓库干净时返回 null。
 */
export async function detectMainRepoPollution(worktreePath: string): Promise<{ repoRoot: string; files: string[] } | null> {
  let repoRoot: string
  try {
    const st = await stat(path.join(worktreePath, ".git"))
    repoRoot = st.isDirectory() ? worktreePath : await discoverRepoRoot(worktreePath)
  } catch {
    return null
  }
  // 健壮性：git 调用失败（如非 git 仓库/权限/损坏）时返回 null，不使 opx_status 整体抛错；
  // 污染诊断属编排者视图的辅助信息，缺失不应阻断状态视图渲染。
  let out: string
  try {
    out = await runGit(repoRoot, ["status", "--porcelain", "--", "openspec/"])
  } catch {
    return null
  }
  const files = parsePorcelainPaths(out)
  if (files.length === 0) return null
  return { repoRoot, files }
}

export interface DetectChangesResult {
  files: string[]
  hasNonDocChange: boolean
}

/**
 * 工具层检查点增量检测（A1）：比较「上次工具检查点 → 当前 HEAD」区间的变更，供 verify_tool step
 * 判断是否需要运行全量工具检查。
 *
 * 两个来源合并判定：
 * 1. 已提交变更：`git diff --name-only <检查点>..HEAD`；无检查点时用 base_ref（worktree 创建时存的
 *    merge-base）；base_ref 缺失或 git 调用失败 → 降级 hasNonDocChange=true（安全侧，走全量）。
 * 2. 未提交变更：`git status --porcelain`，过滤 `openspec/` 目录下的路径后仍有剩余 → 视为有变更。
 *
 * hasNonDocChange 仅按「变更文件是否在 openspec/ 文档目录以外」判定：openspec/ 下文件算文档（不算变更），
 * 其余一律算变更。本函数不做流转方向判定（不推断"应直提/应全量"），也不对工具配置文件做分类——该语义由
 * reviewer 结合已加载 skill 判断，工具层不硬编码技术栈文件类型。
 *
 * @param worktreePath worktree 路径
 * @param opts.checkpoint 上次工具检查点的 commit sha；undefined/null 视为无检查点
 * @param opts.baseRef 无检查点时的兜底基准 ref（worktree 创建时的 merge-base）
 */
export async function detectChanges(
  worktreePath: string,
  opts: { checkpoint?: string | null; baseRef?: string | null },
): Promise<DetectChangesResult> {
  const files: string[] = []
  let gitFailed = false
  const range = opts.checkpoint || opts.baseRef || undefined

  // 已提交变更：diff --name-only <range>..HEAD。diff 输出无状态码前缀，直接整行取路径。
  if (range) {
    try {
      const res = await runGitChecked(worktreePath, ["diff", "--name-only", `${range}..HEAD`])
      if (res.success) {
        for (const line of res.stdout.split("\n")) {
          const f = line.trim()
          if (f) files.push(f)
        }
      } else {
        gitFailed = true
      }
    } catch {
      gitFailed = true
    }
  } else {
    // 无检查点也无 base_ref：无法界定变更区间，安全侧降级为全量
    gitFailed = true
  }

  // 未提交变更：status --porcelain，过滤 openspec/ 文档目录下的路径
  const uncommitted: string[] = []
  try {
    const res = await runGitChecked(worktreePath, ["status", "--porcelain"])
    if (res.success) {
      for (const f of parsePorcelainPaths(res.stdout)) {
        if (!f.startsWith("openspec/")) uncommitted.push(f)
      }
    } else {
      gitFailed = true
    }
  } catch {
    gitFailed = true
  }

  const all = [...files, ...uncommitted]
  const hasNonDocChange = gitFailed || all.some((f) => !f.startsWith("openspec/"))
  return { files: all, hasNonDocChange }
}

/**
 * 将主仓库 `openspec/changes/<changeId>/` 下的未提交污染文档并入 worktree 分支，并清理主仓库工作树。
 *
 * 序列：scoped 检测（仅限本 changeId 目录）→ 预检（主仓库 index 除 change 目录外无其它 staged、
 * worktree 干净、污染路径在 baseRef 与 worktree tip 间无分叉、主仓库 HEAD 未相对 worktree 前进）→
 * 主仓库 add → write-tree/commit-tree 创建不可达合并提交（main 分支 ref 不动）→
 * worktree 真 3-way merge --no-ff <pollSha> → 主仓库 restore --staged --worktree 清理。
 *
 * 失败路径：预检失败时未进入 add 流程，绝不执行 --worktree 恢复（污染内容原样保留待人工处理）；
 * 已进入 merge 流程（add 后）失败时在 finally 中补 restore --staged --worktree，防主仓库 index 残留。
 *
 * @param mainRepo 主仓库路径（orchestrator/architect 会话工作目录）
 * @param worktreePath 任务组 worktree 路径
 * @param opts.changeId 需兜底的 changeId（scope 限定）
 * @param opts.baseRef 基准分支 ref；为 null 时降级跳过分叉预检
 * @returns 已并入的污染文件相对路径列表；无污染返回空数组
 */
export async function reconcileMainPollution(
  mainRepo: string,
  worktreePath: string,
  opts: { changeId: string; baseRef: string | null }
): Promise<string[]> {
  const changeDir = `openspec/changes/${opts.changeId}`
  const files = parsePorcelainPaths(await runGit(mainRepo, ["status", "--porcelain", "--", changeDir]))
  if (files.length === 0) return []

  let staged = false
  try {
    const cachedOut = await runGit(mainRepo, ["diff", "--cached", "--name-only"])
    const stagedOutside = cachedOut.split("\n").map((l) => l.trim()).filter(Boolean)
      .filter((p) => p !== changeDir && !p.startsWith(`${changeDir}/`))
    if (stagedOutside.length > 0) {
      throw new Error(
        `主仓库 index 除 \`${changeDir}\` 外存在其它已暂存内容，拒绝自动合并污染文档：\n` +
        stagedOutside.map((p) => `- \`${p}\``).join("\n") +
        `\n请人工核对处理。`
      )
    }
    if (!(await isWorktreeClean(worktreePath))) {
      throw new Error(`worktree "${worktreePath}" 存在未 commit 内容，拒绝自动合并主仓库污染文档，请先 commit 再重试。`)
    }
    const wtTip = await runGit(worktreePath, ["rev-parse", "HEAD"])
    if (opts.baseRef) {
      const diverged = (await runGit(worktreePath, ["diff", "--name-only", opts.baseRef, wtTip, "--", ...files])).trim()
      if (diverged.length > 0) {
        throw new Error(
          `以下污染文件在 worktree 分支中已相对基准分支发生变更（分叉），拒绝自动合并：\n` +
          diverged.split("\n").filter(Boolean).map((p) => `- \`${p}\``).join("\n") +
          `\n请人工核对处理。`
        )
      }
    }
    const aheadCount = parseInt((await runGit(mainRepo, ["rev-list", "--count", `${wtTip}..HEAD`])).trim(), 10)
    if (!Number.isNaN(aheadCount) && aheadCount > 0) {
      throw new Error(
        `主仓库分支已相对 worktree 分支前进 ${aheadCount} 个提交，自动合并将夹带其它变更内容，拒绝自动合并。\n` +
        `请人工核对处理。`
      )
    }

    const addResult = await runGitChecked(mainRepo, ["add", "--", changeDir])
    if (!addResult.success) throw new Error(`git add 主仓库 ${changeDir} 失败：${addResult.stderr}`)
    staged = true
    const tree = (await runGit(mainRepo, ["write-tree"])).trim()
    if (!tree) throw new Error("git write-tree 失败：主仓库暂存区为空，无法生成合并提交。")
    const pollCommit = (await runGit(mainRepo, [
      "commit-tree", tree, "-p", "HEAD", "-m", "docs(openspec): reconcile main-repo edits into worktree branch",
    ])).trim()
    if (!pollCommit) throw new Error("git commit-tree 失败：无法创建合并提交。")

    const mergeResult = await runGitChecked(worktreePath, ["merge", "--no-ff", pollCommit])
    if (!mergeResult.success) {
      await runGitChecked(worktreePath, ["merge", "--abort"])
      throw new Error(
        `worktree 合并主仓库污染文档失败（冲突）：${mergeResult.stderr}\n` +
        `已中止合并，请人工核对处理。`
      )
    }
    return files
  } finally {
    if (staged) {
      await runGitChecked(mainRepo, ["restore", "--staged", "--worktree", "--", changeDir])
    }
  }
}

/** worktree 自动提交（reviewer 家族文档直改兜底）结果。 */
export interface AutoCommitResult {
  /** skipped：过滤 openspec/states/ 后无已跟踪文件变更（未触发提交）；committed：add -u + commit 完成；
   *  failed：git 调用失败（降级返回，不抛异常）。 */
  status: "skipped" | "committed" | "failed"
  /** 纳入自动提交的已跟踪文件变更路径（skipped 时为空）。 */
  files: string[]
  /** status=failed 时的失败 stderr。 */
  stderr?: string
  /** 未跟踪新建文件（?? 条目）路径清单：add -u 不纳入提交，提示编排者另行处理。 */
  untrackedFiles: string[]
}

/**
 * 自动提交 worktree 内已跟踪文件的未提交修改/删除（reviewer 家族文档直改兜底）。
 *
 * 触发场景：审查者/架构师按文档直改义务修正文档/注释后，由 opx_agent_submit 在 verdict
 * 校验通过后调用——未提交修正会被下一轮工具检查点增量检测误判为新变更，也会在
 * reconcileMainPollution 的干净树预检处死锁，提交时自动 commit 兜底。
 *
 * 语义：
 * 1. `status --porcelain` 解析路径清单，过滤 `openspec/states/` 编排状态目录；过滤后无已跟踪
 *    文件变更 → skipped（未触发）。
 * 2. 有变更 → `add -u`（仅已跟踪文件的修改/删除，未跟踪新建文件不纳入，排除 openspec/states/）
 *    → `commit`（消息风格对齐既有 `docs(tasks):` / `docs(openspec):` 惯例）。
 * 3. 任一 git 调用失败 → failed（含 stderr），不抛异常——调用方据此在返回体提示，不阻塞 verdict 写入。
 */
export async function autoCommitWorktreeChanges(
  wtPath: string,
  agent: string,
  stepId: string,
): Promise<AutoCommitResult> {
  const statusRes = await runGitChecked(wtPath, ["status", "--porcelain"])
  if (!statusRes.success) {
    return { status: "failed", files: [], untrackedFiles: [], stderr: statusRes.stderr }
  }
  const files: string[] = []
  const untrackedFiles: string[] = []
  for (const line of statusRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const path = parsePorcelainPaths(line)[0]
    if (!path || path.startsWith("openspec/states/")) continue
    if (line.startsWith("??")) untrackedFiles.push(path)
    else files.push(path)
  }
  if (files.length === 0) return { status: "skipped", files: [], untrackedFiles }

  const addResult = await runGitChecked(wtPath, ["add", "-u", "--", ".", ":(exclude)openspec/states"])
  if (!addResult.success) {
    return { status: "failed", files, untrackedFiles, stderr: addResult.stderr }
  }
  const commitResult = await runGitChecked(wtPath, [
    "commit",
    "-m",
    `docs(opx): direct fixes by ${agent} (${stepId})`,
  ])
  if (!commitResult.success) {
    return { status: "failed", files, untrackedFiles, stderr: commitResult.stderr }
  }
  return { status: "committed", files, untrackedFiles }
}
