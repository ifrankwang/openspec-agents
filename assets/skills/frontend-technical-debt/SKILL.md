---
name: frontend-technical-debt
description: 前端项目技术债识别（架构维度）——框架版本 EOL、Vue2→Vue3 / CRA→Vite 等迁移残留、双状态库/双请求封装并存、废弃 API 大面积使用、临时方案固化、前后端契约漂移。technical-debt 的前端配套。
capabilities: ["architecture"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 technical-debt 的前端实现配套，仅含前端技术栈特有的债务形态。通用技术债识别框架见 technical-debt。调用本 skill 须同时加载 technical-debt。

## 过时技术选型（前端形态）

- Vue 2 已于 2023-12-31 结束官方支持（EOL），不再有安全补丁；仍在 Vue 2 且无升级计划 → 至少 Medium（存在已知安全暴露面时按安全维度判例升级）
- 已停止维护的脚手架/构建链：`react-scripts`（CRA 已官方弃用）、Vue 3 项目仍用 `vue-cli`、webpack 4 遗留配置、gulp 遗留构建任务
- Node 版本 EOL（`.nvmrc` / `engines` 指向已停止维护的大版本）→ 至少 Low；影响构建可复现或安全补丁时 Medium
- 已 EOL 的 UI 库大版本（如 Vue 2 生态的 Element UI、Vuetify 2）仍在承载核心页面，且与新版本文档/生态脱节
- `browserslist` 缺失或目标包含早已淘汰的浏览器，导致无谓降级与产物体积膨胀
- 生产依赖停更两年以上、无替代计划且位于核心链路 → 至少 Low

## 技术迁移债（前端形态）

- Vue 2 → Vue 3 迁移中断残留：
  - `new Vue()` 与 `createApp()` 并存；`Vue.extend` / `Vue.prototype` / `$listeners` / `filters` / `$children` / eventBus 旧 API 仍在用
  - Options API 与 Composition API 大面积混用且无统一方向；Vue 2 组件库与 Vue 3 组件库并存
  - Vue 2 专用构建插件（`vue-template-compiler`）与新编译链并存
- React 大版本迁移中断：`ReactDOM.render` 与 `createRoot` 并存；旧生命周期（`componentWillMount` 等）残留；版本跨度大且未逐步升级
- CRA → Vite 迁移中断：`react-scripts` 与 Vite 双脚本并存，`%PUBLIC_URL%` 与 `import.meta.env` 两种约定混用
- Webpack → Vite 迁移中断：双构建配置并存，别名、环境变量、产物目录口径不一致
- Vuex → Pinia / Redux → Redux Toolkit 迁移中断：两套状态库并存，新代码继续写旧库
- 迁移只完成部分模块且无完成计划 → 至少 Medium；两套构建链同时产出线上包 → High

## 平行实现与迁移缺失（前端形态）

- 双请求封装：axios 拦截器一套 + fetch 封装一套，token 注入、错误归一、重试策略不一致
- 双状态库 / 双路由库 / 双 UI 库 / 双 i18n 方案并存，边界无约定
- 自研组件与 UI 库重复（自研 Modal / Table / Form 与库内组件功能重叠），且无统一选型
- 多套样式方案并存（less + sass + Tailwind + CSS Modules + styled-components）无边界约定
- 同类工具函数多份实现（日期格式化、金额格式化、权限判断、下载封装各写几套）
- 同类能力已有既有实现仍另起一套，且旧实现无迁移方案 → 至少 Medium

## 临时方案固化（前端形态）

- `TODO` / `FIXME` / "临时" 注释长期滞留且无跟进：超过一个迭代周期按 Low；涉及核心链路或安全 → Medium
- 生产代码启用 mock：mock worker 进入生产构建、业务代码内硬编码 mock 数据、`if (isDev) return mockData` 分支随生产发布
- 绕过统一请求封装直接 fetch/XHR；绕过 store 直接改共享数据；临时 hack 长期保留
- 大面积 `@ts-ignore` / `as any` 作为长期手段（非边界适配场景）
- 前端硬编码环境判断（`location.host` 分支、写死接口地址）代替环境变量
- 功能开关长期关闭、兜底假数据进入生产、降级形态无替代计划 → 至少 Medium

## 契约不一致与模型漂移（前端形态）

- 同一状态/枚举字段在不同接口表达不一致（枚举字符串 vs 数字码），前端维护两套映射与转换
- 金额单位不统一（元 vs 分）、时间格式不统一（ISO 字符串 / 时间戳 / `yyyy-MM-dd`），转换逻辑散落各业务模块
- 大整数 id（雪花 id）以 number 传输导致精度丢失，与 string 口径并存（应统一 string）
- 前端 DTO 类型与后端契约漂移：手写 interface 与 OpenAPI 不同步，可选性与真实返回不一致
- 跨接口同义字段命名不一致（`userName` / `username`、`id` / `uid`）→ 至少 Low；因此产生转换残留 → Medium
- 接口错误码语义不统一（业务码 / HTTP 状态 / 错误文案混用），错误处理分支重复

## 存量债务处置

存量（非本轮引入）技术债与新增债务同等识别，不得因非本轮引入而沉默丢弃。存量可识别债务 → 至少 Low+ 级别；纯建议性优化 → Info。处置分级与利息评估口径同通用技术债识别框架。
