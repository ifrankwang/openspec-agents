#!/usr/bin/env bash
# 将本地源码同步到本机已存在的全部 openspec-agents 安装缓存。
# 支持三类缓存目标（按实际存在的目录发现，发现即同步）：
#   1) opencode GitHub 插件缓存（node_modules 形态）——直接 rsync 源码
#   2) ZCode / Claude Code 插件缓存（marketplace 安装缓存，打包产物形态）——
#      先按缓存内清单目录名判定打包命令（.claude-plugin → claude:plugin，.zcode-plugin → zcode:plugin），
#      再 rsync 打包产物到安装缓存目录（就地刷新，保持 installPath 不变，重启 agent 生效）
#   3) ZCode 市场克隆（marketplaces/<name>/，安装源快照）——直接 rsync 源码
# cd 到项目根目录后运行

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

found=0

# 已处理目标去重（权威记录与目录扫描可能命中同一目录，macOS bash 3.2 下空数组
# 在 set -u 中会报 unbound variable，故用临时文件判重而非数组）。
# trap 保留原退出码：bash 的 EXIT trap 以最后一条命令的退出码作为脚本退出码，
# 直接 rm 会把致命错误（set -e/-u）的退出码吞成 0，掩盖失败。
DEDUP_FILE="$(mktemp)"
trap 'status=$?; rm -f "$DEDUP_FILE"; exit "$status"' EXIT

is_deduped() {
  grep -qxF "$1" "$DEDUP_FILE" 2>/dev/null
}

mark_deduped() {
  echo "$1" >> "$DEDUP_FILE"
}

# 同步排除项（opencode 插件本体与市场克隆共用）：node_modules（依赖由安装器维护）、
# git 元数据、本机运行时状态与索引（.codegraph/.worktree/.opencode/openspec/states/）。
# 数组非空，bash 3.2 + set -u 下展开安全。
RSYNC_EXCLUDES=(
  "--exclude=node_modules"
  "--exclude=.git"
  "--exclude=.DS_Store"
  "--exclude=.codegraph"
  "--exclude=.worktree"
  "--exclude=.worktrees"
  "--exclude=.opencode"
  "--exclude=openspec/states/"
)

# ---- 1) opencode 插件缓存（node_modules 形态，直接同步源码） ----
# 发现目标：~/.cache/opencode/packages/*/node_modules/openspec-agents
CACHE_ROOTS=(
  "$HOME/.cache/opencode/packages"
  "$HOME/Library/Caches/opencode/packages"
)

for root in "${CACHE_ROOTS[@]}"; do
  if [ ! -d "$root" ]; then
    continue
  fi
  while IFS= read -r target; do
    if [ -n "$target" ] && [ -d "$target" ]; then
      # 守卫畸形路径（历史错误同步在 packages/ 下产生的字面量 ~ 嵌套路径）：
      # 合法 opencode 包路径（owner/repo 名）不可能含 ~，命中即跳过
      case "$target" in
        *"~"*)
          echo "SKIP ${target}（畸形路径，跳过）" >&2
          continue
          ;;
      esac
      echo "Syncing workspace → $target"
      rsync -a --delete "${RSYNC_EXCLUDES[@]}" \
        "$PROJECT_DIR/" \
        "$target/"
      found=$((found + 1))
    fi
  done < <(find "$root" -type d -path "*/node_modules/openspec-agents" 2>/dev/null)
done

# ---- 2) ZCode / Claude Code 插件缓存（打包产物形态，先打包再同步） ----
# 发现目标：
#   权威记录 —— ~/.zcode/cli/plugins/installed_plugins.json 中 name=openspec-agents 的 installPath
#   fallback —— 扫描 cache 目录下 {marketplace}/{plugin}/{version} 形态的所有版本目录
# 同步方式：按缓存内清单目录名（.claude-plugin / .zcode-plugin）判定打包命令，产物 rsync 到安装目录。

# 打包结果缓存：同一形态的多个目标只打包一次（产物相同）
built_claude=0
built_zcode=0

sync_plugin_cache() {
  local target="$1"
  local build_cmd src_dir
  if is_deduped "$target"; then
    return 0
  fi
  mark_deduped "$target"
  if [ -d "$target/.claude-plugin" ]; then
    build_cmd="claude:plugin"
    src_dir="dist/claude-code-plugin"
  elif [ -d "$target/.zcode-plugin" ]; then
    build_cmd="zcode:plugin"
    src_dir="dist/zcode-plugin"
  else
    # 注意：bash 3.2 会把多字节标点并入变量名解析，变量后紧跟全角标点必须加花括号
    echo "SKIP ${target}（未识别清单目录形态，跳过）" >&2
    return 1
  fi
  if [ "$build_cmd" = "claude:plugin" ]; then
    if [ "$built_claude" -eq 0 ]; then
      echo "Building plugin package（bun run claude:plugin）→ ${src_dir}/"
      bun run claude:plugin
      built_claude=1
    fi
  else
    if [ "$built_zcode" -eq 0 ]; then
      echo "Building plugin package（bun run zcode:plugin）→ ${src_dir}/"
      bun run zcode:plugin
      built_zcode=1
    fi
  fi
  echo "Syncing ${src_dir}/ → $target"
  rsync -a --delete "$PROJECT_DIR/$src_dir/" "$target/"
  found=$((found + 1))
}

# 权威记录优先（仅取已安装插件的 installPath）。ZCode 记录文件为 installed_plugins.json；
# Claude Code 记录文件名与结构未接入，其缓存由下方目录扫描兜底。
PLUGIN_CACHE_ROOTS=(
  "$HOME/.zcode/cli/plugins/cache"
  "$HOME/.claude/plugins/cache"
)
for state_file in "$HOME/.zcode/cli/plugins/installed_plugins.json" "$HOME/.claude/plugins/installed_plugins.json"; do
  if [ ! -f "$state_file" ]; then
    continue
  fi
  while IFS= read -r install_path; do
    if [ -n "$install_path" ] && [ -d "$install_path" ]; then
      sync_plugin_cache "$install_path" || true
    fi
  done < <(node -e 'const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8")); for (const p of d.plugins ?? []) { if (p.name === "openspec-agents" && p.installPath) console.log(p.installPath) }' "$state_file" 2>/dev/null)
done

# fallback：扫描 cache 目录下 {marketplace}/{plugin}/{version} 形态的所有版本目录
# （含卸载残留目录，同步其内容无害；与权威记录经去重表判重）
for root in "${PLUGIN_CACHE_ROOTS[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r plugin_dir; do
    for version_dir in "$plugin_dir"/*/; do
      [ -d "$version_dir" ] || continue
      sync_plugin_cache "${version_dir%/}" || true
    done
  done < <(find "$root" -maxdepth 2 -type d -name "openspec-agents" 2>/dev/null)
done

# ---- 3) ZCode 市场克隆（安装源快照，直接同步源码） ----
# 发现目标：~/.zcode/cli/plugins/marketplaces/openspec-agents-marketplace
# 市场克隆作为安装源：marketplace.json 的 source 指向 dist/ 打包产物，同步前须确保产物新鲜
# （若本机无任何插件缓存触发过打包，则主动打一次 claude:plugin）。
# exclude 运行时目录（node_modules/.git/.codegraph/.worktree/.opencode/openspec/states/），
# 避免把本机运行状态与索引写入安装源快照。
MARKETPLACE_ROOTS=(
  "$HOME/.zcode/cli/plugins/marketplaces"
  "$HOME/.claude/plugins/marketplaces"
)
for root in "${MARKETPLACE_ROOTS[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r target; do
    if [ -z "$target" ] || [ ! -d "$target" ]; then
      continue
    fi
    # 市场克隆作为安装源，两种形态的 dist 产物都须新鲜（无论之前是否被插件缓存触发过打包）
    if [ "$built_claude" -eq 0 ]; then
      echo "Building plugin package（bun run claude:plugin）→ dist/claude-code-plugin/（市场克隆安装源）"
      bun run claude:plugin
      built_claude=1
    fi
    if [ "$built_zcode" -eq 0 ]; then
      echo "Building plugin package（bun run zcode:plugin）→ dist/zcode-plugin/（市场克隆安装源）"
      bun run zcode:plugin
      built_zcode=1
    fi
    echo "Syncing workspace → ${target}（市场克隆）"
    rsync -a --delete "${RSYNC_EXCLUDES[@]}" \
      "$PROJECT_DIR/" \
      "$target/"
    found=$((found + 1))
  done < <(find "$root" -maxdepth 1 -type d -name "openspec-agents-marketplace" 2>/dev/null)
done

if [ "$found" -eq 0 ]; then
  echo "ERROR: 未发现 openspec-agents 安装缓存。"
  echo "先以插件形式运行一次对应 agent（或安装目标包）以创建缓存目录。"
  exit 1
fi

echo "Synced $found target(s). Restart the agent for changes to take effect."
