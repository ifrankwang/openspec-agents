#!/usr/bin/env node
/**
 * CI-only: publish built plugin packages to each harness marketplace repo.
 *
 * Prerequisites:
 * - `bun run build:plugins` has already produced dist/{claude-code,codex,zcode}-plugin
 * - SSH deploy keys for the marketplace repos are loaded in the CI ssh-agent
 * - Env VERSION is set to the release version (e.g. 0.118.0)
 *
 * Marketplace repos:
 * - ifrankwang/claude-code-plugins  (.claude-plugin/marketplace.json)
 * - ifrankwang/codex-plugins        (.agents/plugins/marketplace.json)
 * - ifrankwang/zcode-plugins        (marketplace.json)
 */
import { execSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"

const ROOT = process.cwd()
process.env.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND || "ssh -o StrictHostKeyChecking=accept-new"
const RAW_VERSION = process.env.VERSION
if (!RAW_VERSION) {
  console.error("VERSION env is required")
  process.exit(1)
}
const VERSION = RAW_VERSION.replace(/^v/, "")

const MARKETPLACE_NAME = "ifrankwang"
const PLUGIN_NAME = "openspec-agents"
const PLUGIN_DESCRIPTION =
  "OpenSpec change 编排：opx_* 编排工具（MCP）+ 编排子代理 + orchestrator skill，非 OpenCode agent 默认无人值守"

const TARGETS = [
  {
    harness: "claude-code",
    repo: "ifrankwang/claude-code-plugins",
    pluginDir: join(ROOT, "dist", "claude-code-plugin"),
    marketplaceFile: ".claude-plugin/marketplace.json",
    kind: "claude",
  },
  {
    harness: "codex",
    repo: "ifrankwang/codex-plugins",
    pluginDir: join(ROOT, "dist", "codex-plugin"),
    marketplaceFile: ".agents/plugins/marketplace.json",
    kind: "codex",
  },
  {
    harness: "zcode",
    repo: "ifrankwang/zcode-plugins",
    pluginDir: join(ROOT, "dist", "zcode-plugin"),
    marketplaceFile: "marketplace.json",
    kind: "zcode",
  },
]

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf-8"))
}

function writeMarketplace(repoDir, target) {
  const pluginVersion = readJson(join(repoDir, "plugins", PLUGIN_NAME, target.kind === "codex" ? ".codex-plugin" : target.kind === "claude" ? ".claude-plugin" : ".zcode-plugin", "plugin.json")).version

  if (target.kind === "codex") {
    const file = join(repoDir, target.marketplaceFile)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        {
          name: MARKETPLACE_NAME,
          interface: { displayName: "ifrankwang's Plugins" },
          plugins: [
            {
              name: PLUGIN_NAME,
              source: { source: "local", path: "./plugins/openspec-agents" },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Developer Tools",
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    )
    return
  }

  const file = join(repoDir, target.marketplaceFile)
  mkdirSync(dirname(file), { recursive: true })
  const manifest = {
    name: MARKETPLACE_NAME,
    description: "ifrankwang 的个人插件市场：OpenSpec change 编排插件",
    owner: { name: "ifrankwang" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: "./plugins/openspec-agents",
        description: PLUGIN_DESCRIPTION,
        version: pluginVersion,
      },
    ],
  }
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf-8")
}

function syncPlugin(repoDir, target) {
  const dest = join(repoDir, "plugins", PLUGIN_NAME)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(target.pluginDir, dest, { recursive: true })
}

for (const target of TARGETS) {
  console.log(`\n=== Publishing ${target.harness} -> ${target.repo} ===`)
  if (!existsSync(target.pluginDir)) {
    throw new Error(`plugin package not found: ${target.pluginDir}`)
  }

  const work = join(tmpdir(), `marketplace-${target.harness}-${Date.now()}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  const repoDir = join(work, target.repo.split("/")[1])
  run(`git clone git@github.com:${target.repo}.git ${repoDir}`)
  process.chdir(repoDir)
  run("git config user.email 'ifrankwang@users.noreply.github.com'")
  run("git config user.name 'ifrankwang'")

  syncPlugin(repoDir, target)
  writeMarketplace(repoDir, target)

  const changed = execSync("git status --porcelain", { encoding: "utf-8" }).trim()
  if (changed) {
    run("git add -A")
    run(`git commit -m "chore: publish ${PLUGIN_NAME} v${VERSION}"`)
    run("git push origin HEAD")
    console.log(`Published ${target.repo}`)
  } else {
    console.log(`No changes for ${target.repo}, skip push`)
  }

  process.chdir(ROOT)
  rmSync(work, { recursive: true, force: true })
}
