---
name: frontend-code-maintainability
description: 前端代码可维护性规范——组件拆分粒度、props 设计、TypeScript any 限制、死代码、DRY、状态与副作用清理。仅在 Vue / React 前端项目使用。
capabilities: ["maintainability"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本文列出**最低审查基线**，不限于所列维度。AI 审查时必须结合自身前端可维护性知识做拓展覆盖，下列任何可能遗漏的可维护性问题均须纳入审查。

## 组件拆分粒度

- 单文件超过 300 行（含模板/JSX，不含空行与注释）→ 至少 Medium
- 同一组件同时承担「取数 + 状态管理 + 展示」三件事 → 必须拆分为容器组件（取数/状态/编排）与展示组件（纯渲染），至少 Medium
- 拆分依据是变更原因，不按行数机械切分；拆分后 props 超过 7 个或布尔开关超过 3 个，重新审视组件边界（Low）
- 业务组件留在所属业务目录，通用展示组件沉淀到共享目录；禁止把业务组件塞进通用组件库（反向污染）
- 组件拆出后禁止通过 ref/defineExpose 直接操作子组件内部状态（绕过 props/事件契约），按耦合问题至少 Medium
- 写新组件前先查 UI 组件库与项目 shared 目录：能直接复用或包一层适配的不新写；自研组件与库组件功能重叠时以库为准，自研仅保留库不覆盖的场景 → Medium
- 同一展示形态第 3 处出现才沉淀为共享组件（与 DRY 章节提取时机一致）；业务变体走 props/slot 扩展既有组件，禁止复制出一个仅参数不同的新组件 → Medium
- 通用展示组件沉淀到共享目录（与既有「业务组件留业务目录，通用沉淀共享」条目衔接）；沉淀前确认语义相同而非长得像，错误抽象比重复更难维护

## props 设计

- props 必须有 TypeScript 类型（Vue `defineProps<Props>()`、React `interface Props`），禁止用 any/unknown 兜底 → High
- 子组件禁止直接修改父级数据：Vue 禁止 mutate props（含对象/数组深层修改），React 禁止原地修改 props 引用对象；通过 emit / 回调通知父级 → High
- 回调替代双向修改：父级提供 `onXxx` / `@xxx`，子组件只上报事件与数据，不要求父级传可变对象进来
- 布尔 props 用 `is` / `has` / `can` 前缀表意；避免 `data`、`info`、`obj` 这类泛名
- 默认值显式给出；不要依赖 `undefined` 分支隐式兜底
- 透传属性（Vue `$attrs` / React `...rest`）只用于容器类组件，禁止借透传隐藏真实 props 契约

## TypeScript 约束

- 禁止 `any`（含 `as any`、`<any>`、隐式 any）→ Medium；边界适配（第三方无类型、动态 JSON）用 `unknown` + 类型守卫/运行时校验，并注释来源
- tsconfig 必须 `strict: true`；`skipLibCheck` 允许但须说明第三方类型问题，其余严格项不得放宽
- 禁止滥用 `@ts-ignore`；确需压制时改用 `@ts-expect-error` 并注明原因（见可工具化规则）
- 公共 API（组件 props、composable/hook 返回值、api 函数、工具函数）必须有显式返回类型
- 类型断言只用于已校验数据；禁止用断言绕过类型错误
- 接口/DTO 类型与后端契约同源（OpenAPI 生成或集中维护），禁止散落手写重复类型

## 死代码

- 未引用的组件、composable/hook、工具函数、导出、CSS 类、依赖 → Low；连续多轮仍无引用按残留处理
- 删除而非注释；确需保留的临时保留必须带原因与清理条件（否则按 Low 记录）
- 禁止提交调试残留：注释掉的整段代码、临时 console、本地 mock 数据、临时开关
- 检测手段：构建告警、`tsc --noUnusedLocals`/`--noUnusedParameters`（开启时）、ESLint `no-unused-vars`、`knip`（项目引入时）
- 动态引用（路由字符串、组件注册表、`import.meta.glob`）中的导出不按未引用判定；判定前先 grep 动态引用

## DRY

- 同一逻辑第 3 处复用前提取：composable/hook、工具函数、共享组件（第 2 处先观察，避免过早抽象）
- 禁止跨业务模块复制粘贴业务逻辑；共享能力经共享目录沉淀，而不是互相 import 内部文件
- 提取前确认语义相同（不是长得像）；错误抽象比重复更难维护
- 抽象后保持单一职责；为复用硬塞条件分支的"万能组件"按可维护性问题记录（至少 Medium）
- 同类能力只保留一套实现：请求封装、格式化工具、权限判断、弹窗封装不得并存多套

## 状态与副作用

- 可推导状态用 computed / 派生值，禁止用 watch/useEffect 再存一份并手动同步
- props → 本地 state 只在需要"可编辑副本"时使用，并明确重置时机（props 变化时重置）
- 副作用集中管理：请求、订阅、定时器、事件监听须在卸载时清理（Vue `onUnmounted`、React effect cleanup）；泄漏按 Medium
- 禁止在渲染过程中产生副作用（发请求、改状态、写 storage）
- 避免状态提升过度：只在真正需要共享的层级提升，局部状态留在使用它的组件
