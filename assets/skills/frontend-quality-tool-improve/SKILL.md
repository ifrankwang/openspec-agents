---
name: frontend-quality-tool-improve
description: 前端工具规则改进指南。把可工具化的前端代码坏味道转成具体的 ESLint 自定义规则 / dependency-cruiser 规则 / size-limit 预算 / Vitest 覆盖率阈值草案。仅在 Vue / React 前端项目使用。
capabilities: ["tool-improvement"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

## 识别可工具化 pattern

以下信号表明一个问题可以沉淀为规则，避免每轮人工审查：

| 信号 | 示例 | 对应工具 |
|------|------|---------|
| 分层/依赖方向违规 | 组件 import 页面；api 层 import store；循环依赖 | dependency-cruiser |
| 跨 feature 直引内部文件 | `@/features/order/api/internal` 被别的 feature 引用 | dependency-cruiser |
| 特定 API 禁用 | 业务代码直接 `fetch` / `new XMLHttpRequest`；`localStorage.setItem` 存 token | ESLint `no-restricted-*` |
| 特定写法禁用 | `v-html` 渲染用户内容；`innerHTML` 直接赋值；`eval` | ESLint 插件规则或自定义规则 |
| 类型约束 | `any` 泛滥、`@ts-ignore` 滥用 | `@typescript-eslint` 规则 |
| 文件/组件规模 | 组件文件超 300 行、函数超 80 行 | ESLint `max-lines` / `max-lines-per-function` |
| 命名/路径约定 | 组件文件非 PascalCase、composable 未用 `use` 前缀 | ESLint `filenames` 插件或自定义规则 |
| 重复代码 | 跨文件复制粘贴 | `jscpd` |
| 体积回归 | 首屏 chunk 超预算 | size-limit |
| 覆盖率回落 | 核心模块覆盖率低于阈值 | Vitest coverage thresholds |
| 格式化 | 缩进/引号/换行不一致 | Prettier |

## ESLint 规则草案模板

### 优先用内置能力（低成本、无维护）

```js
// eslint.config.js（Flat Config）片段
export default [
  {
    files: ['src/**/*.{ts,tsx,vue}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/features/*/internal/*'], message: '跨 feature 禁止引用内部实现，请走该 feature 的 index.ts' }
        ]
      }],
      'no-restricted-properties': ['error', {
        object: 'localStorage',
        property: 'setItem',
        message: '禁止用 localStorage 存敏感信息；会话走 httpOnly cookie'
      }],
      'no-restricted-globals': ['error', { name: 'fetch', message: '禁止直接 fetch，请用统一请求封装 src/api/http' }],
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }]
    }
  }
]
```

- 路径别名（`@/` 或项目自定义）先 read `tsconfig.json` 的 `paths` 确认，禁止凭想象写规则
- Vue 文件规则需带 `.vue` 扩展处理（flat config 里配置 vue parser），否则规则对 SFC 不生效
- 存量违规多时先用 `warn` 过渡，登记转 `error` 的目标与时间；长期 `warn` 视为规则未落地

### 需要 AST 判断时写自定义规则

规则文件位置：先在项目里探测既有本地规则目录（`eslint-rules/`、`eslint-plugin-local/`、`tools/eslint/`），沿用既有约定；确实没有时新建 `eslint-rules/`。

```js
// eslint-rules/no-raw-fetch.js
/** 禁止绕过统一请求封装直接调用 fetch（拦截器、token、错误归一都会失效） */
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: '禁止直接调用 fetch' },
    schema: [],
    messages: { rawFetch: '禁止直接调用 fetch，请使用统一请求封装（src/api/http）' }
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type === 'Identifier' && callee.name === 'fetch') {
          context.report({ node, messageId: 'rawFetch' })
        }
      }
    }
  }
}
```

- 注册（Flat Config）：

```js
import noRawFetch from './eslint-rules/no-raw-fetch.js'
export default [{
  files: ['src/**/*.{ts,tsx,vue}'],
  plugins: { local: { rules: { 'no-raw-fetch': noRawFetch } } },
  rules: { 'local/no-raw-fetch': 'error' }
}]
```

- 给自定义规则配 `RuleTester` 单测（合法样例 + 违规样例各至少 2 条），随规则一起提交
- 验证命令：`pnpm exec eslint src --format json`；期望命中数写入交付说明
- 误报处理：先 `--format json` 统计命中文件清单人工核对，通过规则内边界判断收窄；禁止直接加 `eslint-disable` 或扩大 `ignorePatterns`

## dependency-cruiser 规则草案模板

规则文件 `.dependency-cruiser.cjs`；新增规则追加在 `forbidden` 数组内：

```js
{
  name: 'no-raw-fetch-in-store',
  severity: 'error',
  comment: 'store 内只允许经 api 层取数，禁止直接发请求',
  from: { path: '^src/(stores|features/[^/]+/stores)/' },
  to: { path: '^(src/api/http|src/utils/http)', dependencyTypes: ['local'] }
}
```

- 规则命名 kebab-case，`comment` 写业务理由；`severity` 用 `error`（分层/循环类必须 error），过渡期规则可用 `warn` 并登记清理计划
- 路径正则先对照项目真实目录（`src/features` / `src/modules` / `src/views`），禁止套用与项目不符的模板
- 验证：

```bash
pnpm exec depcruise src --config .dependency-cruiser.cjs --output-type json > depcruise.json
node -e "const s=require('./depcruise.json').summary; console.log(s)"
pnpm exec depcruise src --config .dependency-cruiser.cjs --output-type err
```

- 先核对误报：新规则在现状上跑一遍，列出命中清单，确认每条都是真问题后再启用

## size-limit 预算规则

```json
[
  { "name": "首屏 JS", "path": "dist/assets/index-*.js", "limit": "200 kB", "gzip": true },
  { "name": "样式", "path": "dist/assets/index-*.css", "limit": "60 kB", "gzip": true }
]
```

- 验证：`pnpm exec size-limit`；预算调整（上调/排除文件）须附理由与目标值，按配置削弱口径审查
- 新增页面按异步 chunk 单独设预算，避免页面膨胀被首屏预算掩盖

## Vitest 覆盖率阈值规则

```ts
// vitest.config.ts 片段
coverage: {
  reporter: ['text', 'lcov', 'json-summary'],
  thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 }
}
```

- 核心模块用按目录 override 提高阈值，不以整体阈值掩盖核心逻辑未覆盖
- 验证：`pnpm exec vitest run --coverage`；禁止用 `coverage.exclude` 把业务文件移出统计

## 规则落地原则

- 先实测：在现状代码上运行，统计命中数与误报；误报未清零不合并
- 渐进落地：存量违规多时先 `warn` 或按目录白名单，登记转 `error` 的目标与时间
- 不得用 ignore/exclude 扩大豁免；豁免须逐条理由，且不覆盖安全类规则
- 规则草案交付内容：文件路径、规则正文、验证命令、预期命中数、误报评估结论
