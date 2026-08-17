---
name: openspec-finish
description: >
  项目收尾/发布流程：test & repair → 改版本 → sync → commit & tag version & push。
  Use when the user asks to 收尾、打版本、发布、tag、sync 后提交推送，或完成实施后需要走发布/收尾流程。
  即使没有明确说“发布”，只要出现“收尾”“改版本”“打 tag”“commit & push”等意图也应触发。
---

# 项目收尾 / 发布

在功能、修复或改进已完成并确认后，按以下固定顺序收尾：

1. **test & repair**
2. **改版本**
3. **sync**
4. **commit & tag version & push**

## Quick start

1. 在项目根目录运行 `bun test` 与 `bun run typecheck`，失败则修复到全部通过。
2. 按变更类型修改 `package.json` 的 `version`。
3. 运行 `bun run sync`，确保同步成功。
4. `git add -A` → `git commit -m "<message>"` → 打 `v<version>` tag → push 提交与 tag。

## 详细流程

### 1. test & repair

- 在项目根目录执行：
  ```bash
  bun test
  bun run typecheck
  ```
- 两项都必须通过。若有失败，先修复失败原因，再重新运行直到通过。
- 若失败看起来与本次变更无关（环境问题、既有失败），不要擅自跳过；先向用户报告并取得确认。

### 2. 改版本

- 修改 `package.json` 中的 `version` 字段。
- 版本变动规则：

  | 变更类型 | 版本变动 |
  |---------|---------|
  | 改流程 / 新增能力 / 改工具行为 | minor（0.Y.z → 0.Y+1.0） |
  | 纯文档措辞 / bug 修正 / 注释 | patch（0.Y.z → 0.Y.z+1） |

- 同步更新受影响的文档（README、AGENTS、相关 skill 等），融入现有结构，使用结论式叙述，不用“本次新增/修改”等变更式表达。
- 确认版本号与要打的 tag 一致（如 `0.119.0` → `v0.119.0`）。

### 3. sync

- 在项目根目录执行：
  ```bash
  bun run sync
  ```
- `bun run sync` 会构建插件包并同步到各 harness 缓存，可能生成 `dist/` 等本地构建产物（通常已被 gitignore）；若确实产生应纳入版本管理的变更，应一并提交。
- sync 失败时先修复或向用户报告，禁止带着失败继续 commit/push。

### 4. commit & tag version & push

- 先查看仓库提交风格，按既有风格写 commit message（可参考 `git log`），通常应包含版本号。
- 暂存全部变更并提交（显式提供 message，避免进入交互式编辑器）：
  ```bash
  git add -A
  git commit -m "<commit message>"
  ```
- 打版本 tag（tag 名与 `package.json` 版本一致）：
  ```bash
  git tag v<version>
  ```
- 推送提交与 tag：
  ```bash
  git push origin <当前分支>
  git push origin v<version>
  ```
  或等价地推送分支并附带 tags。
- push 失败时向用户报告并停止，不擅自强推或改写历史。

## 完成输出

```
## 收尾完成

版本变更: <旧版本> → <新版本> (<minor|patch>)
测试: <通过|失败说明>
同步: <成功|失败(原因)>
Commit: <hash>
Tag: <tag>
Push: <成功|失败(原因)>
```

## Worktree 模式（可选）

如果本次实施使用了独立 worktree，在开始改版本前先完成：

- 回到原仓库并检出启动分支。
- 合并实施分支。
- 清理 worktree 与实施分支。

合并与清理完成后，仍按 **test & repair → 改版本 → sync → commit & tag version & push** 的顺序收尾（test & repair 可在合并前或合并后执行，但 commit 前必须通过）。

## Gotchas

- 顺序固定：先测试修复，再改版本，再 sync，最后 commit/tag/push；不要提前提交或先 push 再 sync。
- `bun run sync` 依赖本机已存在的插件缓存；若报“未发现任何可同步的 harness 插件缓存”，说明环境未初始化，需向用户报告，不能视为成功。
- tag 名必须带 `v` 前缀，例如 `v0.119.0`，与仓库现有 tag 风格一致。
- 不要提交与本次收尾无关的本地未提交改动；如工作区存在无关变更，先与用户确认范围。
