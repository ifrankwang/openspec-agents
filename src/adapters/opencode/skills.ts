/**
 * skill 投放：收集随包分发的 skill，交由 V2 skill 域的 transform 逐个注册。
 *
 * V1 形态把 skill 根目录追加进 config.skills.paths，由 opencode 自行发现；V2 插件不持有全局
 * 配置对象，skill 改由 skill 域显式注册。注册项的 path 指向包内 SKILL.md，使 skill 加载时
 * 仍以该目录为附属文件（reference/、scripts/ 等）的相对引用基准。
 *
 * ID 取目录名（V2 以路径派生 ID 为准），name/description 取 SKILL.md frontmatter，
 * content 取去 frontmatter 的正文——与 V2 加载时「加入去掉 frontmatter 的正文」一致。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Skill } from "@opencode/plugin"
import { parseAgentMd } from "../agent-md.ts"
import { DISTRIBUTED_SKILL_ROOTS } from "../../skills/scan.ts"

/**
 * 注册一项 skill 所需的字段（对齐 V2 Skill.Info 中由插件负责提供的部分）。
 * id/name/path 在 V2 schema 中为品牌化字符串（编译期约束，运行时即普通 string），
 * 构造处统一以断言完成品牌化，避免引入 @opencode/plugin 的运行时依赖
 * （Plugin.define 为恒等函数，插件壳不需要该包的运行时实例）。
 */
export interface SkillRegistration {
  id: Skill.Info["id"]
  name: Skill.Info["name"]
  description?: string
  path: Skill.Info["path"]
  content: string
}

/** 收集随包分发的全部 skill；随包 skill 缺失（分发形态裁剪）时返回空数组。 */
export function collectSkills(): SkillRegistration[] {
  const out: SkillRegistration[] = []
  const seen = new Set<string>()
  for (const root of DISTRIBUTED_SKILL_ROOTS) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillFile = join(root, entry.name, "SKILL.md")
      if (!existsSync(skillFile)) continue
      // 多根场景下同名 skill 只注册一次（V2 按 ID 选择，后注册者覆盖前者）。
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      const { frontmatter, body } = parseAgentMd(readFileSync(skillFile, "utf-8"))
      // id 由目录名派生（V2 以路径派生 ID 为准），name 为展示名，缺失时回落 id。
      const name = (frontmatter.name as string) ?? entry.name
      out.push({
        id: entry.name as Skill.Info["id"],
        name: name as Skill.Info["name"],
        description: frontmatter.description as string | undefined,
        path: skillFile as Skill.Info["path"],
        content: body,
      })
    }
  }
  return out
}