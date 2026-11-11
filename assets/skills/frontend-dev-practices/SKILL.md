---
name: frontend-dev-practices
description: 前端开发实践规范——pnpm 包管理约定、构建与启动命令、MSW mock 体系（单一 mock 源与 E2E_API_MODE 切换）、测试代码路径定义、提交规范、依赖管理。仅在 Vue / React 前端项目使用。
capabilities: ["dev-practices"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

## 包管理器约定

- 统一使用 pnpm；`package.json` 的 `packageManager` 字段锁定版本，开启 corepack
- 锁文件 `pnpm-lock.yaml` 必须提交；禁止提交 npm / yarn 锁文件；同一仓库出现两套锁文件 → 至少 Medium
- 安装依赖用 `pnpm add` / `pnpm add -D`；禁止手改 `package.json` 后不更新锁文件
- CI 安装用 `pnpm install --frozen-lockfile`；禁止用 `--no-frozen-lockfile` 绕过一致性检查
- workspace 内跨包依赖用 `workspace:*` 协议，禁止相对路径直接引用其他包源码
- 禁止全局安装项目工具；一律 `pnpm exec <tool>` 调用项目内版本

## 构建与启动命令

- 开发：`pnpm dev`；构建：`pnpm build`；预览：`pnpm preview`
- 类型检查：`pnpm typecheck`（Vue 项目 `vue-tsc --noEmit`，React/纯 TS 项目 `tsc --noEmit`）
- 质量命令统一封装在 `package.json` scripts（`lint` / `format` / `test` / `test:e2e`），CI 与本地同一入口；禁止 CI 另写一套命令
- 环境变量：Vite 用 `.env`、`.env.development`、`.env.production`；仅 `VITE_` 前缀暴露给客户端
- 前端环境变量只放非敏感配置（接口前缀、开关、埋点 id）；密钥一律不进前端环境变量与产物
- `.env.local` / `.env.*.local` 不进仓库；`dist/`、`coverage/`、`node_modules/` 不进仓库
- 构建产物目录、缓存目录（`node_modules/.vite`）纳入 `.gitignore` 与 dev server watch ignore

## mock 体系（MSW）

mock 采用单一来源，开发、端到端测试、组件测试共用同一批 handlers：

```
src/mocks/
  ├── browser.ts          # 浏览器端：setupWorker 注册（开发服务器与端到端 mock 模式共用）
  ├── server.ts           # Node 端：setupServer 注册（组件/单元测试用）
  ├── handlers/           # 按业务域拆文件，如 order.ts、auth.ts
  │   └── index.ts        # 汇总导出 handlers 数组
  └── fixtures/           # mock 数据，与 handlers 一起维护
```

- handlers 独立目录存放，`index.ts` 汇总导出；`browser.ts` 与 `server.ts` 都只 import 这一份数组，禁止在测试文件里另写一套内联响应
- 请求地址用相对路径（`/api/...`），与真实接口前缀一致；接口契约变更时 handlers 同步改，禁止 mock 长期偏离真实契约；新增 mock 数据须有真实来源（本地优先、测试环境兜底），不得按页面需要臆造，取数与转换方式按项目测试规范执行
- 未匹配请求：开发与端到端测试用 `onUnhandledRequest: 'error'`（或显式白名单），避免请求静默穿透到真实后端形成"半 mock"
- 环境变量切换数据源：开发用 `VITE_API_MODE=mock|real`，端到端用 `E2E_API_MODE=mock|real`；real 模式不启动 worker，请求走真实后端/代理，用于联调与发版回归
- mock 场景数据（空列表、异常、超时、权限不足）由 handlers 按请求参数分支返回，不在测试（或页面）里硬编码
- `mockServiceWorker.js` 放 `public/` 目录；首次注册后需刷新才接管请求的场景，测试侧须等待 `navigator.serviceWorker.ready` 或重新导航
- 生产构建禁止注册 mock worker（按环境变量与构建模式双重把关），发现生产启用 mock 按技术债口径处理

## 测试代码路径定义

以下目录只放测试代码、不参与生产构建；判定"仅含测试代码"的豁免以此为准：

| 路径 | 内容 |
|------|------|
| `e2e/` | 端到端测试：Playwright 配置、specs、support、fixtures、reporting、reports |
| `tests/` | 跨模块集成测试、测试基础设施与共享 fixture |
| `__tests__/` | 单元/组件测试，可与实现同目录（`src/**/__tests__/`）或集中根目录 |
| `src/**/*.test.ts`、`src/**/*.spec.ts` | 与被测实现同目录的单元测试 |
| `src/**/__mocks__/` | 测试替身 |

- 测试代码路径纳入 tsconfig `include` 与 ESLint 检查范围；构建入口不得引用测试代码（引入即产物污染）
- 测试 fixture 与数据放测试目录内，禁止被业务代码 import
- 禁止把测试代码或 mock 数据先放进 `src` 业务模块再被生产代码引用
- 新增测试目录须同步更新本节路径清单与 tsconfig/ESLint 配置，避免测试代码游离在检查之外

## 提交规范

使用 Conventional Commits：

```
feat(order): 新增订单列表筛选
fix(auth): 修复登录态过期未跳转
refactor(ui): 抽取表格分页组件
test(e2e): 补充订单导入回归用例
perf(list): 长列表改为虚拟滚动
docs: 更新前端接入说明
chore: 升级依赖版本
build: 调整构建压缩配置
```

- 每个独立子任务至少一个 commit；修复反馈的 commit 引用对应问题编号
- 禁止提交调试残留、注释掉的大段代码、本地 mock 数据、临时开关
- 提交前跑：`pnpm typecheck` + `pnpm lint` + `pnpm test`（涉及业务链路时加 `pnpm test:e2e`）

## 依赖管理

- 新增依赖说明用途与体积影响；为单个小函数引入整包 → Medium
- 同类能力只保留一套（请求库、状态库、UI 库、日期库、工具库），并存按技术债口径处理
- 定期清理未使用依赖（`knip` 或等价工具）；依赖漏洞扫描按安全规范执行
- 升级依赖后必须跑类型检查与全量测试；主版本升级须有迁移记录

## 调试

- 优先用浏览器 DevTools、Vue DevTools / React DevTools、网络面板与性能面板
- 提交前清理临时 console、断点、调试开关
- 环境判断集中封装，禁止业务代码里散落 `import.meta.env.DEV` 分支
- 线上问题排查用 sourcemap 上传到内部监控平台，不把 sourcemap 发布到静态目录（见发布产物安全要求）

## 新功能开发与缺陷修复

- 新功能：先明确接口契约并更新 handlers，再实现组件与逻辑；补组件/单元测试；涉及关键业务链路补端到端场景
- 缺陷修复：从现象追溯根因，修复根因；补能复现缺陷的回归测试（单元或端到端）
- 完成判据：类型检查 + lint + 单测 + 构建全部通过；涉及业务链路时端到端用例通过
