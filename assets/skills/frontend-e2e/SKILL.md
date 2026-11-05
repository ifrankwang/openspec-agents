---
name: frontend-e2e
description: 面向 Vue / React 前端项目的 Playwright 端到端测试与业务报告体系。搭 e2e 目录、按「业务域 → 业务分支 → 场景」组织用例、每步自然语言 + 截图、失败自动收集控制台/接口/断言证据、mock 复用项目 MSW handlers 并用 E2E_API_MODE 切换真实后端，跑完生成「人看的两级 HTML 报告 + 机器/AI 读的 JSON」。当用户说「给这个前端项目搭 e2e」「接入 Playwright」「端到端测试」「验收/回归/测试报告」「把用例结果整理成业务报告」时使用，即使没点名 Playwright 或报告也要用；只要涉及前端端到端测试的组织方式与结果呈现，就属于本 skill 的范围。
capabilities: ["e2e-testing"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
boundary_hints:
  directories: ["e2e/"]
---

# 前端 e2e：业务场景测试与报告

目标不是「跑绿一批用例」，而是让开发、测试、产品能直接读懂：哪些业务场景通过、哪些有问题、问题出在哪个业务分支、复现路径是什么、失败时控制台和接口到底返回了什么。

## 必做清单

| 项 | 要求 |
|----|------|
| 用例脚本 | 交付可执行的用例脚本：`e2e/` 目录、Playwright 配置、support 层（reporter / 证据采集 / fixture）、按「scenario + step」组织的用例；脚本能直接按 README 命令跑起来 |
| 执行报告 | 实际执行过并产出报告：`playwright-report/index.html` 与 `playwright-report/report-data.json` 均存在，报告满足下文硬要求；只写不跑不算完成 |

## 产出物长什么样

一次运行产出两份，同源、不重复维护：

- `playwright-report/index.html`：给人看。**列表页**按「业务域 → 业务分支 → 场景」缩进分组，场景行带用例编号，状态只有 通过 / 失败 / 跳过；**详情页**是该场景的自然语言操作步骤，一步一句话 + 一张截图，失败场景在出错那一步标红，下面给失败证据；从详情返回列表回到原位置并高亮来源行。
- `playwright-report/report-data.json`：给 CI 和 AI Agent 读。带 `schemaVersion`、`schema`（字段说明）、`summary`、`scenarios[]`，失败场景 `error.raw` 保留接口请求响应全量、控制台记录、断言源码与堆栈，`mode` 字段标明本轮是 mock 还是 real。

详细版式、证据规则、验收清单见 `references/report-spec.md`，落地新项目前先读一遍。

## 落地步骤

1. **侦察**：确认前端框架、dev server 启动命令与端口、接口前缀（默认 `/api`）、登录方式（真实账号 / 预置登录态）、项目 mock 层位置（MSW handlers 目录与启动入口）、以及 dev server 代理配置。这些决定了 `playwright.config.ts` 与 fixture 怎么改。
2. **铺骨架**：执行 `node scripts/scaffold.mjs --target <项目根>`，把 reporter、证据采集、请求取证、fixture、配置、README 模板拷到 `<项目>/e2e/` 下，已存在的文件不会覆盖。
3. **接数据源**：报告不关心数据从哪来，但 mock 与真实后端走同一条链路切换。
   - mock 模式：复用项目既有 MSW handlers（单一 mock 源，handlers 独立目录，dev、e2e、组件测试共用）。e2e 侧不另写任何网络拦截。
   - real 模式：不启动 mock worker，请求经 dev server 代理打真实后端，用于联调与发版回归。
   - 两种模式由 `E2E_API_MODE=mock|real` 切换，见下文「mock 与真实接口切换」。
4. **写用例**：一条 `test` 一条业务场景，第一行 `scenario()` 声明业务域与业务分支，每个操作一行 `step()`。写法见下一节。
5. **跑并验收**：`npx playwright test -c e2e/playwright.config.ts`（配置放在 `e2e/` 下必须带 `-c`，或在 package.json 里把它封成 `test:e2e` 脚本），打开报告按 `references/report-spec.md` 的验收清单逐条对照；不达标先修报告或用例，不要交付。

## mock 与真实接口切换

mock 只有一份来源，就是项目里的 MSW handlers；e2e 不复制、不改写 mock 逻辑。

```
src/mocks/
  ├── handlers/        # 按业务域拆的 handlers（唯一 mock 源）
  ├── browser.ts       # 浏览器端 setupWorker 启动入口
  └── server.ts        # 组件/单元测试用的 setupServer 入口
```

- e2e 执行时，dev server 以 `E2E_API_MODE=mock` 启动，应用加载即注册同源 handlers；e2e 用例只写业务操作，不感知 mock 细节
- `E2E_API_MODE` 必须由 Playwright 配置透传给 dev server（`webServer.env`），应用侧用同一环境变量决定是否启动 worker；透传缺失会静默走真实后端，是最常见的"mock 没生效"原因
- `E2E_API_MODE=real` 时 worker 不启动，请求打真实后端；`@regress` 子集在 real 模式下做发版回归/联调
- 未匹配请求设 `onUnhandledRequest: 'error'`（或显式白名单），禁止请求静默穿透形成"半 mock"
- mock 场景数据（空列表、异常、超时、无权限）由 handlers 按请求参数分支返回；用例只声明前置条件，不在测试里硬编码页面注入
- mock handlers 与真实接口契约保持同步；契约变更时 handlers 一起改，mock 长期偏离契约按技术债处理
- 登录态：mock 模式由 handlers 提供登录/会话接口；real 模式用预置账号或 `storageState`，不把账号密码写进用例

## 取证通道（mock 模式下接口证据不降级）

MSW 在浏览器内由 Service Worker 完成拦截，Playwright 的网络事件看不到这些请求；如果只依赖网络事件，mock 模式下失败场景的「接口报错」证据会缺失。因此接口证据改由页面内追踪 + fixture 回传，两个模式走同一条通道：

- fixture 在页面加载前注入请求追踪（`e2e/support/http-trace.ts`），在 `fetch` 与 `XMLHttpRequest` 层记录请求行、请求头、请求体、状态行、响应头、响应体；mock 与 real 模式、axios 与 fetch 客户端都覆盖
- fixture 用 `page.exposeBinding` 把每条记录实时转发给测试进程，写入失败证据容器（`e2e/support/evidence.ts` 的接口记录入口）；测试进程侧完成敏感头打码（`Authorization` / `Cookie` / `Set-Cookie` / `X-XSRF-TOKEN`）
- 非文本/流式响应不读全量正文，按类型与大小记摘要，避免阻塞用例
- 追踪脚本不改变应用行为，只旁路记录；采集失败不得影响用例结论
- 报告仍由脚本从测试结果、截图、证据直接生成，不允许任何 AI 润色或二次解读

## 用例写法（最容易写错的地方）

```ts
test('上传超过 20MB 的清单文件，应提示不能超过 20MB', async ({ page }, testInfo) => {
  scenario(testInfo, { id: 'IMP-004', domain: '贷款导入', branch: '文件校验' })
  await step(page, testInfo, '进入贷款导入页', () => page.goto('/import'))
  await step(page, testInfo, '选择 25MB 的清单文件上传，应提示文件超过 20MB', () =>
    page.setInputFiles('input[type=file]', 'fixtures/oversize.xlsx')
  )
  await expect(page.getByText(/20MB/)).toBeVisible()
})
```

- **标题**写业务结果，不写实现：写「批量删除后列表刷新」，不写「点击 #delete-btn 调用 DELETE 接口」。**标题必须写预期结果，不能写缺陷现状**——`test.fail()` 的已知缺陷也一样。反例：「重新上传后选择同一文件不触发解析」（描述的是 bug），正例：「重新选择同一份清单文件后可再次解析」。
- **步骤句子必须写「操作 + 应发生什么」**。报告在失败处截断，读者只看得到停下来的那一步；如果那一步只写「点击解析文件」，报告就无法回答「本来应该出现什么」。
  反例：`点击解析文件`。正例：`点击解析文件后，应提示文件超过 20MB`。
- **`scenario()` 是第一行**，`id` 是用例编号（模块前缀-序号，如 `PRJ-001`，模块前缀表由项目在 README 里约定），`domain` 是报告一级分组，`branch` 是二级分组。编号显式声明、不按行号生成，保证不随代码插入漂移；报告按编号展示并支持搜索。
- **不要设「错误与边界」「联调环境验证」这类横切域**：异常与边界用例归入所属业务模块的对应分支（如导入失败归「贷款导入」）；依赖真实后端预置数据的用例同样归属业务模块，mock 模式下为它们补等价 handlers 数据，让同一批用例两种模式都执行（是否打真实后端由 `E2E_API_MODE` 决定，不用目录区分）。
- **发版回归子集用 `@regress` 标签**：只读/无害类用例（查看、导出、列表、登录态）在 `test()` 签名上加 `{ tag: ['@regress'] }`，脚本封成 `test:e2e:regress`（内部 `E2E_GREP=@regress`）；回归目标（真实项目/贷款 id）用 `E2E_REGRESS_*` 环境变量注入 fixture 常量。
- **断言放在 `step()` 回调里或步骤之后**；`step()` 会等应用淡入、加载遮罩消失、字体就绪再截图，避免截到灰蒙蒙的中间态。
- **已知缺陷用 `test.fail()`** 保持规格断言。报告里它按「失败」展示并带完整证据，缺陷清单另记在项目的问题文档里，不要在报告里编「已知问题」分类。
- 步骤粒度对齐用户视角：一个用户动作一行，不要把「打开页面 + 展开筛选 + 输入关键字」塞成一行。

## 报告硬要求（验收必看）

- 状态只有 通过 / 失败 / 跳过 三种，不允许出现「已知问题」「关联问题」「规格依据」「失败原因分析」这类人工结论字段。
- 失败场景必须给出**原始证据**，分类为：控制台报错、接口报错、断言不符、脚本异常。
  接口证据要含请求行、请求头、请求体、状态行、响应头、响应体全量（敏感头打码）；接口 body 用可折叠 JSON 树，支持逐级展开、全部展开、复制。mock 与 real 模式的接口证据同等要求，不因 mock 而降级。
  断言证据要含断言源码原文、选择器、期望值、实际值、页面文案，并在失败截图里给断言目标叠红框。
- 报告是脚本从测试结果和截图直接生成的，不允许任何 AI 润色或二次解读。

## 适配新项目要改的地方

- `e2e/playwright.config.ts`：dev server 命令与端口、`E2E_PORT` 传递、`E2E_API_MODE` 透传给 dev server、报告/trace 输出目录、reporter 的 `mode` 取真实运行模式。
- `e2e/support/evidence.ts`：接口前缀（`E2E_API_PREFIX`，默认 `/api`）。
- `e2e/support/reporting.ts`：`waitForUiStable()` 里的应用外壳选择器与加载遮罩选择器，按项目实际 DOM 调整；调不好就会出现灰截图。
- `e2e/support/http-trace.ts`：一般不用改；接口若不走 fetch/XHR（如 WebSocket、SSE），另行补充采集，不得留空导致证据缺失。
- `e2e/support/test.ts`：叠加项目自己的登录 fixture，保留 fixture 内的请求取证注入与回传，不要用项目自有 fixture 整体覆盖 `page` 而丢掉取证通道。
- 项目 `src/mocks/browser.ts`：`E2E_API_MODE=mock` 时启动 worker，`real` 时不启动；确保 dev server 启动时能读到该环境变量。
- `.gitignore`：加 `playwright-report/`、`test-results/`、`.playwright-browsers/`；dev server 的 watch 忽略里也要加报告目录，否则报告写入会触发页面热更新噪音。
- 其他框架或原生项目：先在 SKILL.md frontmatter 的 `frameworks` 声明对应值（如 `["angular"]`），工具代码无需改动；未声明时按框架过滤后本 skill 不会加载。

## 常见坑

- **截图灰蒙蒙**：断言前就截图，或没等加载遮罩消失。截图要放在断言之后，并确保 `waitForUiStable` 的选择器匹配项目实际 DOM。
- **hash 路由**：`page.goto('/login')` 会落到默认页，要用 `page.goto('/#/login')` 或直接操作应用内导航。
- **mock 没生效**：`E2E_API_MODE` 没透传到 dev server、`mockServiceWorker.js` 404、浏览器缓存了旧 service worker、或 worker 首次注册后需刷新才接管。排查顺序：确认环境变量 → 清 service worker/缓存 → 重新导航 → 再跑。
- **半 mock**：未匹配请求被静默放行到真实后端。`onUnhandledRequest: 'error'` 打开，把漏配的 handlers 补齐。
- **接口证据为空**：请求追踪注入被项目自有 fixture 覆盖，或接口走了 fetch/XHR 之外的通道。保证 `page` fixture 链路完整，必要时在 `http-trace.ts` 补采集。
- **mock 与用例数据不一致**：handlers 缺少用例需要的分支。在 handlers 里按参数补场景数据，不要在测试里硬编码注入页面。
- **报告写入触发 dev server reload**：Vite 等会监听整个 root，把 `playwright-report/` 加进 watch ignore。
- **并行跑互相清空产物**：用 `E2E_REPORT_DIR` / `E2E_RESULT_DIR` 给每次运行独立目录，端口也用 `E2E_PORT` 注入。
- **失败现场截图拿不到**：必须在 `page` fixture 的 teardown 里截（页面还活着），不要写在共享模块的 `afterEach` 里。
- **不要给运行命令加 `--reporter=line/json`**：会覆盖自定义 reporter，报告直接不生成。

## 参考

- `references/report-spec.md`：报告版式、证据规则、JSON schema、验收清单。
- `assets/`：可直接拷贝的实现（reporter、证据采集、请求取证、fixture、config、README 模板）。
- `scripts/scaffold.mjs`：一键铺骨架。
