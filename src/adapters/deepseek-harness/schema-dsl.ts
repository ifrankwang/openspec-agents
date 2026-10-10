/**
 * 内核纯 JSON Schema → DSH 原生工具 schema DSL 的投影。
 *
 * DSH 的 `defineTool` 参数不是 draft-07 JSON Schema，而是它自己的统一 schema DSL
 * （见 dsh-tools/lib/types/schema.js 的 parameterSchemaSpecToJsonSchema）：
 * - 参数根是「隐式对象」——每个 key 是一个 value schema，必填用 `required: true` 标注在属性上，
 *   而不是 JSON Schema 的 `required: string[]`；
 * - value schema 只接受 type(string/number/integer/boolean/null/array/object/json)、properties、
 *   items、enum、const、oneOf 与注解(description/title/default/examples)。
 *
 * DSH 强制执行的 raw JSON Schema 子集不含 minLength / minItems / minimum / maximum
 * （见 dsh-tools/lib/types/json-schema.js 的 CONSTRAINT_KEYWORDS），这些约束无法在该层表达，
 * 故按 DSH 官方口径丢弃并降级为描述文本：参数的业务语义与运行时校验仍以内核 *Execute 为准
 * （内核对同一份 JSON Schema 定义的必填/取值做二次校验）。
 */

/**
 * DSH schema DSL 的 value schema。
 *
 * 形态与 DSH 官方 dsh-tools 的 ValueSchemaSpec 对齐（见 dsh-tools/lib/types/schema.js 的
 * runSchemaCompiler）：类型用 `type`，必填用属性上的 `required: true`（而非 required 数组），
 * 并且只接受 type/properties/items/enum/const/oneOf 与注解字段——多一个 key 即报作者错误。
 *
 * 声明为 type alias 而非 interface：type alias 的隐式索引签名使其可直接赋给
 * `ParameterSchemaSpec`（官方形状为开放记录），interface 则不满足索引签名约束。
 */
export type DshValueSchema = {
  type: "string" | "number" | "integer" | "boolean" | "null" | "array" | "object" | "json"
  description?: string
  default?: unknown
  properties?: Record<string, DshValueSchema>
  /** 必填标注：DSH DSL 用属性上的 `required: true`，内核 JSON Schema 用根上的 required 数组。 */
  required?: true
  items?: DshValueSchema
  enum?: readonly (string | number | boolean)[]
  additionalProperties?: boolean
}

/** DSH 工具的 parameters：一个隐式对象根的「属性名 → value schema」映射。 */
export type ToolParameters = Record<string, DshValueSchema>

/** 内核纯 JSON Schema（draft-07 子集），与 src/core/provider.ts 的 JSONSchema 同形。 */
export interface CoreJsonSchema {
  type?: string
  description?: string
  properties?: Record<string, CoreJsonSchema>
  items?: CoreJsonSchema
  required?: readonly string[]
  enum?: readonly (string | number | boolean)[]
  default?: unknown
  additionalProperties?: boolean
}

/** DSH 原生不支持的约束关键字（丢弃并降级为描述，避免模型看不到约束）。 */
const UNSUPPORTED_CONSTRAINTS = [
  { key: "minLength", suffix: "（不得为空）" },
  { key: "minItems", suffix: "（至少含 1 项）" },
  { key: "minimum", suffix: "（不小于该值）" },
  { key: "maximum", suffix: "（不大于该值）" },
] as const

/** 拼接降级后的描述文本：把无法在 DSH 层表达的约束以自然语言形式追加到 description。 */
function describeWithDroppedConstraints(schema: CoreJsonSchema): string | undefined {
  const parts: string[] = []
  if (typeof schema.description === "string" && schema.description !== "") parts.push(schema.description)
  for (const { key, suffix } of UNSUPPORTED_CONSTRAINTS) {
    const value = (schema as Record<string, unknown>)[key]
    if (typeof value === "number") parts.push(`${key}=${value}${suffix}`)
  }
  return parts.length > 0 ? parts.join(" ") : undefined
}

/** 把一个内核 JSON Schema 节点投影为 DSH value schema。 */
function projectValueSchema(schema: CoreJsonSchema): DshValueSchema {
  const description = describeWithDroppedConstraints(schema)
  const annotation = description !== undefined ? { description } : {}
  switch (schema.type) {
    case "object": {
      const properties = projectProperties(schema)
      return {
        type: "object",
        ...annotation,
        ...properties,
        additionalProperties: schema.additionalProperties === true,
      }
    }
    case "array":
      return {
        type: "array",
        ...annotation,
        // DSH 的 array 节点要求 items；内核允许省略（等价于 string），此处按 DSH 口径补齐。
        items: schema.items !== undefined ? projectValueSchema(schema.items) : { type: "string" },
      }
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return {
        type: schema.type,
        ...annotation,
        ...(Array.isArray(schema.enum) ? { enum: [...schema.enum] } : {}),
        ...(schema.default !== undefined ? { default: schema.default } : {}),
      }
    default:
      // 内核 schema 未声明 type（无约束对象）时按 DSH 的无约束 JSON 节点投影。
      return { type: "json", ...annotation }
  }
}

/** 投影对象节点的 properties，并按内核 required 列表把必填项标注为 `required: true`。 */
function projectProperties(schema: CoreJsonSchema): { properties: Record<string, DshValueSchema> } | Record<string, never> {
  const source = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const properties: Record<string, DshValueSchema> = {}
  for (const [key, sub] of Object.entries(source)) {
    const projected = projectValueSchema(sub)
    properties[key] = required.has(key) ? { ...projected, required: true } : projected
  }
  return Object.keys(properties).length > 0 ? { properties } : {}
}

/**
 * 把一份内核纯 JSON Schema（工具参数根）投影为 DSH 工具 parameters。
 * 参数根恒为对象：DSH 的 parameters 就是属性映射本身，不再额外包一层 object。
 */
export function jsonSchemaToToolParameters(schema: CoreJsonSchema): ToolParameters {
  return projectProperties(schema).properties ?? {}
}