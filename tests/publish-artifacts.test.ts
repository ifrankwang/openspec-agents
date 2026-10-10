/**
 * 发布产物覆盖测试：包根 `files` 白名单必须覆盖各 harness 在「npm 安装」形态下依赖的入口，
 * 且构建脚本必须真的产出这些入口。
 *
 * 回归背景（本文件即为这次事故设防）：把 6 个 opx_* 工具从 MCP 改为 DSH 原生插件的改造中，
 * 根 `.mcp-server` 被同时从 package.json 的 files 与构建脚本里移除。OpenCode 的 MCP 入口正是
 * 包根 `.mcp-server/cli.mjs`（src/adapters/opencode/index.ts），后果是：npm 安装的 OpenCode
 * 找不到入口、6 个工具全不可用；本地 `bun run sync` 的 rsync --delete 还会把这个目录从缓存里删掉。
 * 以下断言分别锁住「发布白名单」「构建产出」「prepack 链路」「sync 排除清单」，任一环节再次被删都会失败。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { PROJECT_ROOT, resolve } from "../src/adapters/agent-md"

interface RootPkg {
  files: string[]
  exports: Record<string, string>
  scripts: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

const TMP = mkdtempSync(join(tmpdir(), "opx-publish-artifacts-"))
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function readRootPkg(): RootPkg {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")) as RootPkg
}

/** npm 打包只带 files 命中的路径；断言某绝对路径落在白名单内。 */
function expectPublished(absPath: string, files: string[]): void {
  const rel = relative(PROJECT_ROOT, absPath)
  expect(rel.startsWith("..")).toBe(false)
  const covered = files.some((f) => rel === f || rel.startsWith(`${f}${sep}`) || rel.startsWith(`${f}/`))
  expect(covered, `${rel} 未被 package.json 的 files 白名单覆盖，发布包里不会有它`).toBe(true)
}

/** 走真实插件壳拿到 OpenCode 声明的 MCP 入口（避免测试自造一份路径）。 */
async function openCodeMcpEntry(): Promise<string> {
  const projectDir = join(TMP, "opencode-project")
  const { default: plugin } = await import("../src/adapters/opencode/index")
  let command: string[] = []
  const ctx = {
    location: { directory: projectDir },
    mcp: {
      transform: async (cb: (e: any) => void) => {
        cb({ set: (_name: string, cfg: { command: string[] }) => { command = cfg.command }, remove: () => {} })
      },
    },
    skill: { transform: async (cb: (e: any) => void) => cb({ add: () => {} }) },
  }
  await plugin.setup(ctx as never)
  return command[1]!
}

describe("发布产物覆盖 · 根 package.json files", () => {
  test("OpenCode 的 MCP 入口（包根 .mcp-server/cli.mjs）在发布白名单内", async () => {
    const pkg = readRootPkg()
    const entry = await openCodeMcpEntry()
    // 入口必须就是包根那份（agent-md 的 PROJECT_ROOT = 包根），不是某个插件包内的副本
    expect(entry).toBe(resolve(".mcp-server", "cli.mjs"))
    expectPublished(entry, pkg.files)
    expect(pkg.files).toContain(".mcp-server")
  })

  test("DSH 原生工具插件与 cordis patch 在发布白名单内", () => {
    const pkg = readRootPkg()
    expectPublished(resolve(".dsh-plugin", "opx-tools.mjs"), pkg.files)
    expectPublished(resolve("dsh", "cordis.patch.yml"), pkg.files)
    expect(pkg.files).toContain(".dsh-plugin")
    expect(pkg.dsh?.bundle?.patch).toBe("./dsh/cordis.patch.yml")
    expect(pkg.exports["./.dsh-plugin/opx-tools.mjs"]).toBe("./.dsh-plugin/opx-tools.mjs")
  })
})

describe("发布产物覆盖 · prepack 构建链路", () => {
  test("prepack → build:dsh → scripts/build-dsh-root.ts 链路未被改道", () => {
    const pkg = readRootPkg()
    expect(pkg.scripts.prepack).toBe("bun run build:dsh")
    expect(pkg.scripts["build:dsh"]).toContain("scripts/build-dsh-root.ts")
  })

  test("构建脚本同时产出 OpenCode 入口与 DSH 产物，且入口可被解析", async () => {
    const { buildRootArtifacts } = await import("../scripts/build-dsh-root")
    const out = join(TMP, "root-artifacts")
    buildRootArtifacts(out)

    // OpenCode 侧：MCP server bundle + dashboard 资源（page.ts 按同目录布局探测）
    const mcpEntry = join(out, ".mcp-server", "cli.mjs")
    expect(existsSync(mcpEntry)).toBe(true)
    expect(existsSync(join(out, ".mcp-server", "dashboard", "index.html"))).toBe(true)
    // DSH 侧：原生工具插件 bundle + patch
    expect(existsSync(join(out, ".dsh-plugin", "opx-tools.mjs"))).toBe(true)
    expect(existsSync(join(out, "dsh", "cordis.patch.yml"))).toBe(true)

    // 入口不是空壳、语法可解析：node --check 只做解析不做执行（入口顶层会解析 workflow 路径，
    // 在临时目录导入必然失败，故这里不执行）
    const check = spawnSync("node", ["--check", mcpEntry], { encoding: "utf-8" })
    expect(check.status, `node --check 失败：${check.stderr}`).toBe(0)
  })
})

describe("发布产物覆盖 · sync 排除清单", () => {
  test("rsync 排除清单不得排除任何 harness 的入口产物", async () => {
    const { RSYNC_EXCLUDES } = await import("../scripts/sync")
    // 排除 .mcp-server 会让 OpenCode 缓存丢失入口；排除 .dsh-plugin 会让 DSH profile 同步残缺
    expect(RSYNC_EXCLUDES).not.toContain("--exclude=.mcp-server")
    expect(RSYNC_EXCLUDES).not.toContain("--exclude=.dsh-plugin")
  })
})
