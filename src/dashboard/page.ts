import { fileURLToPath } from "node:url"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

let _html: string | null = null

/** 页面资源定位：bundle 形态（ZCode 插件包）资源随 bundle 同目录放置；源码/包形态位于 ../../assets/dashboard/。 */
function resolveDashboardHtml(): string {
  const __dirname = fileURLToPath(new URL(".", import.meta.url))
  const bundled = join(__dirname, "dashboard", "index.html")
  if (existsSync(bundled)) return bundled
  return join(__dirname, "../../assets/dashboard/index.html")
}

export function getDashboardPage(): string {
  if (_html) return _html
  _html = readFileSync(resolveDashboardHtml(), "utf-8")
  return _html
}
