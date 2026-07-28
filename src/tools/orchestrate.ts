// 旧 barrel：保留向后兼容。所有导出已迁移到 src/core/ 和 src/adapters/opencode/
export { __setGitRunner, type GitRunner } from "../core/git.js"
export { init, set_worktree, status, complete_task_group, set_unattended } from "../adapters/opencode/tools.js"
export { arch_submit, dev_submit, tool_review_submit, task_review_submit, quality_review_submit, resolve_review, arch_blocker } from "../adapters/opencode/tools.js"
export { readDashboardState } from "../core/dashboard.js"
export { MAX_RETRIES } from "../core/constants.js"
