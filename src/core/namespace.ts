import { createHash } from "node:crypto"

/** 由 changeId 生成稳定隔离标识：SHA256 前 6 位 hex（如 "a3f2b1"） */
export function generateIsolationNamespace(changeId: string): string {
  return createHash("sha256").update(changeId).digest("hex").slice(0, 6)
}

/** 由 namespace 派生建议端口：20000 + (hex 数值 mod 30000)，范围 [20000, 50000) */
export function derivePortFromNamespace(namespace: string): number {
  const n = parseInt(namespace, 16)
  return 20000 + (n % 30000)
}
