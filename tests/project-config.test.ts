import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { FakeGitRunner } from "./helpers"
import { __setSkillScanRootsForTest, __resetSkillCache, scanSkillTags } from "../src/skills/resolve"
import type { ContainerProbeResult } from "../src/core/containers"
import {
  collectProjectConfigAssets,
  ensureProjectConfigs,
  ensureProjectConfigsForSession,
  renderProjectConfigSkip,
} from "../src/core/project-config"

const created: string[] = []

afterEach(() => {
  __setSkillScanRootsForTest(null)
  __resetSkillCache()
  __setGitRunner(null)
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

function mkTmp(prefix = "opx-project-config-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** 建一个含 SKILL.md（frontmatter）+ project-config 资产的假 skill。 */
function mkSkill(
  root: string,
  name: string,
  opts: {
    stacks: string[]
    frameworks?: string[]
    match?: string[]
    files?: Record<string, string>
  },
): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const frameworks = opts.frameworks ?? []
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: 测试用 skill\ncapabilities: ["quality-gate"]\n` +
      `stacks: [${opts.stacks.map((s) => `"${s}"`).join(", ")}]\n` +
      `frameworks: [${frameworks.map((s) => `"${s}"`).join(", ")}]\n---\n\n## 测试\n`,
  )
  if (opts.match) {
    mkdirSync(join(dir, "project-config"), { recursive: true })
    writeFileSync(join(dir, "project-config", "container-match"), `${opts.match.join("\n")}\n`)
  }
  for (const [file, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(dir, "project-config"), { recursive: true })
    writeFileSync(join(dir, "project-config", file), content)
  }
}

/** 建 skill 根并把扫描根钉死到它，返回仓库根（目录名用于验证 slug 插值）。 */
function setupSkills(skills: Array<Parameters<typeof mkSkill>[2] & { name: string }>, repoName = "My_Repo"): string {
  const root = mkTmp()
  for (const s of skills) mkSkill(join(root, "skills"), s.name, s)
  __setSkillScanRootsForTest([join(root, "skills")])
  __resetSkillCache()
  const repo = join(root, repoName)
  mkdirSync(repo, { recursive: true })
  return repo
}

function probeWith(images: string[]): ContainerProbeResult {
  return {
    runtime: "docker",
    containers: images.map((image) => ({ image, name: image.split(":")[0], ports: "" })),
    composeHits: [],
    source: "runtime",
  }
}

const BACKEND = { project_stacks: ["backend"], project_frameworks: ["java"] }

const SONAR_TEMPLATE = [
  "# 项目根扫描配置",
  "sonar.projectKey={{project.key}}",
  "sonar.projectName={{project.name}}",
  "sonar.host.url=http://localhost:9000",
  "sonar.sources=src/main/java",
  "",
].join("\n")

describe("collectProjectConfigAssets", () => {
  test("形态与容器双命中才收集，目标名=资产文件名", () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], frameworks: ["java"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
      { name: "fe-gate", stacks: ["frontend"], frameworks: ["vue"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const assets = collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9-community"]), { index: scanSkillTags() })
    expect(assets.map((a) => a.skill)).toEqual(["java-gate"])
    expect(assets[0].target).toBe("sonar-project.properties")
    expect(assets[0].detectedVia).toBe("runtime")
    expect(assets[0].matchedWords).toEqual(["sonarqube"])
    expect(repo).toBeTruthy()
  })

  test("无 container-match 的 skill 不提供基线", () => {
    setupSkills([{ name: "plain", stacks: ["backend"], frameworks: ["java"], files: { "x.properties": "a=1\n" } }])
    expect(collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })).toEqual([])
  })

  test("旧会话无项目栈：不收集", () => {
    setupSkills([{ name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } }])
    expect(collectProjectConfigAssets(null, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })).toEqual([])
    expect(collectProjectConfigAssets({ project_stacks: [], project_frameworks: [] }, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })).toEqual([])
  })

  test("容器不匹配：不收集", () => {
    setupSkills([{ name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } }])
    expect(collectProjectConfigAssets(BACKEND, probeWith(["postgres:16"]), { index: scanSkillTags() })).toEqual([])
  })

  test("运行时不可用时按 compose 文本命中，detectedVia=compose", () => {
    setupSkills([{ name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } }])
    const probe: ContainerProbeResult = {
      runtime: null,
      containers: [],
      composeHits: ["services:\n  sonarqube:\n    image: sonarqube:9.9\n"],
      source: "compose",
    }
    const assets = collectProjectConfigAssets(BACKEND, probe, { index: scanSkillTags() })
    expect(assets).toHaveLength(1)
    expect(assets[0].detectedVia).toBe("compose")
  })
})

describe("ensureProjectConfigs", () => {
  test("目标不存在：按模板创建并插值 project.name / project.key", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const assets = collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })
    const report = await ensureProjectConfigs(repo, assets)
    expect(report.targets).toHaveLength(1)
    expect(report.targets[0].action).toBe("created")
    expect(report.targets[0].sources).toEqual(["skill `java-gate`"])
    const content = readFileSync(join(repo, "sonar-project.properties"), "utf-8")
    expect(content).toContain("sonar.projectKey=my-repo")
    expect(content).toContain("sonar.projectName=my-repo")
    expect(content).toContain("# 项目根扫描配置") // 模板注释作为配置文件注释保留
    expect(content).not.toContain("{{project.")
  })

  test("已存在：只追加缺失键，不改已有行的值", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const target = join(repo, "sonar-project.properties")
    writeFileSync(target, "sonar.projectKey=custom-key\nsonar.host.url=http://ci.example:9000\n")
    const assets = collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })
    const report = await ensureProjectConfigs(repo, assets)
    expect(report.targets[0].action).toBe("appended")
    expect(report.targets[0].addedKeys).toEqual(["sonar.projectName", "sonar.sources"])
    const content = readFileSync(target, "utf-8")
    expect(content).toContain("sonar.projectKey=custom-key")
    expect(content).toContain("sonar.host.url=http://ci.example:9000")
    expect(content).toContain("sonar.projectName=my-repo")
    expect(content).toContain("sonar.sources=src/main/java")
    expect(content).toContain("# 由编排初始化补齐：skill `java-gate`")
  })

  test("幂等：第二次运行不重复追加、不重复注释", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const target = join(repo, "sonar-project.properties")
    writeFileSync(target, "sonar.projectKey=custom-key\n")
    const assets = collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })
    await ensureProjectConfigs(repo, assets)
    const first = readFileSync(target, "utf-8")
    const report = await ensureProjectConfigs(repo, assets)
    const second = readFileSync(target, "utf-8")
    expect(report.targets[0].action).toBe("complete")
    expect(second).toBe(first)
    expect(second.split("# 由编排初始化补齐：")).toHaveLength(2) // 注释只出现一次
  })

  test("两个 skill 同名目标合并条目，来源都记", async () => {
    const repo = setupSkills([
      { name: "a-gate", stacks: ["backend"], match: ["sonarqube"], files: { "shared.properties": "a.key=1\n" } },
      { name: "b-gate", stacks: ["backend"], match: ["sonarqube"], files: { "shared.properties": "b.key=2\n" } },
    ])
    const assets = collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })
    const report = await ensureProjectConfigs(repo, assets)
    expect(report.targets).toHaveLength(1)
    expect(report.targets[0].sources).toEqual(["skill `a-gate`", "skill `b-gate`"])
    const content = readFileSync(join(repo, "shared.properties"), "utf-8")
    expect(content).toContain("a.key=1")
    expect(content).toContain("b.key=2")
  })

  test("dryRun 只算计划，不落盘", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const assets = collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })
    const report = await ensureProjectConfigs(repo, assets, { dryRun: true })
    expect(report.targets[0].action).toBe("created")
    expect(existsSync(join(repo, "sonar-project.properties"))).toBe(false)
  })

  test("写入不触发任何 git 操作（不 add、不 commit）", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const git = new FakeGitRunner()
    __setGitRunner(git)
    const assets = collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })
    await ensureProjectConfigs(repo, assets)
    expect(git.callLog).toEqual([])
  })
})

describe("ensureProjectConfigsForSession / 报告文案", () => {
  test("命中并创建：返回已创建片段，含来源", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const note = await ensureProjectConfigsForSession(repo, BACKEND, probeWith(["sonarqube:9.9"]))
    expect(note).toContain("- **扫描平台配置**: 已创建 `sonar-project.properties`（来源：skill `java-gate`）")
  })

  test("slug 覆盖（worktree 语境）：project.key 用传入 slug 而非 worktree 目录名", async () => {
    const { ensureProjectConfigsForSessionWithReport } = await import("../src/core/project-config")
    // 模拟 worktree 布局：主仓库 my-repo / .worktree/cid/ws（basename 为 ws）
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const wt = join(repo, ".worktree", "cid", "ws")
    mkdirSync(wt, { recursive: true })
    const probe = probeWith(["sonarqube:9.9"])
    const r = await ensureProjectConfigsForSessionWithReport(wt, BACKEND, probe, { slug: "my-repo" })
    expect(r.note).toContain("已创建 `sonar-project.properties`")
    expect(r.writtenTargets).toEqual(["sonar-project.properties"])
    const content = readFileSync(join(wt, "sonar-project.properties"), "utf-8")
    expect(content).toContain("sonar.projectKey=my-repo")
    expect(content).toContain("sonar.projectName=my-repo")
    expect(content).not.toContain("ws")
    // 同 slug 重跑：已完整，不写盘、writtenTargets 为空（受控提交幂等）
    const again = await ensureProjectConfigsForSessionWithReport(wt, BACKEND, probe, { slug: "my-repo" })
    expect(again.writtenTargets).toEqual([])
    expect(again.note).toContain("已存在且完整")
  })

  test("旧会话无栈：跳过并说明", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const note = await ensureProjectConfigsForSession(repo, null, probeWith(["sonarqube:9.9"]))
    expect(note).toBe(renderProjectConfigSkip("no-session"))
    expect(note).toContain("会话未记录项目栈，跳过")
  })

  test("运行时不可用且无 compose：跳过原因是未检测到容器运行时", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const note = await ensureProjectConfigsForSession(repo, BACKEND, {
      runtime: null, containers: [], composeHits: [], source: "none",
    })
    expect(note).toContain("未检测到容器运行时，跳过")
  })

  test("检测到容器但无匹配平台：跳过并说明", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const note = await ensureProjectConfigsForSession(repo, BACKEND, probeWith(["postgres:16"]))
    expect(note).toContain("检测到容器但无匹配的平台，跳过")
  })

  test("按 compose 识别时报告注明来源方式", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const note = await ensureProjectConfigsForSession(repo, BACKEND, {
      runtime: null,
      containers: [],
      composeHits: ["services:\n  sonarqube:\n    image: sonarqube:9.9\n"],
      source: "compose",
    })
    expect(note).toContain("按 compose 文件识别")
  })

  test("运行时可用但零匹配：回落读 compose 文本一次，命中则照常补齐并标注容器未运行", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    writeFileSync(join(repo, "docker-compose.yml"), "services:\n  sonarqube:\n    image: sonarqube:9.9-community\n")
    const note = await ensureProjectConfigsForSession(repo, BACKEND, probeWith(["postgres:16"]))
    expect(note).toContain("已创建 `sonar-project.properties`")
    expect(note).toContain("按 compose 文件识别（容器未在运行）")
    expect(existsSync(join(repo, "sonar-project.properties"))).toBe(true)
  })

  test("运行时可用但没有任何容器在运行：文案区分「没有容器在运行」", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const note = await ensureProjectConfigsForSession(repo, BACKEND, probeWith([]))
    expect(note).toContain("没有容器在运行")
    expect(note).not.toContain("检测到容器但无匹配的平台")
  })
})

describe("C1 同仓多形态：按键合并、不重复键、冲突入报告", () => {
  const FRONTEND = { project_stacks: ["frontend"], project_frameworks: ["vue"] }
  const MONOREPO = { project_stacks: ["frontend", "backend"], project_frameworks: ["vue", "java"] }

  function setupMonorepo(): string {
    return setupSkills([
      {
        name: "fe-gate",
        stacks: ["frontend"],
        frameworks: ["vue"],
        match: ["sonarqube"],
        files: {
          "sonar-project.properties": [
            "# 前端扫描配置",
            "sonar.projectKey={{project.key}}",
            "sonar.sources=src",
            "sonar.exclusions=node_modules/**",
            "",
          ].join("\n"),
        },
      },
      {
        name: "java-gate",
        stacks: ["backend"],
        frameworks: ["java"],
        match: ["sonarqube"],
        files: {
          "sonar-project.properties": [
            "# 后端扫描配置",
            "sonar.projectKey=backend-key",
            "sonar.sources=src/main/java",
            "sonar.java.binaries=target/classes",
            "",
          ].join("\n"),
        },
      },
    ])
  }

  test("目标文件无重复键，冲突键点名键名与来源", async () => {
    const repo = setupMonorepo()
    expect(collectProjectConfigAssets(FRONTEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })).toHaveLength(1)
    const assets = collectProjectConfigAssets(MONOREPO, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })
    expect(assets).toHaveLength(2)
    const report = await ensureProjectConfigs(repo, assets)
    const content = readFileSync(join(repo, "sonar-project.properties"), "utf-8")
    const keyLines = content.split("\n").filter((l) => /^sonar\.projectKey\s*=/.test(l))
    expect(keyLines).toHaveLength(1) // 同键只写一次，后写不覆盖前写
    const sourceLines = content.split("\n").filter((l) => /^sonar\.sources\s*=/.test(l))
    expect(sourceLines).toHaveLength(1)
    expect(content).toContain("sonar.java.binaries=target/classes") // 后端独有键照常补齐
    const conflicts = report.targets[0].conflicts
    expect(conflicts.map((c) => c.key).sort()).toEqual(["sonar.projectKey", "sonar.sources"])
    const keyConflict = conflicts.find((c) => c.key === "sonar.projectKey")!
    expect(keyConflict.sources).toHaveLength(2)
    // 冲突提示出现在报告文本里
    const note = await ensureProjectConfigsForSession(repo, MONOREPO, probeWith(["sonarqube:9.9"]))
    expect(note).toContain("冲突键")
  })
})

describe("H1 追加注释不重复写入", () => {
  test("连续两轮各删除不同键后 init：注释行始终只有 1 行", async () => {
    const repo = setupSkills([
      { name: "java-gate", stacks: ["backend"], match: ["sonarqube"], files: { "sonar-project.properties": SONAR_TEMPLATE } },
    ])
    const assets = collectProjectConfigAssets(BACKEND, probeWith(["sonarqube:9.9"]), { index: scanSkillTags() })
    await ensureProjectConfigs(repo, assets)
    const target = join(repo, "sonar-project.properties")

    // 第一轮：删掉 sonar.host.url 后 init
    const round1 = readFileSync(target, "utf-8")
      .split("\n")
      .filter((l) => !l.startsWith("sonar.host.url="))
      .join("\n")
    writeFileSync(target, round1)
    await ensureProjectConfigs(repo, assets)
    expect(readFileSync(target, "utf-8").split("# 由编排初始化补齐：")).toHaveLength(2)

    // 第二轮：再删掉 sonar.sources 后 init
    const round2 = readFileSync(target, "utf-8")
      .split("\n")
      .filter((l) => !l.startsWith("sonar.sources="))
      .join("\n")
    writeFileSync(target, round2)
    await ensureProjectConfigs(repo, assets)
    const final = readFileSync(target, "utf-8")
    expect(final.split("# 由编排初始化补齐：")).toHaveLength(2) // 注释仍只有 1 行
    expect(final).toContain("sonar.host.url=http://localhost:9000")
    expect(final).toContain("sonar.sources=src/main/java")
  })
})
