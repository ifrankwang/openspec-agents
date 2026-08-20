/**
 * resolveSkillScanRoot 逐级上溯探测的纯函数测试（不依赖真实仓库布局，同 loader.path.test.ts 范式：
 * mkdtemp fixture + pathToFileURL 构造模块 URL + 纯函数入参）：
 * - 源码形态：<tmp>/src/skills/scan.ts 上溯命中 <tmp>/assets/skills
 * - 插件 dist 形态：<tmp>/zcode-plugin/.mcp-server/ 上溯 1 级命中 <tmp>/zcode-plugin/skills
 * - ZCode 缓存嵌套形态：<tmp>/cache/ifrankwang/openspec-agents/0.119.0/.mcp-server/ 命中 0.119.0/skills
 * - npm 形态：<tmp>/node_modules/@scope/pkg/.mcp-server/ 命中包根 assets/skills（不越级收消费方项目根）
 * - 双候选优先级：同一级 assets/skills 优先于 skills/
 * - 空骨架防御：skills/ 下子目录无 SKILL.md 不命中，继续上溯
 * - 无命中：上溯到文件系统根仍未命中返回 null（优雅降级）
 * - 集成：探测根接入 scanSkillTags / resolveSkillsForCapabilities 全链路可解析出 skill 名
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveSkillScanRoot } from "../src/skills/scan"
import { scanSkillTags, resolveSkillsForCapabilities } from "../src/skills/resolve"

const TMP_ROOT = mkdtempSync(join(tmpdir(), "opx-skills-scan-"))

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

/**
 * 构造 moduleDir/cli.mjs 模块文件与 skillRoot/<skillName>/SKILL.md（含 capabilities frontmatter，
 * 参考 assets/skills/quality-gate/SKILL.md 格式），返回 skillRoot。
 */
function setupSkillRoot(moduleDir: string, skillRoot: string, skillName: string): string {
  mkdirSync(moduleDir, { recursive: true })
  writeFileSync(join(moduleDir, "cli.mjs"), "// module\n")
  const skillDir = join(skillRoot, skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: 测试用 skill，仅验证扫描链路\ncapabilities: ["quality-gate"]\n---\n`,
  )
  return skillRoot
}

const moduleUrl = (moduleDir: string) => pathToFileURL(join(moduleDir, "cli.mjs")).href

describe("resolveSkillScanRoot 逐级上溯探测", () => {
  test("源码形态：src/skills/ 上溯命中仓库根 assets/skills", () => {
    const root = join(TMP_ROOT, "src-form")
    const moduleDir = join(root, "src", "skills")
    const expected = setupSkillRoot(moduleDir, join(root, "assets", "skills"), "src-skill")
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBe(expected)
  })

  test("插件 dist 形态：zcode-plugin/.mcp-server/ 上溯 1 级命中插件根 skills/", () => {
    const root = join(TMP_ROOT, "zcode-plugin-form")
    const moduleDir = join(root, ".mcp-server")
    const expected = setupSkillRoot(moduleDir, join(root, "skills"), "plugin-skill")
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBe(expected)
  })

  test("ZCode 缓存嵌套形态：cache/.../0.119.0/.mcp-server/ 上溯 1 级命中版本目录 skills/", () => {
    const root = join(TMP_ROOT, "cache-form")
    const moduleDir = join(root, "cache", "ifrankwang", "openspec-agents", "0.119.0", ".mcp-server")
    const expected = setupSkillRoot(
      moduleDir,
      join(root, "cache", "ifrankwang", "openspec-agents", "0.119.0", "skills"),
      "cache-skill",
    )
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBe(expected)
  })

  test("npm 形态：node_modules/@scope/pkg/.mcp-server/ 命中包根 assets/skills（不越级收消费方项目根）", () => {
    const root = join(TMP_ROOT, "npm-form")
    const moduleDir = join(root, "node_modules", "@scope", "pkg", ".mcp-server")
    const expected = setupSkillRoot(
      moduleDir,
      join(root, "node_modules", "@scope", "pkg", "assets", "skills"),
      "npm-skill",
    )
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBe(expected)
  })

  test("双候选优先级：同一级 assets/skills 优先于 skills/", () => {
    const root = join(TMP_ROOT, "priority-form")
    const moduleDir = join(root, ".mcp-server")
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, "cli.mjs"), "// module\n")
    setupSkillRoot(moduleDir, join(root, "skills"), "skills-form-skill")
    const expected = setupSkillRoot(moduleDir, join(root, "assets", "skills"), "assets-form-skill")
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBe(expected)
  })

  test("空骨架防御：skills/ 下子目录无 SKILL.md 不命中，上溯命中 assets/skills", () => {
    const root = join(TMP_ROOT, "defense-form")
    const moduleDir = join(root, ".mcp-server")
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, "cli.mjs"), "// module\n")
    mkdirSync(join(root, "skills", "skeleton-dir"), { recursive: true }) // 空骨架：子目录无 SKILL.md
    const expected = setupSkillRoot(moduleDir, join(root, "assets", "skills"), "defense-skill")
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBe(expected)
  })

  test("空骨架防御：仅空 skills/ 骨架时继续上溯直至无命中返回 null", () => {
    const root = join(TMP_ROOT, "defense-only-form")
    const moduleDir = join(root, ".mcp-server")
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, "cli.mjs"), "// module\n")
    mkdirSync(join(root, "skills", "skeleton-dir"), { recursive: true })
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBeNull()
  })

  test("无命中：无任何 skills 目录时上溯到文件系统根返回 null（优雅降级）", () => {
    const root = join(TMP_ROOT, "missing-form")
    const moduleDir = join(root, ".mcp-server")
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, "cli.mjs"), "// module\n")
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBeNull()
  })

  test("集成：探测根接入 scanSkillTags / resolveSkillsForCapabilities 全链路可解析出 skill 名", () => {
    const root = join(TMP_ROOT, "integration-form")
    const moduleDir = join(root, ".mcp-server")
    const scanRoot = setupSkillRoot(moduleDir, join(root, "assets", "skills"), "integration-skill")
    expect(resolveSkillScanRoot(moduleUrl(moduleDir))).toBe(scanRoot)
    const index = scanSkillTags([scanRoot])
    expect(index.skillTags.get("integration-skill")).toEqual(["quality-gate"])
    const r = resolveSkillsForCapabilities(["quality-gate"], index)
    expect(r.skillNames).toContain("integration-skill")
    expect(r.generic).toContain("integration-skill")
  })
})
