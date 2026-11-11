import type { Page, TestInfo } from '@playwright/test'

/**
 * 业务报告元信息与步骤采集。
 *
 * 报告不按测试类分组，而是按「业务域 → 业务场景 → 分支」组织，因此每个用例开头用
 * `scenario()` 声明业务归属；每个用户操作调用 `step()`，自动等待界面稳定、截一张
 * 只截当前视口的 JPEG，作为报告的“操作证明”。
 *
 * 使用示例：
 * ```ts
 * test('项目列表加载与关键字筛选', async ({ page }, testInfo) => {
 *   scenario(testInfo, { domain: '项目管理', branch: '列表筛选', precondition: '成员身份，列表返回 2 条项目' })
 *   await step(page, testInfo, '打开项目列表', () => gotoApp(page, '/projects'))
 *   await step(page, testInfo, '输入关键字「项目甲」', () => searchInput.fill('项目甲'))
 *   await step(page, testInfo, '点击搜索按钮', () => searchButton.click())
 *   await step(page, testInfo, '列表只显示命中的项目') // 断言之后再截图，确保数据已渲染
 * })
 * ```
 */

export type Severity = 'P0' | 'P1' | 'P2'

export interface ScenarioMeta {
/** 用例编号：模块前缀-序号（如 ORD-001），显式声明不随代码漂移 */
  id: string
  /** 业务域（报告一级分组）：如 登录与会话 / 项目管理 / 订单导入 / 审批流转 / 导出与批量操作 */
  domain: string
  /** 业务分支或链路，如 关键字搜索、详情查看、批量操作 */
  branch?: string
  /** 前置条件，一句话说明数据与身份前提 */
  precondition?: string
  severity?: Severity
}

/** 声明当前用例的业务归属；放在用例体第一行 */
export function scenario(testInfo: TestInfo, meta: ScenarioMeta): void {
  if (!/^[A-Z]{2,4}-\d{3}$/.test(meta.id)) {
    throw new Error(`scenario() 编号不合法：${meta.id}，应为 模块前缀-三位序号（如 ORD-001）`)
  }
  testInfo.annotations.push({ type: 'domain', description: meta.domain })
  testInfo.annotations.push({ type: 'case-id', description: meta.id })
  if (meta.branch) testInfo.annotations.push({ type: 'branch', description: meta.branch })
  if (meta.precondition) {
    testInfo.annotations.push({ type: 'precondition', description: meta.precondition })
  }
  if (meta.severity) testInfo.annotations.push({ type: 'severity', description: meta.severity })
}

const STEP_PREFIX = '步骤 '
const LOADING_SELECTORS = [
  '.el-loading-mask',
  '.el-loading-spinner',
  '.v-loading-mask',
  '.ant-spin-spinning'
]

/**
 * 等界面稳定后再截图，避免截到加载遮罩/首屏渐变/路由切换中间态（灰蒙蒙）。
 * 判据：应用外壳已完成淡入、启动遮罩已移除、路由页面内容已渲染出文字。
 * 不强制 networkidle，避免拖慢用例；数据是否到位由用例里的断言保证。
 */
export async function waitForUiStable(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const app = document.getElementById('app')
        if (!app) return false
        const style = getComputedStyle(app)
        if (style.display === 'none' || Number(style.opacity || '1') < 0.99) return false
        if (document.getElementById('appLoading')) return false
        const view = document.querySelector('#app .layout-main > *, #app .login-page')
        if (!view) return false
        return (view.textContent || '').replace(/\s/g, '').length > 10
      },
      { timeout: 8_000 }
    )
    .catch(() => undefined)
  await page
    .waitForFunction(
      selectors => !selectors.some(selector => document.querySelector(selector)),
      LOADING_SELECTORS,
      { timeout: 8_000 }
    )
    .catch(() => undefined)
  await page
    .evaluate(async () => {
      const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts
      if (fonts?.ready) await fonts.ready
    })
    .catch(() => undefined)
  await page
    .evaluate(
      () =>
        new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(), 120)))
        })
    )
    .catch(() => undefined)
}

/**
 * 记录一个报告步骤：执行操作（可选）→ 等界面稳定 → 截当前视口 → 挂到报告附件。
 * 步骤名用自然语言描述用户操作，例如「点击搜索按钮」「填写借款人名称」。
 */
export async function step(
  page: Page,
  testInfo: TestInfo,
  description: string,
  action?: () => Promise<unknown>
): Promise<void> {
  if (action) await action()
  await waitForUiStable(page)
  const index =
    testInfo.attachments.filter(attachment => attachment.name.startsWith(STEP_PREFIX)).length + 1
  const body = await page.screenshot({
    type: 'jpeg',
    quality: 55,
    animations: 'disabled',
    caret: 'hide',
    fullPage: false
  })
  await testInfo.attach(`${STEP_PREFIX}${String(index).padStart(2, '0')} · ${description}`, {
    body,
    contentType: 'image/jpeg'
  })
}
