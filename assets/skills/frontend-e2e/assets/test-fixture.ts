import { test as base } from '@playwright/test'
import type { Response } from '@playwright/test'
import {
  attachFailureEvidence,
  collectEvidence,
  ingestHttpRecord,
  markHttpTraceActive,
  type HttpTraceRecord
} from './evidence'
import { installHttpTrace } from './http-trace'

/**
 * 公共 fixture：失败时自动留「失败现场截图 + 失败证据」，并打通 mock 模式下的接口取证通道。
 *
 * 为什么取证要走页面内追踪：mock 由 MSW 在浏览器内（Service Worker）完成拦截，
 * Playwright 的网络事件看不到这些请求。fixture 在页面加载前注入 http-trace，
 * 再用 exposeBinding 把请求/响应回传给测试进程，写入证据容器，接口证据因此不降级。
 *
 * 这里只做报告需要的事；登录、测试数据等由各项目自己的 fixture 叠加，
 * 但不要整体覆盖 page fixture 而丢掉取证通道。
 */
export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const evidence = collectEvidence(page)

    markHttpTraceActive(page)
    await page.exposeBinding('__E2E_HTTP_TRACE__', (_source: unknown, record: HttpTraceRecord) => {
      ingestHttpRecord(page, record)
    })
    await page.addInitScript(installHttpTrace)

    await use(page)

    const failed =
      testInfo.status === 'failed' ||
      testInfo.status === 'timedOut' ||
      testInfo.expectedStatus === 'failed'
    if (!failed) return
    await attachFailureEvidence(page, testInfo, evidence)
  }
})

export { expect } from '@playwright/test'

export type { Response }
