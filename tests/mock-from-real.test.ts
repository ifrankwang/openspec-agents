/**
 * assets/skills/frontend-e2e/assets/mock-from-real.mjs 回归测试（零外部依赖）。
 *
 * 覆盖以下契约：
 * - 离线 --response 正常转换：scrub 字段置 "***"、数字串按原长度零填充、
 *   日期时间冻结为固定值、未指定字段原样保留，溯源记全 5 项
 * - --scrub / --freeze 替换路径未命中字段：退出码 2，且不产出 fixture / source 文件
 * - 冻结规则矩阵：纯日期 → 固定日期、数字 → 递增编号、非纯数字串 → FIXED-001 递增、
 *   null / 布尔保持不变、对象与数组按原结构递归冻结
 * - --source-type contract 时溯源 source 自动写 unverified: true，local 档不写该字段
 * - 同一输入 + 固定 --captured-at 两次运行输出逐字节一致（可重复）
 * - --source-type 缺失：退出码 2
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")
const SCRIPT = join(REPO_ROOT, "assets", "skills", "frontend-e2e", "assets", "mock-from-real.mjs")
const FIXTURE_REL = join("src", "mocks", "fixtures", "orders.json")
const SOURCE_REL = join("src", "mocks", "fixtures", "orders.source.json")
const CAPTURED_AT = "2024-04-01T00:00:00.000Z"

/** 真实响应样本：包一层 {status,headers,body}，覆盖取数脚本的离线解包分支。 */
const SAVED_RESPONSE = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: {
    code: 0,
    data: {
      records: [
        { id: "1001", amount: "1299.50", createdAt: "2024-03-05T08:30:00.000Z", token: "real-token-a", name: "张三" },
        { id: "1002", amount: "99.00", createdAt: "2024-03-06T09:00:00.000Z", token: "real-token-b", name: "李四" }
      ]
    }
  }
}

/** 冻结规则矩阵样本：覆盖固定日期、数字、非纯数字串、null、布尔与嵌套结构。 */
const FREEZE_MATRIX_RESPONSE = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: {
    code: 0,
    data: {
      date: "2024-03-05",
      numbers: [7, 8],
      code: "ORD-2024-0001",
      nothing: null,
      flag: true,
      nested: { value: "ORD-2024-0002", sibling: "ORD-2024-0003" }
    }
  }
}

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "opx-mock-from-real-"))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 每个用例独立目录：写入响应文件，返回目录绝对路径。 */
function caseDir(name: string, response: unknown = SAVED_RESPONSE): string {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "saved-response.json"), JSON.stringify(response), "utf8")
  return dir
}

/** 在指定目录执行脚本，返回退出码与输出流。 */
function runMock(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/** 正常转换的完整参数（离线 + 记录接口路径 + 脱敏 + 两类冻结）。 */
function convertArgs(extra: string[] = []): string[] {
  return [
    "--response", "saved-response.json",
    "--url", "/api/orders",
    "--source-type", "local",
    "--captured-at", CAPTURED_AT,
    "--scrub", "data.records[].token",
    "--freeze", "data.records[].id",
    "--freeze", "data.records[].createdAt",
    "--out", FIXTURE_REL,
    ...extra
  ]
}

describe("mock-from-real 离线转换", () => {
  test("scrub 置 ***、数字串按长度零填充、日期时间冻结、未指定字段原样保留", () => {
    const dir = caseDir("convert")
    const { status, stderr } = runMock(convertArgs(), dir)
    expect(stderr).not.toContain("错误")
    expect(status).toBe(0)

    const fixture = JSON.parse(readFileSync(join(dir, FIXTURE_REL), "utf8"))
    const [first, second] = fixture.data.records
    expect(first.token).toBe("***")
    expect(second.token).toBe("***")
    expect(first.id).toBe("0001")
    expect(second.id).toBe("0002")
    expect(first.id).toHaveLength("1001".length)
    expect(first.createdAt).toBe("2020-01-01T00:00:00.000Z")
    expect(second.createdAt).toBe("2020-01-01T00:00:00.000Z")
    expect(first.amount).toBe("1299.50")
    expect(first.name).toBe("张三")
    expect(second.name).toBe("李四")
    expect(fixture.code).toBe(0)

    const provenance = JSON.parse(readFileSync(join(dir, SOURCE_REL), "utf8"))
    expect(provenance.api).toEqual({ method: "GET", path: "/api/orders" })
    expect(provenance.source).toEqual({ type: "local", env: "local", capturedAt: CAPTURED_AT })
    expect(provenance.replacements).toEqual([
      { path: "data.records[].token", rule: "scrub" },
      { path: "data.records[].id", rule: "freeze" },
      { path: "data.records[].createdAt", rule: "freeze" }
    ])
    expect(provenance.response.data.records[0].token).toBe("***")
  })

  test("同一输入 + 固定 captured-at 两次运行输出逐字节一致", () => {
    const firstDir = caseDir("deterministic-a")
    const secondDir = caseDir("deterministic-b")
    expect(runMock(convertArgs(), firstDir).status).toBe(0)
    expect(runMock(convertArgs(), secondDir).status).toBe(0)
    for (const rel of [FIXTURE_REL, SOURCE_REL]) {
      const a = readFileSync(join(firstDir, rel))
      const b = readFileSync(join(secondDir, rel))
      expect(a.equals(b)).toBe(true)
    }
  })
})

describe("mock-from-real 参数与命中校验", () => {
  test("--scrub 路径未命中任何字段时退出码 2 且不产出 fixture / source", () => {
    const dir = caseDir("missed-scrub")
    const { status, stderr } = runMock(
      convertArgs(["--scrub", "data.records[].notExist"]),
      dir
    )
    expect(status).toBe(2)
    expect(stderr).toContain("data.records[].notExist")
    expect(stderr).toContain("未命中")
    expect(existsSync(join(dir, FIXTURE_REL))).toBe(false)
    expect(existsSync(join(dir, SOURCE_REL))).toBe(false)
  })

  test("--freeze 路径未命中任何字段时退出码 2 且不产出 fixture / source", () => {
    const dir = caseDir("missed-freeze")
    const { status, stderr } = runMock(
      convertArgs(["--freeze", "data.records[].notExist"]),
      dir
    )
    expect(status).toBe(2)
    expect(stderr).toContain("data.records[].notExist")
    expect(stderr).toContain("未命中")
    expect(existsSync(join(dir, FIXTURE_REL))).toBe(false)
    expect(existsSync(join(dir, SOURCE_REL))).toBe(false)
  })

  test("--source-type 缺失时退出码 2", () => {
    const dir = caseDir("missing-source-type")
    const { status, stderr } = runMock(
      [
        "--response", "saved-response.json",
        "--url", "/api/orders",
        "--captured-at", CAPTURED_AT,
        "--out", FIXTURE_REL
      ],
      dir
    )
    expect(status).toBe(2)
    expect(stderr).toContain("--source-type")
    expect(existsSync(join(dir, FIXTURE_REL))).toBe(false)
  })
})

describe("mock-from-real 冻结规则矩阵", () => {
  test("纯日期固定、数字递增、非纯数字串 FIXED 递增、null 与布尔保留、对象递归冻结", () => {
    const dir = caseDir("freeze-matrix", FREEZE_MATRIX_RESPONSE)
    const { status, stderr } = runMock(
      [
        "--response", "saved-response.json",
        "--url", "/api/orders",
        "--source-type", "local",
        "--captured-at", CAPTURED_AT,
        "--freeze", "data.date",
        "--freeze", "data.numbers",
        "--freeze", "data.code",
        "--freeze", "data.nothing",
        "--freeze", "data.flag",
        "--freeze", "data.nested",
        "--out", FIXTURE_REL
      ],
      dir
    )
    expect(stderr).not.toContain("未命中")
    expect(status).toBe(0)

    const { data } = JSON.parse(readFileSync(join(dir, FIXTURE_REL), "utf8"))
    expect(data.date).toBe("2020-01-01")
    expect(data.numbers).toEqual([1, 2])
    expect(data.code).toBe("FIXED-001")
    expect(data.nothing).toBeNull()
    expect(data.flag).toBe(true)
    expect(data.nested).toEqual({ value: "FIXED-001", sibling: "FIXED-002" })

    const provenance = JSON.parse(readFileSync(join(dir, SOURCE_REL), "utf8"))
    expect(provenance.replacements.every((each: { rule: string }) => each.rule === "freeze")).toBe(true)
  })
})

describe("mock-from-real 溯源来源标记", () => {
  test("--source-type contract 时溯源 source 自动写 unverified: true", () => {
    const dir = caseDir("source-contract")
    const { status } = runMock(
      [
        "--response", "saved-response.json",
        "--url", "/api/orders",
        "--source-type", "contract",
        "--captured-at", CAPTURED_AT,
        "--out", FIXTURE_REL
      ],
      dir
    )
    expect(status).toBe(0)

    const provenance = JSON.parse(readFileSync(join(dir, SOURCE_REL), "utf8"))
    expect(provenance.source).toEqual({
      type: "contract",
      env: "contract",
      capturedAt: CAPTURED_AT,
      unverified: true
    })
  })

  test("--source-type local 时溯源不含 unverified 字段", () => {
    const dir = caseDir("source-local")
    expect(runMock(convertArgs(), dir).status).toBe(0)

    const provenance = JSON.parse(readFileSync(join(dir, SOURCE_REL), "utf8"))
    expect(provenance.source).toEqual({ type: "local", env: "local", capturedAt: CAPTURED_AT })
    expect("unverified" in provenance.source).toBe(false)
  })
})
