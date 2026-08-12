#!/usr/bin/env bash
# 将本地源码同步到本机已存在的全部 openspec-orchestrate 安装缓存
# （opencode GitHub 插件缓存等任意 node_modules 缓存目标）。
# cd 到项目根目录后运行

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 发现目标：~/.cache/opencode/packages/*/node_modules/openspec-orchestrate
CACHE_ROOTS=(
  "$HOME/.cache/opencode/packages"
  "$HOME/Library/Caches/opencode/packages"
)

found=0
for root in "${CACHE_ROOTS[@]}"; do
  if [ ! -d "$root" ]; then
    continue
  fi
  while IFS= read -r target; do
    if [ -n "$target" ] && [ -d "$target" ]; then
      echo "Syncing workspace → $target"
      rsync -a --delete \
        --exclude=node_modules \
        --exclude=.git \
        "$PROJECT_DIR/" \
        "$target/"
      found=$((found + 1))
    fi
  done < <(find "$root" -type d -path "*/node_modules/openspec-orchestrate" 2>/dev/null)
done

if [ "$found" -eq 0 ]; then
  echo "ERROR: 未发现 openspec-orchestrate 安装缓存。"
  echo "先以插件形式运行一次 opencode（或安装目标包）以创建缓存目录。"
  exit 1
fi

echo "Synced $found target(s). Restart the agent for changes to take effect."
