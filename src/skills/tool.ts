import { readFileSync } from "node:fs"
import { findSkillPath, projectSkillNames } from "./scan.js"

interface ParsedContent {
  body: string
}

function parseBody(md: string): ParsedContent {
  const result: ParsedContent = { body: md }
  if (!md.startsWith("---")) return result
  const end = md.indexOf("---", 3)
  if (end === -1) return result
  result.body = md.slice(end + 3).trim()
  return result
}

export function loadSkillBody(skillName: string): string {
  const skillPath = findSkillPath(skillName)
  if (!skillPath) {
    return `(bundled skill not found: ${skillName})`
  }
  const raw = readFileSync(skillPath, "utf-8")
  const { body } = parseBody(raw)
  return body
}

export function listBundledSkills(): string[] {
  return projectSkillNames()
}
