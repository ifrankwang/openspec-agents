import path from "node:path"

export function isPathWithin(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(base, target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function assertPathWithin(base: string, target: string, subject: string): string {
  if (!isPathWithin(base, target)) {
    throw new Error(
      `${subject}路径 "${target}" 超出允许目录（\`${path.resolve(base)}\`），已拒绝。\n` +
      `路径必须位于该目录之内，禁止用 ".." 或绝对路径逃逸到主仓库/主分支。`
    )
  }
  return path.resolve(base, target)
}

export function assertIssueFilesWithin(issues: Array<{ file?: string }>, base: string | null | undefined): void {
  if (!base) return
  for (const iss of issues) {
    if (iss.file) assertPathWithin(base, iss.file, "issue 文件")
  }
}
