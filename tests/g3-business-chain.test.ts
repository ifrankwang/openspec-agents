/**
 * G3 业务链路覆盖契约测试。
 *
 * 背景：两个导入接口分别单测都通过、生产仍然出事——接口测试以「接口」为覆盖单元，
 * 跨接口的业务链路从未成为用例。本文件锁住三件事：
 * 1. 覆盖模型以业务链路为主、接口基础面为辅（api-test / test-design skill）
 * 2. 链路口径贯穿 workflow 指令与 reviewer 判例（implement / verify / cleanup）
 * 3. 提案标准补第四类强制场景，模板与本仓库已安装副本一致
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  loadWorkflowFile, MUST_DO_CATALOG,
  TASK_WORKFLOW_PATH, SIMPLE_WORKFLOW_PATH, REVIEW_WORKFLOW_PATH, REVIEW_SIMPLE_WORKFLOW_PATH,
} from "../src/core/workflow/loader"

const REPO_ROOT = join(import.meta.dir, "..")

function readRepo(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8")
}

function stepInstructions(filePath: string, stepId: string): string {
  const wf = loadWorkflowFile(filePath)
  const step = wf.stepMap.get(stepId)
  if (!step) throw new Error(`workflow ${filePath} 缺 step ${stepId}`)
  return (step.step.instructions ?? []).join("\n")
}

const API_TEST = readRepo("assets/skills/api-test/SKILL.md")
const TEST_DESIGN = readRepo("assets/skills/test-design/SKILL.md")
const REVIEWER = readRepo("assets/agents/openspec-reviewer.md")
const MUST_DO = readRepo("assets/workflows/must-do.yaml")
const OPTIMIZER = readRepo(".agents/skills/openspec-orchestrate-optimizer/SKILL.md")

// ─── api-test skill：覆盖模型重构 ───

describe("api-test skill 覆盖模型以业务链路为主", () => {
  test("开篇明确覆盖单元是业务链路而非接口", () => {
    expect(API_TEST).toContain("## 覆盖模型")
    expect(API_TEST).toContain("接口测试的覆盖单元是业务链路，不是接口本身")
    expect(API_TEST).toContain("属于单接口单元测试，不构成接口测试")
  })

  test("覆盖要求主体是 change 的业务链路清单 + 接口基础面", () => {
    expect(API_TEST).toContain("覆盖对象是本次 change 涉及的业务链路清单（主体）加接口基础面（补充）")
    expect(API_TEST).toContain("从本次 change 的 spec 场景、proposal 的关联场景与实施逻辑、历史缺陷记录枚举出业务链路清单")
    expect(API_TEST).toContain("按业务顺序串联多个接口，断言后续接口查询到的字段内容与前面接口的写入值逐字段一致")
    expect(API_TEST).toContain("基础面只作补充，不得替代链路")
    // 关键数据产出行保留
    expect(API_TEST).toContain("关键产出字段已持久化到 spec 指定承载位置且值完整非空")
  })

  test("划界收敛为四类一张表（不再线性追加）", () => {
    expect(API_TEST).toContain("### 四类覆盖划分界")
    expect(API_TEST).toContain("| 维度 | 定义 | 缺了它就漏掉的区别 |")
    for (const kind of ["| 业务链路 |", "| 接口基础面 |", "| 一并操作行为组 |", "| 关键数据产出落位 |"]) {
      expect(API_TEST, kind).toContain(kind)
    }
    expect(API_TEST).toContain("四类互补，均须覆盖")
  })

  test("脚本按链路组织，禁止一个接口一个脚本", () => {
    expect(API_TEST).toContain("### 脚本组织")
    expect(API_TEST).toContain("一个 `.http` 文件对应一条链路（或一组同源链路）")
    expect(API_TEST).toContain("每个 `###` 块头部注明溯源场景")
    expect(API_TEST).toContain("禁止「一个接口一个脚本」")
  })

  test("跨接口链路示例含跨 ### 块变量传递与字段级断言", () => {
    expect(API_TEST).toContain("### 跨接口链路示例")
    expect(API_TEST).toContain('client.global.set("ORDER_ID", response.body.data.id)')
    expect(API_TEST).toContain("{{ORDER_NO}}")
    expect(API_TEST).toContain("逐字段核对：后续接口查到的值必须与前序接口写入的值一致")
    expect(API_TEST).toContain("变量必须来自本次链路前序步骤的真实响应，不得在环境文件里硬编码期望值")
  })

  test("旧脚本迁移限定本次 change 范围，存量不动", () => {
    expect(API_TEST).toContain("迁移范围限于本次 change 涉及的脚本")
    expect(API_TEST).toContain("change 范围外的存量脚本保持原样不动")
  })

  test("脚本准备以业务链路清单与接口基础面对应", () => {
    expect(API_TEST).toContain("与本次 change 的业务链路清单及接口基础面对应的 .http 测试脚本")
    expect(API_TEST).toContain("### 链路映射")
  })

  test("空集规则：无跨接口链路须显式声明及依据", () => {
    expect(API_TEST).toContain("### 链路为空集的情形")
    expect(API_TEST).toContain("显式声明「无跨接口链路」并给出依据")
    expect(API_TEST).toContain("以接口基础面为覆盖主体")
  })

  test("多写路径顺序作用：后一路径执行后再查一次", () => {
    expect(API_TEST).toContain("### 多写路径的顺序作用")
    expect(API_TEST).toContain("只验证两条路径各自成功，等于没有验证顺序作用")
  })

  test("清尽 must_do item id 与「本节对应必做项」措辞", () => {
    for (const id of ["api_script", "api_execution", "chain_map", "behavior_surface", "case_matrix", "negative_probe"]) {
      expect(API_TEST, id).not.toContain(id)
    }
    expect(API_TEST).not.toContain("本节对应必做项")
    expect(API_TEST).toContain("本节交付脚本就绪证据")
  })
})

// ─── test-design skill：链路维度 + 断言强度 + 缺陷回归探针 ───

describe("test-design skill 补业务链路维度", () => {
  test("行为面推导含业务流程与链路维度及四要素", () => {
    expect(TEST_DESIGN).toContain("- 业务流程与链路：")
    expect(TEST_DESIGN).toContain("入口（用户或下游实际触发的那个动作）")
    expect(TEST_DESIGN).toContain("步骤顺序（各步按什么次序执行、顺序换了结果是否不同）")
    expect(TEST_DESIGN).toContain("前置状态（链路执行前数据必须处于什么状态）")
    expect(TEST_DESIGN).toContain("最终可观察结果（链路跑完后能查到的持久化状态与字段内容）")
  })

  test("链路来源含历史缺陷记录与 proposal 关联场景", () => {
    expect(TEST_DESIGN).toContain("来源为 spec 场景、proposal 的关联场景与实施逻辑、历史缺陷记录")
    expect(TEST_DESIGN).toContain("同一份数据存在多条写入路径时（导入、保存、更新、批量同步），写入路径的先后作用本身就是链路要素")
  })

  test("链路轴写清与既有三轴的关系", () => {
    expect(TEST_DESIGN).toContain("链路轴与上述三轴的关系")
    expect(TEST_DESIGN).toContain("链路轴是它们之外的一条独立轴")
    expect(TEST_DESIGN).toContain("把链路拆成三个单动作分别塞进三轴矩阵、格子里看不到顺序")
    expect(TEST_DESIGN).toContain("链路组合格至少覆盖")
  })

  test("断言强度补链路组合场景的字段级断言", () => {
    expect(TEST_DESIGN).toContain("链路组合场景须断言最终持久化状态与字段内容")
    expect(TEST_DESIGN).toContain("不得以链路中各步接口返回 2xx 替代")
  })

  test("反向探针补缺陷修复类回归用例（修复前须变红）", () => {
    expect(TEST_DESIGN).toContain("缺陷修复类变更的探针")
    expect(TEST_DESIGN).toContain("把缺陷的触发条件（前置状态 + 操作顺序）固化为回归用例")
    expect(TEST_DESIGN).toContain("只认「修复前红、修复后绿」这一条判据")
    expect(TEST_DESIGN).toContain("禁止按修复后的实现反写期望值")
  })

  test("证据形态同步链路要素与组合格", () => {
    expect(TEST_DESIGN).toContain("流程链路须拆到入口 / 步骤顺序 / 前置状态 / 最终可观察结果四要素")
    expect(TEST_DESIGN).toContain("链路×状态/顺序组合格")
    expect(TEST_DESIGN).toContain("缺陷形态下回归用例变红")
  })
})

// ─── reviewer agent 判例 ───

describe("openspec-reviewer 判例补链路口径", () => {
  test("任务维度 High 判例在高风险场景括号内加多写路径顺序作用", () => {
    expect(REVIEWER).toContain("高风险场景（并发、幂等、多写路径顺序作用、状态机非法迁移、第三方依赖异常与回调超时）")
  })

  test("任务维度 Medium 判例的测试设计物缺失补链路映射", () => {
    expect(REVIEWER).toContain("行为面清单缺业务流程与链路维度/用例矩阵缺链路×状态/顺序组合格/反向探针记录）/链路映射缺失")
  })

  test("职责边界的任务验证独立推导补链路清单", () => {
    expect(REVIEWER).toContain("独立产出行为面清单、用例矩阵与业务链路清单")
    expect(REVIEWER).toContain("不以开发者申报为输入")
    expect(REVIEWER).toContain("识别漏面、漏格、漏链路、断言放水与探针缺失")
  })
})

// ─── workflow 指令 ───

describe("workflow 指令按链路口径（change 会话两份）", () => {
  const CASES = [
    { name: "task.yaml", path: TASK_WORKFLOW_PATH },
    { name: "task-simple.yaml", path: SIMPLE_WORKFLOW_PATH },
  ] as const

  for (const { name, path } of CASES) {
    test(`${name} implement 脚本口径按业务链路清单 + 跨路径顺序作用自证独立一句`, () => {
      const ins = stepInstructions(path, "implement")
      expect(ins).toContain("与本次 change 的业务链路清单对应的接口测试脚本")
      expect(ins).toContain("按链路组织 .http 文件与 ### 块")
      expect(ins).toContain("覆盖链路清单与接口清单")
      // 跨路径自证必须是独立一条 instruction
      const lines = ins.split("\n")
      const chainOrderLine = lines.filter((l) => l.includes("牵动数据的其它写入路径存在时"))
      expect(chainOrderLine).toHaveLength(1)
      expect(chainOrderLine[0]).toContain("按已加载测试设计规范自证跨路径顺序作用")
      expect(chainOrderLine[0]).toContain("逐字段核对默认值/派生值是被重算、重置还是保留")
    })

    test(`${name} verify_cleanup 回归复验补链路复跑`, () => {
      const ins = stepInstructions(path, "verify_cleanup")
      expect(ins).toContain("接口测试按 change 业务链路清单复跑、端到端测试按链路场景复跑")
      expect(ins).toContain("跨写路径顺序作用回归断言")
    })
  }

  test("task.yaml verify_task ③按链路清单执行、⑤字段级断言、⑦跨写路径顺序作用", () => {
    const ins = stepInstructions(TASK_WORKFLOW_PATH, "verify_task")
    expect(ins).toContain("③按 change 业务链路清单逐条执行测试并核验")
    expect(ins).toContain("每条链路由真实入口起步、按业务顺序串联、末端断言后续查询字段内容与写入值逐字段一致")
    expect(ins).toContain("核验链路的字段级断言强度与链路清单覆盖完整性")
    expect(ins).toContain("⑦跨写路径顺序作用核验")
    expect(ins).toContain("默认值/派生值的重算或重置语义与 spec 一致")
    expect(ins).toContain("缺陷触发顺序（前置状态 + 操作顺序）已固化为回归场景")
    // 链路清单由审查者独立推导
    expect(ins).toContain("从 spec、proposal 的关联场景与既有实现独立推导行为面清单、用例矩阵与业务链路清单")
  })

  test("task-simple.yaml quality_review 抽样重放与核验项同口径", () => {
    const ins = stepInstructions(SIMPLE_WORKFLOW_PATH, "quality_review")
    expect(ins).toContain("②③按 change 业务链路清单选定核心链路抽样重放")
    expect(ins).toContain("1-2 条跨接口链路，由真实入口起步、按业务顺序串联、末端断言后续查询字段内容与写入值逐字段一致")
    expect(ins).toContain("核验链路的字段级断言强度与链路清单覆盖完整性")
    expect(ins).toContain("⑦跨写路径顺序作用核验")
    expect(ins).toContain("从 spec、proposal 的关联场景与既有实现独立推导行为面清单、用例矩阵与业务链路清单")
  })

  test("review.yaml / review-simple.yaml 独立审查会话保持原口径（无链路锚点）", () => {
    for (const path of [REVIEW_WORKFLOW_PATH, REVIEW_SIMPLE_WORKFLOW_PATH]) {
      const wf = loadWorkflowFile(path)
      const all = [...wf.stepMap.values()].flatMap((s) => s.step.instructions ?? []).join("\n")
      expect(all).not.toContain("业务链路")
    }
  })
})

// ─── 提案标准：第四类强制场景 + 副本一致性 ───

describe("提案标准第四类强制场景：跨接口业务链路", () => {
  const TPL_SCHEMA = "assets/skills/openspec-standard/templates/schemas/spec-driven-standard/schema.yaml"
  const TPL_SPEC_MD = "assets/skills/openspec-standard/templates/schemas/spec-driven-standard/templates/spec.md"
  const TPL_CONFIG = "assets/skills/openspec-standard/templates/openspec/config.yaml"
  const INS_SCHEMA = "openspec/schemas/spec-driven-standard/schema.yaml"
  const INS_SPEC_MD = "openspec/schemas/spec-driven-standard/templates/spec.md"
  const INS_CONFIG = "openspec/config.yaml"

  test("schema.yaml specs 指令含跨接口业务链路场景要求", () => {
    const schema = readRepo(TPL_SCHEMA)
    expect(schema).toContain("Cross-interface business chains (跨接口业务链路)")
    expect(schema).toContain("WHEN states the order of operations")
    expect(schema).toContain("THEN states the field contents the later query")
    expect(schema).toContain("Splitting the chain into one scenario per endpoint does not")
    // 计数口径从三类改为四类
    expect(schema).toContain("The scenario taxonomy has four kinds in total")
    expect(schema).toContain("a change can be\n        rule-free and still need a chain scenario")
  })

  test("templates/spec.md 顶部注释同步第四类", () => {
    const specMd = readRepo(TPL_SPEC_MD)
    expect(specMd).toContain("Fourth mandatory kind - cross-interface business chains (跨接口业务链路)")
    expect(specMd).toContain("One scenario per endpoint hides the")
  })

  test("config.yaml specs 规则含跨接口业务链路门禁", () => {
    const config = readRepo(TPL_CONFIG)
    expect(config).toContain("跨接口业务链路场景（强制）")
    expect(config).toContain("链路本身是第四类强制场景")
    expect(config).toContain("WHEN 写清操作顺序")
    expect(config).toContain("THEN 写清后续查询返回的字段内容并逐字段列明")
  })

  test("已安装副本与模板逐字一致", () => {
    expect(readRepo(INS_SCHEMA)).toBe(readRepo(TPL_SCHEMA))
    expect(readRepo(INS_SPEC_MD)).toBe(readRepo(TPL_SPEC_MD))
    expect(readRepo(INS_CONFIG)).toBe(readRepo(TPL_CONFIG))
  })
})

// ─── chain_map 词表语义 ───

describe("must-do 词表 chain_map 语义为业务链路到脚本的映射", () => {
  test("description 表达链路 → 脚本/块映射，含无链路声明", () => {
    const item = MUST_DO_CATALOG.chain_map
    expect(item).toBeDefined()
    expect(item.description).toContain("业务链路到测试脚本/块的映射")
    expect(item.description).toContain("无跨接口链路时显式声明并写明依据")
  })

  test("evidence 指向链路清单与字段级断言位置", () => {
    expect(MUST_DO_CATALOG.chain_map.evidence).toContain("脚本路径与块名")
    expect(MUST_DO_CATALOG.chain_map.evidence).toContain("字段级断言位置")
  })
})

// ─── optimizer skill ───

describe("optimizer skill 强制前后端影响分析", () => {
  test("约束含禁止按单栈写死方案", () => {
    expect(OPTIMIZER).toContain("## 技术栈影响评估")
    expect(OPTIMIZER).toContain("每个优化项的方案必须分别说明后端会话与前端会话下的影响")
    expect(OPTIMIZER).toContain("只写单栈结论、把某一种会话的形态当通用方案，视为分析未完成")
  })

  test("评估顺序覆盖共用层与两端差异及各自落点", () => {
    expect(OPTIMIZER).toContain("backend 会话下的表现")
    expect(OPTIMIZER).toContain("frontend 会话下的表现")
    expect(OPTIMIZER).toContain("各自要改的落点")
    expect(OPTIMIZER).toContain("评估结论并入报告对应优化项的「方案」小节")
  })
})
