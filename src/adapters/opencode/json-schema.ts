/**
 * 纯 JSON Schema → zod（OpenCode 链式 schema）转换器。
 * 适配层专用：工具参数定义以 P1 纯 JSON Schema 为单一事实源（src/core/tools/schemas.ts），
 * OpenCode 链式 API 仅作为转换目标，工具定义本身不依赖任何 agent 专有 API。
 */
import { tool } from "@opencode-ai/plugin"
import type { JSONSchema } from "../../core/provider.ts"

function convert(schema: JSONSchema): any {
  switch (schema.type) {
    case "object": {
      const shape: Record<string, any> = {}
      const properties = schema.properties ?? {}
      for (const [key, sub] of Object.entries(properties)) {
        const converted = convert(sub)
        shape[key] = (schema.required ?? []).includes(key) ? converted : tool.schema.optional(converted)
      }
      if (Object.keys(shape).length === 0) return tool.schema.object({})
      return tool.schema.object(shape)
    }
    case "array": {
      const items = schema.items ?? { type: "string" }
      let arr = tool.schema.array(convert(items))
      if (typeof schema.minItems === "number" && schema.minItems > 0) arr = arr.min(schema.minItems)
      return arr
    }
    case "string": {
      if (Array.isArray(schema.enum)) {
        const values = schema.enum as string[]
        return values.length === 0 ? tool.schema.string() : tool.schema.enum(values)
      }
      let s = tool.schema.string()
      if (typeof schema.minLength === "number" && schema.minLength > 0) s = s.min(schema.minLength)
      return s
    }
    case "number":
    case "integer": {
      let n = schema.type === "integer" ? tool.schema.number().int() : tool.schema.number()
      if (typeof schema.minimum === "number") n = n.min(schema.minimum)
      if (typeof schema.maximum === "number") n = n.max(schema.maximum)
      return n
    }
    case "boolean": {
      let b: any = tool.schema.boolean()
      if (schema.default !== undefined) b = b.default(schema.default as boolean)
      return b
    }
    case "null":
      return tool.schema.null()
    default:
      return tool.schema.any()
  }
}

/** JSON Schema → zod schema（description 注入）。 */
export function jsonSchemaToZod(schema: JSONSchema): any {
  const base = convert(schema)
  if (schema.description) base.describe(schema.description)
  return base
}
