/**
 * workflow 顶层 common 块解析与缺省降级测试。
 *
 * 覆盖：
 * 1. loader：common 解析（instructions / constraints 可选非空字符串数组）
 * 2. 缺省：无 common 块 → common undefined；common 块全空 → undefined
 * 3. common 非法结构报错（非对象 / instructions 空数组 / 数组含非字符串 / 空字符串元素）
 * 4. common 不参与流转（不改变 stepMap / transitions），仅承载渲染语义
 */
import { describe, expect, test } from "bun:test"

import { loadWorkflow } from "../src/core/workflow/loader"

const BASE_YAML = `
id: x
name: X
max_retries: 1
phases:
  - name: todo
    steps:
      - id: analyze
        agents: [architect]
        transitions:
          on_pass: implement
          on_fail: analyze
  - name: in_progress
    steps:
      - id: implement
        agents: [developer]
        transitions:
          on_pass: done
          on_fail: analyze
`

function makeWorkflow(extra: string): ReturnType<typeof loadWorkflow> {
  return loadWorkflow(`${BASE_YAML}${extra}`)
}

describe("loader：common 块解析", () => {
  test("无 common 块 → common 为 undefined（降级）", () => {
    const wf = loadWorkflow(BASE_YAML)
    expect(wf.common).toBeUndefined()
  })

  test("common 正常解析：instructions / constraints 均可选", () => {
    const wf = makeWorkflow(`
common:
  instructions:
    - 调用 opx_status 自取上下文
    - 完成后提交
  constraints:
    - 所有改动限定在 worktree 内
`)
    expect(wf.common).toEqual({
      instructions: ["调用 opx_status 自取上下文", "完成后提交"],
      constraints: ["所有改动限定在 worktree 内"],
    })
  })

  test("common 仅 instructions / 仅 constraints 均可解析", () => {
    const onlyIns = makeWorkflow(`
common:
  instructions:
    - 只写指引
`)
    expect(onlyIns.common).toEqual({ instructions: ["只写指引"], constraints: undefined })

    const onlyCons = makeWorkflow(`
common:
  constraints:
    - 只写约束
`)
    expect(onlyCons.common).toEqual({ instructions: undefined, constraints: ["只写约束"] })
  })

  test("common 块声明但全空 → 降级 undefined", () => {
    const wf = makeWorkflow("common: {}")
    expect(wf.common).toBeUndefined()
  })

  test("common 非法：非对象 / instructions 空数组 / 数组含非字符串 / 空字符串元素 报错", () => {
    expect(() => makeWorkflow("common: [a, b]")).toThrow(/common 必须是对象/)
    expect(() => makeWorkflow("common:\n  instructions: []")).toThrow(/common\.instructions/)
    expect(() => makeWorkflow("common:\n  constraints: [ok, 42]")).toThrow(/common\.constraints/)
    expect(() => makeWorkflow("common:\n  instructions:\n    - '  '")).toThrow(/common\.instructions/)
  })

  test("common 不参与流转：stepMap / transitions 不受影响", () => {
    const wf = makeWorkflow(`
common:
  instructions:
    - 通用指引
`)
    expect(wf.stepMap.get("analyze")?.step.agents).toEqual(["architect"])
    expect(wf.stepMap.get("implement")?.step.transitions.on_pass).toBe("done")
    // common 未注入 step 内部，仅渲染层合并
    expect(wf.stepMap.get("implement")?.step.instructions).toBeUndefined()
  })
})
