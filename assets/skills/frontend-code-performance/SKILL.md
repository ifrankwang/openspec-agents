---
name: frontend-code-performance
description: 前端性能规范——bundle 体积预算（size-limit 按 gzip）、gzip/brotli 预压缩产物、懒加载、长列表虚拟化、请求合并与缓存、避免重复渲染。仅在 Vue / React 前端项目使用。
capabilities: ["performance"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本文列出**最低审查基线**，不限于所列维度。AI 审查时必须结合自身前端性能知识做拓展覆盖，下列任何可能遗漏的性能问题均须纳入审查。

## bundle 体积预算（size-limit，按 gzip）

- 必查命令：`pnpm exec size-limit`；预算配置在 `.size-limit.json` 或 `package.json` 的 `size-limit` 字段
- 预算以 gzip 后体积为准（`"gzip": true`），不以原始体积作为达标依据
- 参考预算（项目按实际调整）：首屏 JS ≤ 200 kB gzip；单个异步 chunk ≤ 80 kB；首屏 CSS ≤ 60 kB；单页面增量 ≤ 100 kB
- 体积预算被上调、文件被排除出统计 → 按配置削弱处理，须有理由与目标值
- 与基线对比：构建产物相对基线增长超过 10% 且无对应功能变更 → 至少 Low；直接影响首屏 → Medium
- 定位大依赖：`vite build` 后接 `rollup-plugin-visualizer` / `vite-bundle-visualizer` 看 treemap；禁止整库引入（`import _ from 'lodash'`、整包 UI 库全量注册）
- 依赖选型先核对 gzip 体积与 tree-shaking 支持（ESM）；为单个函数引入整包 → Medium

## gzip / brotli 预压缩产物

- 构建阶段生成 `.gz` / `.br` 预压缩文件（`vite-plugin-compression` 或构建后脚本），服务端启用 `gzip_static` / `brotli_static`
- 验收：`dist/` 内存在与静态资源同名的 `.gz`/`.br`；线上响应头 `Content-Encoding: gzip|br` 且命中预压缩文件
- 禁止只依赖服务端动态压缩：高并发 CPU 成本高，部分 CDN/网关默认不压缩大文件
- 预压缩产物属构建产物，不进仓库；构建脚本须可靠生成，不能靠人工补
- 压缩前剔除 sourcemap（见发布产物安全要求），避免压缩无关大文件

## 懒加载

- 路由级懒加载：`component: () => import('@/pages/Xxx.vue')`（Vue）或 `lazy(() => import('./Xxx'))`（React）；禁止全量静态注册路由组件
- 重组件异步加载：图表、富文本、地图、编辑器、大表格用 `defineAsyncComponent` / `lazy` + `Suspense`，必须有加载态与错误态
- 第三方重库动态 `import()`，不进入首屏 chunk
- 图片：响应式尺寸 + `loading="lazy"` + 现代格式（webp/avif）；首屏关键图用 `preload`，非首屏图默认懒加载
- UI 组件库按需引入（`unplugin-vue-components` / 手动 import / 按需插件），禁止全量注册
- 懒加载不得破坏首屏关键路径：首屏依赖的组件/数据不延迟加载；路由切换有骨架屏或过渡态

## 长列表虚拟化

- 可滚动列表超过 100 行必须虚拟滚动或分页/无限滚动；超过 500 行必须虚拟滚动
- 选型按框架：Vue 用 `vue-virtual-scroller` / `@tanstack/vue-virtual`；React 用 `@tanstack/react-virtual` / `react-window`
- 虚拟列表要求行高固定或可预估；动态行高须用支持动态测量的方案，不得硬套固定行高导致错位
- 大表格：Element Plus `el-table` 大数据用其虚拟表格能力或分页；禁止一次性渲染上千行 DOM
- 批量操作/导出在服务端分页处理，禁止前端拼全量数据后再计算
- 虚拟滚动区域内避免复杂外层布局影响测量（transform/缩放容器会导致滚动计算失真）

## 请求合并与缓存

- 并发相同请求合并：同一 key 的在途请求复用同一个 Promise；重复请求 → Medium
- 搜索/筛选输入加防抖（300ms 级）或节流；禁止每次按键触发请求
- 请求瀑布：串行依赖改并行（`Promise.all`）；循环内不允许逐个发请求 → Medium（循环内同步请求 → High）
- 缓存策略：列表/详情设合理缓存与失效（查询库缓存、`keep-alive`、HTTP 缓存头）；数据变更时按 key 失效，禁止全量刷新
- 轮询任务用递增间隔或 SSE/WebSocket 替代固定高频轮询；页面不可见时暂停轮询
- 静态资源用内容哈希文件名 + 长缓存；HTML 入口短缓存/不缓存
- 首屏数据预取与服务端渲染按项目能力决定，不作为强制项

## 避免重复渲染

- Vue：大对象避免深层 `reactive`，只读大列表用 `shallowRef` / `markRaw`；稳定子树用 `v-memo`；computed 依赖保持精简
- React：不盲目 `React.memo` / `useMemo` / `useCallback`，先定位真实重渲染再优化；优化须有测量依据，无测量的滥用本身也是维护负担
- Context 按域拆分，避免一个 Context 变更导致全量消费者重渲染
- 列表 `key` 稳定、组件拆分边界稳定；禁止在渲染中创建新对象/新函数并传给深层组件（必要时上提或用稳定引用）
- 图表、编辑器、地图等重组件在数据未变化时不重建；实例复用、按需更新
- 避免在渲染路径做重计算：排序/过滤/格式化放 computed / useMemo 或数据层

## 测量与判据

- 判据用数据：构建产物体积、Lighthouse（LCP / TBT / CLS）、PerformanceObserver 实测、网络面板瀑布
- 优化前后给出对比数字（体积、LCP、请求数）；无数据的"优化"不成立
- 性能回归须能定位到具体变更（chunk 体积变化、请求数增加、渲染次数）
- 不把"看起来更快"当结论；开发环境数据不作准，以生产构建与接近真实的网络条件测量
