---
name: frontend-e2e
description: 面向 Vue / React 前端项目的 Playwright 端到端测试与业务报告体系。搭 e2e 目录、按「业务域 → 业务分支 → 场景」组织用例、每步自然语言 + 截图、失败自动收集控制台/接口/断言证据、mock 复用项目 MSW handlers 并用 E2E_API_MODE 切换真实后端，跑完生成「人看的两级 HTML 报告 + 机器/AI 读的 JSON」。当用户说「给这个前端项目搭 e2e」「接入 Playwright」「端到端测试」「验收/回归/测试报告」「把用例结果整理成业务报告」时使用，即使没点名 Playwright 或报告也要用；只要涉及前端端到端测试的组织方式与结果呈现，就属于本 skill 的范围。
capabilities: ["e2e-testing"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
boundary_hints:
  directories: ["e2e/", "src/mocks/handlers/", "src/mocks/fixtures/"]
---

# 前端 e2e：业务场景测试与报告

目标不是「跑绿一批用例」，而是让开发、测试、产品能直接读懂：哪些业务场景通过、哪些有问题、问题出在哪个业务分支、复现路径是什么、失败时控制台和接口到底返回了什么。

## 交付要求（最低基准）

| 项 | 要求 |
|----|------|
| 用例脚本 | 交付可执行的用例脚本：`e2e/` 目录、Playwright 配置、reporting 层（报告生成器与路径解析）、scripts 层（启动器与辅助脚本）、support 层（证据采集 / fixture）、按「scenario + step」组织的用例；脚本能直接按 README 命令跑起来；涉及 mock 数据变更的，附真实接口溯源记录与 mock / real 双模式一致性证据（契约定义档的数据集除外，须标 unverified 并登记到 `e2e/README.md` 的待补数据集） |
| 执行报告 | 实际执行过并产出报告：`e2e/reports/playwright-report/index.html` 与 `e2e/reports/playwright-report/report-data.json` 均存在（真实模式在 `.../real/` 下），报告满足下文硬要求；截图 / trace 等运行痕迹在系统临时目录、不进仓库；只写不跑不算完成 |

## 产出物长什么样

一次运行产出两份，同源、不重复维护：

- `e2e/reports/playwright-report/index.html`：给人看。**列表页**按「业务域 → 业务分支 → 场景」缩进分组，场景行带用例编号，状态只有 通过 / 失败 / 跳过；**详情页**是该场景的自然语言操作步骤，一步一句话 + 一张截图，失败场景在出错那一步标红，下面给失败证据；从详情返回列表回到原位置并高亮来源行。
- `e2e/reports/playwright-report/report-data.json`：给 CI 和 AI Agent 读。带 `schemaVersion`、`schema`（字段说明）、`summary`、`scenarios[]`，失败场景 `error.raw` 保留接口请求响应全量、控制台记录、断言源码与堆栈，`mode` 字段标明本轮是 mock 还是 real。
- 报告生成时把每步截图复制进报告 `assets/`，报告自包含；运行痕迹在系统临时目录，被系统清掉也不影响看图。

详细版式、证据规则、验收清单见 `references/report-spec.md`，落地新项目前先读一遍。

## 前置

- `@playwright/test` 作为项目 devDependency 安装（按项目包管理器安装，如 `pnpm add -D @playwright/test`）。
- 项目 `package.json` 带 `"type": "module"`：配置与 e2e 脚本按 ESM 加载，缺了会在加载 config 时报 `import.meta` 相关错误。

## 落地步骤

1. **侦察**：确认前端框架、dev server 启动命令与端口、接口前缀（默认 `/api`）、登录方式（真实账号 / 预置登录态）、项目 mock 层位置（MSW handlers 目录与启动入口）、以及 dev server 代理配置。这些决定了 `playwright.config.ts` 与 fixture 怎么改。
2. **铺骨架**：执行 `node scripts/scaffold.mjs --target <项目根>`，把报告生成器与路径解析（`e2e/reporting/`）、启动器与辅助脚本（`e2e/scripts/`）、证据采集、请求取证、fixture、配置、README 模板拷到 `<项目>/e2e/` 下（同时拷入 `e2e/support/mock-from-real.mjs`，用于把真实响应转成 fixture 与溯源记录），并建好空的 `e2e/specs/` 与 `e2e/fixtures/`；已存在的文件不会覆盖。
3. **接数据源**：报告结构不关心数据从哪来，但数据集来源受下文「mock 数据来源：真实接口优先」约束；mock 与真实后端走同一条链路切换。
   - mock 模式：复用项目既有 MSW handlers（单一 mock 源，handlers 独立目录，dev、e2e、组件测试共用）。e2e 侧不另写任何网络拦截。
   - real 模式：不启动 mock worker，请求经 dev server 代理打真实后端，用于联调与发版回归。
   - 两种模式由 `E2E_API_MODE=mock|real` 切换，见下文「mock 与真实接口切换」。
4. **写用例**：写用例前先确认所需 mock 数据已按真实响应转换完成（见下文「mock 数据来源」），不要边写用例边按页面需要补数据。一条 `test` 一条业务场景，第一行 `scenario()` 声明业务域与业务分支，每个操作一行 `step()`。写法见下一节。
5. **跑并验收**：首次运行先 `npm run test:e2e:install` 安装浏览器（装到 Playwright 默认缓存目录，跨项目复用）；再 `npm run test:e2e`（脚本内部调 `e2e/scripts/run-e2e.mjs`；不要从仓库根直接跑 `npx playwright test`），打开 `e2e/reports/playwright-report/index.html` 按 `references/report-spec.md` 的验收清单逐条对照；不达标先修报告或用例，不要交付。

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
- mock 场景数据先按下一节取真实响应再转成 handlers 分支数据；这些场景数据（空列表、异常、超时、无权限）由 handlers 按请求参数分支返回；用例只声明前置条件，不在测试里硬编码页面注入
- mock handlers 与真实接口契约保持同步；契约变更时 handlers 一起改，mock 长期偏离契约按技术债处理
- 登录态：mock 模式由 handlers 提供登录/会话接口；real 模式用预置账号或 `storageState`，不把账号密码写进用例

## mock 数据来源：真实接口优先

新增或修改用例需要动 `src/mocks/` 下的 handlers / fixtures 数据时，数据必须来自真实接口响应，不得按页面需要想象。本节约束的是数据与场景分支；mock 的运行逻辑（worker 注册、拦截实现、序列化）不在维护范围，仍按上一节要求只维护一份。

**来源分级**（按优先级取第一个可用的）：

1. **本地**：本机启动的后端（dev server 代理目标，或按项目配置定位的本地服务）
2. **测试环境**：项目既有测试环境，地址与凭证从环境配置读，不得写进用例或脚本
3. **契约定义**：OpenAPI / TS 类型 / 变更说明，仅前两档都取不到时使用

本地优先不是图省事：接口契约刚改时，只有本地是新代码，测试环境很可能还是旧契约，拿旧响应当新 mock 比不取数更危险。用到第 3 档时，须在溯源记录里标注「未验证来源」（用脚本转换时会自动写 `unverified: true`），并列入待补数据集（记在项目 `e2e/README.md` 的「待补数据集」小节）。

**取数**：

- 用项目既有的接口调试方式取完整响应：正常、空列表、异常分支分别取真实返回；取不到的异常分支按下面「转换」的推导规则处理
- 凭证从环境变量或项目既有配置读；`Authorization` / `Cookie` 等敏感头不落盘
- 原始响应脱敏后与 fixtures 一起提交，作为可 diff 的取数证据

**转换**（真实响应 → mock 数据）：

- 照抄：字段名、嵌套层级、字段类型、枚举取值全集、分页结构、空值形态（`null`、缺字段、空数组是三件事，不得互换）
- 只允许替换两类值：敏感值（token、个人信息）与易变值（id、时间戳）；替换后保持原类型（字符串仍是字符串、数字仍是数字）。`--freeze` 的具体规则：ISO 日期时间 → 固定时间、纯日期 → 固定日期、纯数字串 → 同长度递增编号、数字 → 递增编号、其他字符串 → `FIXED-001` 递增
- 需要保持特定格式的值（uuid、业务编码、金额串）不要用 `--freeze`：用 `--scrub` 脱敏后在 fixture 里手工改成符合格式的稳定值，或直接编辑 fixture；冻结只保证同一条 `--freeze` 路径内不重复（多条路径各自从 `FIXED-001` 起，跨路径可能重复），也不保证格式还原。需要跨字段唯一的 id，用 `--scrub` 后手工改成稳定且唯一的值
- 不得新增真实响应里不存在的字段，不得把可选字段写成必有，不得按前端期望改字段名或层级
- 多态字段与枚举：保留真实响应里出现过的取值全集；用例只命中其中一个值时，不得只保留那个值
- 异常 / 空列表分支取不到真实响应时，沿用真实正常响应的信封（字段名、层级、分页结构、`null` 形态），只允许数组为空或错误码 / 提示文案不同，并在溯源记录里写清推导依据

**溯源记录**（随代码提交）：

每个新增或修改的数据集在 `src/mocks/fixtures/` 下留一份 `<名称>.source.json`，含 5 项：

| 项 | 内容 |
|----|------|
| 接口 | 方法与路径 |
| 来源 | 来源类型（本地 / 测试环境 / 契约定义）+ 环境标识；契约定义档脚本会自动写 `unverified: true` |
| 取数时间 | ISO 时间 |
| 替换 | 被替换的字段路径清单（无则空数组） |
| 脱敏原文 | 脱敏后的真实响应原文 |

生成优先用脚本，联网与离线两种形态都能产出完整 5 项溯源：

```bash
# 联网取数
node e2e/support/mock-from-real.mjs --url /api/xxx --base-url $BASE_URL --token-env TOKEN --source-type local --out src/mocks/fixtures/xxx.json
# 已有保存好的响应文件时离线转换（离线也要带 --source-type 与 --out）
node e2e/support/mock-from-real.mjs --response saved-response.json --url /api/xxx --source-type local --out src/mocks/fixtures/xxx.json
```

离线模式下的 `--url` 只用于记录接口路径、不发起请求；不传则溯源里的「接口」一项为空，脚本会打提示不报错。需要脱敏或冻结时用 `--scrub <路径>` / `--freeze <路径>`：路径未命中任何字段时脚本以退出码 2 失败且不写文件，避免溯源谎称已脱敏。脚本只做替换、冻结与溯源，不改字段结构。

**一致性验收**：

- 涉及 mock 变更的场景在 mock 与 real 两种模式下各跑一次，两次断言结果一致；不一致时以真实响应为准修 mock，不得改用例断言迁就 mock
- 跑 real 之前先确认 webServer 真以 `E2E_API_MODE=real` 启动：复用已有服务或 `E2E_SKIP_WEBSERVER` 时，服务可能仍以 mock 模式运行，此时的 real 运行无效
- 只跑受影响场景（`E2E_GREP` 或单个 spec）或只读 `@regress` 子集，避免写操作污染共用环境
- 证据形态：取数与转换命令 + mock 与 real 两次运行的报告路径（`e2e/reports/playwright-report/index.html` 与 `e2e/reports/playwright-report/real/index.html`）

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
  scenario(testInfo, { id: 'ORD-004', domain: '订单导入', branch: '文件校验' })
  await step(page, testInfo, '进入订单导入页', () => page.goto('/import'))
  await step(page, testInfo, '选择 25MB 的清单文件上传，应提示文件超过 20MB', () =>
    page.setInputFiles('input[type=file]', 'fixtures/oversize.xlsx')
  )
  await expect(page.getByText(/20MB/)).toBeVisible()
})
```

- **标题**写业务结果，不写实现：写「批量删除后列表刷新」，不写「点击 #delete-btn 调用 DELETE 接口」。**标题必须写预期结果，不能写缺陷现状**——`test.fail()` 的已知缺陷也一样。反例：「重新上传后选择同一文件不触发解析」（描述的是 bug），正例：「重新选择同一份清单文件后可再次解析」。
- **步骤句子必须写「操作 + 应发生什么」**。报告在失败处截断，读者只看得到停下来的那一步；如果那一步只写「点击解析文件」，报告就无法回答「本来应该出现什么」。
  反例：`点击解析文件`。正例：`点击解析文件后，应提示文件超过 20MB`。
- **`scenario()` 是第一行**，`id` 是用例编号（模块前缀-序号，如 `ORD-001`，模块前缀表由项目在 README 里约定），`domain` 是报告一级分组，`branch` 是二级分组。编号显式声明、不按行号生成，保证不随代码插入漂移；报告按编号展示并支持搜索。
- **不要设「错误与边界」「联调环境验证」这类横切域**：异常与边界用例归入所属业务模块的对应分支（如导入失败归「订单导入」）；依赖真实后端预置数据的用例同样归属业务模块，mock 模式下按真实响应为它们转出等价的 handlers 数据，让同一批用例两种模式都执行（是否打真实后端由 `E2E_API_MODE` 决定，不用目录区分）。
- **发版回归子集用 `@regress` 标签**：只读/无害类用例（查看、导出、列表、登录态）在 `test()` 签名上加 `{ tag: ['@regress'] }`，脚本封成 `test:e2e:regress`（内部 `E2E_GREP=@regress`）；回归目标（真实环境里的业务对象 id）用 `E2E_REGRESS_*` 环境变量注入 fixture 常量。
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

- `e2e/playwright.config.ts`：dev server 命令与端口、`E2E_API_MODE` 透传给 dev server、reporter 的 `mode` 取真实运行模式。报告与痕迹路径由 `e2e/reporting/paths.mjs` 决定，不要在 config 里另写路径公式。
- `e2e/reporting/paths.mjs`：报告根、痕迹根与环境变量覆盖语义的唯一实现；一般不用改。`E2E_REPORT_DIR` 显式覆盖报告输出（此时不再叠加 `real/`），两个 env 若是相对路径按 `e2e/` 目录解析，绝对路径原样使用。
- `e2e/support/evidence.ts`：接口前缀（`E2E_API_PREFIX`，默认 `/api`）。
- `e2e/support/reporting.ts`：`waitForUiStable()` 里的应用外壳选择器与加载遮罩选择器，按项目实际 DOM 调整；调不好就会出现灰截图。
- `e2e/support/http-trace.ts`：一般不用改；接口若不走 fetch/XHR（如 WebSocket、SSE），另行补充采集，不得留空导致证据缺失。
- `e2e/support/test.ts`：叠加项目自己的登录 fixture，保留 fixture 内的请求取证注入与回传，不要用项目自有 fixture 整体覆盖 `page` 而丢掉取证通道。
- 项目 `src/mocks/browser.ts`：`E2E_API_MODE=mock` 时启动 worker，`real` 时不启动；确保 dev server 启动时能读到该环境变量。
- 项目 `src/mocks/`：新增或修改 mock 数据时按「mock 数据来源」取数并留溯源记录；mock 数据目录随项目既有布局，e2e 侧不另建一份。
- `.gitignore`：加 `e2e/reports/`，并保留兜底项 `test-results*/`、`playwright-report*/`、`blob-report/`；dev server 的 watch 忽略里加 `e2e/reports/`，否则报告写入会触发无意义的整页刷新。
- 其他框架或原生项目：先在 SKILL.md frontmatter 的 `frameworks` 声明对应值（如 `["angular"]`），工具代码无需改动；未声明时按框架过滤后本 skill 不会加载。

## 常见坑

- **截图灰蒙蒙**：断言前就截图，或没等加载遮罩消失。截图要放在断言之后，并确保 `waitForUiStable` 的选择器匹配项目实际 DOM。
- **hash 路由**：`page.goto('/login')` 会落到默认页，要用 `page.goto('/#/login')` 或直接操作应用内导航。
- **mock 没生效**：`E2E_API_MODE` 没透传到 dev server、`mockServiceWorker.js` 404、浏览器缓存了旧 service worker、或 worker 首次注册后需刷新才接管。排查顺序：确认环境变量 → 清 service worker/缓存 → 重新导航 → 再跑。
- **半 mock**：未匹配请求被静默放行到真实后端。`onUnhandledRequest: 'error'` 打开，把漏配的 handlers 补齐。
- **接口证据为空**：请求追踪注入被项目自有 fixture 覆盖，或接口走了 fetch/XHR 之外的通道。保证 `page` fixture 链路完整，必要时在 `http-trace.ts` 补采集。
- **mock 数据与真实不符 / handlers 缺分支**：新增数据前先按「mock 数据来源」取真实响应再转，handlers 按参数挂该数据，不要在测试里硬编码注入页面；real 模式跑同一用例失败或字段缺失，通常就是 mock 凭想象写的。
- **Vite 监听报告目录**：必须把 `e2e/reports/` 加进 watch ignore，否则每次写报告都会触发无意义的 full-reload。
- **并行跑互相覆盖产物**：运行痕迹按端口分目录（`run-e2e.mjs` 自动挑端口），并行运行互不可见；一次性验证要单独出报告时用 `E2E_REPORT_DIR=$(mktemp -d)`，不要写进仓库。
- **从仓库根直接跑 `npx playwright test`**：没有 config 时 Playwright 默认把 `test-results/` 落在仓库根，报告也不会生成；一律 `npm run test:e2e`。
- **失败现场截图拿不到**：必须在 `page` fixture 的 teardown 里截（页面还活着），不要写在共享模块的 `afterEach` 里。
- **不要给运行命令加 `--reporter=line/json`**：会覆盖自定义 reporter，报告直接不生成。
- **假 real**：复用已有 dev server 或设置 `E2E_SKIP_WEBSERVER` 时，服务可能仍以 mock 模式运行，此时 `E2E_API_MODE=real` 的「real 复跑」实际跑的是 mock，一致性验收会假通过。跑前确认 webServer 的启动命令带 `E2E_API_MODE=real`，或重启服务再跑。

## 参考

- `references/report-spec.md`：报告版式、证据规则、JSON schema、验收清单。
- `assets/`：可直接拷贝的实现（reporter、证据采集、请求取证、fixture、config、README 模板、mock 取数转换脚本 mock-from-real.mjs）。
- `assets/run-e2e.mjs` / `open-report.mjs` / `install-browsers.mjs` / `check-case-ids.mjs`：启动器（用例编号预检、端口隔离、过期痕迹清理）、打开报告、安装浏览器、用例编号唯一性检查。
- `scripts/scaffold.mjs`：一键铺骨架。
