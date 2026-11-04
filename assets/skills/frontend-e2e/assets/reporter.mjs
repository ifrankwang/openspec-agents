import fs from 'node:fs'
import path from 'node:path'

/**
 * 业务场景报告生成器（Playwright Reporter）——两级结构：场景列表 + 场景详情。
 *
 * 打开 index.html 先看到按「业务域 → 分支 → 场景」分组的列表，点击场景进入详情：
 * 面包屑、标题、文件行号、状态页签与「操作步骤」卡片（每步一句话 + 截图）。
 * 失败场景把失败步骤标红，并在该步骤下渲染证据块（控制台 / 接口 / 断言 / 脚本异常），
 * 支持折叠 JSON 树、复制完整 JSON、点击截图看原图。
 *
 * 数据来源：
 * - 用例标题：业务场景一句话；`scenario()` 注解：domain / branch（其余注解忽略）。
 * - `step()` 附件：`步骤 NN · 自然语言描述` + JPEG 截图。
 * - 失败现场附件：`失败现场截图`（失败瞬间截图，优先替换失败步骤的步骤截图）。
 * - 失败证据附件：`失败证据`（JSON 文本，渲染为 error blocks）。
 *
 * report-data.json 与页面 JS 共用同一份数据模型，不含图片二进制。
 */

const STEP_PREFIX = '步骤 '
const FAILURE_SHOT_NAMES = ['失败现场截图', 'screenshot']
const EVIDENCE_NAME = '失败证据'
const DOMAIN_ORDER = []
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g
const ERROR_CATEGORIES = ['console', 'http', 'assert', 'script']
const HTTP_STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

function annotationOf(test, type) {
  const hit = (test.annotations || []).find(item => item.type === type)
  return String(hit?.description || '').trim()
}

/** 只保留 passed / failed / skipped；test.fail() 的期望失败同样记为 failed。 */
function outcomeOf(test, result) {
  if (result.status === 'skipped') return 'skipped'
  if (test.expectedStatus === 'failed') return 'failed'
  return result.status === 'passed' ? 'passed' : 'failed'
}

function stepIndexOf(name) {
  const match = /^步骤\s*(\d+)/.exec(String(name || ''))
  return match ? Number(match[1]) : 0
}

function stripStepPrefix(name) {
  return String(name || '').replace(/^步骤\s*\d+\s*·\s*/, '')
}

function slug(value) {
  return String(value || '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '')
}

/** 一行摘要：去 ANSI、压成单行、超长截断 */
function firstLine(value, max = 300) {
  const line =
    stripAnsi(value)
      .split('\n')
      .map(item => item.trim())
      .find(Boolean) || ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 多行文本：去 ANSI，超长整体截断 */
function textOf(value, max = 6000) {
  const text = stripAnsi(value).trim()
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text
}

function httpStatusText(status) {
  return HTTP_STATUS_TEXT[Number(status)] || ''
}

function maskHeaderValue(name, value) {
  const key = String(name || '').toLowerCase()
  if (
    !['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'].includes(key)
  ) {
    return String(value ?? '')
  }
  const text = String(value ?? '')
  if (/^bearer\s+/i.test(text)) return 'Bearer ***'
  if (/^basic\s+/i.test(text)) return 'Basic ***'
  return '***'
}

function headerLines(headers) {
  if (!headers) return []
  if (Array.isArray(headers)) {
    return headers
      .map(item => {
        if (item && typeof item === 'object') {
          const name = item.name || item.key || ''
          return `${name}: ${maskHeaderValue(name, item.value)}`
        }
        return String(item || '')
      })
      .filter(Boolean)
  }
  if (typeof headers === 'object') {
    return Object.entries(headers)
      .map(([name, value]) => `${name}: ${maskHeaderValue(name, value)}`)
      .filter(Boolean)
  }
  return [String(headers)]
}

/** 请求/返回 body：对象直接用；字符串尝试解析 JSON，失败则按原字符串进 JSON 树 */
function parseBody(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'object') return value
  const text = String(value)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function normalizeMark(mark) {
  if (!mark || typeof mark !== 'object') return null
  const l = Number(mark.l)
  const t = Number(mark.t)
  const w = Number(mark.w)
  const h = Number(mark.h)
  if (![l, t, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null
  const round = value => Math.round(value * 100) / 100
  return { l: round(l), t: round(t), w: round(w), h: round(h) }
}

/** 失败证据 → error { category, summary, blocks }；证据缺失或不合法返回 null */
/** Playwright 断言的英文状态值翻成中文；未收录的原样展示 */
const ASSERT_VALUE_TEXT = {
  visible: '可见',
  hidden: '不可见',
  enabled: '可用',
  disabled: '不可用',
  attached: '已挂载',
  detached: '未挂载',
  editable: '可编辑',
  stable: '稳定',
  'element(s) not found': '未找到元素'
}

function displayAssertValue(value) {
  const text = String(value ?? '').trim()
  return ASSERT_VALUE_TEXT[text] || text
}

function buildError(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const category = ERROR_CATEGORIES.includes(evidence.category) ? evidence.category : 'script'
  const blocks = []
  let summary = ''

  if (category === 'http') {
    const calls = Array.isArray(evidence.http)
      ? evidence.http.filter(item => item && typeof item === 'object')
      : []
    const call = calls.find(item => Number(item.status) >= 400) || calls[calls.length - 1]
    if (call) {
      const method = String(call.method || 'GET').toUpperCase()
      const url = String(call.url || '')
      const requestMeta = [`${method} ${url}`.trim(), ...headerLines(call.requestHeaders)]
      const statusLine = `HTTP/1.1 ${call.status ?? ''} ${httpStatusText(call.status)}`.trim()
      blocks.push({
        label: '请求',
        kind: 'http',
        meta: requestMeta.filter(Boolean),
        body: parseBody(call.requestBody)
      })
      blocks.push({
        label: '返回',
        kind: 'http',
        meta: [statusLine, ...headerLines(call.responseHeaders)].filter(Boolean),
        body: parseBody(call.responseBody)
      })
      const status = httpStatusText(call.status)
      summary = `${method} ${url} → ${call.status ?? ''}${status ? ` ${status}` : ''}`
    }
    if (evidence.location)
      blocks.push({ label: '位置', kind: 'code', text: String(evidence.location) })
  } else if (category === 'console') {
    const entries = Array.isArray(evidence.console)
      ? evidence.console.filter(item => item && typeof item === 'object')
      : []
    const text = entries
      .map(entry => {
        const head = `[${entry.level || 'error'}] ${textOf(entry.text, 2000)}`.trim()
        return entry.location ? `${head}\n    at ${entry.location}` : head
      })
      .join('\n')
    if (text) blocks.push({ label: '控制台', kind: 'console', text })
    if (evidence.location)
      blocks.push({ label: '位置', kind: 'code', text: String(evidence.location) })
    summary = firstLine(entries[0]?.text || evidence.message || '控制台报错')
  } else if (category === 'assert') {
    if (evidence.selector) {
      blocks.push({ label: '选择器', kind: 'selector', text: String(evidence.selector) })
    }
    if (evidence.assertion && evidence.assertion.code) {
      blocks.push({ label: '断言', kind: 'code', text: String(evidence.assertion.code) })
    }
    if (evidence.expected !== undefined && evidence.expected !== null) {
      blocks.push({
        label: '期望',
        kind: 'expect',
        text: displayAssertValue(textOf(evidence.expected, 2000))
      })
    }
    if (evidence.actual !== undefined && evidence.actual !== null) {
      blocks.push({
        label: '实际',
        kind: 'actual',
        text: displayAssertValue(textOf(evidence.actual, 2000))
      })
    }
    if (evidence.pageText) {
      blocks.push({ label: '页面文案', kind: 'text', text: textOf(evidence.pageText, 2000) })
    }
    if (evidence.location)
      blocks.push({ label: '位置', kind: 'code', text: String(evidence.location) })
    summary = evidence.assertion?.code
      ? firstLine(String(evidence.assertion.code))
      : firstLine(evidence.message) || '断言不符'
  } else {
    const message = textOf(evidence.message || evidence.error || '', 2000)
    if (message) blocks.push({ label: '错误', kind: 'actual', text: message })
    if (evidence.location)
      blocks.push({ label: '位置', kind: 'code', text: String(evidence.location) })
    summary = firstLine(evidence.message || evidence.error || '脚本异常')
  }

  if (!summary) summary = '执行异常'
  // 断言源码已经当摘要显示了，单行断言就不重复渲染一次
  if (blocks[0] && blocks[0].label === '断言' && blocks[0].text === summary) blocks.shift()
  return { category, summary, blocks }
}

function readEvidence(attachment) {
  try {
    const raw = attachment.path
      ? fs.readFileSync(attachment.path, 'utf8')
      : Buffer.from(attachment.body).toString('utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    /* 证据不是合法 JSON 时报告降级为无证据块，不影响其他场景 */
    return null
  }
}

function copyAttachment(attachment, target) {
  if (attachment.path) fs.copyFileSync(attachment.path, target)
  else fs.writeFileSync(target, Buffer.from(attachment.body))
}

function domainRank(name) {
  // 业务域顺序交给域名字母序，保证报告可稳定 diff；需要固定顺序时把域名填进 DOMAIN_ORDER
  const index = DOMAIN_ORDER.indexOf(name)
  return index === -1 ? DOMAIN_ORDER.length : index
}

/** 场景顺序：业务域按固定顺序，域内按文件行号，保证报告稳定可 diff */
function compareScenario(a, b) {
  return (
    domainRank(a.domain) - domainRank(b.domain) ||
    String(a.domain).localeCompare(String(b.domain), 'zh') ||
    String(a.file).localeCompare(String(b.file)) ||
    a.line - b.line ||
    String(a.title).localeCompare(String(b.title), 'zh')
  )
}

export default class BusinessReport {
  constructor(options = {}) {
    this.outputDir = options.outputDir || path.resolve(process.cwd(), 'playwright-report')
    this.mode = options.mode || 'mock'
    this.baseURL = options.baseURL || ''
    this.scenarios = []
    this.startedAt = Date.now()
    this.repoRoot = process.cwd()
  }

  onBegin(config) {
    this.startedAt = Date.now()
    this.repoRoot = config?.rootDir || process.cwd()
    fs.mkdirSync(this.outputDir, { recursive: true })
    // 只清理本报告自己的产物：outputDir 可能是 playwright-report，同级还有 sample/ 与 real/，
    // 整目录删除会误伤；旧一轮的 assets 与 HTML/JSON 在这里清掉即可。
    fs.rmSync(path.join(this.outputDir, 'assets'), { recursive: true, force: true })
    fs.rmSync(path.join(this.outputDir, 'index.html'), { force: true })
    fs.rmSync(path.join(this.outputDir, 'report-data.json'), { force: true })
    fs.mkdirSync(path.join(this.outputDir, 'assets'), { recursive: true })
  }

  onTestEnd(test, result) {
    const index = this.scenarios.length + 1
    const title = String(test.title || '')
    const dirName = `${String(index).padStart(3, '0')}-${slug(title) || 'scenario'}`
    const scenarioDir = path.join(this.outputDir, 'assets', dirName)
    fs.mkdirSync(scenarioDir, { recursive: true })
    const imagePath = fileName => path.posix.join('assets', dirName, fileName)

    const status = outcomeOf(test, result)
    const stepAttachments = []
    let failureAttachment = null
    let evidenceAttachment = null
    for (const attachment of result.attachments || []) {
      if (!attachment || (!attachment.path && !attachment.body)) continue
      const name = attachment.name || ''
      if (name.startsWith(STEP_PREFIX)) stepAttachments.push(attachment)
      else if (FAILURE_SHOT_NAMES.includes(name)) failureAttachment = attachment
      else if (name === EVIDENCE_NAME) evidenceAttachment = attachment
    }

    const steps = []
    stepAttachments.forEach((attachment, order) => {
      const stepIndex = stepIndexOf(attachment.name) || order + 1
      if (steps.some(item => item.index === stepIndex)) return
      const fileName = `${String(stepIndex).padStart(2, '0')}.jpg`
      try {
        copyAttachment(attachment, path.join(scenarioDir, fileName))
      } catch {
        /* 单张截图复制失败不影响报告生成 */
        return
      }
      steps.push({
        index: stepIndex,
        text: stripStepPrefix(attachment.name),
        image: imagePath(fileName)
      })
    })
    steps.sort((a, b) => a.index - b.index)

    // 失败步骤 = 最后一个步骤附件；没有步骤附件说明运行前就失败，记 0
    const failedStepIndex =
      status === 'failed' ? (steps.length ? steps[steps.length - 1].index : 0) : null

    if (status === 'failed' && failedStepIndex > 0 && failureAttachment) {
      try {
        copyAttachment(failureAttachment, path.join(scenarioDir, 'failure.jpg'))
        const target = steps.find(item => item.index === failedStepIndex)
        // 失败现场截图优先；复制失败时回退该步骤的原截图
        if (target) target.image = imagePath('failure.jpg')
      } catch {
        /* 失败现场截图不可用时沿用步骤截图 */
      }
    }

    const evidence = evidenceAttachment ? readEvidence(evidenceAttachment) : null
    const error = status === 'failed' ? buildError(evidence) : null
    // 原始证据给机器读（schema 见 REPORT_SCHEMA.error.raw），页面只渲染 blocks
    if (error && evidence) error.raw = evidence
    const mark = status === 'failed' ? normalizeMark(evidence?.mark) : null

    this.scenarios.push({
      id: `s${index}`,
      caseId: annotationOf(test, 'case-id') || '',
      title,
      domain: annotationOf(test, 'domain') || '未归类场景',
      branch: annotationOf(test, 'branch') || '未分类分支',
      status,
      durationMs: result.duration || 0,
      file: test.location?.file ? path.relative(this.repoRoot, test.location.file) : '',
      line: test.location?.line || 0,
      steps,
      failedStepIndex,
      error,
      mark
    })
  }

  onEnd(result) {
    const summary = { total: 0, passed: 0, failed: 0, skipped: 0 }
    this.scenarios.forEach(scenario => {
      summary.total += 1
      summary[scenario.status] += 1
    })

    const data = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      schema: REPORT_SCHEMA,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt,
      mode: this.mode,
      runStatus: result?.status || 'unknown',
      summary,
      scenarios: [...this.scenarios].sort(compareScenario)
    }

    fs.writeFileSync(path.join(this.outputDir, 'index.html'), renderHtml(data), 'utf8')
    fs.writeFileSync(
      path.join(this.outputDir, 'report-data.json'),
      JSON.stringify(data, null, 2),
      'utf8'
    )

    const { passed, failed, skipped, total } = summary
    console.log(
      `[e2e-report] ${total} 个业务场景：通过 ${passed}，失败 ${failed}，跳过 ${skipped} → ${path.join(this.outputDir, 'index.html')}`
    )
  }
}

const REPORT_SCHEMA_VERSION = 1

/** report-data.json 的字段说明：给人看的同时，也给 AI Agent 直接消费 */
const REPORT_SCHEMA = {
  status: "通过='passed'，失败='failed'，跳过='skipped'；test.fail() 的已知缺陷计为 failed",
  'scenario.domain': '业务域（一级分组）',
  'scenario.branch': '业务分支（二级分组）',
  'scenario.file': '用例文件，相对仓库根目录',
  'scenario.line': '用例起始行号',
  'scenario.steps[]': '步骤序号、自然语言描述、截图相对路径',
  'scenario.failedStepIndex': '失败发生的步骤序号（1 基）；0 表示运行前失败；无失败为 null',
  'scenario.mark': '失败截图上断言目标的位置，视口百分比 {l,t,w,h}',
  'error.category':
    "失败来源：'console'=控制台报错、'http'=接口报错、'assert'=断言不符、'script'=脚本异常",
  'error.summary': '一行机械摘要（失败断言的源码行、或 HTTP 方法与状态码）',
  'error.blocks':
    '证据分块，每块 {label,kind,text}；kind 取值 http/console/expect/actual/selector/code/text',
  'error.raw': '原始失败证据（接口请求响应全量、控制台记录、断言源码与堆栈）'
}

function renderHtml(data) {
  // 数据以 JS 字面量注入：把 < 转成 \u003c，避免 </script> 提前闭合脚本；
  // 反引号与 ${} 落在双引号字符串里，不会触发模板求值。
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>端到端业务场景报告</title>
    <style>
      :root {
        --fg: #1f2328;
        --muted: #59636e;
        --border: #d1d9e0;
        --header-bg: #f6f8fa;
        --hover: #f6f8fa;
        --green: #1a7f37;
        --red: #d1242f;
        --gray: #6e7781;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: #fff;
        color: var(--fg);
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica,
          Arial, sans-serif, 'PingFang SC', 'Microsoft YaHei';
        -webkit-font-smoothing: antialiased;
      }
      a {
        color: inherit;
        text-decoration: none;
      }
      .toolbar {
        position: sticky;
        top: 0;
        z-index: 10;
        background: #fff;
        border-bottom: 1px solid var(--border);
      }
      .toolbar-in {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 8px 0;
      }
      .wrap {
        width: 976px;
        max-width: calc(100vw - 48px);
        margin: 0 auto;
      }
      .search {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 400px;
        height: 32px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--muted);
      }
      .search input {
        flex: 1;
        border: 0;
        outline: 0;
        font-size: 13px;
        color: var(--fg);
        background: transparent;
      }
      .chips {
        display: flex;
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
      }
      .chip {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        font-size: 13px;
        border-left: 1px solid var(--border);
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      .chip:first-child {
        border-left: 0;
      }
      .chip:hover {
        background: var(--hover);
      }
      .chip.on {
        background: #32383f;
        color: #fff;
      }
      .chip .num {
        font-size: 12px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }
      .chip.on .num {
        color: #cfd6dd;
      }
      .toolbar-right {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--muted);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        flex: none;
      }
      .icon {
        width: 15px;
        height: 15px;
        flex: none;
        display: inline-block;
      }
      .icon-ok {
        color: var(--green);
      }
      .icon-bad {
        color: var(--red);
      }
      .icon-skip {
        color: var(--gray);
      }
      .caret {
        width: 12px;
        height: 12px;
        color: var(--muted);
        transition: transform 0.12s ease;
        flex: none;
      }
      .is-collapsed .caret {
        transform: rotate(-90deg);
      }

      main {
        padding: 18px 0 80px;
      }
      .group {
        border: 1px solid var(--border);
        border-radius: 6px;
        margin-bottom: 16px;
        overflow: hidden;
      }
      .group-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        background: var(--header-bg);
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        user-select: none;
        font-weight: 600;
        font-size: 13px;
      }
      .group.is-collapsed .group-head {
        border-bottom: 0;
      }
      .group.is-collapsed .group-body {
        display: none;
      }
      .branch-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px 2px 26px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
      }
      .branch.is-collapsed .branch-head {
        border-bottom: 0;
      }
      .branch.is-collapsed .branch-body {
        display: none;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px 10px 46px;
        border-bottom: 1px solid #eef1f4;
        cursor: pointer;
      }
      .row:last-child {
        border-bottom: 0;
      }
      .row:hover {
        background: var(--hover);
      }
      .row-main {
        flex: 1;
        min-width: 0;
      }
      .row-title {
        font-size: 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row-path {
        font-size: 12px;
        color: var(--muted);
        margin-top: 1px;
      }
      .row-dur {
        font-size: 12px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }

      /* detail */
      .crumb {
        font-size: 12.5px;
        color: var(--muted);
        padding: 2px 0 4px;
      }
      h1 {
        font-size: 26px;
        line-height: 1.35;
        font-weight: 600;
        margin: 4px 0 2px;
      }
      .detail-meta {
        display: flex;
        align-items: baseline;
        gap: 12px;
        font-size: 12.5px;
        color: var(--muted);
      }
      .detail-meta .dur {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
      }
      .tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--border);
        margin: 16px 0 18px;
      }
      .tab {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        font-size: 13px;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
      }
      .tab.on {
        border-bottom-color: #fd8c73;
        font-weight: 600;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 6px;
        margin-bottom: 16px;
        overflow: hidden;
      }
      .card-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        background: var(--header-bg);
        border-bottom: 1px solid var(--border);
        font-weight: 600;
        font-size: 13px;
      }
      .card-body {
        padding: 4px 0;
      }
      .step {
        padding: 12px 14px 18px 14px;
        border-bottom: 1px solid #eef1f4;
      }
      .step:last-child {
        border-bottom: 0;
      }
      .step-line {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
      }
      .step-idx {
        flex: none;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #eaeef2;
        color: var(--muted);
        font-size: 11.5px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-variant-numeric: tabular-nums;
      }
      .step-text {
        font-size: 14px;
      }
      .step img {
        display: block;
        max-width: 100%;
        max-height: 380px;
        width: auto;
        border: 1px solid var(--border);
        border-radius: 6px;
        cursor: zoom-in;
        margin-left: 30px;
      }
      .step .error {
        margin: 10px 0 0 30px;
        max-width: 100%;
      }
      .shot {
        position: relative;
        display: inline-block;
        max-width: 100%;
        margin-left: 30px;
      }
      .shot img {
        margin-left: 0;
      }
      .mark {
        position: absolute;
        border: 2px solid #d1242f;
        border-radius: 3px;
        box-shadow: 0 0 0 3px rgba(209, 36, 47, 0.16);
        pointer-events: none;
      }
      .mark-label {
        position: absolute;
        right: -2px;
        top: -20px;
        background: #d1242f;
        color: #fff;
        font-size: 11px;
        line-height: 18px;
        padding: 0 6px;
        border-radius: 3px;
        white-space: nowrap;
      }
      .step.fail .step-idx {
        background: #ffebe9;
        color: var(--red);
      }
      .step.fail .step-text {
        color: var(--red);
        font-weight: 600;
      }
      .error {
        margin: 10px 14px 14px;
        padding: 12px 14px;
        background: var(--header-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        font: 12px/1.65 ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        white-space: pre-wrap;
        overflow-x: auto;
      }
      .err {
        margin: 10px 0 0 30px;
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
      }
      .err-top {
        padding: 12px 14px 0;
      }
      .err-top .err {
        margin-left: 30px;
      }
      .err-head {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        background: var(--header-bg);
        border-bottom: 1px solid var(--border);
      }
      .err-tag {
        flex: none;
        font-size: 11.5px;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid;
      }
      .err-tag.console {
        color: #9a6700;
        border-color: #eac54f;
        background: #fff8c5;
      }
      .err-tag.http {
        color: #d1242f;
        border-color: #ffcecb;
        background: #ffebe9;
      }
      .err-tag.assert {
        color: #0969da;
        border-color: #cfe3ff;
        background: #ddf4ff;
      }
      .err-tag.script {
        color: #6e7781;
        border-color: #d1d9e0;
        background: #f6f8fa;
      }
      .err-summary {
        font: 12.5px/1.5 ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        color: var(--fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ev {
        display: flex;
        border-bottom: 1px solid #eef1f4;
      }
      .ev:last-child {
        border-bottom: 0;
      }
      .ev-label {
        flex: none;
        width: 60px;
        padding: 10px 0 10px 12px;
        font-size: 11.5px;
        color: var(--muted);
        user-select: none;
      }
      .ev pre {
        flex: 1;
        min-width: 0;
        margin: 0;
        padding: 10px 12px 10px 0;
        font: 12px/1.65 ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .ev-expect .ev-label,
      .ev-expect pre {
        color: #1a7f37;
        background: #f0fff4;
      }
      .ev-actual .ev-label,
      .ev-actual pre {
        color: #d1242f;
        background: #fff5f5;
      }
      .ev-console .ev-label,
      .ev-console pre {
        color: #9a6700;
        background: #fffbeb;
      }
      .ev-http pre {
        color: #24292f;
      }
      .ev-code,
      .ev-code pre {
        background: #eef1f4;
        color: #24292f;
      }
      .ev-code pre {
        font-weight: 600;
      }
      .ev-body-cell {
        flex: 1;
        min-width: 0;
        padding: 10px 12px 10px 0;
      }
      .ev-meta {
        font: 12px/1.7 ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        color: #57606a;
      }
      .ev-json {
        position: relative;
        margin-top: 8px;
        padding: 8px 10px;
        background: #fbfcfd;
        border: 1px solid var(--border);
        border-radius: 6px;
      }
      .ev-tools {
        position: absolute;
        top: 6px;
        right: 8px;
        display: flex;
        gap: 6px;
        background: #fbfcfd;
        padding-left: 8px;
      }
      .mini {
        font-size: 11.5px;
        padding: 1px 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: #fff;
        color: var(--muted);
        cursor: pointer;
      }
      .mini:hover {
        color: var(--fg);
        border-color: #afb8c1;
      }
      .json {
        font: 12px/1.7 ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        padding-top: 2px;
      }
      .jn-row {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        word-break: break-all;
      }
      .jn-container > .jn-row {
        cursor: pointer;
        user-select: none;
      }
      .jn-container > .jn-row:hover {
        background: #f0f3f6;
      }
      .jn-caret {
        width: 10px;
        flex: none;
        color: #6e7781;
        font-size: 9px;
        line-height: 1.9;
        transition: transform 0.12s ease;
      }
      .jn-caret-empty {
        visibility: hidden;
      }
      .jn-container.open > .jn-row > .jn-caret {
        transform: rotate(90deg);
      }
      .jn-children {
        padding-left: 14px;
      }
      .jn-children[hidden] {
        display: none;
      }
      .jn-key {
        color: #0550ae;
      }
      .jn-colon {
        color: #57606a;
      }
      .jn-summary {
        color: #6e7781;
      }
      .jn-str {
        color: #1a7f37;
      }
      .jn-num {
        color: #0550ae;
      }
      .jn-bool,
      .jn-null {
        color: #8250df;
      }
      .jn-null {
        font-style: italic;
      }
      .ev-selector pre {
        color: #0550ae;
      }
      .ev-text pre {
        color: #57606a;
      }
      .empty {
        padding: 14px;
        color: var(--muted);
        font-size: 13px;
      }
      .lightbox {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 50;
        cursor: zoom-out;
      }
      .lightbox.show {
        display: flex;
      }
      .lightbox img {
        max-width: 94vw;
        max-height: 92vh;
        border-radius: 6px;
        background: #fff;
      }
      .back {
        color: var(--muted);
        font-size: 12.5px;
        cursor: pointer;
      }
      .back:hover {
        color: var(--fg);
        text-decoration: underline;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <div class="wrap toolbar-in">
        <label class="search">
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M10.68 11.74a6 6 0 01-7.922-8.982 6 6 0 018.982 7.922l3.04 3.04a.749.749 0 11-1.06 1.06l-3.04-3.04zm-1.06-1.06a4.5 4.5 0 10-6.364-6.364 4.5 4.5 0 006.364 6.364z"
            />
          </svg>
          <input id="search" placeholder="搜索场景" />
        </label>
        <div class="chips" id="chips"></div>
        <div class="toolbar-right">
          <span id="report-time"></span>
          <span id="report-duration"></span>
        </div>
      </div>
    </div>

    <main class="wrap" id="view"></main>
    <div class="lightbox" id="lightbox"><img alt="" id="lightbox-img" /></div>

    <script>
      const DATA = ${payload};
      const STATUS_TEXT = { passed: '通过', failed: '失败', skipped: '跳过' }
      const ICON = {
        passed:
          '<svg class="icon icon-ok" viewBox="0 0 16 16"><path fill="currentColor" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>',
        failed:
          '<svg class="icon icon-bad" viewBox="0 0 16 16"><path fill="currentColor" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>',
        skipped:
          '<svg class="icon icon-skip" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.4 11.6l7.2-7.2" stroke="currentColor" stroke-width="1.6"/></svg>'
      }
      const CARET =
        '<svg class="caret" viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M4.5 6l3.5 3.5L11.5 6"/></svg>'
      const ERR_LABEL = {
        console: '控制台报错',
        http: '接口报错',
        assert: '断言不符',
        script: '脚本异常'
      }

      const ALL = DATA.scenarios || []
      const state = { filter: 'all', keyword: '', collapsed: new Set(), current: null }

      /* 业务域 → 分支 → 场景：场景在数据里已按业务域顺序与文件行号排序 */
      const GROUPS = []
      const DOMAIN_INDEX = new Map()
      for (const scenario of ALL) {
        const domainName = scenario.domain || '未归类场景'
        if (!DOMAIN_INDEX.has(domainName)) {
          DOMAIN_INDEX.set(domainName, GROUPS.length)
          GROUPS.push({ name: domainName, branches: [], branchIndex: new Map() })
        }
        const domain = GROUPS[DOMAIN_INDEX.get(domainName)]
        const branchName = scenario.branch || '未分类分支'
        if (!domain.branchIndex.has(branchName)) {
          domain.branchIndex.set(branchName, domain.branches.length)
          domain.branches.push({ name: branchName, scenarios: [] })
        }
        domain.branches[domain.branchIndex.get(branchName)].scenarios.push(scenario)
      }

      function esc(value) {
        return String(value === null || value === undefined ? '' : value).replace(
          /[&<>"]/g,
          function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
          }
        )
      }
      function fmtDuration(ms, status) {
        if (status === 'skipped') return '—'
        return (Number(ms || 0) / 1000).toFixed(1) + 's'
      }
      function fmtTime(iso) {
        const date = new Date(iso)
        if (Number.isNaN(date.getTime())) return ''
        const pad = function (n) {
          return String(n).padStart(2, '0')
        }
        return (
          date.getFullYear() +
          '/' +
          pad(date.getMonth() + 1) +
          '/' +
          pad(date.getDate()) +
          ' ' +
          pad(date.getHours()) +
          ':' +
          pad(date.getMinutes())
        )
      }
      function fileLine(scenario) {
        if (!scenario.file) return ''
        return esc(scenario.file) + (scenario.line ? ':' + scenario.line : '')
      }

      function primClass(value) {
        if (value === null) return 'jn-null'
        if (typeof value === 'string') return 'jn-str'
        if (typeof value === 'number') return 'jn-num'
        return 'jn-bool'
      }
      function primText(value) {
        if (value === null) return 'null'
        if (typeof value === 'string') return JSON.stringify(value)
        return String(value)
      }
      function jsonNode(key, value) {
        const keyHtml =
          key === null
            ? ''
            : '<span class="jn-key">' + esc(key) + '</span><span class="jn-colon">: </span>'
        if (value && typeof value === 'object') {
          const isArray = Array.isArray(value)
          const size = isArray ? value.length : Object.keys(value).length
          const summary = isArray ? '[…] ' + size + ' 项' : '{…} ' + size + ' 个字段'
          let html =
            '<div class="jn jn-container"><div class="jn-row"><span class="jn-caret">▶</span>' +
            keyHtml +
            '<span class="jn-summary">' +
            summary +
            '</span></div><div class="jn-children" hidden>'
          const entries = isArray ? value.map(function (item, index) {
            return [String(index), item]
          }) : Object.entries(value)
          for (const entry of entries) html += jsonNode(isArray ? entry[0] : entry[0], entry[1])
          html += '</div></div>'
          return html
        }
        return (
          '<div class="jn"><div class="jn-row"><span class="jn-caret jn-caret-empty">▶</span>' +
          keyHtml +
          '<span class="' +
          primClass(value) +
          '">' +
          esc(primText(value)) +
          '</span></div></div>'
        )
      }
      function jsonTreeHtml(value) {
        return (
          '<div class="json" data-raw="' +
          encodeURIComponent(JSON.stringify(value, null, 2)) +
          '">' +
          jsonNode(null, value) +
          '</div>'
        )
      }
      function blockHtml(block) {
        if (block.text !== undefined) {
          return (
            '<div class="ev ev-' +
            block.kind +
            '"><div class="ev-label">' +
            esc(block.label) +
            '</div><pre>' +
            esc(block.text) +
            '</pre></div>'
          )
        }
        const meta = (block.meta || [])
          .map(function (line) {
            return '<div class="ev-meta">' + esc(line) + '</div>'
          })
          .join('')
        const json =
          block.body === undefined
            ? ''
            : '<div class="ev-json"><div class="ev-tools"><button class="mini" data-copy-json>复制</button>' +
              '<button class="mini" data-expand-all>全部展开</button></div>' +
              jsonTreeHtml(block.body) +
              '</div>'
        return (
          '<div class="ev ev-' +
          block.kind +
          '"><div class="ev-label">' +
          esc(block.label) +
          '</div><div class="ev-body-cell">' +
          meta +
          json +
          '</div></div>'
        )
      }
      function errHtml(error) {
        return (
          '<div class="err"><div class="err-head"><span class="err-tag ' +
          esc(error.category) +
          '">' +
          esc(ERR_LABEL[error.category] || '执行异常') +
          '</span><span class="err-summary">' +
          esc(error.summary) +
          '</span></div><div class="err-body">' +
          (error.blocks || []).map(blockHtml).join('') +
          '</div></div>'
        )
      }

      function stepHtml(scenario, step) {
        const fail = scenario.status === 'failed' && scenario.failedStepIndex === step.index
        let html =
          '<div class="step' +
          (fail ? ' fail' : '') +
          '"><div class="step-line"><span class="step-idx">' +
          esc(step.index) +
          '</span><span class="step-text">' +
          esc(step.text) +
          '</span></div>'
        if (step.image) {
          html +=
            '<div class="shot"><img src="' +
            esc(step.image) +
            '" alt="步骤 ' +
            esc(step.index) +
            ' 截图" loading="lazy" />'
          if (fail && scenario.mark) {
            const mark = scenario.mark
            html +=
              '<div class="mark" style="left:' +
              mark.l +
              '%;top:' +
              mark.t +
              '%;width:' +
              mark.w +
              '%;height:' +
              mark.h +
              '%"><span class="mark-label">问题位置</span></div>'
          }
          html += '</div>'
        }
        if (fail && scenario.error) html += errHtml(scenario.error)
        html += '</div>'
        return html
      }
      function stepsBody(scenario) {
        const failStep =
          scenario.status === 'failed'
            ? scenario.steps.find(function (step) {
                return step.index === scenario.failedStepIndex
              })
            : null
        let html = ''
        if (scenario.status === 'failed' && !failStep && scenario.error) {
          html += '<div class="err-top">' + errHtml(scenario.error) + '</div>'
        }
        if (scenario.steps.length) {
          html += scenario.steps.map(function (step) {
            return stepHtml(scenario, step)
          }).join('')
        } else if (scenario.status === 'skipped') {
          html += '<div class="empty">本次未执行</div>'
        } else if (!(scenario.status === 'failed' && !failStep)) {
          html += '<div class="empty">本场景没有登记操作步骤</div>'
        }
        return html
      }

      const counts = function () {
        return {
          all: ALL.length,
          passed: ALL.filter(function (item) {
            return item.status === 'passed'
          }).length,
          failed: ALL.filter(function (item) {
            return item.status === 'failed'
          }).length,
          skipped: ALL.filter(function (item) {
            return item.status === 'skipped'
          }).length
        }
      }
      function visible(scenario) {
        const keyword = state.keyword.trim().toLowerCase()
        const byStatus = state.filter === 'all' || scenario.status === state.filter
        const byKeyword =
          !keyword || String(scenario.title || '').toLowerCase().indexOf(keyword) !== -1
        return byStatus && byKeyword
      }
      function ownerOf(id) {
        for (const domain of GROUPS) {
          for (const branch of domain.branches) {
            const scenario = branch.scenarios.find(function (item) {
              return item.id === id
            })
            if (scenario) return { domain: domain, branch: branch, scenario: scenario }
          }
        }
        return null
      }

      function renderChips() {
        const c = counts()
        const items = [
          ['all', '全部', c.all, ''],
          ['passed', '通过', c.passed, ICON.passed],
          ['failed', '失败', c.failed, ICON.failed],
          ['skipped', '跳过', c.skipped, ICON.skipped]
        ]
        document.getElementById('chips').innerHTML = items
          .map(function (item) {
            return (
              '<div class="chip' +
              (state.filter === item[0] ? ' on' : '') +
              '" data-filter="' +
              item[0] +
              '">' +
              item[3] +
              '<span>' +
              item[1] +
              '</span><span class="num">' +
              item[2] +
              '</span></div>'
            )
          })
          .join('')
      }

      function renderList() {
        let html = ''
        for (const domain of GROUPS) {
          const shown = domain.branches
            .reduce(function (list, branch) {
              return list.concat(branch.scenarios)
            }, [])
            .filter(visible)
          if (!shown.length) continue
          const dkey = 'd:' + domain.name
          html +=
            '<div class="group' +
            (state.collapsed.has(dkey) ? ' is-collapsed' : '') +
            '"><div class="group-head" data-toggle="' +
            esc(dkey) +
            '">' +
            CARET +
            '<span>' +
            esc(domain.name) +
            '</span></div><div class="group-body">'
          for (const branch of domain.branches) {
            const branchShown = branch.scenarios.filter(visible)
            if (!branchShown.length) continue
            const bkey = dkey + '/' + branch.name
            html +=
              '<div class="branch' +
              (state.collapsed.has(bkey) ? ' is-collapsed' : '') +
              '"><div class="branch-head" data-toggle="' +
              esc(bkey) +
              '">' +
              CARET +
              '<span>' +
              esc(branch.name) +
              '</span></div><div class="branch-body">'
            html += branchShown
              .map(function (scenario) {
                return (
                  '<div class="row" data-id="' +
                  esc(scenario.id) +
                  '">' +
                  ICON[scenario.status] +
                  '<div class="row-main"><div class="row-title">' +
                  (scenario.caseId ? '<span class="row-id">' + esc(scenario.caseId) + '</span>' : '') +
                  esc(scenario.title) +
                  '</div><div class="row-path">' +
                  fileLine(scenario) +
                  '</div></div><span class="row-dur">' +
                  fmtDuration(scenario.durationMs, scenario.status) +
                  '</span></div>'
                )
              })
              .join('')
            html += '</div></div>'
          }
          html += '</div></div>'
        }
        document.getElementById('view').innerHTML =
          html || '<div class="empty">没有匹配的场景</div>'
      }

      function renderDetail(entry) {
        const domain = entry.domain
        const branch = entry.branch
        const scenario = entry.scenario
        document.getElementById('view').innerHTML =
          '<div class="back" id="back">← 返回场景列表</div>' +
          '<div class="crumb" style="margin-top:8px">' +
          esc(domain.name) +
          ' / ' +
          esc(branch.name) +
          '</div>' +
          '<h1>' +
          esc(scenario.title) +
          '</h1>' +
          '<div class="detail-meta"><span>' +
          fileLine(scenario) +
          '</span><span class="dur">' +
          fmtDuration(scenario.durationMs, scenario.status) +
          '</span></div>' +
          '<div class="tabs"><div class="tab on">' +
          ICON[scenario.status] +
          '<span>' +
          STATUS_TEXT[scenario.status] +
          '</span></div></div>' +
          '<div class="card"><div class="card-head">' +
          CARET +
          '<span>操作步骤</span></div><div class="card-body">' +
          stepsBody(scenario) +
          '</div></div>'
      }

      function render() {
        renderChips()
        if (state.current) {
          const entry = ownerOf(state.current)
          if (entry) renderDetail(entry)
          else {
            state.current = null
            renderList()
          }
        } else {
          renderList()
        }
      }

      document.getElementById('report-time').textContent = fmtTime(DATA.generatedAt)
      document.getElementById('report-duration').textContent =
        '总耗时 ' + fmtDuration(DATA.durationMs, 'passed')

      document.getElementById('chips').addEventListener('click', function (event) {
        const chip = event.target.closest('.chip')
        if (!chip) return
        state.filter = chip.dataset.filter
        state.current = null
        render()
      })
      document.getElementById('search').addEventListener('input', function (event) {
        state.keyword = event.target.value
        state.current = null
        render()
      })
      document.getElementById('view').addEventListener('click', function (event) {
        const toggle = event.target.closest('[data-toggle]')
        if (toggle) {
          const key = toggle.dataset.toggle
          if (state.collapsed.has(key)) state.collapsed.delete(key)
          else state.collapsed.add(key)
          render()
          return
        }
        if (event.target.closest('#back')) {
          state.current = null
          render()
          return
        }
        const row = event.target.closest('.row')
        if (row) {
          state.current = row.dataset.id
          render()
          window.scrollTo(0, 0)
          return
        }
        if (event.target.tagName === 'IMG' && event.target.closest('.step')) {
          document.getElementById('lightbox-img').src = event.target.src
          document.getElementById('lightbox').classList.add('show')
        }
      })

      function fallbackCopy(text, done) {
        const area = document.createElement('textarea')
        area.value = text
        document.body.appendChild(area)
        area.select()
        try {
          document.execCommand('copy')
          done()
        } catch (error) {
          /* 忽略复制失败 */
        }
        document.body.removeChild(area)
      }
      function copyText(text, button) {
        const done = function () {
          button.textContent = '已复制'
          setTimeout(function () {
            button.textContent = '复制'
          }, 1200)
        }
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(done, function () {
            fallbackCopy(text, done)
          })
        } else {
          fallbackCopy(text, done)
        }
      }
      document.addEventListener('click', function (event) {
        const row = event.target.closest('.jn-container > .jn-row')
        if (row) {
          const box = row.parentElement
          const open = box.classList.toggle('open')
          box.querySelector(':scope > .jn-children').hidden = !open
          return
        }
        const copyButton = event.target.closest('[data-copy-json]')
        if (copyButton) {
          const cell = copyButton.closest('.ev-json').querySelector('.json')
          copyText(decodeURIComponent(cell.dataset.raw || ''), copyButton)
          return
        }
        const expandButton = event.target.closest('[data-expand-all]')
        if (expandButton) {
          expandButton
            .closest('.ev-json')
            .querySelectorAll('.jn-container')
            .forEach(function (box) {
              box.classList.add('open')
              const children = box.querySelector(':scope > .jn-children')
              if (children) children.hidden = false
            })
        }
      })

      document.getElementById('lightbox').addEventListener('click', function () {
        document.getElementById('lightbox').classList.remove('show')
      })
      render()
    </script>
  </body>
</html>`
}
