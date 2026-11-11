# e2e（Playwright）

面向业务场景的端到端测试。跑完自动生成两级业务报告：场景列表（业务域 → 业务分支 → 场景）→ 场景详情（操作步骤 + 截图 + 失败证据）。

## 前置

- `@playwright/test` 已作为项目 devDependency 安装（按项目包管理器安装，如 `pnpm add -D @playwright/test`）。
- 项目 `package.json` 带 `"type": "module"`：配置与 e2e 脚本按 ESM 加载，缺了会在加载 config 时报 `import.meta` 相关错误。
- 首次运行先执行 `npm run test:e2e:install` 安装浏览器（装到 Playwright 默认缓存目录，跨项目复用）。

## 命令

```bash
# 首次运行先装浏览器（装到 Playwright 默认缓存目录，跨项目复用）
npm run test:e2e:install

# mock 模式（默认）：复用项目自己的 MSW handlers，不依赖真实后端
npm run test:e2e

# real 模式：不启动 mock worker，请求经 dev server 代理打真实后端（联调 / 发版回归）
# 等价于 E2E_API_MODE=real npm run test:e2e
npm run test:e2e:real

# 只跑回归子集（@regress 标签；npm 脚本内部设置 E2E_GREP）
npm run test:e2e:regress

# 真实后端 + 只跑回归子集
E2E_API_MODE=real npm run test:e2e:regress

# 调试单条：参数透传给 Playwright；结论以全量运行报告为准
npm run test:e2e -- -g "关键字"

# 打开报告
npm run test:e2e:report

# 新增/修改 mock 数据：先从真实接口取数，转成 fixture + 溯源记录（本地优先，测试环境兜底）
node e2e/support/mock-from-real.mjs --url /api/orders --base-url "$BASE_URL" --token-env TOKEN --source-type local --out src/mocks/fixtures/orders.json
```

不要从仓库根直接跑 `npx playwright test`：没有 config 时 Playwright 会把 `test-results/` 落在仓库根，报告也不会生成。一律走 `npm run test:e2e`。

不要给运行命令追加 `--reporter=line/json`，会覆盖自定义 reporter，报告不会生成。

带 `E2E_*=` 前缀的写法在 Windows 的 cmd / PowerShell 下不生效（`test:e2e:real`、`test:e2e:regress` 脚本内部同理）：PowerShell 先设变量再运行，如 `$env:E2E_API_MODE='real'; npm run test:e2e`。

## 数据源：mock / real

- mock 只有一份来源：项目 `src/mocks/handlers/`（开发、e2e、组件测试共用）。e2e 不另写网络拦截；需要新场景数据时，先按「本地 > 测试环境」取真实接口响应，再用 `e2e/support/mock-from-real.mjs` 转成 fixture 与溯源记录，不要按页面需要手写数据
- `e2e/playwright.config.ts` 把 `E2E_API_MODE` 透传给 dev server；应用侧读同值环境变量（Vite 项目通常是 `VITE_API_MODE`）决定是否启动 mock worker。透传缺失会静默走真实后端
- `real` 模式必须显式设置 `E2E_API_MODE=real`；登录态用预置账号或 `storageState`，不把账号密码写进用例
- 未匹配请求应配置为报错（`onUnhandledRequest: 'error'`），禁止静默穿透形成"半 mock"
- 数据来源优先级：本地真实响应 > 测试环境真实响应 > 契约定义（OpenAPI / TS 类型）；用契约推导的数据集必须在溯源文件里标注「未验证来源」
- 每个新增或修改的 mock 数据集在 `src/mocks/fixtures/` 下留 `<名称>.source.json`（接口、来源、取数时间、替换清单、脱敏原文），随代码提交
- 涉及 mock 变更的场景在 mock 与 real 两种模式各跑一次，结果必须一致；real 运行前确认 webServer 真以 `E2E_API_MODE=real` 启动，只跑受影响场景或 `@regress` 只读子集

### 待补数据集

契约定义档（未验证来源）的 mock 数据集登记在这里，补齐真实响应后移出本表：

| 接口 | 数据集 | 未验证原因 |
|------|--------|-----------|
| （示例）GET /api/orders | src/mocks/fixtures/orders.json | 本地与测试环境均不可达，按 OpenAPI 推导 |

## 失败取证

- `e2e/support/http-trace.ts` 由 fixture 在页面加载前注入，在 fetch / XHR 层记录请求与响应，再回传测试进程；mock 模式下（MSW 在浏览器内拦截）接口证据因此不缺失
- 项目自有 fixture 可以叠加登录等能力，但不要整体覆盖 `page` fixture，否则取证通道会丢

## 写用例约定

```ts
test('上传超过 20MB 的清单文件，应提示不能超过 20MB', async ({ page }, testInfo) => {
  scenario(testInfo, { id: 'ORD-001', domain: '订单管理', branch: '文件校验' })
  await step(page, testInfo, '进入订单导入页', () => page.goto('/import'))
  await step(page, testInfo, '选择 25MB 的清单文件上传，应提示文件超过 20MB', () =>
    page.setInputFiles('input[type=file]', 'fixtures/oversize.xlsx')
  )
  await expect(page.getByText(/20MB/)).toBeVisible()
})
```

1. 一个 test 就是一条业务场景，标题写业务结果，不写实现细节。
2. 用例第一行 `scenario()` 声明业务域和业务分支，报告据此分组；`id` 用「模块前缀-三位序号」（2~4 位大写字母前缀 + 三位数字，如 `ORD-001`），编号唯一性由 `e2e/scripts/check-case-ids.mjs` 在启动时预检。
3. 每个操作一行 `step()`，句子必须是「操作 + 应发生什么」，失败时报告停在这一步，读者看它就知道预期；步骤粒度对齐用户视角，一个用户动作一行。
4. 断言放在步骤之后或步骤回调里，`step()` 会等页面稳定再截图；断言看用户可见结果（文案、按钮显隐、URL、下载文件名、状态徽章），不要断言内部实现。
5. 已知缺陷用 `test.fail()` 保持规格断言，报告里按「失败」展示并附证据；疑似产品缺陷不要改源码绕过，在项目问题文档登记。
6. 新增业务域在报告里自动出现，不需要改 reporter。
7. fixture 放 `fixtures/<领域>.ts`，用工厂函数 + 覆盖字段的方式构造，避免逐条写大对象。
8. 提交前跑项目的格式化与 lint 命令。

## 报告

- `e2e/reports/playwright-report/index.html`：给人看，列表页 + 详情页。
- `e2e/reports/playwright-report/report-data.json`：给机器/AI Agent 读，含 `schemaVersion`、`schema` 字段说明、失败场景的 `error.raw`，`mode` 标明本轮是 mock 还是 real。
- 真实环境验证单独出一份：`e2e/reports/playwright-report/real/`，不覆盖 mock 全量报告。
- 步骤截图在报告的 `assets/` 下（生成报告时从运行痕迹复制，HTML 自包含，痕迹目录被系统清掉也能看图）。
- trace / video / 失败现场等运行痕迹写系统临时目录 `<项目目录名>-e2e/test-results-<端口>`（`npm run test:e2e` 启动时打印路径，系统定期清理，不进仓库）。
- 报告根与痕迹目录的路径公式只在 `e2e/reporting/paths.mjs` 实现；需把 `e2e/reports/` 加入 `.gitignore` 与 Vite 的 watch ignore。
- 一次性验证要单独出一份报告时，用 `E2E_REPORT_DIR=$(mktemp -d)`，不要写进仓库。
- `e2e/fixtures/` 与 `<名称>.source.json` 溯源记录是交付物，留在项目内随代码提交。

## 模式与配置

| 环境变量 | 说明 |
|---|---|
| `E2E_API_MODE=real` | 关掉 mock 数据源，请求经 vite 代理转发到后端 |
| `E2E_API_PREFIX` | 接口前缀，默认 `/api`；`support/evidence.ts` 用它判定要采集证据的接口 |
| `E2E_PORT` | 指定 dev server 端口；不设时由 `run-e2e.mjs` 自动挑空闲端口 |
| `E2E_PORT_START` | 自动选端口的起点（默认 5173 + 进程号散列），并行跑多份时改起点避开冲突 |
| `E2E_BASE_URL` | 覆盖页面地址（默认 `http://127.0.0.1:<端口>`） |
| `E2E_REPORT_DIR` | 覆盖报告输出目录（默认 `e2e/reports/playwright-report/`，real 模式 `.../real/`）；相对路径按 `e2e/` 解析，绝对路径原样使用 |
| `E2E_RESULT_DIR` | 覆盖截图/trace/video 输出目录（默认系统临时目录，按端口分目录）；相对路径按 `e2e/` 解析 |
| `E2E_GREP` | 只跑标题/标签匹配的用例，如 `E2E_GREP=@regress` |
| `E2E_SKIP_WEBSERVER=1` | 不启动 dev server（需自行保证服务已就绪且模式正确） |
| `E2E_REUSE_SERVER=1` | Playwright 复用同端口已有 dev server |

真实模式会读写本机后端数据库，只用于本地验收；用例集合与 mock 模式完全相同（同一批用例、同一份报告结构），
没有「只在真实模式跑、mock 模式跳过」的用例——只把 mock 数据源关掉、请求直接打到后端，因此只有种子数据能对上的用例才会通过。

## 目录

```
e2e/
├── playwright.config.ts
├── fixtures/            # 接口 fixture（按领域拆分）与生成的样本文件
├── support/             # 登录态、公共 test/expect、报告元信息与步骤截图、请求取证
├── reporting/           # 业务报告生成器与产物路径解析（paths.mjs）
├── reports/             # 正式业务报告（gitignore）：playwright-report/（真实模式 real/）；痕迹在系统临时目录
├── scripts/             # 启动器（挑端口/清过期痕迹/编号预检）、打开报告、装浏览器
└── specs/               # 用例，按领域分目录
```
