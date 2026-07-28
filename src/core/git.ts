import path from "path"
import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"

export interface GitRunner {
  run(worktree: string, args: string[]): Promise<string>
  runChecked(
    worktree: string,
    args: string[]
  ): Promise<{ success: boolean; stdout: string; stderr: string }>
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
    return { success: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() }
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
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return gitRunner.runChecked(worktree, args)
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

export async function getDiffFileList(worktree: string, baseRef: string): Promise<string[]> {
  const out = await runGit(worktree, ["diff", "--name-only", `${baseRef}..HEAD`])
  if (!out) return []
  return out.split("\n").map((s) => s.trim()).filter(Boolean)
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

export async function mergeBranchToTarget(
  worktree: string,
  sourceBranch: string,
  targetBranch: string
): Promise<{ success: boolean; conflict: boolean }> {
  const checkoutResult = await runGitChecked(worktree, ["checkout", targetBranch])
  if (!checkoutResult.success) {
    throw new Error(`无法切到目标分支 "${targetBranch}"：${checkoutResult.stderr}`)
  }
  const mergeResult = await runGitChecked(worktree, ["merge", "--no-ff", sourceBranch])
  if (!mergeResult.success) {
    await runGitChecked(worktree, ["merge", "--abort"])
    return { success: false, conflict: true }
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
