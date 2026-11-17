/**
 * 忽略基线守卫（ensureIgnoreBaseline）测试。
 *
 * 混合模式：目标忽略文件是真实的（node:fs 临时目录读写），只有 git 命令走 FakeGitRunner
 * 模拟（gitignoreSim 启用时按文件接管守卫专属命令形态，null 时既有行为完全不变）。
 *
 * 覆盖：条目齐全不动作 / 缺行补齐 / 多目标（.gitignore + .prettierignore）一次提交 /
 * 新建文件 add -N / 用户暂存改动只写不提交 / add -N 后提交失败回滚 / 提交后 name-only 核验 /
 * 强制组 `!` 后仍补齐 / 基线条目 `!` 显式保留 / 跨分支 / detached HEAD / fix=none /
 * stagedOutside / CRLF 保留 / 幂等重入 / 返回体契约 / init 与 set_worktree 实测。
 *
 * 运行：bun test tests/orchestrate.gitignore-guard.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensureIgnoreBaseline } from "../src/core/gitignore"
import { __setGitRunner } from "../src/core/git"
import { init, set_worktree } from "../src/adapters/opencode/tools"
import { createFakeGit, FakeGitRunner, installTestSkillEnv, makeOrchCtx, INIT_PROJECT_STACKS, teardown } from "./helpers"
import type { SessionStacks } from "../src/skills/stacks"

const tempDirs: string[] = []

const BACKEND_SESSION: SessionStacks = { project_stacks: ["backend"], project_frameworks: ["java"] }
const FRONTEND_SESSION: SessionStacks = { project_stacks: ["frontend"], project_frameworks: ["vue"] }

const FRAMEWORK_ENTRIES = [".DS_Store", ".idea/", "*.iml", "*.log", ".env", ".env.local", ".env.*.local", "*.local"]
const GENERATED_ENTRIES = [".worktree/", "openspec/states/"]

function makeRepo(opts: { gitignore?: string; prettierignore?: string } = {}): {
  repo: string
  fake: FakeGitRunner
} {
  const dir = mkdtempSync(join(tmpdir(), "opx-ignore-baseline-"))
  tempDirs.push(dir)
  if (opts.gitignore !== undefined) writeFileSync(join(dir, ".gitignore"), opts.gitignore, "utf-8")
  if (opts.prettierignore !== undefined) writeFileSync(join(dir, ".prettierignore"), opts.prettierignore, "utf-8")
  const fake = createFakeGit()
  fake.gitignoreSim = {}
  __setGitRunner(fake)
  return { repo: dir, fake }
}

const COMMIT_LINE_PREFIX = "checked:commit -m chore(ignore): add project ignore baseline"

function readText(repo: string, file: string): string {
  return readFileSync(join(repo, file), "utf-8")
}

function valueLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

function assertNoMutatingBeyondGuard(fake: FakeGitRunner): void {
  const mutating = fake.callLog.filter(
    (l) =>
      l.startsWith("checked:") &&
      !l.startsWith("checked:add -N") &&
      !l.startsWith(COMMIT_LINE_PREFIX) &&
      !l.startsWith("checked:reset --"),
  )
  expect(mutating).toEqual([])
}

afterEach(() => {
  __setGitRunner(null)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不掩盖断言失败 */
    }
  }
})

describe("条目齐全：不动作", () => {
  test("框架级基线与强制组都在 → 不改文件、不提交", async () => {
    const content = [...GENERATED_ENTRIES, ...FRAMEWORK_ENTRIES].join("\n") + "\n"
    const { repo, fake } = makeRepo({ gitignore: content })
    fake.gitignoreSim!.checkIgnoreHit = true

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main" })

    expect(out).toContain("已齐全，未改动文件")
    expect(out).not.toContain("版本库提交")
    expect(readText(repo, ".gitignore")).toBe(content)
    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test("旧会话无项目栈 → 只补框架级基线，并说明本形态无 prettier 基线", async () => {
    const { repo } = makeRepo()

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(valueLines(readText(repo, ".gitignore"))).toEqual([...GENERATED_ENTRIES, ...FRAMEWORK_ENTRIES])
    expect(existsSync(join(repo, ".prettierignore"))).toBe(false)
    expect(out).toContain("当前声明的形态没有 `.prettierignore` 基线")
    expect(out).toContain("框架通用基线")
  })
})

describe("缺行补齐与多目标提交", () => {
  test("后端会话：新建 .gitignore，补齐框架级 + 能力级条目并提交", async () => {
    const { repo, fake } = makeRepo()
    fake.gitignoreSim!.commitOid = "abc123def456"
    fake.gitignoreSim!.files = { ".gitignore": { untracked: true } }

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: BACKEND_SESSION })

    const lines = valueLines(readText(repo, ".gitignore"))
    expect(lines).toEqual([...GENERATED_ENTRIES, ...FRAMEWORK_ENTRIES, "target/"])
    expect(out).toContain("新建")
    expect(out).toContain("框架通用基线")
    expect(out).toContain("skill `java-dev-practices`")
    // 全新文件需要先 add -N，再提交
    const addIdx = fake.callLog.findIndex((l) => l.startsWith("checked:add -N -- .gitignore"))
    const commitIdx = fake.callLog.findIndex((l) => l.startsWith(COMMIT_LINE_PREFIX))
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdx).toBeGreaterThan(addIdx)
    expect(out).toContain("已提交，仅含 `.gitignore`")
    expect(out).toContain("abc123def456")
    expect(out).toContain("chore(ignore): add project ignore baseline")
    expect(out).not.toContain("提交核验")
  })

  test("前端会话：.gitignore 与 .prettierignore 都补齐，一次提交两个目标", async () => {
    const { repo, fake } = makeRepo()
    fake.gitignoreSim!.files = {
      ".gitignore": { untracked: true },
      ".prettierignore": { untracked: true },
    }

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: FRONTEND_SESSION })

    const gitLines = valueLines(readText(repo, ".gitignore"))
    const prettierLines = valueLines(readText(repo, ".prettierignore"))
    expect(gitLines).toContain("node_modules/")
    expect(gitLines).toContain("dist/")
    expect(gitLines).toContain("e2e/reports/")
    expect(prettierLines).toContain("pnpm-lock.yaml")
    expect(prettierLines).toContain("coverage/")
    // 两个目标由同一次 commit 提交；先逐个 add -N
    const commitCalls = fake.callLog.filter((l) => l.startsWith(COMMIT_LINE_PREFIX))
    expect(commitCalls).toHaveLength(1)
    expect(commitCalls[0]).toContain("-- .gitignore .prettierignore")
    expect(out).toContain("已提交，仅含 `.gitignore`、`.prettierignore`")
    expect(out).not.toContain("当前声明的形态没有 `.prettierignore` 基线")
  })

  test("已跟踪且干净：补齐后不回退为未跟踪路径，直接提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\n" })

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(out).toContain("已提交")
  })
})

describe("用户改动与安全边界", () => {
  test("其中一个目标有用户暂存改动（` A `）→ 两个文件都只写工作树、不提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\n" })
    fake.gitignoreSim!.files = { ".gitignore": { statusLine: " A .gitignore" } }

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: BACKEND_SESSION })

    expect(out).toContain("存在用户其它未提交改动")
    expect(out).toContain("未提交")
    expect(out).not.toContain("已提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
    // 工作树仍补齐
    expect(valueLines(readText(repo, ".gitignore"))).toContain("target/")
  })

  test("混合状态 `AM` 同样只写工作树", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.files = { ".gitignore": { statusLine: "AM .gitignore" } }

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(out).toContain("未提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test("主仓库暂存区含其它改动 → 只写工作树", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.stagedOutside = ["src/App.java"]

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(out).toContain("暂存区含其它已暂存改动")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test("跨分支 → 只写工作树并说明分支", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.currentBranch = "feature-x"

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(out).toContain("feature-x")
    expect(out).toContain("未提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
    assertNoMutatingBeyondGuard(fake)
  })

  test("detached HEAD → 只写工作树", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.detached = true

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(out).toContain("detached HEAD")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test("fix=none（skipCommit）→ 写工作树、不提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })

    const out = await ensureIgnoreBaseline(repo, { skipCommit: true, session: null })

    expect(out).toContain("只审不修")
    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })
})

describe("提交失败与回滚", () => {
  test("add -N 成功但 commit 失败 → reset 回滚 intent-to-add", async () => {
    const { repo, fake } = makeRepo()
    fake.gitignoreSim!.files = { ".gitignore": { untracked: true } }
    fake.gitignoreSim!.forceCommitFail = true

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(out).toContain("`git commit --only` 失败")
    expect(out).not.toContain("已提交，仅含")
    const resetIdx = fake.callLog.findIndex((l) => l.startsWith("checked:reset -- .gitignore"))
    expect(resetIdx).toBeGreaterThanOrEqual(0)
    expect(fake.gitignoreSim!.files?.[".gitignore"]?.addNDone).toBe(false)
  })

  test("add -N 失败 → 不进入 commit、不残留 intent-to-add", async () => {
    const { repo, fake } = makeRepo()
    fake.gitignoreSim!.files = { ".gitignore": { untracked: true, forceAddNFail: true } }

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(out).toContain("`git add -N` 失败")
    expect(out).toContain("未提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test("提交后 name-only 与预期不一致 → 报告提交核验告警", async () => {
    const { repo, fake } = makeRepo()
    fake.gitignoreSim!.files = { ".gitignore": { untracked: true } }
    fake.gitignoreSim!.showNameOnly = ".gitignore\nREADME.md"

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(out).toContain("提交核验")
    expect(out).toContain("README.md")
  })
})

describe("否定与保留分层", () => {
  test("强制组被 `!` 否定后仍补齐；基线条目 `!` 尊重不追加并报告", async () => {
    const content = "!.worktree/\n!.DS_Store\n"
    const { repo, fake } = makeRepo({ gitignore: content })

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    const lines = valueLines(readText(repo, ".gitignore"))
    expect(lines).toContain(".worktree/")
    expect(lines).not.toContain(".DS_Store")
    expect(out).toContain("用户显式保留")
    expect(out).toContain("`!.DS_Store`")
  })

  test("通配行不算覆盖 → 补齐明确条目", async () => {
    const { repo } = makeRepo({ gitignore: "openspec/*\n" })

    await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(valueLines(readText(repo, ".gitignore"))).toContain("openspec/states/")
  })

  test("`.worktree` 无斜杠等价 → 不重复补", async () => {
    const { repo } = makeRepo({ gitignore: ".worktree\n" })

    const out = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    const lines = valueLines(readText(repo, ".gitignore"))
    expect(lines.filter((l) => l === ".worktree/")).toHaveLength(0)
    expect(out).toContain("`.worktree/`")
  })

  test("注释与空行不构成覆盖", async () => {
    const { repo } = makeRepo({ gitignore: "# .worktree/\n\n# openspec/states/\n" })

    await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    const lines = valueLines(readText(repo, ".gitignore"))
    expect(lines).toContain(".worktree/")
    expect(lines).toContain("openspec/states/")
  })
})

describe("文本边界与幂等", () => {
  test("CRLF 文件 → 追加行保持 CRLF", async () => {
    const { repo } = makeRepo({ gitignore: "node_modules/\r\n" })

    await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(readText(repo, ".gitignore")).toContain("node_modules/\r\n.worktree/\r\n")
  })

  test("无尾换行 → 追加前补换行", async () => {
    const { repo } = makeRepo({ gitignore: "node_modules/" })

    await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(readText(repo, ".gitignore").startsWith("node_modules/\n.worktree/")).toBe(true)
  })

  test("第二次调用不重复追加、不重复提交", async () => {
    const { repo, fake } = makeRepo()
    const first = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })
    expect(first).toContain("已提交")

    fake.callLog.length = 0
    const second = await ensureIgnoreBaseline(repo, { baseBranch: "main", session: null })

    expect(second).toContain("已齐全，未改动文件")
    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })
})

describe("check-ignore 辅助校验", () => {
  test("checkIgnoreHit=false → 返回体含未确认命中来源说明", async () => {
    const { repo } = makeRepo({ gitignore: [...GENERATED_ENTRIES, ...FRAMEWORK_ENTRIES].join("\n") })

    const out = await ensureIgnoreBaseline(repo, { session: null })

    expect(out).toContain("未确认命中来源")
    expect(out).toContain("已齐全，未改动文件")
  })

  test("checkIgnoreHit=true → 返回体含命中来源 .gitignore 说明", async () => {
    const content = [...GENERATED_ENTRIES, ...FRAMEWORK_ENTRIES].join("\n")
    const { repo, fake } = makeRepo({ gitignore: content })
    fake.gitignoreSim!.checkIgnoreHit = true

    const out = await ensureIgnoreBaseline(repo, { session: null })

    expect(out).toContain("命中来源 `.gitignore`")
  })
})

describe("init / set_worktree 实测", () => {
  test("init.execute：守卫按最终 stacks 补齐并并入返回体", async () => {
    installTestSkillEnv()
    const dir = mkdtempSync(join(tmpdir(), "opx-ignore-init-"))
    tempDirs.push(dir)
    mkdirSync(join(dir, "openspec", "changes", "ignore-cid"), { recursive: true })
    writeFileSync(
      join(dir, "openspec", "changes", "ignore-cid", "tasks.md"),
      "## 1. First Task Group\n\n- [ ] 1.1 Task one [spec:spec-a]\n",
      "utf-8",
    )
    const fake = createFakeGit()
    fake.gitignoreSim = {}
    fake.gitignoreSim.currentBranch = "main"
    __setGitRunner(fake)

    const orch = makeOrchCtx(dir)
    const out = await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: "ignore-cid", task_group_id: "1", mode: "simple" },
      orch,
    )

    const content = readFileSync(join(dir, ".gitignore"), "utf-8")
    expect(content).toContain("openspec/states/")
    expect(content).toContain(".DS_Store")
    expect(content).toContain("target/")
    expect(out).toContain("忽略基线")
    expect(fake.callLog.some((l) => l.startsWith("check-ignore -v"))).toBe(true)
    expect(fake.callLog.some((l) => l.startsWith("status --porcelain -- .gitignore"))).toBe(true)
  })

  test("set_worktree：读取 state 内嵌 stacks，条目已齐时不重复提交", async () => {
    installTestSkillEnv()
    const dir = mkdtempSync(join(tmpdir(), "opx-ignore-sw-"))
    tempDirs.push(dir)
    mkdirSync(join(dir, "openspec", "changes", "ignore-sw"), { recursive: true })
    writeFileSync(
      join(dir, "openspec", "changes", "ignore-sw", "tasks.md"),
      "## 1. First Task Group\n\n- [ ] 1.1 Task one [spec:spec-a]\n",
      "utf-8",
    )
    const fake = createFakeGit()
    fake.gitignoreSim = {}
    fake.gitignoreSim.currentBranch = "main"
    fake.gitignoreSim.checkIgnoreHit = true
    __setGitRunner(fake)

    const orch = makeOrchCtx(dir)
    await init.execute({ ...INIT_PROJECT_STACKS, change_id: "ignore-sw", task_group_id: "1", mode: "simple" }, orch)
    fake.callLog.length = 0
    const out = await set_worktree.execute({ change_id: "ignore-sw" }, orch)

    expect(out).toContain("已创建 worktree")
    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("check-ignore -v"))).toBe(true)
  })

  test("set_worktree：state 缺失时跳过守卫，报未初始化且零写动作", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opx-ignore-sw-noinit-"))
    tempDirs.push(dir)
    const fake = createFakeGit()
    fake.gitignoreSim = {}
    fake.gitignoreSim.currentBranch = "main"
    __setGitRunner(fake)

    const orch = makeOrchCtx(dir)
    const err = await set_worktree.execute({ change_id: "no-such" }, orch).catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("未初始化")
    expect((err as Error).message).toContain("opx_orch_init")
    expect(fake.callLog.some((l) => l.startsWith("checked:add"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })
})

// teardown 由 bun 自动执行 afterEach；显式引用避免未使用告警
void teardown
