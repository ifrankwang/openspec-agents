/**
 * sync 目标声明式配置。
 * 新增同形态 harness 时只需在此表增加一项；若引入新的同步形态（如 dsh-profile），
 * 需同步扩展 scripts/sync.ts 的对应处理。
 */
export interface SyncTarget {
  harness: string
  kind: "source-cache" | "plugin-cache" | "dsh-profile"
  manifestDir?: string
  build?: "claude" | "codex" | "zcode" | "deepseek-harness"
  /** DSH profile 中安装的 bundle 包名（用于定位 node_modules/<packageName>）。 */
  packageName?: string
  cacheRoots: string[]
}

export const SYNC_TARGETS: SyncTarget[] = [
  {
    harness: "opencode",
    kind: "source-cache",
    cacheRoots: [
      "~/.cache/opencode/packages",
      "~/Library/Caches/opencode/packages",
    ],
  },
  {
    harness: "claude-code",
    kind: "plugin-cache",
    manifestDir: ".claude-plugin",
    build: "claude",
    cacheRoots: ["~/.claude/plugins/cache"],
  },
  {
    harness: "codex",
    kind: "plugin-cache",
    manifestDir: ".codex-plugin",
    build: "codex",
    cacheRoots: ["~/.codex/plugins/cache"],
  },
  {
    harness: "zcode",
    kind: "plugin-cache",
    manifestDir: ".zcode-plugin",
    build: "zcode",
    cacheRoots: ["~/.zcode/cli/plugins/cache"],
  },
  {
    harness: "deepseek-harness",
    kind: "dsh-profile",
    build: "deepseek-harness",
    packageName: "@ifrankwang/openspec-agents",
    cacheRoots: ["~/.dsh/profiles"],
  },
]
