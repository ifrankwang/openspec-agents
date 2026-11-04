import type { HttpTraceRecord } from './evidence'

/**
 * 浏览器内请求追踪脚本（由 fixture 在页面加载前注入）。
 *
 * 为什么需要它：mock 由 MSW 在浏览器内（Service Worker）完成拦截，Playwright 的网络事件
 * 看不到这些请求；若只依赖网络事件，mock 模式下失败场景的接口证据会缺失。这里在 fetch 与
 * XMLHttpRequest 层旁路记录请求/响应，再经 fixture 的 exposeBinding 回传给测试进程。
 *
 * 约束：
 * - 只记录，不改写请求参数、状态与响应内容；
 * - 记录失败 / 回传失败一律吞掉，不影响用例结论；
 * - 函数体会被 Playwright 序列化到页面执行，禁止引用本文件外的运行时变量（类型引用会被擦除）。
 */
export function installHttpTrace(): void {
  const win = window as unknown as Record<string, unknown>
  if (win.__E2E_HTTP_TRACE_INSTALLED__) return
  win.__E2E_HTTP_TRACE_INSTALLED__ = true

  const MAX_BODY = 20000
  const MAX_RECORDS = 200
  let recorded = 0

  const clip = (text: string): string =>
    text.length <= MAX_BODY ? text : `${text.slice(0, MAX_BODY)}\n…（已截断，原文 ${text.length} 字符）`

  const emit = (record: HttpTraceRecord): void => {
    if (recorded >= MAX_RECORDS) return
    recorded += 1
    const sink = win.__E2E_HTTP_TRACE__
    if (typeof sink !== 'function') return
    try {
      void (sink as (value: HttpTraceRecord) => unknown)(record)
    } catch {
      /* 采集失败不影响用例 */
    }
  }

  const headersToObject = (headers: Headers): Record<string, string> => {
    const result: Record<string, string> = {}
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }

  const requestBodyOf = (body: BodyInit | null | undefined): string => {
    if (body === null || body === undefined) return ''
    if (typeof body === 'string') return clip(body)
    if (body instanceof URLSearchParams) return clip(body.toString())
    if (body instanceof FormData) {
      const parts: string[] = []
      body.forEach((value, key) => {
        parts.push(
          `${key}=${typeof value === 'string' ? value : `（文件：${value.name}，${value.size} 字节）`}`
        )
      })
      return clip(parts.join('&'))
    }
    if (body instanceof Blob) return `（Blob：${body.type || '未知类型'}，${body.size} 字节）`
    if (body instanceof ArrayBuffer) return `（ArrayBuffer：${body.byteLength} 字节）`
    return '（无法序列化的请求体）'
  }

  const responseBodyOf = async (response: Response): Promise<string> => {
    const contentType = response.headers.get('content-type') || ''
    if (!/json|text|xml|javascript|x-www-form-urlencoded/.test(contentType)) {
      const size = response.headers.get('content-length') || '未知'
      return `（非文本响应：${contentType || '未知类型'}，${size} 字节）`
    }
    try {
      return clip(await response.clone().text())
    } catch {
      return '（响应体读取失败）'
    }
  }

  const parseRawHeaders = (raw: string): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const line of raw.trim().split(/[\r\n]+/)) {
      const index = line.indexOf(':')
      if (index <= 0) continue
      const key = line.slice(0, index).trim().toLowerCase()
      const value = line.slice(index + 1).trim()
      result[key] = result[key] ? `${result[key]}, ${value}` : value
    }
    return result
  }

  // ── fetch ──────────────────────────────────────────────
  const originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    window.fetch = async function tracedFetch(input: RequestInfo | URL, init?: RequestInit) {
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const requestHeaders = init?.headers
        ? headersToObject(new Headers(init.headers))
        : input instanceof Request
          ? headersToObject(input.headers)
          : {}
      let requestBody = ''
      try {
        if (typeof input === 'string' || input instanceof URL) {
          requestBody = requestBodyOf(init?.body)
        } else {
          requestBody = clip(await input.clone().text())
        }
      } catch {
        requestBody = '（请求体读取失败）'
      }

      const response = await originalFetch.call(window, input as RequestInfo, init)
      void (async () => {
        const responseBody = await responseBodyOf(response)
        emit({
          method,
          url: response.url || String(url),
          status: response.status,
          requestHeaders,
          requestBody,
          responseHeaders: headersToObject(response.headers),
          responseBody
        })
      })()
      return response
    } as typeof window.fetch
  }

  // ── XMLHttpRequest（axios 等基于 XHR 的客户端） ─────────
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader
  const meta = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string; requestHeaders: Record<string, string>; body: string }
  >()

  XMLHttpRequest.prototype.open = function tracedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    meta.set(this, {
      method: String(method).toUpperCase(),
      url: typeof url === 'string' ? url : url.toString(),
      requestHeaders: {},
      body: ''
    })
    return originalOpen.call(this, method, url as string, async ?? true, username, password)
  } as typeof XMLHttpRequest.prototype.open

  XMLHttpRequest.prototype.setRequestHeader = function tracedSetRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string
  ) {
    const entry = meta.get(this)
    if (entry) entry.requestHeaders[name] = value
    return originalSetRequestHeader.call(this, name, value)
  }

  XMLHttpRequest.prototype.send = function tracedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    const entry = meta.get(this)
    if (entry) {
      entry.body = requestBodyOf(body as BodyInit | null | undefined)
      this.addEventListener(
        'loadend',
        () => {
          const responseBody = (() => {
            try {
              const type = this.responseType
              if (type === '' || type === 'text') return clip(this.responseText || '')
              if (type === 'json') return clip(JSON.stringify(this.response))
              return `（非文本响应：responseType=${type || '未知'}）`
            } catch {
              return '（响应体读取失败）'
            }
          })()
          emit({
            method: entry.method,
            url: this.responseURL || entry.url,
            status: this.status,
            requestHeaders: entry.requestHeaders,
            requestBody: entry.body,
            responseHeaders: parseRawHeaders(this.getAllResponseHeaders()),
            responseBody
          })
        },
        { once: true }
      )
    }
    return originalSend.call(this, body as Document | XMLHttpRequestBodyInit | null)
  }
}
