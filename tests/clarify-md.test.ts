/**
 * src/core/clarify-md.ts parseExecutionBoundary 单测。
 *
 * 覆盖 clarify.md「执行边界」小节的解析契约（提案阶段产出 → opx_orch_init 落 metadata）：
 * 标题变体（级别/编号/冒号/空白）、CRLF、多任务组取当前组、notes 缺省、首 yaml 围栏、
 * 非 yaml 围栏、围栏未闭合、非法 YAML、空数组/类型不符、无该小节、该组缺失、小节范围边界。
 * 解析失败一律返回 null（调用方降级「整个 worktree」），不得抛错。
 */
import { describe, expect, test } from "bun:test"
import { parseExecutionBoundary } from "../src/core/clarify-md"

/** 标准单组边界内容（可替换标题与换行）。 */
function md(opts: { heading?: string; eol?: string; groups?: string; extra?: string } = {}): string {
  const heading = opts.heading ?? "## 执行边界"
  const groups = opts.groups ?? `  "1":\n    allowed_directories: ["src/core"]\n    allowed_packages: ["src/core/x"]\n    notes: "限定核心目录"`
  const lines = [
    "# 需求澄清",
    "",
    heading,
    "",
    "```yaml",
    "task_groups:",
    groups,
    "```",
    "",
    ...(opts.extra ? [opts.extra] : []),
  ]
  return lines.join(opts.eol ?? "\n")
}

const EXPECTED = {
  allowed_directories: ["src/core"],
  allowed_packages: ["src/core/x"],
  notes: "限定核心目录",
}

describe("parseExecutionBoundary：标题变体", () => {
  test("标准二级标题 → 正确对象", () => {
    expect(parseExecutionBoundary(md(), "1")).toEqual(EXPECTED)
  })

  test("标题级别变体（# / ###）均可识别", () => {
    expect(parseExecutionBoundary(md({ heading: "# 执行边界" }), "1")).toEqual(EXPECTED)
    expect(parseExecutionBoundary(md({ heading: "### 执行边界" }), "1")).toEqual(EXPECTED)
  })

  test("标题带编号（1. / 1、/ 一、）与尾部冒号 → 正确对象", () => {
    expect(parseExecutionBoundary(md({ heading: "## 1. 执行边界" }), "1")).toEqual(EXPECTED)
    expect(parseExecutionBoundary(md({ heading: "## 1、执行边界：" }), "1")).toEqual(EXPECTED)
    expect(parseExecutionBoundary(md({ heading: "## 一、执行边界" }), "1")).toEqual(EXPECTED)
    expect(parseExecutionBoundary(md({ heading: "##   执行边界   " }), "1")).toEqual(EXPECTED)
  })

  test("标题前缀匹配：执行边界（实施范围）同样识别", () => {
    expect(parseExecutionBoundary(md({ heading: "## 执行边界（实施范围）" }), "1")).toEqual(EXPECTED)
  })
})

describe("parseExecutionBoundary：换行与围栏", () => {
  test("CRLF 换行 → 正确对象", () => {
    expect(parseExecutionBoundary(md({ eol: "\r\n" }), "1")).toEqual(EXPECTED)
  })

  test("小节内首 yaml 围栏生效，后续围栏忽略", () => {
    const content = md({
      extra: [
        "## 附注",
        "",
        "```yaml",
        "task_groups:",
        '  "1":',
        '    allowed_directories: ["src/other"]',
        '    allowed_packages: ["pkg/other"]',
        "```",
      ].join("\n"),
    })
    expect(parseExecutionBoundary(content, "1")).toEqual(EXPECTED)
  })

  test("小节内非 yaml 围栏出现在 yaml 之前 → 仍取首个 yaml 围栏", () => {
    const content = [
      "## 执行边界",
      "",
      "```text",
      "说明文本",
      "```",
      "",
      "```yaml",
      "task_groups:",
      '  "1":',
      '    allowed_directories: ["src/core"]',
      '    allowed_packages: ["src/core/x"]',
      '    notes: "限定核心目录"',
      "```",
    ].join("\n")
    expect(parseExecutionBoundary(content, "1")).toEqual(EXPECTED)
  })

  test("yml 围栏同样识别", () => {
    const content = md().replace("```yaml", "```yml")
    expect(parseExecutionBoundary(content, "1")).toEqual(EXPECTED)
  })

  test("仅有非 yaml 围栏（json）→ null", () => {
    const content = [
      "## 执行边界",
      "",
      "```json",
      '{"task_groups":{"1":{"allowed_directories":["src"],"allowed_packages":["p"]}}}',
      "```",
    ].join("\n")
    expect(parseExecutionBoundary(content, "1")).toBeNull()
  })

  test("yaml 围栏未闭合 → null", () => {
    const content = [
      "## 执行边界",
      "",
      "```yaml",
      "task_groups:",
      '  "1":',
      '    allowed_directories: ["src/core"]',
      '    allowed_packages: ["src/core/x"]',
    ].join("\n")
    expect(parseExecutionBoundary(content, "1")).toBeNull()
  })
})

describe("parseExecutionBoundary：任务组选取与 notes", () => {
  const multi = md({
    groups: [
      '  "1":',
      '    allowed_directories: ["src/one"]',
      '    allowed_packages: ["pkg/one"]',
      '  "2":',
      '    allowed_directories: ["src/two"]',
      '    allowed_packages: ["pkg/two"]',
      '    notes: "第二组"',
    ].join("\n"),
  })

  test("多任务组按当前组取（组 1 / 组 2 各取各的）", () => {
    expect(parseExecutionBoundary(multi, "1")).toEqual({
      allowed_directories: ["src/one"],
      allowed_packages: ["pkg/one"],
      notes: "",
    })
    expect(parseExecutionBoundary(multi, "2")).toEqual({
      allowed_directories: ["src/two"],
      allowed_packages: ["pkg/two"],
      notes: "第二组",
    })
  })

  test("该任务组缺失 → null", () => {
    expect(parseExecutionBoundary(multi, "9")).toBeNull()
  })

  test("notes 缺省 → 空串；notes 显式空串 → 空串", () => {
    const noNotes = md({
      groups: '  "1":\n    allowed_directories: ["src"]\n    allowed_packages: ["pkg"]',
    })
    expect(parseExecutionBoundary(noNotes, "1")).toEqual({
      allowed_directories: ["src"],
      allowed_packages: ["pkg"],
      notes: "",
    })
    const emptyNotes = md({
      groups: '  "1":\n    allowed_directories: ["src"]\n    allowed_packages: ["pkg"]\n    notes: ""',
    })
    expect(parseExecutionBoundary(emptyNotes, "1")).toEqual({
      allowed_directories: ["src"],
      allowed_packages: ["pkg"],
      notes: "",
    })
  })

  test("目录/包数组元素去前后空白", () => {
    const content = md({
      groups: '  "1":\n    allowed_directories: ["  src/core  "]\n    allowed_packages: ["  src/core/x  "]',
    })
    expect(parseExecutionBoundary(content, "1")).toEqual({
      allowed_directories: ["src/core"],
      allowed_packages: ["src/core/x"],
      notes: "",
    })
  })
})

describe("parseExecutionBoundary：非法输入一律 null", () => {
  test("空内容 / 纯空白 → null", () => {
    expect(parseExecutionBoundary("", "1")).toBeNull()
    expect(parseExecutionBoundary("   \n\t\n", "1")).toBeNull()
  })

  test("无「执行边界」小节 → null", () => {
    const content = [
      "# 需求澄清",
      "",
      "## 背景",
      "",
      "```yaml",
      "task_groups:",
      '  "1":',
      '    allowed_directories: ["src"]',
      '    allowed_packages: ["pkg"]',
      "```",
    ].join("\n")
    expect(parseExecutionBoundary(content, "1")).toBeNull()
  })

  test("非法 YAML → null（不抛错）", () => {
    const content = [
      "## 执行边界",
      "",
      "```yaml",
      "task_groups: {",
      '  "1": [unclosed',
      "```",
    ].join("\n")
    expect(parseExecutionBoundary(content, "1")).toBeNull()
  })

  test("yaml 根非映射（数组 / 标量）→ null", () => {
    const arr = ["## 执行边界", "", "```yaml", "- a", "- b", "```"].join("\n")
    expect(parseExecutionBoundary(arr, "1")).toBeNull()
    const scalar = ["## 执行边界", "", "```yaml", "just-a-string", "```"].join("\n")
    expect(parseExecutionBoundary(scalar, "1")).toBeNull()
  })

  test("task_groups 缺失 / 非映射（数组 / 字符串）→ null", () => {
    const missing = ["## 执行边界", "", "```yaml", "foo: bar", "```"].join("\n")
    expect(parseExecutionBoundary(missing, "1")).toBeNull()
    const arr = ["## 执行边界", "", "```yaml", "task_groups: []", "```"].join("\n")
    expect(parseExecutionBoundary(arr, "1")).toBeNull()
    const str = ["## 执行边界", "", "```yaml", 'task_groups: "x"', "```"].join("\n")
    expect(parseExecutionBoundary(str, "1")).toBeNull()
  })

  test("任务组条目非对象（null / 数组 / 字符串）→ null", () => {
    expect(parseExecutionBoundary(["## 执行边界", "", "```yaml", 'task_groups:\n  "1": null', "```"].join("\n"), "1")).toBeNull()
    expect(parseExecutionBoundary(["## 执行边界", "", "```yaml", 'task_groups:\n  "1": ["a"]', "```"].join("\n"), "1")).toBeNull()
    expect(parseExecutionBoundary(["## 执行边界", "", "```yaml", 'task_groups:\n  "1": "src"', "```"].join("\n"), "1")).toBeNull()
  })

  test("allowed_directories / allowed_packages 空数组 → null", () => {
    expect(parseExecutionBoundary(md({ groups: '  "1":\n    allowed_directories: []\n    allowed_packages: ["pkg"]' }), "1")).toBeNull()
    expect(parseExecutionBoundary(md({ groups: '  "1":\n    allowed_directories: ["src"]\n    allowed_packages: []' }), "1")).toBeNull()
  })

  test("数组元素为空/纯空白 → null", () => {
    expect(parseExecutionBoundary(md({ groups: '  "1":\n    allowed_directories: ["src", "   "]\n    allowed_packages: ["pkg"]' }), "1")).toBeNull()
    expect(parseExecutionBoundary(md({ groups: '  "1":\n    allowed_directories: [""]\n    allowed_packages: ["pkg"]' }), "1")).toBeNull()
  })

  test("字段类型不符（字符串 / 数字 / notes 非字符串）→ null", () => {
    expect(parseExecutionBoundary(md({ groups: '  "1":\n    allowed_directories: "src"\n    allowed_packages: ["pkg"]' }), "1")).toBeNull()
    expect(parseExecutionBoundary(md({ groups: '  "1":\n    allowed_directories: [1]\n    allowed_packages: ["pkg"]' }), "1")).toBeNull()
    expect(parseExecutionBoundary(md({ groups: '  "1":\n    allowed_directories: ["src"]\n    allowed_packages: ["pkg"]\n    notes: 123' }), "1")).toBeNull()
    expect(parseExecutionBoundary(md({ groups: '  "1":\n    allowed_directories: ["src"]\n    allowed_packages: ["pkg"]\n    notes: ["x"]' }), "1")).toBeNull()
  })
})

describe("parseExecutionBoundary：小节范围边界", () => {
  test("同级后续标题终止小节 → 其后的 yaml 围栏不参与解析", () => {
    const content = [
      "## 执行边界",
      "",
      "说明文字",
      "",
      "## 其它小节",
      "",
      "```yaml",
      "task_groups:",
      '  "1":',
      '    allowed_directories: ["src"]',
      '    allowed_packages: ["pkg"]',
      "```",
    ].join("\n")
    expect(parseExecutionBoundary(content, "1")).toBeNull()
  })

  test("小节内更深级标题不终止小节 → 其后 yaml 围栏仍生效", () => {
    const content = [
      "## 执行边界",
      "",
      "### 细分说明",
      "",
      "```yaml",
      "task_groups:",
      '  "1":',
      '    allowed_directories: ["src"]',
      '    allowed_packages: ["pkg"]',
      "```",
    ].join("\n")
    expect(parseExecutionBoundary(content, "1")).toEqual({
      allowed_directories: ["src"],
      allowed_packages: ["pkg"],
      notes: "",
    })
  })
})
