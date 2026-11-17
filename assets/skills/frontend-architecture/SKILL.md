---
name: frontend-architecture
description: 前端架构分层规范——页面/组件/composable-hook/store/api 职责分层与依赖方向、按 feature 切分 vs 按类型切分、状态管理边界、路由与页面职责、错误码消费。architecture-evolution 的前端配套。
capabilities: ["architecture"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 architecture-evolution 的前端实现配套，仅含前端技术栈特有的分层与依赖方向实现。通用架构演进审查框架见 architecture-evolution。调用本 skill 须同时加载 architecture-evolution。

## 分层与依赖方向

前端按职责分五层，依赖只能自上而下：

| 层 | 目录示例 | 职责 | 允许依赖 |
|----|----------|------|---------|
| 页面 / 路由 | `src/pages`、`src/views`、`src/router` | 页面编排、参数解析、数据装配、权限入口 | 组件、composable/hook、store、api |
| 组件 | `src/components`、`src/features/*/components` | 展示与交互 | composable/hook、工具、类型 |
| 组合逻辑 | `src/composables`、`src/hooks` | 复用状态与副作用逻辑 | store、api、工具、类型 |
| 状态 | `src/stores` | 跨页面共享状态 | api、工具、类型 |
| 接口封装 | `src/api` | 请求定义、DTO 类型、错误归一 | http 客户端、工具、类型 |

- 依赖方向单向：上层可依赖下层，禁止反向与跨层跳跃
  - 组件不得 import 页面/路由
  - api 层不得 import store / 组件 / 页面
  - store 不得 import 组件 / 页面
  - http 客户端（axios 实例、拦截器）不得 import 任何业务模块
- 禁止循环依赖；同层之间只允许经由共享模块（`src/shared`、`src/utils`）单向前置
- 严重级别：跨层反向依赖 Medium；循环依赖 High；业务模块直接引用另一 feature 内部文件 Medium；http 客户端引用业务模块 High
- 工具化落地：dependency-cruiser 规则文件 `.dependency-cruiser.cjs`，检查命令 `pnpm exec depcruise src --config .dependency-cruiser.cjs --output-type err`

### dependency-cruiser 规则草案

```js
// .dependency-cruiser.cjs
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-reverse-layer',
      severity: 'error',
      comment: '下层不得依赖上层：api/store/composable 不得引用组件与页面',
      from: { path: '^src/(api|stores|composables|hooks)/' },
      to: { path: '^src/(components|features/[^/]+/components|pages|views)/' }
    },
    {
      name: 'no-page-from-component',
      severity: 'error',
      comment: '组件不得依赖页面与路由',
      from: { path: '^src/(components|features/[^/]+/components)/' },
      to: { path: '^src/(pages|views|router)/' }
    },
    {
      name: 'no-business-in-http-client',
      severity: 'error',
      comment: 'http 客户端保持技术无关，不得引用业务模块',
      from: { path: '^src/(api/http|utils/http|shared/http)/' },
      to: { path: '^src/(features|stores|pages|views|components)/' }
    },
    {
      name: 'no-cross-feature-internals',
      severity: 'error',
      comment: '跨 feature 只能引用对方 index.ts；$1 回指 from 路径捕获组，项目版本不支持时按 feature 名逐条写配对规则',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/(?!$1)[^/]+/', pathNot: '^src/features/[^/]+/index\\.ts$' }
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: '禁止循环依赖',
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' }
  }
}
```

- 规则首次落地先在现状上实测命中数，误报清零后再启用（不接受"先 error 再逐条 ignore"）
- 路径前缀（`src/features` 还是 `src/modules`）按项目实际目录调整；规则名保持语义化
- 校验：`pnpm exec depcruise src --config .dependency-cruiser.cjs --output-type json > depcruise.json`，用 `.summary.error` 与 `.summary.warn` 核对

## 错误码消费

接口层统一解包响应，把服务端错误、网关错误、网络错误都归一为统一结构再向上传递：

```
interface AppError {
  kind: 'network' | 'business' | 'auth'
  code: number        // 业务错误码（数字），与后端契约同源
  httpStatus?: number
  retryable: boolean
  message: string     // 已经映射好的用户可读文案
}
```

- 解包只在一处做（http 客户端拦截器或 api 层的统一响应处理），禁止各页面自己判断 `res.code === 0`、自己读 `res.data`
- 按业务错误码映射用户可见提示与后续动作（重试 / 跳转 / 联系支持），映射表集中维护；禁止在各页面各自 if-else 判断错误码 → 分散判断按 Medium
- 禁止把后端原始 message 直接展示给用户：原始 message 只用于日志与排障，面向用户的文案从映射表取，映射缺失时回退通用提示
- 错误码与提示文案的映射表随接口契约一起维护，新增错误码同批补映射；契约里有码而映射表没有 → Medium
- 前后端错误码口径必须同源：错误码来自接口契约（枚举或生成的常量），禁止前端硬编码契约中未定义的数字码 → 前端出现未定义的码按 Medium
- 业务码为数字，禁止按字符串比较（`code === '40301'`），也禁止把数字码转成字符串后再判断
- 三类错误必须区分处理，禁止一律弹「系统异常」：
  - 网络错误（超时、断网、5xx）：可重试，给出重试入口，保留用户已填内容
  - 业务错误（4xx + 业务错误码）：按码给具体提示与可行动作，不自动重试
  - 鉴权失效（401 / 令牌过期 / 无权限 403）：统一跳登录或提示权限不足，禁止逐页面各写一套 → 未统一按 Medium
- 未捕获错误须有兜底：全局错误处理器把未知错误归一后记录并给用户确定结果，禁止静默吞掉导致界面停在加载态

## 按 feature 切分 vs 按类型切分

- 业务代码按 feature 切分（feature-first）：

```
src/
  app/                 # 应用装配：入口、路由、布局、全局提供者
  features/
    order/
      pages/
      components/
      composables/
      api/
      stores/
      types.ts
      index.ts         # 该 feature 唯一对外出口
  shared/              # 跨 feature 通用能力：ui 组件、hooks、工具、类型
  mocks/               # mock 层（开发与测试共用）
```

- 每个 feature 只有一个对外出口 `index.ts`；跨 feature 只能引用对方 `index.ts`，禁止直引内部文件
- `shared` 不得 import 任何 feature；共享能力只能从下层向上沉淀
- 禁止按类型平铺所有业务代码（`src/components` 堆全部业务组件、`src/api` 堆全部接口）：随规模增长会演变成跨模块修改扩散与边界消失
- 禁止一个 feature 直接读写另一个 feature 的 store 状态；跨 feature 协作通过页面层编排或事件/回调
- 路由、权限、布局、全局错误边界等应用级装配放 `app/`，业务 feature 不感知路由表细节
- 存量按类型切分的项目不强制一次性迁移：新增业务按 feature 落地，迁移按 feature 逐个完成，避免双轨长期并存（双轨并存按技术债口径处理）

## 状态管理边界

- 服务端状态（接口数据）与客户端状态分离：接口数据优先用查询缓存（TanStack Query / SWR / 项目自封装缓存），不整包塞进全局 store
- 全局 store 只放跨页面共享的客户端状态（会话、权限、主题、跨页筛选）；页面内状态留组件，跨组件用 `provide/inject` 或局部 store
- 禁止万能 store：按业务域拆 store；store 之间禁止直接 import 互相引用，跨域协作走上层编排
- 状态单一来源：同一数据只在一个 store/缓存中存在，禁止多处各存一份再手动同步
- 持久化状态（localStorage/sessionStorage）须声明字段白名单与版本迁移，禁止整 store 序列化；敏感字段遵守安全规范
- store 只暴露必要的读状态与动作，禁止把内部可变引用直接暴露给组件修改

## 路由与页面职责

- 页面只做编排：取数、传参、组合组件；业务规则下沉到 composable/store/api，不写在模板里
- 路由集中注册、按需懒加载；路由守卫只做导航与权限入口，不承载业务逻辑
- 页面与组件不直接解析 URL 细节，路由参数由页面统一解析后以 props 下发
- 页面级数据加载与错误态/空态/加载态统一处理，不散落在各子组件

## 演进审查要点

- 新增模块是否延续既有分层与 feature 边界；是否平行引入第二套状态库 / 请求库 / UI 库 / 路由库
- 依赖方向是否可被工具规则验证；新增例外是否写进规则白名单并留理由
- 跨层能力是否放在正确的层（请求重试放 http 客户端、权限判断放共享能力、格式化放工具层）
- 本次变更是否让既有规则/校验在新的执行路径上失效（按通用架构演进框架的规则边界推演要求核对）
- 分层目录调整是否影响既有 import 路径与构建别名；别名（`@/`）配置是否与 tsconfig paths 一致
