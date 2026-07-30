import { __setGitRunner, type GitRunner } from "../src/core/git"
import type { ToolContext } from "@opencode-ai/plugin"
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, cpSync } from "node:fs"
import { join } from "node:path"

// ─── Fake Git ───

export class FakeGitRunner implements GitRunner {
  worktrees = new Map<string, { branch: string; path: string }>()
  diffs = new Map<string, string[]>()
  baseRef = "base000000000000000000000000000000000001"
  dirtyPaths = new Set<string>()
  mergedBranches: string[] = []
  mergeConflictOnNext = false
  currentBranch = "main"
  callLog: string[] = []

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
    if (cmd === "rev-parse") {
      if (rest[0] === "--abbrev-ref" && rest[1] === "HEAD") return this.currentBranch
      return "abc123def456"
    }

    if (cmd === "diff" && rest[0] === "--name-only") {
      return (this.diffs.get(worktree) ?? []).join("\n")
    }

    if (cmd === "status" && rest[0] === "--porcelain") {
      if (rest.some((r) => r.startsWith("openspec"))) {
        return this.dirtyPaths.has(`${worktree}-openspec`) ? "M  openspec/changes/foo/tasks.md" : ""
      }
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

    if (cmd === "merge") {
      if (this.mergeConflictOnNext) {
        this.mergeConflictOnNext = false
        return { success: false, stdout: "", stderr: "merge conflict" }
      }
      this.mergedBranches.push(args[args.length - 1])
      return { success: true, stdout: "", stderr: "" }
    }

    if (cmd === "status") return { success: true, stdout: this.dirtyPaths.has(worktree) ? "M  some-file.txt" : "", stderr: "" }
    if (cmd === "add" || cmd === "commit" || cmd === "checkout") return { success: true, stdout: "", stderr: "" }

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
    directory: worktree,
    sessionID: "test-session",
    messageID: "test-msg",
    abort: new AbortController().signal,
    metadata() {},
    ask() {},
    ...overrides,
  } as ToolContext
}

// ─── State Reader ───

export function readState(worktree: string, changeId: string): Record<string, unknown> | null {
  const p = join(worktree, ".opencode", ".orchestrate_state", `${changeId}.json`)
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
  if (existsSync(tmpRoot)) {
    for (const entry of readdirSync(tmpRoot)) {
      try { rmSync(join(tmpRoot, entry), { recursive: true, force: true }) } catch {}
    }
  }
}
