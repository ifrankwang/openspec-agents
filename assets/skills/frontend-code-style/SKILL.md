---
name: frontend-code-style
description: 前端代码风格规范——Prettier 格式化、ESLint 规则、组件/文件/目录命名约定、Vue 与 React 写法约定、.gitignore 必须项、可访问性基线、响应式基线、设计系统与组件库治理。仅在 Vue / React 前端项目使用。
capabilities: ["style"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本文列出**最低审查基线**，不限于所列维度。AI 审查时必须结合自身前端代码风格知识做拓展覆盖，下列任何可能遗漏的风格维度均须纳入审查。

## 格式化工具

- Prettier 是唯一格式化来源；ESLint 只负责代码质量与正确性，风格类规则交给 Prettier
- 必须启用 eslint-config-prettier（或等价方式）关闭与 Prettier 冲突的 ESLint 规则
- 格式化：提交前 `pnpm exec prettier --write --ignore-unknown .`；检查：`pnpm exec prettier --check --ignore-unknown .`
- 推荐配置（项目已有 `.prettierrc` 以其为准）：`printWidth: 100`、`singleQuote: true`、`semi: false`、`trailingComma: "all"`、`arrowParens: "always"`
- 格式分歧改配置而不是逐文件手工调整；禁止在代码里用 `prettier-ignore` 规避正常格式化（特殊排版除外，且须有理由）

## 样式管理标准化

- 组件样式主方案全项目唯一：scoped SFC / CSS Modules / utility-first 之一，或项目已选定的等价方案；并存多套样式方案按技术债口径处理
- 设计令牌单一来源：颜色、间距、圆角、字号、阴影以 CSS variables（或所选 utility 方案的 theme 配置）集中声明，组件样式引用令牌；禁止业务样式硬编码魔法值 → Medium
- 例外（不强制走令牌）：SVG 图形/图标内部样式、图表库配置与数据可视化色板、第三方组件样式覆盖、一次性动效的关键帧/缓动值；业务布局、间距与主题相关样式仍必须用令牌，新增可复用颜色/间距应沉淀为令牌而非就地硬编码
- 全局样式只承载三类：reset、令牌声明、少量工具类；组件样式一律走主方案的隔离机制（scoped / module / utility 前缀），禁止全局裸类名承载组件样式（与命名约定章节的 BEM 条目衔接，同文件内不算双源）
- 禁止行内样式承载布局与视觉，动态主题计算除外 → Medium

## 可访问性基线

以下为无需额外工具即可核对的最低基线，可参照 WCAG AA 的常用判据；项目的合规等级由项目规范确定，与本基线不一致时以项目规范为准。

- 语义化标签优先：可点击操作用 `button`，导航跳转用 `a`，表单控件用 `input` / `select` / `textarea`；禁止用 `div` / `span` 绑点击事件冒充交互控件 → Medium
- 图片必须有 `alt`：承载信息的图片给出描述性 `alt`，纯装饰图显式写 `alt=""`；禁止省略 `alt` 属性 → Medium
- 表单控件必须有可见 `label`（`<label for>` 或包裹式），确无可见标签时用 `aria-label` / `aria-labelledby`；禁止只用 placeholder 充当标签（输入后即消失）→ Medium
- 键盘可达：所有交互元素可 Tab 到达、Enter / Space 触发、`Esc` 关闭浮层；禁止正数 `tabindex` 打乱文档顺序，禁止用 `outline: none` 之外的手段移除原生可聚焦性 → Medium
- 焦点样式不得被抹掉：禁止无条件 `outline: none`；如需自定义焦点样式，须提供对比度足够、与原样式可区分的替代方案 → High（键盘用户失去位置感，无法操作）
- 颜色不得作为唯一信息载体：错误态、必填态、状态标签除颜色外须同时有文字或图标 → Medium
- 动态更新区域需可被读屏感知：异步结果、校验错误、浮层出现使用 `aria-live`（`polite` / `assertive`）或等价机制，禁止只靠视觉变化提示 → Medium
- 浮层与弹窗需完成焦点管理：打开时焦点移入浮层，关闭后回到触发元素；`Esc` 可关闭 → 未处理按 Medium
- 每个可交互元素有可编程名称；纯图标按钮必须有 `aria-label` → Medium

## 响应式基线

- 断点集中定义（CSS variables / 主题配置 / 统一 media-query 常量），禁止在业务组件里散落魔法宽度（如 `@media (max-width: 787px)`）→ Medium
- 最小支持宽度须明确（桌面端项目由项目规范定，如 1280px），关键内容在该宽度下不得横向溢出、不得被裁切 → Medium
- 布局不得依赖悬停才能完成主要操作：hover 出现的操作须有可点击的等价入口，触屏与键盘同样可达；把删除、提交等主操作藏在 hover 里 → 至少 Medium
- 容器使用弹性或网格布局、宽度用相对单位，禁止固定像素宽度写死整页；固定尺寸容器须声明溢出策略 → Medium
- 内容长度变化（长文案、大数字、多语言展开后更长的文案）不得撑破布局 → Medium
- 系统缩放到 150% / 200%、窗口尺寸变化时关键操作不被遮挡，不出现重叠与不可点击区域 → Medium

## 设计系统与组件库治理

本节适用于已使用或计划引入统一组件库、且存在设计令牌来源的项目。

- 同一类控件只允许一套实现：按钮、弹窗、表格、表单控件、提示等在全项目只有一个来源（组件库，或项目自建的共享组件层），禁止同一场景并存两套同类控件 → 至少 Medium
- 禁止业务代码绕过组件库自造同类控件：库未覆盖时须先确认无等价能力，新增实现沉淀到共享组件层，禁止在单个页面里就地实现 → Medium
- 同一仓库只允许一个组件库版本，出现第二份（含传递依赖带入）须收敛 → 多版本并存按 Medium
- 组件库升级须先读变更日志的破坏性变更清单，逐个列出受影响控件并评估影响面，给出迁移说明后再升级；主版本升级须有迁移记录 → 仅改版本号而无迁移说明按 Low
- 升级后必须跑类型检查、全量测试与关键页面回归；升级带来的既有用法失效按破坏性变更处理

## ESLint

- 基线：`eslint` + `typescript-eslint` + 框架插件（Vue 用 `eslint-plugin-vue`，React 用 `eslint-plugin-react` / `eslint-plugin-react-hooks`）
- Vue 项目推荐 `plugin:vue/vue3-recommended`（Flat Config 用对应 config）；React 项目开启 hooks 规则
- 检查命令统一走 `pnpm lint`，CI 与本地同口径，启用 `--max-warnings=0`
- 新增 `eslint-disable` 必须有理由注释；整文件禁用视为配置削弱，按质量工具配置检查口径处理
- 规则命名与数量以项目配置为准，不以个人习惯新增互相冲突的规则

## 命名约定

| 对象 | 约定 | 示例 |
|------|------|------|
| 组件文件 | PascalCase（Vue SFC 与 React 组件一致） | `UserProfile.vue`、`UserProfile.tsx` |
| 页面文件 | PascalCase，按路由语义命名 | `OrderDetail.vue` |
| composable / hook | `useXxx.ts`，导出 `useXxx` | `useOrderList.ts` |
| store | `xxx.store.ts`（或 `stores/xxx.ts`），导出 `useXxxStore` | `order.store.ts` |
| 工具函数 | camelCase，动词开头，一个文件一组同类能力 | `formatAmount.ts` |
| 常量 | UPPER_SNAKE_CASE | `MAX_UPLOAD_SIZE` |
| 类型 / 接口 | PascalCase，禁止 `I` 前缀 | `interface OrderQuery` |
| 目录 | kebab-case | `order-detail/`、`shared-ui/` |
| 事件 | 动词过去式，kebab-case（Vue）或 `onXxx`（React 回调 props） | `order-created`、`onOrderCreated` |
| CSS 类 | BEM 或项目约定前缀，禁止全局裸类名 | `.order-card__title` |

- 一个组件文件一个默认导出；工具模块用命名导出
- 组件名与文件名保持一致，禁止 `index.vue` 作为页面组件（失去可检索性）
- `index.ts` 只做再导出，不承载逻辑
- 缩写词大小写统一（`URL` 全大写或 `Url` 全大驼峰，全项目二选一）

## Vue 写法约定

- 新代码用 `<script setup lang="ts">` + Composition API；Options API 仅用于存量维护，不做新功能
- props / emits 用类型声明：`defineProps<Props>()`、`defineEmits<{ (e: 'save', value: Order): void }>()`；禁止运行时数组/对象声明（丢失类型）
- 单文件组件顺序：`<script>` → `<template>` → `<style>`
- 采用 scoped 样式方案时按「样式管理标准化」章节执行；跨组件样式用 `:deep()` 且注明原因，禁止全局样式污染组件
- 模板中避免复杂表达式（多层三元、函数调用链、对象字面量）→ 提取 computed 或脚本常量
- `v-for` 必须带稳定 `key`（业务 id），禁止用数组下标
- `v-html` 仅在渲染经净化的富文本时使用，普通文本禁止用 `v-html` 输出
- 能由现有状态推导的一律用 `computed`，禁止用 `watch` 再维护一份同步状态
- 事件名用 kebab-case，语义用动词过去式；不要用原生事件名做自定义事件

## React 写法约定

- 函数组件 + hooks；禁止新增 class 组件
- 一个文件一个组件（同名文件），props 用 `interface Props` 并在组件签名中显式标注
- hooks 顺序稳定；条件分支中不得跳过 hooks
- 列表 `key` 用业务 id，可重排列表禁止用数组下标
- `useEffect` 依赖完整；数据请求不写在渲染路径；能派生的值用 `useMemo` 之外的普通计算或 `useMemo`（须有依据）
- 事件处理函数命名 `handleXxx`，对外回调 props 命名 `onXxx`
- 条件渲染保持可读：多层嵌套三元改为提前 return 或局部变量/小组件
- 不写 `useEffect` 做 props 到 state 的同步（除非明确的可编辑副本场景）

## 注释与调试残留

- 注释写"为什么"（约束、坑、业务规则来源），不写"做了什么"
- 过期注释随代码删除；禁止保留被注释掉的整段代码
- 允许 `console.warn` / `console.error`；禁止提交 `console.log`（ESLint `no-console` 兜底，构建生产剥离）
- 调试开关、临时断点、本地 mock 数据不得进入提交

## .gitignore 必须项

```
node_modules/
dist/
coverage/
e2e/reports/
*.local
.env.local
.env.*.local
.DS_Store
```

- `dist/`、`coverage/`、`e2e/reports/`、依赖目录必须忽略
- 本地环境变量文件（`.env.local`、`.env.*.local`）必须忽略，`.env` 系列模板可提交
- 构建报告目录同时加入 dev server 的 watch ignore（如 `e2e/reports/`），避免报告写入触发热更新噪音
