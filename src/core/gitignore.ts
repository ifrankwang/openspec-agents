import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { runGit, runGitChecked, listStagedPathsOutside } from "./git.ts"

/**
 * 插件生成的目录清单：编排框架在目标项目根下生成、不应进入版本库的目录。
 * 本清单是忽略判定与补齐写入的唯一来源（将来增删生成目录只改这里）。
 */
export const GENERATED_DIR_ENTRIES = [".worktree/", "openspec/states/"] as const

const GITIGNORE_REL = ".gitignore"
const COMMIT_MESSAGE = "chore(gitignore): ignore openspec orchestration artifacts"

export interface EnsureGeneratedDirsIgnoredOpts {
  /** 会话固化的基准分支；null/缺省 = 无法判定 → 只写工作树不提交（保守语义）。 */
  baseBranch?: string | null
  /** fix=none 的独立审查会话：跳过版本库提交，仍写工作树。 */
  skipCommit?: boolean
}

/** 明确条目的归一化：去首尾空白与尾部斜杠，使 `.worktree` 与 `.worktree/` 等价。 */
function normalizeEntry(line: string): string {
  return line.trim().replace(/\/+$/, "")
}

/**
 * 文本解析：只认「明确条目」，返回被覆盖的生成目录归一化集合。
 * - 忽略注释行与空行；
 * - `!` 否定行把对应目录判为未覆盖（git 后写优先口径的保守简化）；
 * - 含通配符的路径（如 `openspec/*`）归一化后不在清单内，一律不算覆盖，避免误判；
 * - CRLF 行尾经 split(/\r?\n/) 兼容。
 */
function explicitlyCovered(content: string): Set<string> {
  const wanted = new Set<string>(GENERATED_DIR_ENTRIES.map(normalizeEntry))
  const covered = new Set<string>()
  const negated = new Set<string>()
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const isNegation = line.startsWith("!")
    const normalized = normalizeEntry(isNegation ? line.slice(1) : line)
    if (!wanted.has(normalized)) continue
    if (isNegation) negated.add(normalized)
    else covered.add(normalized)
  }
  for (const n of negated) covered.delete(n)
  return covered
}

/**
 * `git check-ignore -v` 辅助校验：命中来源须为工作树内 `.gitignore`。
 * 仅作辅助——覆盖与否完全由文本解析的明确条目决定，check-ignore 命中不单独构成覆盖，
 * 未命中也不推翻已有明确条目。返回可核对的命中来源说明。
 */
async function probeIgnoreSources(repoRoot: string): Promise<string[]> {
  const notes: string[] = []
  for (const entry of GENERATED_DIR_ENTRIES) {
    const out = await runGit(repoRoot, ["check-ignore", "-v", "--", entry])
    const firstLine = out.split("\n")[0]?.trim() ?? ""
    // 输出形如 ".gitignore:2:.worktree/\t.worktree/"；首段即命中来源文件
    const source = firstLine ? firstLine.split(":")[0] : ""
    notes.push(source === GITIGNORE_REL
      ? `\`${entry}\` 命中来源 \`${GITIGNORE_REL}\``
      : `\`${entry}\` 未确认命中来源`)
  }
  return notes
}

/**
 * 只追加缺失行，保留原有内容与换行格式（CRLF 文件继续用 CRLF），不改写其它行。
 * 「存在但为空」与「不存在」同等处理：空文件追加直接从头写条目，不产前导空行。
 */
function appendMissing(before: string | null, missing: readonly string[]): string {
  if (missing.length === 0) return before ?? ""
  if (before === null || before.trim() === "") return `${missing.join("\n")}\n`
  const eol = before.includes("\r\n") ? "\r\n" : "\n"
  const hasTrailingNewline = /\r?\n$/.test(before)
  const head = hasTrailingNewline ? before : `${before}${eol}`
  return `${head}${missing.join(eol)}${eol}`
}

interface CommitPrecheck {
  /** 是否允许进入版本库提交。 */
  allowed: boolean
  /** 未提交原因（markdown 片段用）。 */
  reason: string
  /** `.gitignore` 是否属于全新未跟踪文件（提交前须 add -N）。 */
  willBeUntracked: boolean
}

/**
 * 提交前置判定（必须在写入工作树之前执行，否则本次追加会被误判成用户改动）：
 * 1) 当前检出分支 == 基准分支（detached / 跨分支一律不提交，避免提交到错误分支）；
 * 2) 主仓库 index 除 `.gitignore` 外无其它已暂存改动（复用 git.ts 共享检查，DRY）；
 * 3) `.gitignore` 相对 HEAD 无用户其它未提交改动（本次只允许追加我们的条目）。
 */
async function precheckCommit(
  repoRoot: string,
  opts: EnsureGeneratedDirsIgnoredOpts,
  beforeExists: boolean,
): Promise<CommitPrecheck> {
  if (opts.skipCommit) {
    return { allowed: false, reason: "当前会话为只审不修的独立审查会话，跳过版本库提交", willBeUntracked: false }
  }
  const currentBranch = (await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
  if (currentBranch === "" || currentBranch === "HEAD") {
    return { allowed: false, reason: "当前处于 detached HEAD，无法确认提交目标分支", willBeUntracked: false }
  }
  // baseBranch 缺省 = 会话尚未固化基准分支（新会话保守语义）：以当前检出分支为提交目标，
  // 同分支即可提交；显式传入时严格比较，跨分支一律不静默提交到错误分支。
  const effectiveBase = opts.baseBranch ?? currentBranch
  if (currentBranch !== effectiveBase) {
    return {
      allowed: false,
      reason: `当前检出分支 \`${currentBranch}\` 与基准分支 \`${effectiveBase}\` 不同`,
      willBeUntracked: false,
    }
  }

  const statusOut = await runGit(repoRoot, ["status", "--porcelain", "--", GITIGNORE_REL])
  const entries = statusOut.split("\n").map((l) => l.trim()).filter(Boolean)
  const untrackedOnly = entries.length === 1 && /^\?\?\s+\.gitignore$/.test(entries[0])
  let willBeUntracked = false
  let userDirty = false
  if (!beforeExists) {
    // 文件不存在：本次新建后即全新未跟踪；status 里若已有 .gitignore 条目属反常状态，保守不提交
    willBeUntracked = entries.length === 0
    userDirty = entries.length > 0
  } else if (entries.length === 0) {
    // 已跟踪且相对 HEAD 干净
    willBeUntracked = false
  } else if (untrackedOnly) {
    // 未跟踪（用户预建或此前守卫写入未提交）：按全新未跟踪文件处理
    willBeUntracked = true
  } else {
    userDirty = true
  }
  if (userDirty) {
    return {
      allowed: false,
      reason: `\`${GITIGNORE_REL}\` 存在用户其它未提交改动，提交会夹带非本次内容`,
      willBeUntracked: false,
    }
  }
  const stagedOutside = await listStagedPathsOutside(repoRoot, [GITIGNORE_REL])
  if (stagedOutside.length > 0) {
    return {
      allowed: false,
      reason: "主仓库暂存区含其它已暂存改动，提交会夹带非本次内容",
      willBeUntracked: false,
    }
  }
  return { allowed: true, reason: "", willBeUntracked }
}

/**
 * 编排前置守卫：确保目标项目根 `.gitignore` 明确覆盖插件生成目录，并在可安全提交时
 * 以「只含 .gitignore 一处变更」的独立 commit 原子提交。
 *
 * 两层语义：工作树写入（生效）无条件执行；版本库提交仅当「当前检出分支 == 基准分支」、
 * index 干净、`.gitignore` 相对 HEAD 无用户其它改动时进行。不满足时只写工作树、不提交，
 * 返回 markdown 说明原因。返回体不含流转方向提示。
 */
export async function ensureGeneratedDirsIgnored(
  repoRoot: string,
  opts: EnsureGeneratedDirsIgnoredOpts = {},
): Promise<string> {
  const gitignorePath = path.join(repoRoot, GITIGNORE_REL)
  let before: string | null = null
  try {
    before = await readFile(gitignorePath, "utf-8")
  } catch {
    before = null
  }
  const beforeExists = before !== null

  // 文本解析（明确条目） + git check-ignore -v（辅助校验命中来源）双重
  const covered = explicitlyCovered(before ?? "")
  const probeNotes = await probeIgnoreSources(repoRoot)
  const missing = GENERATED_DIR_ENTRIES.filter((e) => !covered.has(normalizeEntry(e)))

  // 提交前置判定必须在写入前完成（见 precheckCommit）
  const precheck = await precheckCommit(repoRoot, opts, beforeExists)
  const needCommit = missing.length > 0 || precheck.willBeUntracked

  if (missing.length > 0) {
    await writeFile(gitignorePath, appendMissing(before, missing), "utf-8")
  }

  const addedNote = missing.length > 0
    ? `本次补齐：${missing.map((e) => `\`${e}\``).join("、")}`
    : "条目齐全，未改动文件"
  const lines: string[] = [
    `- **生成目录忽略**: 已写入并生效（${addedNote}）。`,
    `- **辅助校验**: ${probeNotes.join("；")}。`,
  ]

  if (!precheck.allowed || !needCommit) {
    const reason = !precheck.allowed
      ? precheck.reason
      : "条目已纳入版本库，无变更需要提交"
    lines.push(`- **版本库提交**: 未提交（原因：${reason}）；已生效、未提交。`)
    return lines.join("\n")
  }

  // 全新未跟踪文件：intent-to-add（不 stage 内容、不动用户其它暂存），禁止 plain git add
  if (precheck.willBeUntracked) {
    const addRes = await runGitChecked(repoRoot, ["add", "-N", "--", GITIGNORE_REL])
    if (!addRes.success) {
      lines.push(`- **版本库提交**: 未提交（原因：\`git add -N\` 失败：${addRes.stderr}）；已生效、未提交。`)
      return lines.join("\n")
    }
  }
  // --only + pathspec 限定：只提交 .gitignore，隔离其它已暂存文件；断言保证工作树全量内容
  // 就是「HEAD 版本 + 本次追加的两行」，不会夹带用户改动。
  const commitRes = await runGitChecked(repoRoot, ["commit", "-m", COMMIT_MESSAGE, "--only", "--", GITIGNORE_REL])
  if (!commitRes.success) {
    lines.push(`- **版本库提交**: 未提交（原因：\`git commit --only\` 失败：${commitRes.stderr}）；已生效、未提交。`)
    return lines.join("\n")
  }
  const oid = (await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"])).trim()
  lines.push(`- **版本库提交**: 已原子提交，仅含 \`${GITIGNORE_REL}\` 一处变更（commit \`${oid}\`，消息 \`${COMMIT_MESSAGE}\`）。`)
  return lines.join("\n")
}
