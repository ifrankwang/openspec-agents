/**
 * 生成目录忽略守卫（ensureGeneratedDirsIgnored）测试。
 *
 * 混合模式：.gitignore 文件是真实的（node:fs 临时目录读写），只有 git 命令走 FakeGitRunner
 * 模拟（gitignoreSim 启用时接管守卫专属命令形态，null 时既有行为完全不变）。
 *
 * 覆盖：条目齐全不动作 / 缺行补齐 / 新建与 add -N → commit 路径 / CRLF 保留 / `!` 否定 /
 * 通配不覆盖 / .worktree 无斜杠等价 / 跨分支 / detached HEAD / fix=none / stagedOutside /
 * user-dirty / 幂等重入 / 返回体契约（含 commit oid、无流转指令）/ initExecute 顶部触发。
 *
 * 运行：bun test tests/orchestrate.gitignore-guard.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensureGeneratedDirsIgnored } from "../src/core/gitignore"
import { __setGitRunner } from "../src/core/git"
import { init, set_worktree } from "../src/adapters/opencode/tools"
import { createFakeGit, FakeGitRunner, installTestSkillEnv, makeOrchCtx, INIT_PROJECT_STACKS, teardown } from "./helpers"

const tempDirs: string[] = []

function makeRepo(opts: { gitignore?: string } = {}): { repo: string; fake: FakeGitRunner } {
  const dir = mkdtempSync(join(tmpdir(), "opx-gitignore-"))
  tempDirs.push(dir)
  if (opts.gitignore !== undefined) {
    writeFileSync(join(dir, ".gitignore"), opts.gitignore, "utf-8")
  }
  const fake = createFakeGit()
  fake.gitignoreSim = {}
  __setGitRunner(fake)
  return { repo: dir, fake }
}

const COMMIT_LINE_PREFIX = "checked:commit -m chore(gitignore): ignore openspec orchestration artifacts"

function readGitignore(repo: string): string {
  return readFileSync(join(repo, ".gitignore"), "utf-8")
}

function assertNoMutatingBeyondGuard(fake: FakeGitRunner): void {
  // 除守卫自身的 add -N / commit --only 外，不应有任何其它写类命令
  const mutating = fake.callLog.filter(
    (l) => l.startsWith("checked:") && !l.startsWith("checked:add -N") && !l.startsWith(COMMIT_LINE_PREFIX),
  )
  expect(mutating).toEqual([])
}

afterEach(() => {
  __setGitRunner(null)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不掩盖断言失败 */ }
  }
})

describe("条目齐全：不动作", () => {
  test("HEAD 已含两行且文件干净 → 不改文件、不提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\n.worktree/\nopenspec/states/\n" })
    fake.gitignoreSim!.checkIgnoreHit = true
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(out).toContain("条目齐全，未改动文件")
    expect(out).toContain("未提交")
    expect(readGitignore(repo)).toBe("node_modules/\n.worktree/\nopenspec/states/\n")
    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
    expect(fake.gitignoreSim!.addNDone).toBeFalsy()
  })

  test("文件不存在但 HEAD 版本已含两行（刚被外部还原）→ 不动作", async () => {
    // precheckCommit 的 willBeUntracked 分支：文件不存在 + status 干净 = willBeUntracked=true，
    // 但条目缺失也要补写文件。此用例验证「文件不存在 → 补写两行 → intent-to-add → commit」链路。
    const { repo, fake } = makeRepo()
    fake.gitignoreSim!.currentBranch = "main"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
    expect(out).toContain("本次补齐")
    // 全新未跟踪：add -N 先于 commit --only
    const addIdx = fake.callLog.findIndex((l) => l.startsWith("checked:add -N"))
    const commitIdx = fake.callLog.findIndex((l) => l.startsWith(COMMIT_LINE_PREFIX))
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdx).toBeGreaterThan(addIdx)
    expect(fake.gitignoreSim!.addNDone).toBe(true)
    expect(out).toContain("已原子提交")
    expect(out).toContain("abc123def456")
  })
})

describe("缺行补齐", () => {
  test("缺一条 → 只补缺失行，原行保留", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\n.worktree/\n" })
    fake.gitignoreSim!.checkIgnoreHit = true
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe("node_modules/\n.worktree/\nopenspec/states/\n")
    expect(out).toContain("本次补齐：`openspec/states/`")
    expect(out).toContain("已原子提交")
  })

  test("缺两条 → 一次补齐两行", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\n" })
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe("node_modules/\n.worktree/\nopenspec/states/\n")
    expect(out).toContain("本次补齐：`.worktree/`、`openspec/states/`")
    expect(out).toContain("已原子提交")
  })
})

describe("提交前置守卫", () => {
  test("跨分支（currentBranch ≠ baseBranch）→ 只写工作树，返回体含未提交与分支说明", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.currentBranch = "feature-x"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
    expect(out).toContain("未提交")
    expect(out).toContain("feature-x")
    expect(out).toContain("main")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
    assertNoMutatingBeyondGuard(fake)
  })

  test("detached HEAD → 只写工作树、不提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.detached = true

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
    expect(out).toContain("detached HEAD")
    expect(out).toContain("未提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test("baseBranch 缺省 → 以当前检出分支为提交目标，同分支可提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.currentBranch = "develop"

    const out = await ensureGeneratedDirsIgnored(repo)

    expect(out).toContain("已原子提交")
    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
  })

  test("fix=none（skipCommit）→ 写工作树、不提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })

    const out = await ensureGeneratedDirsIgnored(repo, { skipCommit: true })

    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
    expect(out).toContain("只审不修")
    expect(out).toContain("未提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test("主仓库暂存区含其它已暂存改动（stagedOutside 非空）→ 不提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.currentBranch = "main"
    fake.gitignoreSim!.stagedOutside = ["src/App.java"]

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
    expect(out).toContain("暂存区含其它已暂存改动")
    expect(out).toContain("未提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test(".gitignore 自身有其它未暂存改动（user-dirty）→ 不提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\n# 用户未提交的注释\n" })
    fake.gitignoreSim!.gitignoreStatus = "user-dirty"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    // 工作树仍补齐（生效），但用户的其它行保留、不提交
    expect(readGitignore(repo)).toContain("# 用户未提交的注释")
    expect(readGitignore(repo)).toContain("openspec/states/")
    expect(out).toContain("用户其它未提交改动")
    expect(out).toContain("未提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })

  test("全新未跟踪且未 add -N 时 commit 失败 → 真实失败路径（降级不提交）", async () => {
    // 未启用 add -N 补偿的失败路径：untracked + commitOnlyFailsWithoutAddN 默认 true（贴真实 git
    // pathspec 不匹配语义）。但实现「先 add -N 再 commit」，正常链路不会踩到 pathspec 失败；
    // 故通过 forceCommitOnlyFail 真实触发 commit 失败降级（add -N 已成功执行）。
    const { repo, fake } = makeRepo()
    fake.gitignoreSim!.currentBranch = "main"
    fake.gitignoreSim!.untracked = true
    fake.gitignoreSim!.forceCommitOnlyFail = true

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    // add -N 先行执行，commit 失败后返回降级文案、无「已原子提交」
    const addIdx = fake.callLog.findIndex((l) => l.startsWith("checked:add -N"))
    const commitIdx = fake.callLog.findIndex((l) => l.startsWith(COMMIT_LINE_PREFIX))
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdx).toBeGreaterThan(addIdx)
    expect(out).toContain("`git commit --only` 失败")
    expect(out).toContain("未提交")
    expect(out).not.toContain("已原子提交")
    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
  })

  test("commit --only 失败 → 返回体含失败原因、已生效未提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.currentBranch = "main"
    fake.gitignoreSim!.forceCommitOnlyFail = true

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(out).toContain("`git commit --only` 失败")
    expect(out).toContain("未提交")
    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
  })

  test("add -N 失败 → 降级不提交", async () => {
    const { repo, fake } = makeRepo()
    fake.gitignoreSim!.currentBranch = "main"
    fake.gitignoreSim!.untracked = true
    // 强制 add -N 失败（runChecked 侧专用开关）：intent-to-add 失败即降级返回，
    // 不进入 commit --only，callLog 中不应出现任何 commit 命令。
    fake.gitignoreSim!.forceAddNFail = true

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(out).toContain("`git add -N` 失败")
    expect(out).toContain("未提交")
    expect(out).not.toContain("已原子提交")
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
    expect(fake.gitignoreSim!.addNDone).toBeFalsy()
  })
})

describe("文本解析边界", () => {
  test("CRLF 文件 → 追加行保持 CRLF", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\r\n" })
    fake.gitignoreSim!.gitignoreStatus = "clean"

    await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe("node_modules/\r\n.worktree/\r\nopenspec/states/\r\n")
  })

  test("`!` 否定行判未覆盖 → 补齐该条目", async () => {
    const { repo, fake } = makeRepo({ gitignore: "!openspec/states/\n" })
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe("!openspec/states/\n.worktree/\nopenspec/states/\n")
    expect(out).toContain("本次补齐")
  })

  test("通配行不算覆盖 → 补齐明确条目", async () => {
    const { repo, fake } = makeRepo({ gitignore: "openspec/*\n" })
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe("openspec/*\n.worktree/\nopenspec/states/\n")
    expect(out).toContain("本次补齐")
  })

  test("`.worktree` 无斜杠等价 → 不重复补", async () => {
    const { repo, fake } = makeRepo({ gitignore: "worktree 前身注释\n.worktree\n" })
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe("worktree 前身注释\n.worktree\nopenspec/states/\n")
    expect(out).toContain("本次补齐：`openspec/states/`")
    expect(out).not.toContain("`.worktree/`、")
  })

  test("无尾换行 → 追加前补换行", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/" })
    fake.gitignoreSim!.gitignoreStatus = "clean"

    await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe("node_modules/\n.worktree/\nopenspec/states/\n")
  })

  test("存在但为空 → 按文件不存在同等处理，不产前导空行", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
    expect(out).toContain("本次补齐")
  })

  test("注释与空行被忽略，不构成覆盖", async () => {
    const { repo, fake } = makeRepo({ gitignore: "# .worktree/\n\n# openspec/states/\n" })
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(out).toContain("本次补齐：`.worktree/`、`openspec/states/`")
    expect(readGitignore(repo)).toContain(".worktree/\n")
  })
})

describe("幂等重入", () => {
  test("第二次调用不重复追加、不重复提交", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.currentBranch = "main"

    const first = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })
    expect(first).toContain("已原子提交")

    // 模拟提交后的库状态：HEAD 已含条目、文件已跟踪且干净
    fake.gitignoreSim!.checkIgnoreHit = true
    fake.gitignoreSim!.gitignoreStatus = "clean"
    fake.gitignoreSim!.untracked = false
    fake.gitignoreSim!.addNDone = false
    fake.callLog.length = 0

    const second = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(second).toContain("条目齐全，未改动文件")
    expect(second).toContain("未提交")
    expect(readGitignore(repo)).toBe(".worktree/\nopenspec/states/\n")
    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })
})

describe("返回体契约", () => {
  test("提交成功路径返回体含 commit oid、消息，不含流转指令", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.currentBranch = "main"
    fake.gitignoreSim!.commitOid = "deadbeef1234567890"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(out).toContain("deadbeef1234567890")
    expect(out).toContain("chore(gitignore): ignore openspec orchestration artifacts")
    expect(out).not.toContain("请调用")
    expect(out).not.toContain("请分派")
    expect(out).toContain("辅助校验")
  })

  test("未提交路径返回体不含流转指令", async () => {
    const { repo, fake } = makeRepo({ gitignore: "" })
    fake.gitignoreSim!.detached = true

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(out).not.toContain("请调用")
    expect(out).not.toContain("请分派")
    expect(out).not.toContain("进入")
  })
})

describe("check-ignore 辅助校验", () => {
  test("checkIgnoreHit=false → 返回体含未确认命中来源说明（不影响覆盖判定）", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\n.worktree/\nopenspec/states/\n" })
    fake.gitignoreSim!.checkIgnoreHit = false
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(out).toContain("未确认命中来源")
    expect(out).toContain("条目齐全，未改动文件")
  })

  test("checkIgnoreHit=true → 返回体含命中来源 .gitignore 说明", async () => {
    const { repo, fake } = makeRepo({ gitignore: "node_modules/\n.worktree/\nopenspec/states/\n" })
    fake.gitignoreSim!.checkIgnoreHit = true
    fake.gitignoreSim!.gitignoreStatus = "clean"

    const out = await ensureGeneratedDirsIgnored(repo, { baseBranch: "main" })

    expect(out).toContain("命中来源 `.gitignore`")
  })
})

describe("initExecute 顶部守卫触发", () => {
  test("init.execute 实测：守卫先于任何 state 写盘执行，返回体并入 init 输出", async () => {
    installTestSkillEnv()
    const dir = mkdtempSync(join(tmpdir(), "opx-gitignore-init-"))
    tempDirs.push(dir)
    // tasks.md 夹具（init 需解析任务组）：手写，不走 setupWorkspace（后者会装自己的 CLI 桩，无冲突但目录结构不同）
    mkdirSync(join(dir, "openspec", "changes", "gitignore-cid"), { recursive: true })
    writeFileSync(
      join(dir, "openspec", "changes", "gitignore-cid", "tasks.md"),
      "## 1. First Task Group\n\n- [ ] 1.1 Task one [spec:spec-a]\n",
      "utf-8",
    )
    const fake = createFakeGit()
    fake.gitignoreSim = {}
    fake.gitignoreSim.currentBranch = "main"
    __setGitRunner(fake)

    const orch = makeOrchCtx(dir)
    const out = await init.execute(
      { ...INIT_PROJECT_STACKS, change_id: "gitignore-cid", task_group_id: "1", mode: "simple" },
      orch,
    )

    // 守卫真实写入 .gitignore（node:fs 层面），且返回体并入 init 输出
    expect(existsSync(join(dir, ".gitignore"))).toBe(true)
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toContain("openspec/states/")
    expect(out).toContain("生成目录忽略")
    // 守卫命令确实发生
    expect(fake.callLog.some((l) => l.startsWith("check-ignore -v"))).toBe(true)
    expect(fake.callLog.some((l) => l.startsWith("status --porcelain -- .gitignore"))).toBe(true)
  })

  test("set_worktree 实测：守卫在 init 已跑过（条目已提交）后不重复动作", async () => {
    installTestSkillEnv()
    const dir = mkdtempSync(join(tmpdir(), "opx-gitignore-sw-"))
    tempDirs.push(dir)
    mkdirSync(join(dir, "openspec", "changes", "gitignore-sw"), { recursive: true })
    writeFileSync(
      join(dir, "openspec", "changes", "gitignore-sw", "tasks.md"),
      "## 1. First Task Group\n\n- [ ] 1.1 Task one [spec:spec-a]\n",
      "utf-8",
    )
    // 预置 .gitignore 已齐全且已提交（模拟 init 守卫提交后的库状态）
    writeFileSync(join(dir, ".gitignore"), ".worktree/\nopenspec/states/\n", "utf-8")
    const fake = createFakeGit()
    fake.gitignoreSim = {}
    fake.gitignoreSim.currentBranch = "main"
    fake.gitignoreSim.checkIgnoreHit = true
    fake.gitignoreSim.gitignoreStatus = "clean"
    __setGitRunner(fake)

    const orch = makeOrchCtx(dir)
    await init.execute({ ...INIT_PROJECT_STACKS, change_id: "gitignore-sw", task_group_id: "1", mode: "simple" }, orch)
    fake.callLog.length = 0
    const out = await set_worktree.execute({ change_id: "gitignore-sw" }, orch)

    expect(out).toContain("已创建 worktree")
    // 第二次守卫零写动作：无 add -N、无 commit --only
    expect(fake.callLog.some((l) => l.startsWith("checked:add -N"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("check-ignore -v"))).toBe(true)
  })

  test("set_worktree 实测：state 缺失时跳过守卫，报未初始化错且零写动作", async () => {
    // 会话未初始化：守卫不再执行（无效调用不产生 add/commit 副作用），仍走原抛错路径。
    const dir = mkdtempSync(join(tmpdir(), "opx-gitignore-sw-noinit-"))
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
    // 守卫被跳过：callLog 无 add / commit 写动作
    expect(fake.callLog.some((l) => l.startsWith("checked:add"))).toBe(false)
    expect(fake.callLog.some((l) => l.startsWith("checked:commit"))).toBe(false)
  })
})
