import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runGit, runGitChecked, listStagedPathsOutside } from "./git.ts"
import {
  collectIgnoreBaseline,
  normalizeIgnoreLine,
  resolveIgnoreBaselineRoot,
  type IgnoreBaselineEntry,
} from "./ignore-baseline.ts"
import type { SessionStacks } from "../skills/stacks.ts"

/**
 * 忽略基线守卫。
 *
 * 两类来源合并写入项目根同名文件：
 * - 强制覆盖组（GENERATED_DIR_ENTRIES）：编排产物，用户显式 `!` 否定后仍补齐；
 * - 基线条目（框架通用基线 + 形态命中的 skill 的 ignore/ 资产）：用户显式 `!<entry>`
 *   视为显式保留，尊重其意图、绝不追加（git 后写优先，追加等于推翻用户意图）。
 *
 * 提交按「逐文件判定 + 单次原子提交」进行：只放行「tracked 且干净」与「纯未跟踪」两种状态，
 * 其余状态（含已暂存 `A `、有工作树改动 ` M`）一律只写工作树不提交，避免夹带用户改动。
 */

export const GENERATED_DIR_ENTRIES = [".worktree/", "openspec/states/"] as const
const COMMIT_MESSAGE = "chore(ignore): add project ignore baseline"

export interface EnsureIgnoreBaselineOpts {
  baseBranch?: string | null
  skipCommit?: boolean
  /** 会话项目栈；缺省/null = 旧会话未固化项目栈，只补框架级基线。 */
  session?: SessionStacks | null
  /** 框架级基线目录覆盖（测试注入；缺省按模块位置上溯探测）。 */
  baselineRoot?: string | null
}

/** 单个目标文件的计划与安全判定结果。 */
interface FilePlan {
  target: string
  existsBefore: boolean
  before: string | null
  /** 待追加条目（原始行），强制组在前、基线条目在后。 */
  missing: string[]
  /** 追加条目涉及的基线来源（去重）。 */
  sources: string[]
  /** 用户显式 `!<entry>` 保留的基线条目（原始行）。 */
  preserved: string[]
  /** 因该条目是某条否定行的父路径而跳过追加（条目 + 命中的否定行）。 */
  preservedByNegation: { entry: string; negation: string }[]
  /** `git status --porcelain -- <f>` 原始输出（trim 后）。 */
  statusRaw: string
  /** 纯未跟踪：唯一状态行恰好为 `?? <f>`。 */
  untrackedOnly: boolean
  /** 有用户改动（已暂存、已修改、混合状态等），不允许提交。 */
  userDirty: boolean
}

function normalizeEntry(line: string): string {
  return normalizeIgnoreLine(line)
}

/**
 * 计算目标文件已有的覆盖与显式否定集合。
 * 覆盖判定用归一化键（去尾部斜杠）；`!x` 行从覆盖集合移除并记入否定集合。
 */
function analyzeCoverage(content: string | null): { covered: Set<string>; negated: Set<string> } {
  const covered = new Set<string>()
  const negated = new Set<string>()
  for (const raw of (content ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    if (line.startsWith("!")) {
      const body = normalizeEntry(line.slice(1))
      negated.add(body)
      covered.delete(body)
      continue
    }
    covered.add(normalizeEntry(line))
  }
  return { covered, negated }
}

/**
 * 合并强制组与基线条目，判定每个目标文件需要追加什么、哪些被用户显式保留。
 * wanted 集合包含「本次要写出的全部条目」，因此重复 init 不会重复追加。
 */
function planTarget(
  target: string,
  baseline: IgnoreBaselineEntry[],
  existsBefore: boolean,
  before: string | null,
  statusRaw: string,
): FilePlan {
  const { covered, negated } = analyzeCoverage(before)
  const missing: string[] = []
  const sources: string[] = []
  const preserved: string[] = []
  const preservedByNegation: { entry: string; negation: string }[] = []
  const seen = new Set<string>()
  const negatedBodies = [...negated]

  const push = (line: string, source?: string): void => {
    const key = normalizeEntry(line)
    if (key.length === 0 || seen.has(key) || covered.has(key)) return
    seen.add(key)
    missing.push(line)
    if (source && !sources.includes(source)) sources.push(source)
  }

  // 强制覆盖组：纳入 wanted 集合，但不因用户 `!` 否定而放弃补齐。仅 `.gitignore` 承载编排产物，
  // `.prettierignore` 等其它目标只补基线条目。
  if (target === ".gitignore") {
    for (const entry of GENERATED_DIR_ENTRIES) push(entry)
  }

  for (const { line, source } of baseline) {
    const key = normalizeEntry(line)
    if (seen.has(key) || covered.has(key)) continue
    if (negated.has(key)) {
      // 用户显式保留：尊重其意图，绝不追加。
      if (!preserved.includes(line)) preserved.push(line)
      continue
    }
    // 父目录条目会因 git 后写优先击败子路径否定（如追加 `dist/` 会推翻 `!dist/keep.txt`）：
    // 命中子路径否定时跳过追加，并在报告里点名保留的是哪条否定行。
    const childNegation = key.length > 0
      ? negatedBodies.find((body) => body.startsWith(`${key}/`))
      : undefined
    if (childNegation) {
      const negation = `!${childNegation}`
      if (!preservedByNegation.some((p) => p.entry === line && p.negation === negation)) {
        preservedByNegation.push({ entry: line, negation })
      }
      continue
    }
    push(line, source)
  }

  const lines = statusRaw.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0)
  const untrackedOnly = lines.length === 1 && lines[0] === `?? ${target}`
  const clean = lines.length === 0
  return {
    target,
    existsBefore,
    before,
    missing,
    sources,
    preserved,
    preservedByNegation,
    statusRaw,
    untrackedOnly,
    userDirty: !clean && !untrackedOnly,
  }
}

/** 保留文件原有换行风格（CRLF/无尾换行），不存在时从头写。 */
function appendMissing(before: string | null, missing: readonly string[]): string {
  if (missing.length === 0) return before ?? ""
  const eol = before && before.includes("\r\n") ? "\r\n" : "\n"
  const base = before ?? ""
  const prefix = base.length > 0 && !base.endsWith("\n") ? eol : ""
  return `${base}${prefix}${missing.join(eol)}${eol}`
}

/** 强制组条目是否真的生效（被上层 .gitignore / 全局 excludes 覆盖时提示人工确认）。 */
async function probeIgnoreSources(repoRoot: string): Promise<string[]> {
  const notes: string[] = []
  for (const entry of GENERATED_DIR_ENTRIES) {
    const out = await runGit(repoRoot, ["check-ignore", "-v", "--", entry])
    if (!out) {
      notes.push(`\`${entry}\` 未确认命中来源`)
      continue
    }
    const source = out.split(/\r?\n/)[0]?.split("\t")[0]?.split(":").slice(0, -2).join(":") ?? ""
    const fileName = source.split(/[\\/]/).pop() ?? source
    notes.push(
      fileName === ".gitignore" ? `\`${entry}\` 命中来源 \`.gitignore\`` : `\`${entry}\` 未确认命中来源`,
    )
  }
  return notes
}

async function readTarget(repoRoot: string, target: string): Promise<string | null> {
  try {
    return await readFile(join(repoRoot, target), "utf-8")
  } catch {
    return null
  }
}

/**
 * 版本库提交的全局前置条件（与具体文件无关）：只审不修会话、detached HEAD、跨分支、
 * 暂存区另有改动。返回 null 表示可提交。
 */
async function precheckCommit(
  repoRoot: string,
  opts: EnsureIgnoreBaselineOpts,
  targets: readonly string[],
): Promise<string | null> {
  if (opts.skipCommit) return "当前会话为只审不修的独立审查会话，跳过版本库提交"
  const branch = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (!branch || branch === "HEAD") return "当前处于 detached HEAD，无法确认提交目标分支"
  const base = opts.baseBranch ?? null
  if (base && branch !== base) return `当前检出分支 \`${branch}\` 与基准分支 \`${base}\` 不同`
  const stagedOutside = await listStagedPathsOutside(repoRoot, [...targets])
  if (stagedOutside.length > 0) return "主仓库暂存区含其它已暂存改动，提交会夹带非本次内容"
  return null
}

function renderBaselineLines(
  plans: readonly FilePlan[],
  hasPrettierBaseline: boolean,
  baselineMissing: boolean,
): string[] {
  const lines: string[] = []
  if (baselineMissing) {
    lines.push("- **忽略基线**: 基线资产缺失，本次只补编排产物条目。")
  }
  for (const plan of plans) {
    if (plan.missing.length === 0) {
      lines.push(`- **忽略基线**: \`${plan.target}\` 已齐全，未改动文件。`)
      continue
    }
    const action = plan.existsBefore ? "补齐" : "新建"
    const entries = plan.missing.map((e) => `\`${e}\``).join("、")
    lines.push(`- **忽略基线**: \`${plan.target}\` ${action} ${plan.missing.length} 条（${entries}）。`)
    if (plan.sources.length > 0) {
      lines.push(`- **基线来源**: \`${plan.target}\` ← ${plan.sources.join("、")}。`)
    }
  }
  for (const plan of plans) {
    if (plan.preserved.length === 0) continue
    const entries = plan.preserved.map((e) => `\`!${e}\``).join("、")
    lines.push(`- **用户显式保留**: \`${plan.target}\` 中的 ${entries} 未追加（用户已显式保留）。`)
  }
  for (const plan of plans) {
    for (const item of plan.preservedByNegation) {
      lines.push(
        `- **用户显式保留**: \`${plan.target}\` 已保留你的 \`${item.negation}\`，故未追加 \`${item.entry}\`。`,
      )
    }
  }
  if (!hasPrettierBaseline) {
    lines.push("- **`.prettierignore` 基线**: 当前声明的形态没有 `.prettierignore` 基线，未创建该文件。")
  }
  return lines
}

function renderCommitLine(
  commitTargets: readonly string[],
  reasons: readonly string[],
): string | null {
  if (commitTargets.length === 0) return null
  const list = commitTargets.map((t) => `\`${t}\``).join("、")
  if (reasons.length > 0) {
    return `- **版本库提交**: 未提交（原因：${reasons.join("；")}）；本次改动只写工作树，未进版本库。`
  }
  return null
}

/**
 * 确保项目根忽略文件覆盖「编排产物 + 技术栈基线」，并在安全时提交。
 * repoRoot 为目标项目根（或 worktree 根）；返回 markdown 报告片段（由调用方拼接）。
 */
export async function ensureIgnoreBaseline(
  repoRoot: string,
  opts: EnsureIgnoreBaselineOpts = {},
): Promise<string> {
  const baselineRoot = opts.baselineRoot === undefined ? resolveIgnoreBaselineRoot() : opts.baselineRoot
  const baseline = collectIgnoreBaseline(opts.session ?? null, { baselineRoot })
  const baselineByTarget = new Map(baseline.map((b) => [b.target, b.entries]))
  const targets = [...new Set([".gitignore", ...baseline.map((b) => b.target)])].sort((a, b) =>
    a.localeCompare(b),
  )

  const plans: FilePlan[] = []
  for (const target of targets) {
    const before = await readTarget(repoRoot, target)
    const statusRaw = await runGit(repoRoot, ["status", "--porcelain", "--", target])
    plans.push(
      planTarget(target, baselineByTarget.get(target) ?? [], before !== null, before, statusRaw),
    )
  }

  const globalReason = await precheckCommit(repoRoot, opts, targets)
  const dirtyReasons = plans
    .filter((p) => p.userDirty)
    .map((p) => `\`${p.target}\` 存在用户其它未提交改动，提交会夹带非本次内容`)
  const reasons = globalReason ? [globalReason] : []
  reasons.push(...dirtyReasons)

  // 写入工作树：先落盘，再做提交前置断言（避免断言失败后留下半成品）。
  for (const plan of plans) {
    if (plan.missing.length === 0) continue
    await writeFile(join(repoRoot, plan.target), appendMissing(plan.before, plan.missing), "utf-8")
  }

  // pathspec 只包含本次实际写入或需 add -N 建立跟踪的文件；不存在的文件绝不进 pathspec。
  const commitTargets = plans
    .filter((p) => p.missing.length > 0 || p.untrackedOnly)
    .map((p) => p.target)

  const lines = renderBaselineLines(
    plans,
    baseline.some((b) => b.target === ".prettierignore"),
    baselineRoot === null,
  )
  const probe = await probeIgnoreSources(repoRoot)
  if (probe.length > 0) lines.push(`- **辅助校验**: ${probe.join("；")}。`)

  if (commitTargets.length === 0) return lines.join("\n")

  const blocked = renderCommitLine(commitTargets, reasons)
  if (blocked) {
    lines.push(blocked)
    return lines.join("\n")
  }

  // 提交前再断言：暂存区为空、逐文件状态仍是「干净」或「纯未跟踪」。
  const staged = await runGit(repoRoot, ["diff", "--cached", "--name-only"])
  if (staged) {
    lines.push(renderCommitLine(commitTargets, ["主仓库暂存区含其它已暂存改动，提交会夹带非本次内容"])!)
    return lines.join("\n")
  }
  // 写入后逐文件复核：允许「无输出」（已跟踪且改动已落盘）、` M <f>`（本次写入的改动）
  // 与 `?? <f>`（新建文件，需 add -N 建立跟踪）；其余状态说明出现预期外改动，拒绝提交。
  const needsIntentToAdd: string[] = []
  for (const target of commitTargets) {
    const status = await runGit(repoRoot, ["status", "--porcelain", "--", target])
    const statusLines = status.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
    if (statusLines.length === 0) continue
    if (statusLines.length === 1 && statusLines[0] === `?? ${target}`) {
      needsIntentToAdd.push(target)
      continue
    }
    if (statusLines.length === 1 && statusLines[0] === ` M ${target}`) continue
    lines.push(
      renderCommitLine(commitTargets, [
        `\`${target}\` 在写入后出现预期外状态（${statusLines.join(" / ")}），提交会夹带非本次内容`,
      ])!,
    )
    return lines.join("\n")
  }

  // 全新未跟踪文件先 add -N 建立跟踪；失败则回滚已加的 intent-to-add 并只写工作树。
  const added: string[] = []
  for (const target of needsIntentToAdd) {
    const res = await runGitChecked(repoRoot, ["add", "-N", "--", target])
    if (!res.success) {
      await rollbackIntentToAdd(repoRoot, added)
      lines.push(
        renderCommitLine(commitTargets, [`\`git add -N\` 失败（${res.stderr || "未知错误"}）`])!,
      )
      return lines.join("\n")
    }
    added.push(target)
  }

  const commit = await runGitChecked(repoRoot, [
    "commit",
    "-m",
    COMMIT_MESSAGE,
    "--only",
    "--",
    ...commitTargets,
  ])
  if (!commit.success) {
    await rollbackIntentToAdd(repoRoot, added)
    lines.push(
      renderCommitLine(commitTargets, [`\`git commit --only\` 失败（${commit.stderr || "未知错误"}）`])!,
    )
    return lines.join("\n")
  }

  const oid = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"])
  const list = commitTargets.map((t) => `\`${t}\``).join("、")
  lines.push(`- **版本库提交**: 已提交，仅含 ${list}（commit \`${oid}\`，消息 \`${COMMIT_MESSAGE}\`）。`)

  // 提交后核验：只含本次目标文件。
  const shown = (await runGit(repoRoot, ["show", "--name-only", "--format=", "HEAD"]))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .sort()
  const expected = [...commitTargets].sort()
  if (shown.join("\n") !== expected.join("\n")) {
    lines.push(
      `- **提交核验**: 提交内容与预期不一致（实际：${shown.join("、") || "无"}；预期：${expected.join("、")}），请人工核对。`,
    )
  }
  return lines.join("\n")
}

/** 提交失败时回滚 intent-to-add，避免下次预检把 `" A "` 误判为用户改动。 */
async function rollbackIntentToAdd(repoRoot: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return
  await runGitChecked(repoRoot, ["reset", "--", ...files])
}
