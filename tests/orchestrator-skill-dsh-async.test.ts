/**
 * 编排主代理 skill 的 DSH 异步委派小节文案契约测试。
 *
 * 背景：DSH 0.2.1 起子代理委派为异步（调用只返回子代理 id），原小节未闭合定义
 * 「等待期允许的动作集合」，主代理据工具名语义误用 wait_agent 并自创 sleep 轮询，
 * 整轮空转。此处锚定小节必须写明的关键点，防止文案回退。
 *
 * 断言读取真实 skill 文件，不存快照；断言范围限定在「### DSH 异步委派」小节内。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")

describe("orchestrator skill 的 DSH 异步委派小节", () => {
  const skill = readFileSync(join(REPO_ROOT, "assets/skills/orchestrator/SKILL.md"), "utf8")
  const start = skill.indexOf("### DSH 异步委派")
  const rest = start >= 0 ? skill.slice(start + "### DSH 异步委派".length) : ""
  const nextHeading = rest.search(/\n#{2,3} /)
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest

  test("小节存在", () => {
    expect(start).toBeGreaterThanOrEqual(0)
    expect(section.trim().length).toBeGreaterThan(0)
  })

  test("写明分派后本轮结束且等待期没有允许动作", () => {
    expect(section).toContain("分派后本轮立即结束；等待期允许的动作 = 无")
    expect(section).toContain("不查状态")
    expect(section).toContain("不调用 `wait_agent`")
    expect(section).toContain("不 sleep 或定时轮询")
    expect(section).toContain("不重复分派同一 `_agent` 身份")
  })

  test("写明全部到齐后再推进", () => {
    expect(section).toContain("全部到齐后再推进")
    expect(section).toContain("收到首个通知不等于全部完成")
  })

  test("写明禁止用 Team 协作原语等待子代理", () => {
    expect(section).toContain("禁止用于等待子代理")
    expect(section).toContain("只覆盖 durable teammate")
  })

  test("写明通知由运行时送达且全部到齐后才推进", () => {
    expect(section).toContain("完成通知由运行时自动送达")
    expect(section).toContain("全部到齐")
  })

  test("写明卡住时的处置且不得转回轮询", () => {
    expect(section).toContain("不得转回轮询")
    expect(section).toContain("无人值守按状态查询工具给出的建议处置")
  })

  test("写明通知缺失只在可观测触发点被发现", () => {
    expect(section).toContain("用户发起新轮次")
    expect(section).toContain("运行时返回异常")
    expect(section).toContain("不存在主动判定「长时间无通知」的时机")
  })

  test("写明有人值守时向用户报告卡在哪一步", () => {
    expect(section).toContain("有人值守")
    expect(section).toContain("卡在哪一步")
  })

  test("写明无进展时的兜底动作且不依赖不存在的小节条款", () => {
    expect(section).toContain("结束本次编排")
    expect(section).not.toContain("收尾报告")
    expect(section).not.toContain("无人值守行为约定")
  })

  test("不得回退到等待或轮询措辞", () => {
    expect(section).not.toContain("稍等")
    expect(section).not.toContain("定时等待")
  })

  test("写明通知是子代理自述且权威状态以状态查询工具为准", () => {
    expect(section).toContain("子代理自述")
    expect(section).toContain("以状态查询工具为准")
  })
})
