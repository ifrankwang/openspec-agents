/**
 * 跨基准分支发起 / 规划文档落位 / init 规划文档来源回落 / base_branch 校验测试。
 *
 * 真实 git 用例与 tests/git.merge-real.test.ts 同口径：不注入 FakeGitRunner，直接操作临时真仓库，
 * 每个用例后 `__setGitRunner(null)` 复位；工具层重入用例按 tests/orchestrate.*.test.ts 的 fake 口径。
 *
 * 覆盖：
 * 1. 跨分支发起：规划文档同步进 change 分支（worktree 内可读、主工作树未跟踪副本清理、主仓库不切分支）；
 *    同步提交为 scope 起点，不进入本任务组审查范围；
 * 2. 重复 set_worktree → 不产生重复同步提交（幂等）；
 * 3. 规划文档已提交在当前分支 / 已暂存未提交 → blocked 零改动；
 * 4. 基准分支已有规划文档：同版本 → 跳过同步并提示（不覆盖）；不一致 → blocked 零改动；
 * 5. init 在 state 已存在但主工作树无 tasks.md 时从 worktree 读取（重入换组）；
 * 6. init 第三级回落取「会话固化的基准分支」而非当前检出分支（跨分支后当前分支已无该文件）；
 * 7. 异常路径：gitignore 导致提交缺失 → 不删源报错；哈希不一致 / 快照外新文件 → 中止不删；
 *    提交失败 → 源保留；detached HEAD 仅有文档待同步时 blocked（基准分支已自带文档时放行）；
 * 8. 视图回显基准分支；init 返回体回显；base_branch 不存在 / 与固化值不一致 → 报错。
 *
 * 运行：bun test tests/orchestrate.cross-branch.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { renderWorktreeSection } from "../src/core/views"
import type { OrchestrateState, TaskGroupState } from "../src/core/types"
import { init, set_worktree } from "../src/adapters/opencode/tools"
import { INIT_PROJECT_STACKS, installTestSkillEnv, makeOrchCtx, readState, setupWithFakeGit, teardown } from "./helpers"

const CID = "cross-branch"
const TASKS = `## 1. First Task Group

- [ ] 1.1 Task one [spec:spec-a]
- [ ] 1.2 Task two [spec:spec-b]

## 2. Second Task Group

- [ ] 2.1 Another task [spec:spec-b]
`

const tempDirs: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

function writeRepoFile(repo: string, file: string, content: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
}

function commitFile(repo: string, file: string, content: string, message: string): void {
  writeRepoFile(repo, file, content)
  git(repo, "add", file)
  git(repo, "commit", "-m", message)
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "opx-cross-"))
  tempDirs.push(dir)
  git(dir, "init", "-b", "main")
  git(dir, "config", "user.email", "opx-test@example.com")
  git(dir, "config", "user.name", "opx-test")
  commitFile(dir, "README.md", "base\n", "init")
  return dir
}

/** 安装 git hook（真实 git 异常路径用：模拟提交失败 / 提交过程中源文件被改）。 */
function installHook(repo: string, name: string, body: string): void {
  const p = join(repo, ".git", "hooks", name)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
  chmodSync(p, 0o755)
}

function currentBranchOf(repo: string): string {
  return git(repo, "rev-parse", "--abbrev-ref", "HEAD")
}

function localBranchesOf(repo: string): string[] {
  return git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean)
}

function taskItemOf(state: Record<string, unknown> | null): any {
  const workItems = (state?.["workItems"] ?? []) as any[]
  return workItems.find((w: any) => w.id === "task:1")
}

function changeDirOf(): string {
  return `openspec/changes/${CID}`
}

beforeEach(() => {
  // 真实 git 用例使用默认 runner；fake 用例自行注入（防上一文件注入泄漏）
  __setGitRunner(null)
})

afterEach(() => {
  __setGitRunner(null)
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

// ════════════════════════════════════════════════════════════════
//  1. 跨分支发起：规划文档同步进 change 分支
// ════════════════════════════════════════════════════════════════

describe("跨分支发起：规划文档落位", () => {
  test("规划文档进 change 分支、主工作树副本清理、worktree 内可读，同步提交为 scope 起点", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    git(repo, "checkout", "-b", "work")
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    writeRepoFile(repo, `${changeDirOf()}/proposal.md`, "proposal\n")
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const out = await set_worktree.execute({ change_id: CID }, o)
    expect(out).toContain("已创建 worktree")
    expect(out).toContain("已从主仓库工作树同步到变更分支")

    const wtPath = join(repo, ".worktree", CID, "ws")
    // change 分支自带规划文档（worktree 内可读）
    expect(git(repo, "show", `change/${CID}:${changeDirOf()}/tasks.md`)).toContain("First Task Group")
    expect(git(repo, "show", `change/${CID}:${changeDirOf()}/proposal.md`)).toBe("proposal")
    expect(readFileSync(join(wtPath, changeDirOf(), "tasks.md"), "utf-8")).toContain("First Task Group")

    // 主仓库工作树副本已清理
    expect(existsSync(join(repo, `${changeDirOf()}/tasks.md`))).toBe(false)
    expect(existsSync(join(repo, changeDirOf()))).toBe(false)

    // 主仓库仍停在原检出分支；规划文档没有提交到当前分支，也没有落到基准分支
    expect(currentBranchOf(repo)).toBe("work")
    expect(git(repo, "ls-tree", "-r", "--name-only", "work", "--", changeDirOf())).toBe("")
    expect(git(repo, "ls-tree", "-r", "--name-only", "main", "--", changeDirOf())).toBe("")
    expect(git(repo, "rev-list", "--count", `main..change/${CID}`)).toBe("1")
    expect(git(repo, "log", "--max-count=1", "--format=%s", `change/${CID}`)).toBe(
      "docs(openspec): sync change plan into change branch",
    )

    const item = taskItemOf(readState(repo, CID))
    expect(item.metadata["worktree_path"]).toBe(wtPath)
    // 绑定发生在同步提交之后：scope 起点 = 同步提交，本任务组审查范围不含该提交
    expect(item.metadata["scope_start_oid"]).toBe(git(repo, "rev-parse", `change/${CID}`))
    expect(item.metadata["base_ref"]).toBe(item.metadata["scope_start_oid"])
  })

  test("重复 set_worktree → 不产生重复同步提交（幂等），主工作树副本保持清理", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    git(repo, "checkout", "-b", "work")
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    await set_worktree.execute({ change_id: CID }, o)
    const second = await set_worktree.execute({ change_id: CID }, o)
    expect(second).toContain("复用已有 worktree")

    const syncCommits = git(repo, "log", "--format=%s", `change/${CID}`)
      .split("\n")
      .filter((m) => m === "docs(openspec): sync change plan into change branch")
    expect(syncCommits).toHaveLength(1)
    expect(existsSync(join(repo, changeDirOf()))).toBe(false)
    expect(readFileSync(join(repo, ".worktree", CID, "ws", changeDirOf(), "tasks.md"), "utf-8"))
      .toContain("First Task Group")
  })
})

// ════════════════════════════════════════════════════════════════
//  2. 规划文档已提交 / 已暂存 → blocked（零改动）
// ════════════════════════════════════════════════════════════════

describe("跨分支发起：规划文档已提交或已暂存", () => {
  test("已提交在当前分支 → blocked，不创建 worktree 与 change 分支，主工作树零改动", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    git(repo, "checkout", "-b", "work")
    commitFile(repo, `${changeDirOf()}/tasks.md`, TASKS, "docs: plan on work")
    const headBefore = git(repo, "rev-parse", "HEAD")
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const out = await set_worktree.execute({ change_id: CID }, o)

    expect(out).toContain("- **原因**")
    expect(out).toContain("- **处理**")
    expect(out).toContain("已提交在当前检出分支")
    expect(existsSync(join(repo, ".worktree"))).toBe(false)
    expect(localBranchesOf(repo)).not.toContain(`change/${CID}`)
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore)
    expect(existsSync(join(repo, `${changeDirOf()}/tasks.md`))).toBe(true)
    expect(taskItemOf(readState(repo, CID)).metadata["worktree_path"]).toBeUndefined()
  })

  test("已暂存未提交 → blocked，未创建 worktree / 分支，暂存条目原样保留", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    git(repo, "checkout", "-b", "work")
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    git(repo, "add", `${changeDirOf()}/tasks.md`)
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const out = await set_worktree.execute({ change_id: CID }, o)

    expect(out).toContain("已暂存未提交")
    expect(out).toContain("- **处理**")
    expect(out).toContain("git restore --staged")
    expect(existsSync(join(repo, ".worktree"))).toBe(false)
    expect(localBranchesOf(repo)).not.toContain(`change/${CID}`)
    expect(git(repo, "status", "--porcelain", "--", changeDirOf())).toBe(`A  ${changeDirOf()}/tasks.md`)
  })
})

// ════════════════════════════════════════════════════════════════
//  3. 基准分支已有规划文档：同版本跳过 / 不一致 blocked
// ════════════════════════════════════════════════════════════════

describe("跨分支发起：基准分支已有规划文档", () => {
  test("同版本 → 跳过同步并提示，不覆盖、不产生同步提交", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    commitFile(repo, `${changeDirOf()}/tasks.md`, TASKS, "docs: plan on main")
    git(repo, "checkout", "-b", "work")
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const out = await set_worktree.execute({ change_id: CID }, o)

    expect(out).toContain("已有同一 change 的规划文档")
    expect(out).not.toContain("blocked")
    // worktree 自带基准分支上的文档，主工作树文件原样保留（未搬运）
    expect(readFileSync(join(repo, ".worktree", CID, "ws", changeDirOf(), "tasks.md"), "utf-8"))
      .toContain("First Task Group")
    expect(existsSync(join(repo, `${changeDirOf()}/tasks.md`))).toBe(true)
    // 未产生同步提交
    expect(git(repo, "rev-list", "--count", `main..change/${CID}`)).toBe("0")
  })

  test("基准分支只有部分文档、与工作树版本不一致 → blocked，不搬运不覆盖", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    commitFile(repo, `${changeDirOf()}/proposal.md`, "proposal\n", "docs: proposal on main")
    git(repo, "checkout", "-b", "work")
    // 基准分支没有 tasks.md，工作树里补了一份：版本不一致，直接同步会丢掉基准分支的 proposal 版本差异
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    const headBefore = git(repo, "rev-parse", "HEAD")
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const out = await set_worktree.execute({ change_id: CID }, o)

    expect(out).toContain("- **原因**")
    expect(out).toContain("已有该 change 的规划文档且与当前工作树版本不一致")
    expect(out).toContain("- **处理**")
    expect(out).toContain(`git diff main -- ${changeDirOf()}`)
    // 零改动：无 worktree / change 分支，HEAD 与两侧文件原样
    expect(existsSync(join(repo, ".worktree"))).toBe(false)
    expect(localBranchesOf(repo)).not.toContain(`change/${CID}`)
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore)
    expect(readFileSync(join(repo, `${changeDirOf()}/proposal.md`), "utf-8")).toBe("proposal\n")
    expect(readFileSync(join(repo, `${changeDirOf()}/tasks.md`), "utf-8")).toBe(TASKS)
  })
})

// ════════════════════════════════════════════════════════════════
//  4. init 规划文档来源回落
// ════════════════════════════════════════════════════════════════

describe("init 规划文档来源回落", () => {
  test("state 已存在但主工作树无 tasks.md → 从 worktree 读取（重入换组）", async () => {
    const root = `/tmp/cross-reentry-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, o)
      await set_worktree.execute({ change_id: CID }, o)
      const wtPath = taskItemOf(readState(wt, CID)).metadata["worktree_path"]
      expect(existsSync(join(wtPath, "openspec", "changes", CID, "tasks.md"))).toBe(true)

      // 模拟跨分支发起后的主仓库工作树：规划文档副本已清理
      rmSync(join(wt, "openspec", "changes", CID), { recursive: true, force: true })
      expect(existsSync(join(wt, "openspec", "changes", CID, "tasks.md"))).toBe(false)

      await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "2", mode: "full" }, o)
      const state = readState(wt, CID) as any
      expect(state.taskGroupId).toBe("2")
      const group2 = state.workItems.find((w: any) => w.id === "task:2")
      expect(group2.metadata["task_count"]).toBe(2)
      expect(group2.metadata["name"]).toBe("Second Task Group")
    } finally { teardown(root) }
  })

  test("未传 base_branch 时第三级回落用固化的基准分支（当前检出分支已无该文件）", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    commitFile(repo, `${changeDirOf()}/tasks.md`, TASKS, "docs: plan on main")
    git(repo, "checkout", "-b", "work")
    // 当前检出分支 work 上删掉规划文档并提交：work 分支的版本库里确实没有该文件
    git(repo, "rm", `${changeDirOf()}/tasks.md`)
    git(repo, "commit", "-m", "chore: drop plan on work")
    expect(existsSync(join(repo, `${changeDirOf()}/tasks.md`))).toBe(false)
    const o = makeOrchCtx(repo)

    // 首次 init 显式 base_branch=main：第三级回落从 main 版本库读到内容
    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    // 重入换组且不传 base_branch：回落必须取 state.baseBranch=main（若误用当前检出分支 work 会解析失败）
    await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "2", mode: "full" }, o)
    const state = readState(repo, CID) as any
    expect(state.baseBranch).toBe("main")
    expect(state.taskGroupId).toBe("2")
    expect(state.workItems.find((w: any) => w.id === "task:2")).toBeTruthy()
  })
})

// ════════════════════════════════════════════════════════════════
//  5. 跨分支异常路径：提交复核 / 哈希核对 / 提交失败 / detached HEAD
// ════════════════════════════════════════════════════════════════

describe("跨分支发起：异常路径不丢源", () => {
  test("文件被 .gitignore 忽略导致提交缺失 → 报错且不删主仓库副本", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    commitFile(repo, ".gitignore", "*.tmp\n", "chore: ignore tmp")
    git(repo, "checkout", "-b", "work")
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    writeRepoFile(repo, `${changeDirOf()}/notes.tmp`, "tmp\n")
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const err = await set_worktree.execute({ change_id: CID }, o).catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("未全部提交")
    expect(err.message).toContain("notes.tmp")
    expect(err.message).toContain("add -f")
    // 源目录未被删除（含被忽略的 notes.tmp）
    expect(existsSync(join(repo, `${changeDirOf()}/tasks.md`))).toBe(true)
    expect(readFileSync(join(repo, `${changeDirOf()}/notes.tmp`), "utf-8")).toBe("tmp\n")
  })

  test("提交过程中主仓库文件被改动（哈希不一致）→ 中止删除并报错，源文件保留", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    git(repo, "checkout", "-b", "work")
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    const sourcePath = join(repo, `${changeDirOf()}/tasks.md`)
    // pre-commit hook 在 worktree 提交时改主仓库源文件：模拟「同步期间用户改动源副本」
    installHook(repo, "pre-commit", `#!/bin/sh\necho tampered >> '${sourcePath}'\n`)
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const err = await set_worktree.execute({ change_id: CID }, o).catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("在同步过程中被修改")
    expect(err.message).toContain("已跳过删除")
    expect(err.message).toContain("rm -rf")
    // 源目录未删除，且保留了被篡改后的内容（内容归属用户）
    expect(existsSync(sourcePath)).toBe(true)
    expect(readFileSync(sourcePath, "utf-8")).toContain("tampered")
  })

  test("同步期间出现快照外新文件 → 中止删除、不删任何源文件", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    git(repo, "checkout", "-b", "work")
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    // pre-commit hook 在 worktree 提交时往主仓库目录新增一个快照外文件
    installHook(repo, "pre-commit", `#!/bin/sh\necho extra > '${join(repo, changeDirOf(), "extra.md")}'\n`)
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const err = await set_worktree.execute({ change_id: CID }, o).catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("快照外新文件")
    expect(err.message).toContain("未删除任何文件")
    expect(err.message).toContain("rm -rf")
    // 源目录完整保留：快照内文件与快照外新文件都在
    expect(readFileSync(join(repo, `${changeDirOf()}/tasks.md`), "utf-8")).toBe(TASKS)
    expect(readFileSync(join(repo, `${changeDirOf()}/extra.md`), "utf-8")).toBe("extra\n")
  })

  test("worktree 内提交失败 → 报错且保留主仓库副本", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    git(repo, "checkout", "-b", "work")
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    installHook(repo, "pre-commit", "#!/bin/sh\nexit 1\n")
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const err = await set_worktree.execute({ change_id: CID }, o).catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("git commit 失败")
    expect(err.message).toContain("主仓库副本未删除")
    expect(existsSync(join(repo, `${changeDirOf()}/tasks.md`))).toBe(true)
  })

  test("detached HEAD 且基准分支无文档、工作树有文件待同步 → blocked，不创建 worktree", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    // 基准分支没有规划文档；工作树里放未跟踪副本后 detach（未跟踪文件保留）
    writeRepoFile(repo, `${changeDirOf()}/tasks.md`, TASKS)
    git(repo, "checkout", "--detach", "main")
    expect(currentBranchOf(repo)).toBe("HEAD")
    const headBefore = git(repo, "rev-parse", "HEAD")
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const out = await set_worktree.execute({ change_id: CID }, o)

    expect(out).toContain("detached HEAD")
    expect(out).toContain("规划文档同步未执行")
    expect(out).toContain("- **处理**")
    expect(out).toContain("git switch")
    expect(existsSync(join(repo, ".worktree"))).toBe(false)
    expect(localBranchesOf(repo)).not.toContain(`change/${CID}`)
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore)
  })

  test("detached HEAD 且基准分支已自带文档 → 放行，按既有逻辑建 worktree、不产生同步提交", async () => {
    installTestSkillEnv()
    const repo = initRepo()
    commitFile(repo, `${changeDirOf()}/tasks.md`, TASKS, "docs: plan on main")
    git(repo, "checkout", "--detach", "main")
    expect(currentBranchOf(repo)).toBe("HEAD")
    const o = makeOrchCtx(repo)

    await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "main" },
      o,
    )
    const out = await set_worktree.execute({ change_id: CID }, o)

    expect(out).not.toContain("blocked")
    expect(out).toContain("worktree 自带")
    expect(out).toContain("detached HEAD")
    // worktree 从基准分支切出，自带规划文档
    expect(readFileSync(join(repo, ".worktree", CID, "ws", changeDirOf(), "tasks.md"), "utf-8"))
      .toContain("First Task Group")
    // 未产生同步提交；detached 下主仓库副本未被搬移/删除
    expect(git(repo, "rev-list", "--count", `main..change/${CID}`)).toBe("0")
    expect(existsSync(join(repo, `${changeDirOf()}/tasks.md`))).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════
//  6. 编排者视图回显基准分支
// ════════════════════════════════════════════════════════════════

describe("编排者视图回显基准分支", () => {
  test("change 会话 Worktree 区块含「基准分支」行；独立审查会话不渲染", () => {
    const state = {
      changeId: "cid", isolationNamespace: "ns", taskGroupId: "1", baseBranch: "main",
      workItems: [], createdAt: "", updatedAt: "",
    } as unknown as OrchestrateState
    const tg = { worktreePath: "/wt", branchName: "change/cid" } as unknown as TaskGroupState

    expect(renderWorktreeSection(state, tg).join("\n")).toContain("- **基准分支**: `main`")
    const review = { ...state, kind: "review" } as unknown as OrchestrateState
    expect(renderWorktreeSection(review, tg).join("\n")).not.toContain("基准分支")
  })
})

// ════════════════════════════════════════════════════════════════
//  7. base_branch 校验与回显 / git 底层口径
// ════════════════════════════════════════════════════════════════

describe("base_branch 校验与回显", () => {
  test("显式传不存在的 base_branch → 报错并列出当前本地分支，不落盘", async () => {
    const root = `/tmp/cross-badb-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeOrchCtx(wt)
      const err = await init.execute(
        { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "next-release" },
        o,
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain('base_branch "next-release" 不是本地分支')
      expect(err.message).toContain("main")
      expect(readState(wt, CID)).toBeNull()
    } finally { teardown(root) }
  })

  test("state 已存在时传不同 base_branch → 报错不覆盖，init 返回体回显生效基准分支", async () => {
    const root = `/tmp/cross-mismatch-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeOrchCtx(wt)
      const out = await init.execute({ ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full" }, o)
      expect(out).toContain("- **基准分支**: `main`")

      const err = await init.execute(
        { ...INIT_PROJECT_STACKS, change_id: CID, task_group_id: "1", mode: "full", base_branch: "master" },
        o,
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("已固化的基准分支")
      expect((readState(wt, CID) as any).baseBranch).toBe("main")
    } finally { teardown(root) }
  })
})
