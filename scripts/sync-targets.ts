/**
 * sync 目标声明式配置。
 * 新增 harness 时只需在此表增加一项，无需改动 sync.ts 主逻辑。
 */
export interface SyncTarget {
  harness: string
  kind: "source-cache" | "plugin-cache"
  manifestDir?: string
  build?: "claude" | "codex" | "zcode"
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
]
