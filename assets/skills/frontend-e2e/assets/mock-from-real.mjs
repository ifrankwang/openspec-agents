#!/usr/bin/env node
/**
 * 把真实接口响应转成 fixture + 溯源文件（零依赖，Node >= 18）。
 *
 *   node mock-from-real.mjs --url /api/orders --base-url "$BASE_URL" \
 *     --token-env TOKEN --source-type local --out src/mocks/fixtures/orders.json
 *   node mock-from-real.mjs --response saved.json --url /api/orders \
 *     --source-type test --out out.json
 *
 * 只做三件事：按路径脱敏/冻结易变值、按原类型冻结、写 <名称>.source.json 溯源。
 * 不改字段名、层级与类型，不落盘任何请求头。
 *
 * --response 离线模式下 --url 只用于记录接口路径、不发起请求；不传则溯源里的
 * api.path 为空（脚本会打提示，不阻断）。任一 --scrub / --freeze 路径未命中
 * 任何字段时退出码 2，且不写任何文件，避免溯源谎称已脱敏。
 */
import fs from 'node:fs'
import path from 'node:path'

const HELP = `用法：
  node mock-from-real.mjs (--url <路径> [--base-url <地址>] | --response <文件>) --source-type <local|test|contract> [选项]

输入（二选一，同时给出时 --response 优先、--url 只用于记录接口路径）：
  --url <路径>          联网取数，如 /api/orders
  --response <文件>     读取已保存的响应 JSON（离线，不联网）
                        兼容 {status,headers,body} / {responseBody} / 裸响应体
                        离线模式要记录接口路径时同时传 --url /api/xxx（只用于记
                        路径，不发起请求）；不传则溯源 api.path 为空

取数选项（--url 模式）：
  --base-url <地址>     服务地址，缺省读 MOCK_SOURCE_BASE_URL
  --method <方法>       HTTP 方法，默认 GET
  --token-env <变量名>  从该环境变量取 token，加 Authorization: Bearer
  --header "k: v"       附加请求头，可重复
  请求超时 15 秒，超时按请求失败处理（退出码 3）

输出：
  --out <文件>          fixture 路径；.ts 结尾输出 export default，否则格式化 JSON
                        缺省按 url 末段推导为 src/mocks/fixtures/<名称>.json
  --captured-at <ISO>   覆盖溯源里的取数时间（默认当前时间）
  --dry-run             只打印转换结果，不写文件
  --help                打印本用法

替换选项（按路径，支持 data.records[].id 这种数组通配，可重复；
命中对象或数组时按原结构递归处理）：
  --scrub <路径>        按原类型替换：字符串 "***"、数字 0、布尔 false、null 保持
  --freeze <路径>       按原类型冻结，同一次 freeze 内共享递增计数器保唯一：
                        ISO 时间 → 2020-01-01T00:00:00.000Z，纯日期 → 2020-01-01，
                        纯数字串 → 同长度零填充的递增编号（"1001" → "0001"），
                        数字 → 递增编号 1、2、3…，其他字符串 → FIXED-001 递增，
                        null / 布尔保持不变
  未命中任何字段的路径视为参数错误：退出码 2，不写任何文件

溯源与安全：
  --source-type <值>    必填，数据来源分级（local 本地 / test 测试环境 / contract 契约定义）；
                        contract 档在溯源 source 里自动写 unverified: true（契约未验证来源）
  --env <标识>          环境标识，缺省读 MOCK_SOURCE_ENV，再缺省取 --source-type
  <名称>.source.json    与 fixture 同目录，含接口、来源、取数时间、替换清单、脱敏原文

退出码：0 成功，2 参数错误，3 读取/解析/请求失败。
`

const argv = process.argv.slice(2)
const opts = {
  url: '',
  response: '',
  baseUrl: '',
  method: 'GET',
  tokenEnv: '',
  headers: [],
  out: '',
  capturedAt: '',
  sourceType: '',
  env: '',
  scrub: [],
  freeze: [],
  dryRun: false
}

function fail(message, code) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  const value = () => {
    const found = argv[i + 1]
    if (found === undefined || found.startsWith('--')) fail(`参数 ${arg} 缺少值`, 2)
    i += 1
    return found
  }
  switch (arg) {
    case '--url': opts.url = value(); break
    case '--response': opts.response = value(); break
    case '--base-url': opts.baseUrl = value(); break
    case '--method': opts.method = value().toUpperCase(); break
    case '--token-env': opts.tokenEnv = value(); break
    case '--header': opts.headers.push(value()); break
    case '--out': opts.out = value(); break
    case '--captured-at': opts.capturedAt = value(); break
    case '--source-type': opts.sourceType = value(); break
    case '--env': opts.env = value(); break
    case '--scrub': opts.scrub.push(value()); break
    case '--freeze': opts.freeze.push(value()); break
    case '--dry-run': opts.dryRun = true; break
    case '--help': case '-h': process.stdout.write(HELP); process.exit(0); break
    default: fail(`未知参数：${arg}（--help 查看用法）`, 2)
  }
}

const SOURCE_TYPES = ['local', 'test', 'contract']
if (!SOURCE_TYPES.includes(opts.sourceType)) {
  fail(`--source-type 必填且只能是 ${SOURCE_TYPES.join(' / ')}，当前：${opts.sourceType || '(空)'}`, 2)
}
if (!opts.url && !opts.response) fail('需要 --url 或 --response 之一', 2)
if (opts.response && !opts.out) fail('--response 模式必须指定 --out（无法推导文件名）', 2)
if (opts.url && !opts.response && !opts.out) opts.out = defaultOut(opts.url)
if (!opts.out) fail('无法推导 --out，请显式指定', 2)

const capturedAt = opts.capturedAt || new Date().toISOString()
const envLabel = opts.env || process.env.MOCK_SOURCE_ENV || opts.sourceType
const apiPath = opts.url ? stripQuery(opts.url) : ''
if (opts.response && !opts.url) {
  process.stderr.write('提示：未记录接口路径，建议同时传 --url /api/xxx（只用于记路径，不发起请求）\n')
}

// --- 路径处理 ---------------------------------------------------------------

function stripQuery(target) {
  const cut = target.indexOf('?')
  return cut >= 0 ? target.slice(0, cut) : target
}

function defaultOut(target) {
  const segments = stripQuery(target).split('/').filter(Boolean)
  const last = segments.length ? segments[segments.length - 1] : 'fixture'
  const slug = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'fixture'
  return path.join('src/mocks/fixtures', `${slug}.json`)
}

function parseSegments(target) {
  return target
    .split('.')
    .filter((part) => part.length > 0)
    .map((part) => {
      const each = part.endsWith('[]')
      return { key: each ? part.slice(0, -2) : part, each }
    })
}

function findTargets(node, segments, out = []) {
  if (node === null || typeof node !== 'object' || segments.length === 0) return out
  const [segment, ...rest] = segments
  const child = node[segment.key]
  if (child === undefined) return out
  if (segment.each) {
    if (!Array.isArray(child)) return out
    for (let index = 0; index < child.length; index += 1) {
      if (rest.length === 0) out.push({ parent: child, key: index })
      else findTargets(child[index], rest, out)
    }
  } else if (rest.length === 0) {
    out.push({ parent: node, key: segment.key })
  } else {
    findTargets(child, rest, out)
  }
  return out
}

function scrubValue(value) {
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value !== null && typeof value === 'object') {
    const scrubbed = {}
    for (const key of Object.keys(value)) scrubbed[key] = scrubValue(value[key])
    return scrubbed
  }
  if (typeof value === 'string') return '***'
  if (typeof value === 'number') return 0
  if (typeof value === 'boolean') return false
  return null
}

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}$/

function freezeValue(value, counter) {
  if (Array.isArray(value)) return value.map((item) => freezeValue(item, counter))
  if (value !== null && typeof value === 'object') {
    const frozen = {}
    for (const key of Object.keys(value)) frozen[key] = freezeValue(value[key], counter)
    return frozen
  }
  if (typeof value === 'number') {
    counter.count += 1
    return counter.count
  }
  if (typeof value === 'string') {
    if (ISO_LIKE.test(value)) return '2020-01-01T00:00:00.000Z'
    if (DATE_LIKE.test(value)) return '2020-01-01'
    counter.count += 1
    if (/^\d+$/.test(value)) return String(counter.count).padStart(value.length, '0')
    return `FIXED-${String(counter.count).padStart(3, '0')}`
  }
  return value
}

// --- 读取响应 ---------------------------------------------------------------

function unwrapResponse(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { body: parsed }
  if ('responseBody' in parsed) return { body: parsed.responseBody }
  if ('body' in parsed && ('status' in parsed || 'headers' in parsed)) return { body: parsed.body }
  return { body: parsed }
}

async function loadResponse() {
  if (opts.response) {
    let raw
    try {
      raw = fs.readFileSync(opts.response, 'utf8')
    } catch (error) {
      fail(`读取响应文件失败：${opts.response}（${error.message}）`, 3)
    }
    try {
      return unwrapResponse(JSON.parse(raw)).body
    } catch (error) {
      fail(`解析响应文件失败：${opts.response}（${error.message}）`, 3)
    }
  }
  const baseUrl = opts.baseUrl || process.env.MOCK_SOURCE_BASE_URL
  if (!baseUrl) fail('--url 模式需要 --base-url 或环境变量 MOCK_SOURCE_BASE_URL', 2)
  const headers = {}
  for (const raw of opts.headers) {
    const cut = raw.indexOf(':')
    if (cut <= 0) fail(`--header 格式应为 "k: v"，当前：${raw}`, 2)
    headers[raw.slice(0, cut).trim()] = raw.slice(cut + 1).trim()
  }
  if (opts.tokenEnv) {
    const token = process.env[opts.tokenEnv]
    if (!token) fail(`环境变量 ${opts.tokenEnv} 为空，无法取 token`, 2)
    headers.Authorization = `Bearer ${token}`
  }
  const url = `${baseUrl.replace(/\/+$/, '')}${opts.url.startsWith('/') ? '' : '/'}${opts.url}`
  let response
  try {
    response = await fetch(url, { method: opts.method, headers, signal: AbortSignal.timeout(15000) })
  } catch (error) {
    fail(`请求失败：${url}（${error.message}）`, 3)
  }
  const text = await response.text()
  if (!response.ok) fail(`接口返回 ${response.status}：${url}\n${text.slice(0, 500)}`, 3)
  try {
    return text ? JSON.parse(text) : null
  } catch (error) {
    fail(`解析接口响应失败：${url}（${error.message}）`, 3)
  }
}

// --- 转换与输出 -------------------------------------------------------------

const body = await loadResponse()
if (body === null || body === undefined) fail('响应体为空，无法生成 fixture', 3)

const replacements = []
const missed = []
for (const target of opts.scrub) {
  const spots = findTargets(body, parseSegments(target))
  if (spots.length === 0) {
    missed.push(`--scrub ${target}`)
    continue
  }
  for (const spot of spots) {
    spot.parent[spot.key] = scrubValue(spot.parent[spot.key])
  }
  replacements.push({ path: target, rule: 'scrub' })
}
for (const target of opts.freeze) {
  const spots = findTargets(body, parseSegments(target))
  if (spots.length === 0) {
    missed.push(`--freeze ${target}`)
    continue
  }
  const counter = { count: 0 }
  for (const spot of spots) {
    spot.parent[spot.key] = freezeValue(spot.parent[spot.key], counter)
  }
  replacements.push({ path: target, rule: 'freeze' })
}
if (missed.length > 0) {
  fail(
    `以下替换路径未命中任何字段，未写入任何文件：\n${missed.map((each) => `  ${each}`).join('\n')}\n` +
      '确认真实响应结构后修正路径，或删掉该参数（避免溯源谎称已脱敏/冻结）',
    2
  )
}

const source = { type: opts.sourceType, env: envLabel, capturedAt }
// 契约定义档拿不到真实响应，溯源必须能自证「未验证来源」；其余两档不写该字段。
if (opts.sourceType === 'contract') source.unverified = true

const provenance = {
  api: { method: opts.method, path: apiPath },
  source,
  replacements,
  response: body
}

const json = JSON.stringify(body, null, 2)
const fixtureText = opts.out.endsWith('.ts') ? `export default ${json}\n` : `${json}\n`
const sourcePath = path.join(
  path.dirname(opts.out),
  `${path.basename(opts.out, path.extname(opts.out))}.source.json`
)
const sourceText = `${JSON.stringify(provenance, null, 2)}\n`

if (opts.dryRun) {
  process.stdout.write(`# ${opts.out}\n${fixtureText}`)
  process.stdout.write(`# ${sourcePath}\n${sourceText}`)
} else {
  try {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true })
    fs.writeFileSync(opts.out, fixtureText)
    fs.writeFileSync(sourcePath, sourceText)
  } catch (error) {
    fail(`写入失败：${error.message}`, 3)
  }
  process.stdout.write(`已写入：${opts.out}\n已写入：${sourcePath}\n`)
}
