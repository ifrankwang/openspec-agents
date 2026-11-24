import { runGit, runGitChecked, listStagedPathsOutside } from "./git.ts"

/**
 * 基线文件提交外壳（只负责“能否提交 + 受控提交 + 核验 + 回滚”，不做任何内容合并判定）：
 * - 内容补什么、补哪些文件由调用方在写盘前/写盘时决定；本模块只提交调用方声明的 targets；
 * - main 侧安全不通过时只写盘并返回说明原因（不抛错），worktree 侧提交失败时显式抛错（不静默降级），由 failOnCommitError 区分；
 * - 提交一律 add -N + commit --only，核验只含本次 targets，失败/夹带则回滚 intent-to-add。
 */
export interface CommitBaselineTargetsOpts {
  /** git 操作根目录（主仓库根或 worktree 根）。 */
  repoRoot: string
  /** 本次实际写盘、需要补入版本库的文件（相对 repoRoot）。 */
  targets: readonly string[]
  /** true=跳过提交（只审不修的独立审查会话等），只返回说明原因。 */
  skipCommit?: boolean
  /** 主仓库侧基准分支；跨分支或 null 分支以外场景不提交（worktree 侧传 null）。 */
  baseBranch?: string | null
  /** 提交消息，由调用方给出（ignore 与扫描配置使用不同消息）。 */
  commitMessage: string
  /** 写盘前采集的文件状态：已被用户修改/untracked 改动的文件不纳入提交。 */
  precheck?: BaselineTargetPrecheck[]
  /** 写盘后逐文件复核的文件状态；传了就覆盖 precheck 的判定。 */
  postcheck?: BaselineTargetPrecheck[]
  /** 提交失败语义：false=只写盘并返回说明原因（main 侧）；true=显式抛错（worktree 侧）。 */
  failOnCommitError?: boolean
  /** 提交前的额外断言：返回 null 表示安全，返回字符串表示原因（只写盘不提交）。 */
  extraGuard?: () => Promise<string | null>
  /** skipCommit / 安全不通过时的说明前缀；外部套用“xxx: 原因”格式。 */
  notePrefix?: string
  /** 已提交说明使用的提交消息；传入后用于报告展示。 */
  displayMessage?: string
  /** 已提交说明是否在末尾附 commit oid（worktree 侧旧格式不带）。 */
  showOid?: boolean
}

/**
 * 文件状态预检数据：由调用方在 git 操作前通过 status 采集，供提交外壳判定用户脏文件与需 add -N 的文件。
 */
export interface BaselineTargetPrecheck {
  /** target 相对 repoRoot 的路径。 */
  target: string
  /** 写盘前 status 原始行（空表示 tracked 且干净）。 */
  statusRaw?: string
  /** 文件此前不存在（untracked）。 */
  untracked?: boolean
  /** 存在用户其它未提交改动；命中则只写盘不提交。 */
  userDirty?: boolean
}

interface CommitBaselineResult {
  /** 提交结果说明（追加到写盘报告）。 */
  note: string
  /** 已提交的文件清单（供调用方精确核验）。 */
  committedTargets: string[]
  /** 是否因 skip/安全拦截/失败而只写盘未提交。 */
  skipped: boolean
}

const DEFAULT_NOTE_PREFIX = "版本库提交"

/** 通用安全门槛：skipCommit / detached HEAD / 跨分支 / 暂存区夹带。返回 null 表示可提交。 */
async function precheckCommit(repoRoot: string, opts: CommitBaselineTargetsOpts, targets: readonly string[]): Promise<string | null> {
  if (opts.skipCommit) return "当前会话为只审不修的独立审查会话，跳过版本库提交"
  const currentBranch = (await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
  if (currentBranch === "HEAD") return "当前处于 detached HEAD，无法确认提交目标分支"
  const base = opts.baseBranch ?? null
  if (base && currentBranch !== base) return `当前检出分支 \`${currentBranch}\` 与基准分支 \`${base}\` 不同`
  const stagedOutside = await listStagedPathsOutside(repoRoot, [...targets])
  if (stagedOutside.length > 0) return "主仓库暂存区含其它已暂存改动，提交会夹带非本次内容"
  return null
}

/**
 * 逐文件状态分类（GitRunner.run 对 stdout 整体 trim()：真 git 的 ` M <f>` 会变成 `M <f>`，两种形态都放行；
 * staged 形态 `M  <f>`（两个空格）视为用户暂存改动，拒绝提交，避免夹带）。
 */
function classifyStatus(raw: string, target: string): { needsIntentToAdd: boolean; unknown: string | null } {
  const line = raw.trim()
  if (line === "") return { needsIntentToAdd: false, unknown: null }
  if (line === ` M ${target}` || line === `M ${target}`) return { needsIntentToAdd: false, unknown: null }
  if (line === `?? ${target}`) return { needsIntentToAdd: true, unknown: null }
  return { needsIntentToAdd: false, unknown: line }
}

async function rollbackIntentToAdd(repoRoot: string, files: string[]): Promise<void> {
  if (files.length === 0) return
  await runGitChecked(repoRoot, ["reset", "--", ...files])
}

function note(prefix: string, reason: string): CommitBaselineResult {
  return { note: `${prefix}: ${reason}`, committedTargets: [], skipped: true }
}

/**
 * 提交已写盘的基线文件。所有写盘入口（主仓库 init / set_worktree、worktree 新建/复用）统一走此函数。
 */
export async function commitBaselineTargets(opts: CommitBaselineTargetsOpts): Promise<CommitBaselineResult> {
  const prefix = opts.notePrefix ?? DEFAULT_NOTE_PREFIX
  const targets = [...opts.targets]
  if (targets.length === 0) return { note: "", committedTargets: [], skipped: true }

  const blocked = await precheckCommit(opts.repoRoot, opts, targets)
  if (blocked) return note(prefix, `未提交（原因：${blocked}）；本次改动只写工作树，未进版本库。`)

  if (opts.extraGuard) {
    const extraBlocked = await opts.extraGuard()
    if (extraBlocked) return note(prefix, `未提交（原因：${extraBlocked}）；本次改动只写工作树，未进版本库。`)
  }

  // 写盘前采集的用户脏文件：必须在写盘前判定（写盘自身会把干净文件变成 ` M `，
  // 若写盘后判脏会误伤“补缺失行/键”的正常提交）。命中则只写盘不提交。
  const dirtyBefore = opts.precheck?.filter((c) => c.userDirty) ?? []
  if (dirtyBefore.length > 0) {
    return note(
      prefix,
      `${dirtyBefore.map((c) => `\`${c.target}\` 存在用户其它未提交改动`).join("；")}，未纳入提交（只写工作树）`,
    )
  }

  // 逐文件状态判定：优先用调用方写盘后复核的 postcheck（gitignore 一次采集，避免重复 git 调用），
  // 否则现查写盘后 status。只放行「干净 / 未暂存修改 / 纯未跟踪」三种，其余状态只写盘不提交。
  const postStatus: { target: string; raw: string }[] = []
  if (opts.postcheck) {
    for (const c of opts.postcheck) {
      postStatus.push({ target: c.target, raw: c.statusRaw ?? (c.untracked ? `?? ${c.target}` : "") })
    }
  } else {
    for (const t of targets) {
      postStatus.push({ target: t, raw: (await runGit(opts.repoRoot, ["status", "--porcelain", "--", t])).trim() })
    }
  }
  const toAdd: string[] = []
  for (const s of postStatus) {
    if (s.raw === "") continue
    const lines = s.raw.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
    if (lines.length !== 1) return note(prefix, `\`${s.target}\` 状态为 \`${s.raw}\`，未纳入提交`)
    const classified = classifyStatus(lines[0], s.target)
    if (classified.unknown) {
      return note(prefix, `\`${s.target}\` 存在用户其它未提交改动，未纳入提交（状态 \`${lines[0]}\`）`)
    }
    if (classified.needsIntentToAdd || opts.precheck?.some((c) => c.target === s.target && c.untracked)) {
      toAdd.push(s.target)
    }
  }

  let commitError: unknown = null
  try {
    for (const [idx, file] of toAdd.entries()) {
      const res = await runGitChecked(opts.repoRoot, ["add", "-N", "--", file])
      if (!res.success) {
        await rollbackIntentToAdd(opts.repoRoot, toAdd.slice(0, idx))
        return note(prefix, `\`git add -N\` 失败，文件未提交（${res.stderr || "未知错误"}）`)
      }
    }
    const res = await runGitChecked(
      opts.repoRoot,
      ["commit", "-m", opts.commitMessage, "--only", "--", ...targets],
    )
    if (!res.success) {
      commitError = new Error(res.stderr || "git commit --only 失败")
    }
  } catch (error) {
    commitError = error
  }
  if (commitError !== null) {
    await rollbackIntentToAdd(opts.repoRoot, toAdd)
    if (opts.failOnCommitError) throw commitError
    return note(
      prefix,
      `\`git commit --only\` 失败（${commitError instanceof Error ? commitError.message : String(commitError)}）`,
    )
  }

  const oid = (await runGit(opts.repoRoot, ["rev-parse", "--verify", "HEAD"])).trim()
  const committedFiles = (await runGit(opts.repoRoot, ["show", "--name-only", "--format=", "HEAD"]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const expected = [...targets].sort()
  if (committedFiles.length !== expected.length || committedFiles.some((f, i) => f !== expected[i])) {
    return {
      note: `${prefix}: 提交核验告警（${oid}）：本次提交文件与预期不一致，实际为 ${committedFiles.join(", ") || "（空）"}`,
      committedTargets: committedFiles,
      skipped: false,
    }
  }

  const list = committedFiles.map((f) => `\`${f}\``).join("、")
  const message = opts.displayMessage ? `，消息 \`${opts.displayMessage}\`` : ""
  return {
    note: `${prefix}: 已提交，仅含 ${list}（${opts.showOid === false ? `commit \`${oid}\`${message}` : oid}）`,
    committedTargets: committedFiles,
    skipped: false,
  }
}
