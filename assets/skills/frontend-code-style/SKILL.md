---
name: frontend-code-style
description: 前端代码风格规范——Prettier 格式化、ESLint 规则、组件/文件/目录命名约定、Vue 与 React 写法约定、.gitignore 必须项。仅在 Vue / React 前端项目使用。
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
- 单文件组件顺序：`<script>` → `<template>` → `<style scoped>`
- 样式默认 `scoped`；跨组件样式用 `:deep()` 且注明原因，禁止全局样式污染组件
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
