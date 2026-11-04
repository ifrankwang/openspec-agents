# e2e（Playwright）

面向业务场景的端到端测试。跑完自动生成两级业务报告：场景列表（业务域 → 业务分支 → 场景）→ 场景详情（操作步骤 + 截图 + 失败证据）。

## 命令

```bash
# mock 模式（默认）：复用项目 src/mocks 下的 MSW handlers，不依赖真实后端
npx playwright test -c e2e/playwright.config.ts

# real 模式：不启动 mock worker，请求经 dev server 代理打真实后端（联调 / 发版回归）
E2E_API_MODE=real npx playwright test -c e2e/playwright.config.ts

# 只跑发版回归子集（real 模式常用）
E2E_API_MODE=real E2E_GREP=@regress npx playwright test -c e2e/playwright.config.ts

npx playwright show-report playwright-report        # 打开报告
npm run test:e2e:install  # 安装浏览器（沙箱环境建议装到仓库内目录）
```

不要给运行命令追加 `--reporter=line/json`，会覆盖自定义 reporter，报告不会生成。

## 数据源：mock / real

- mock 只有一份来源：项目 `src/mocks/handlers/`（开发、e2e、组件测试共用）。e2e 不另写网络拦截，需要新场景数据就在 handlers 里补分支
- `e2e/playwright.config.ts` 把 `E2E_API_MODE` 透传给 dev server；应用侧读同值环境变量（Vite 项目通常是 `VITE_API_MODE`）决定是否启动 mock worker。透传缺失会静默走真实后端
- `real` 模式必须显式设置 `E2E_API_MODE=real`；登录态用预置账号或 `storageState`，不把账号密码写进用例
- 未匹配请求应配置为报错（`onUnhandledRequest: 'error'`），禁止静默穿透形成"半 mock"

## 失败取证

- `e2e/support/http-trace.ts` 由 fixture 在页面加载前注入，在 fetch / XHR 层记录请求与响应，再回传测试进程；mock 模式下（MSW 在浏览器内拦截）接口证据因此不缺失
- 项目自有 fixture 可以叠加登录等能力，但不要整体覆盖 `page` fixture，否则取证通道会丢

## 写法

```ts
test('上传超过 20MB 的清单文件，应提示不能超过 20MB', async ({ page }, testInfo) => {
  scenario(testInfo, { id: 'IMP-001', domain: '贷款导入', branch: '文件校验' })
  await step(page, testInfo, '进入贷款导入页', () => page.goto('/import'))
  await step(page, testInfo, '选择 25MB 的清单文件上传，应提示文件超过 20MB', () =>
    page.setInputFiles('input[type=file]', 'fixtures/oversize.xlsx')
  )
  await expect(page.getByText(/20MB/)).toBeVisible()
})
```

规则：

1. 一个 test 就是一条业务场景，标题写业务结果，不写实现细节。
2. 用例第一行 `scenario()` 声明业务域和业务分支，报告据此分组。
3. 每个操作一行 `step()`，句子必须是「操作 + 应发生什么」，失败时报告停在这一步，读者看它就知道预期。
4. 断言放在步骤之后或步骤回调里；`step()` 会等页面稳定再截图。
5. 已知缺陷用 `test.fail()` 保持规格断言，报告里按「失败」展示并附证据。
6. 新增业务域在报告里自动出现，不需要改 reporter。

## 报告

- `playwright-report/index.html`：给人看，列表页 + 详情页。
- `playwright-report/report-data.json`：给机器/AI Agent 读，含 `schemaVersion`、`schema` 字段说明、失败场景的 `error.raw`，`mode` 标明本轮是 mock 还是 real。
- 两个目录都已 gitignore，并在 dev server 的 watch 忽略里，避免报告写入触发页面热更新噪音。
