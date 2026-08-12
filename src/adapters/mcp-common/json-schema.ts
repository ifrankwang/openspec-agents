/**
 * 纯 JSON Schema → zod 转换（MCP SDK 工具 inputSchema 校验用）。
 * 与 opencode 适配层转换器职责相同但独立实现（不依赖 @opencode-ai/plugin），
 * 转换语义与 P1 纯 JSON Schema 契约一致。
 */
import { z } from "zod"
import type { JSONSchema } from "../../core/provider.ts"

export function jsonSchemaToZod(schema: JSONSchema): any {
  switch (schema.type) {
    case "object": {
      const shape: Record<string, any> = {}
      const properties = schema.properties ?? {}
      for (const [key, sub] of Object.entries(properties)) {
        const converted = jsonSchemaToZod(sub)
        shape[key] = (schema.required ?? []).includes(key) ? converted : converted.optional()
      }
      if (Object.keys(shape).length === 0) return z.object({})
      return z.object(shape)
    }
    case "array": {
      const items = schema.items ?? { type: "string" }
      let arr = z.array(jsonSchemaToZod(items))
      if (typeof schema.minItems === "number" && schema.minItems > 0) arr = arr.min(schema.minItems)
      return arr
    }
    case "string": {
      if (Array.isArray(schema.enum)) {
        const values = schema.enum as string[]
        return values.length === 0 ? z.string() : z.enum(values as [string, ...string[]])
      }
      let s = z.string()
      if (typeof schema.minLength === "number" && schema.minLength > 0) s = s.min(schema.minLength)
      return s
    }
    case "number":
    case "integer": {
      let n = schema.type === "integer" ? z.number().int() : z.number()
      if (typeof schema.minimum === "number") n = n.min(schema.minimum)
      if (typeof schema.maximum === "number") n = n.max(schema.maximum)
      return n
    }
    case "boolean": {
      let b: any = z.boolean()
      if (schema.default !== undefined) b = b.default(schema.default as boolean)
      return b
    }
    case "null":
      return z.null()
    default:
      return z.any()
  }
}
