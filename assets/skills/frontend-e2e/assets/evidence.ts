import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'

/**
 * 失败证据采集。
 *
 * 报告里的「控制台报错 / 接口报错 / 断言不符」全部来自这里，不做任何人工解释：
 * - 控制台：页面 `console.error` 与未捕获异常（pageerror）原文；
 * - 接口：API 前缀下的请求与响应（默认 `/api`，可用 `E2E_API_PREFIX` 覆盖），方法、URL、请求头、请求体、状态码、响应头、响应体全量；
 *   mock 模式（MSW 在浏览器内拦截）下由 fixture 注入的页面追踪回传（ingestHttpRecord），
 *   与真实网络采集同一套数据口径，不因 mock 而降级；
 * - 断言：从 Playwright 错误消息里取定位选择器、期望值、实际值，并给断言目标加红框后截图。
 *
 * 只有用例失败时才落盘，通过的用例不产生证据附件。
 */

export interface ConsoleRecord {
  level: string
  text: string
  location: string
}

export interface HttpRecord {
  method: string
  url: string
  status: number
  requestHeaders: Record<string, string>
  requestBody: string
  responseHeaders: Record<string, string>
  responseBody: string
}

/** 页面内追踪（http-trace）回传的记录：字段与 HttpRecord 同口径，由 fixture 转发。 */
export type HttpTraceRecord = HttpRecord

/** 已开启页面内追踪的页面：接口记录以追踪通道为准，不再重复采集网络事件。 */
const traceActive = new WeakSet<Page>()

export interface EvidenceState {
  console: ConsoleRecord[]
  pageErrors: string[]
  http: HttpRecord[]
}

export type FailureCategory = 'console' | 'http' | 'assert' | 'script'

export interface FailureMark {
  /** 视口百分比坐标，红框直接按百分比叠加 */
  l: number
  t: number
  w: number
  h: number
}

export interface FailureEvidence {
  category: FailureCategory
  summary: string
  selector: string | null
  expected: string | null
  actual: string | null
  pageText: string | null
  mark: FailureMark | null
  console: ConsoleRecord[]
  http: HttpRecord[]
  location: string | null
  /** 失败断言的源码原文（含断言目标），从失败行回读 */
  assertion: { file: string; line: number; code: string } | null
  message: string
}

const MAX_CONSOLE = 40
const MAX_HTTP = 20
const MAX_TEXT = 20000
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-xsrf-token']

/** 挂上监听器；同一页面只挂一次，重复调用返回同一份证据容器 */
const registry = new WeakMap<Page, EvidenceState>()

export function collectEvidence(page: Page): EvidenceState {
  const existing = registry.get(page)
  if (existing) return existing

  const state: EvidenceState = { console: [], pageErrors: [], http: [] }
  registry.set(page, state)

  page.on('console', message => {
    if (message.type() !== 'error' || state.console.length >= MAX_CONSOLE) return
    const location = message.location()
    state.console.push({
      level: 'error',
      text: message.text(),
      location: location.url ? `${location.url}:${location.lineNumber ?? 0}` : ''
    })
  })

  page.on('pageerror', error => {
    state.pageErrors.push(String(error.message || error))
    if (state.console.length >= MAX_CONSOLE) return
    state.console.push({
      level: 'pageerror',
      text: String(error.message || error),
      location: firstFrame(String(error.stack || ''))
    })
  })

  page.on('response', response => {
    // 取证通道开启时以页面内追踪为准：MSW 在 Service Worker 内应答的请求不会出现在
    // Playwright 网络事件里，双通道既漏记 mock 请求又可能重复，故只保留一条。
    if (traceActive.has(page)) return
    void recordResponse(response, state)
  })

  return state
}

async function recordResponse(response: import('@playwright/test').Response, state: EvidenceState) {
  if (state.http.length >= MAX_HTTP) return
  const request = response.request()
  const url = response.url()
  if (!isApiRequest(url)) return

  const [requestHeaders, responseHeaders] = await Promise.all([
    request.allHeaders().catch(() => ({}) as Record<string, string>),
    response.allHeaders().catch(() => ({}) as Record<string, string>)
  ])
  const contentType = String(responseHeaders['content-type'] || '')
  const record: HttpRecord = {
    method: request.method(),
    url: redactUrl(url),
    status: response.status(),
    requestHeaders: redactHeaders(requestHeaders),
    requestBody: clip(request.postData() || ''),
    responseHeaders: redactHeaders(responseHeaders),
    responseBody: ''
  }
  if (/json|text|xml|javascript/.test(contentType)) {
    record.responseBody = clip(await response.text().catch(() => ''))
  } else {
    const size = responseHeaders['content-length'] || '未知'
    record.responseBody = `（非文本响应：${contentType || '未知类型'}，${size} 字节）`
  }
  state.http.push(record)
}

/** 标记该页面已启用页面内追踪通道（fixture 在注入追踪脚本前调用）。 */
export function markHttpTraceActive(page: Page): void {
  traceActive.add(page)
}

/**
 * 页面内追踪回传的接口记录入库：前缀过滤、敏感头打码、长度裁剪与本地网络采集同口径。
 * 重复记录按上限截断；任何字段缺失都不阻断其余证据。
 */
export function ingestHttpRecord(page: Page, record: HttpTraceRecord): void {
  const state = registry.get(page)
  if (!state || state.http.length >= MAX_HTTP) return
  if (!record || typeof record !== 'object') return
  const url = String(record.url || '')
  if (!isApiRequest(url)) return
  state.http.push({
    method: String(record.method || 'GET').toUpperCase(),
    url: redactUrl(url),
    status: Number(record.status) || 0,
    requestHeaders: redactHeaders(record.requestHeaders || {}),
    requestBody: clip(String(record.requestBody || '')),
    responseHeaders: redactHeaders(record.responseHeaders || {}),
    responseBody: clip(String(record.responseBody || ''))
  })
}

const API_PREFIX = process.env.E2E_API_PREFIX || '/api'

function isApiRequest(url: string): boolean {
  try {
    const pathname = new URL(url).pathname
    return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)
  } catch {
    return false
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.includes(key.toLowerCase()) ? '***' : value
  }
  return result
}

function redactUrl(url: string): string {
  return url.replace(/(token|access_token|code)=[^&]+/gi, '$1=***')
}

function clip(text: string): string {
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT)}\n…（已截断，原文 ${text.length} 字符）`
}

/** Playwright 断言消息里带 ANSI 颜色控制符，报告里要剥掉 */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** 堆栈里的绝对路径改成相对仓库根的短路径，便于研发定位 */
function relativeLocation(location: string): string {
  return location.replace(`${process.cwd()}/`, '')
}

/** 取错误堆栈里第一条业务代码位置 */
export function firstFrame(stack: string): string {
  const lines = stack.split('\n')
  for (const line of lines) {
    const match = /(?:at\s+.*?\()?([^\s()]+:\d+:\d+)\)?$/.exec(line.trim())
    if (!match) continue
    const file = match[1]
    if (file.includes('node_modules') || file.includes('@playwright')) continue
    return file
  }
  return ''
}

function parseSelector(message: string): string | null {
  const matches = message.match(/locator\((['"])(.+?)\1\)/g) || []
  const last = matches[matches.length - 1]
  if (!last) return null
  const inner = /locator\((['"])(.+?)\1\)/.exec(last)
  return inner ? inner[2] : null
}

function firstLine(message: string): string {
  return (
    message
      .split('\n')
      .find(line => line.trim().length > 0)
      ?.trim() || message.trim()
  )
}

function field(message: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(message)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

function classify(message: string, state: EvidenceState): FailureCategory {
  if (state.pageErrors.length > 0) return 'console'
  if (/HTTP \d{3}/.test(message)) return 'http'
  if (/expect\(|expect\.|Timeout|waiting for locator|toBe|toHave|toContain/.test(message)) {
    return 'assert'
  }
  if (state.console.length > 0) return 'console'
  return 'script'
}

function summarize(category: FailureCategory, message: string, state: EvidenceState): string {
  if (category === 'http') {
    const http = lastHttp(state, message)
    if (http) return `${http.method} ${shortPath(http.url)} → ${http.status}`
    return message.split('\n').slice(0, 2).join(' ').slice(0, 160)
  }
  if (category === 'console') {
    return (state.pageErrors[0] || state.console[0]?.text || firstLine(message)).slice(0, 160)
  }
  return firstLine(message)
    .replace(/^Error:\s*/, '')
    .slice(0, 160)
}

function shortPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/** 失败的接口：优先取错误消息里提到的那条，其次取最后一条非 2xx 响应 */
function lastHttp(state: EvidenceState, message: string): HttpRecord | null {
  const mentioned = state.http.filter(record => message.includes(shortPath(record.url)))
  if (mentioned.length) return mentioned[mentioned.length - 1]
  const abnormal = state.http.filter(record => record.status >= 400 || record.status === 0)
  if (abnormal.length) return abnormal[abnormal.length - 1]
  return state.http[state.http.length - 1] || null
}

interface MarkResult {
  mark: FailureMark | null
  pageText: string | null
}

/** 给断言目标加红框，并读出它的可见文案 */
async function markTarget(page: Page, selector: string): Promise<MarkResult> {
  try {
    const result = await page.evaluate(rawSelector => {
      let element: Element | null = null
      try {
        element = document.querySelector(rawSelector)
      } catch {
        return null
      }
      if (!element) return null
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = element.getBoundingClientRect()
      const text = (element.textContent || '').trim().slice(0, 200)
      if (!rect.width || !rect.height) return { text, mark: null }
      // 只量位置，不往页面里画描边：红框由报告页面按 mark 叠加，避免截图里出现双层框
      const round = (value: number) => Math.round(value * 100) / 100
      return {
        text,
        mark: {
          l: round((rect.left / window.innerWidth) * 100),
          t: round((rect.top / window.innerHeight) * 100),
          w: round((rect.width / window.innerWidth) * 100),
          h: round((rect.height / window.innerHeight) * 100)
        }
      }
    }, selector)
    if (!result) return { mark: null, pageText: null }
    return { mark: result.mark ?? null, pageText: result.text || null }
  } catch {
    return { mark: null, pageText: null }
  }
}

/**
 * 从失败行回读断言源码：报告里的「断言」块直接给这句代码，
 * 让人和 Agent 都能看出到底在断言什么，而不是只看到期望值 1、实际值 0。
 */
function readAssertionSource(
  location: string | null
): { file: string; line: number; code: string } | null {
  if (!location) return null
  const match = /^(.*?):(\d+):(\d+)$/.exec(location)
  if (!match) return null
  const file = match[1]
  const line = Number(match[2])
  const absolute = path.resolve(process.cwd(), file)
  try {
    const source = readFileSync(absolute, 'utf8').split('\n')
    let start = Math.max(0, line - 1)
    while (start > 0 && !source[start].includes('expect')) start -= 1
    if (!source[start].includes('expect')) start = Math.max(0, line - 1)
    let depth = 0
    let end = start
    const limit = Math.min(source.length, start + 12)
    for (; end < limit; end += 1) {
      for (const char of source[end]) {
        if (char === '(') depth += 1
        if (char === ')') depth -= 1
      }
      if (depth <= 0) break
    }
    const code = source
      .slice(start, Math.min(end + 1, limit))
      .map(text => text.trim())
      .join('\n')
    return { file, line, code: code.slice(0, 800) }
  } catch {
    return null
  }
}

/**
 * 用例失败时调用：给断言目标加红框、截失败现场、落 `失败证据` 附件。
 * 任何一步失败都不影响用例本身的失败结论（全部 catch 掉）。
 */
export async function attachFailureEvidence(
  page: Page,
  testInfo: TestInfo,
  state: EvidenceState
): Promise<void> {
  const error = testInfo.errors[0]
  const message = stripAnsi(String(error?.message || ''))
  const stack = stripAnsi(String(error?.stack || message))

  const selector = parseSelector(message)
  const marked = selector ? await markTarget(page, selector) : { mark: null, pageText: null }

  const screenshot = await page
    .screenshot({ type: 'jpeg', quality: 55, animations: 'disabled', caret: 'hide' })
    .catch(() => null)
  if (screenshot) {
    await testInfo.attach('失败现场截图', { body: screenshot, contentType: 'image/jpeg' })
  }

  const category = classify(message, state)
  const evidence: FailureEvidence = {
    category,
    summary: summarize(category, message, state),
    selector,
    expected: field(message, [
      /Expected (?:substring|string|value|pattern):\s*\n?\s*(.+)/,
      /Expected:\s*\n?\s*(.+)/
    ]),
    actual:
      field(message, [/Received (?:string|value|array):\s*\n?\s*(.+)/, /Received:\s*\n?\s*(.+)/]) ||
      (message.includes('element(s) not found') ? '（未找到该元素）' : null),
    pageText: marked.pageText ?? (selector ? '（元素未出现）' : null),
    mark: marked.mark,
    console: state.console.slice(-10),
    http: category === 'http' ? state.http.slice(-5) : [],
    location: relativeLocation(firstFrame(stack)) || null,
    assertion: readAssertionSource(relativeLocation(firstFrame(stack))),
    message: message.slice(0, 4000)
  }

  await testInfo.attach('失败证据', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json'
  })
}
