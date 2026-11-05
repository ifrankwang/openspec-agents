/**
 * 测试进程全局前置：把 skill 扫描根钉死为「仅仓库内」，与开发者 home 目录解耦。
 *
 * 生产默认扫描根含 homedir() 下 .agents/skills 与 .config/opencode/skills，
 * 会让用例结果随本机装了哪些用户级 skill 漂移（本地过、干净 CI 挂）。
 * 经 bunfig.toml 的 [test] preload 在所有测试文件加载前生效。
 */
import { REPO_SKILL_SCAN_ROOTS } from "../src/skills/scan.ts"
import { __setSkillScanRootsForTest } from "../src/skills/resolve.ts"

__setSkillScanRootsForTest(REPO_SKILL_SCAN_ROOTS)
