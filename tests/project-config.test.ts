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
})
