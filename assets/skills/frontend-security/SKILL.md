---
name: frontend-security
description: 前端安全规范——XSS 输出审查、发布产物禁带 sourcemap、敏感信息禁入 localStorage、依赖漏洞扫描、CSP、postMessage 校验。security-baseline 的前端配套。
capabilities: ["security"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 security-baseline 的前端实现配套，仅含前端技术栈特有的实现细节。通用安全审查基线见 security-baseline。调用本 skill 须同时加载 security-baseline。

## XSS 输出审查

- 禁止用 `v-html` / `dangerouslySetInnerHTML` / `innerHTML` / `outerHTML` / `document.write` 渲染用户可控内容 → High
- 确需渲染富文本时，先经 DOMPurify 白名单过滤再渲染，禁止"先拼接后过滤"（拼接过程已可执行）→ 未过滤 High
- 模板/JSX 插值默认转义，普通文本一律用插值；禁止为省事用 `v-html` 输出纯文本
- URL 类输出（`href` / `src` / `window.open`）校验协议白名单（http/https/mailto），禁止 `javascript:` / `vbscript:`；`data:` 仅允许图片场景
- 拼接 HTML 字符串的依赖组件（地图信息窗、富文本编辑器回显、第三方 SDK）按同一标准审查，不能因"库的行为"免责
- 第三方脚本加载加 `integrity` + `crossorigin`（SRI）；关键页面禁止引入来源不明的外链脚本
- 服务端返回的错误信息/富文本同样按不可信内容处理，不在前端直接 innerHTML 注入

## 发布产物禁带 sourcemap

- 生产构建 `sourcemap: false`；若为线上排障保留，构建后上传到内部错误监控平台并从发布产物删除
- 验收：`find dist -name '*.map'` 为空；CI 增加该项校验
- 禁止把 `.map` 提交仓库、打进 Docker 镜像或部署到静态资源目录 → 出现即 High（源码与内部逻辑泄露）
- `build.sourcemap: 'hidden'` 仍会产出文件，必须配合上传后删除，不得直接发布

## 敏感信息禁入 localStorage

- token / refresh token / 用户敏感数据禁止存 `localStorage` 与 `sessionStorage` → High
- 会话优先 httpOnly + Secure + SameSite cookie；如确需前端持有 token，须说明威胁模型并做短时效 + 可撤销
- 禁止把 token、手机号、身份证号、地址等写进 URL 参数、日志、错误上报 payload
- 埋点/监控上报前做字段白名单，禁止整对象/整个 store 上报
- 前端环境变量（`VITE_` 前缀）会打进产物 → 禁止放密钥、口令；密钥只能在后端/网关
- 页面上的敏感信息展示按需脱敏（如身份证、手机号中间位打码），不整串回显

## 依赖漏洞扫描

- 命令：`pnpm audit --prod --audit-level=high`；CI 对 High/Critical 阻断
- 未修复的 High/Critical 漏洞 → 至少 High；有记录的漏洞豁免须留理由与复核期限
- 锁文件必须提交；禁止用浮动版本或 `latest` 绕过已修复版本
- 新增依赖审查维护活跃度、许可证、体积；禁止引入无人维护且与既有能力重复的包
- 传递依赖漏洞同样处理，通过 `pnpm.overrides` 钉版并验证兼容后复扫

## CSP

- 生产必须启用 Content-Security-Policy（响应头优先；meta 仅作过渡）→ 缺失 High
- 推荐基线：

```
default-src 'self';
script-src 'self' 'nonce-<随机值>';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
connect-src 'self' https://<api-domain>;
frame-ancestors 'none';
object-src 'none';
base-uri 'self';
```

- 禁止 `script-src` 出现 `'unsafe-eval'`；`'unsafe-inline'` 仅 style 可用且须有理由（Vue 运行时编译、内联样式）
- 上线先以 `Content-Security-Policy-Report-Only` 试跑，收集违规并收敛后再切强制
- 与后端安全响应头（`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`）协同，避免互相冲突或重复
- CSP 是纵深防御，不替代输出编码与净化

## postMessage 校验

- 接收方必须校验 `event.origin` 白名单 + `event.source`（预期窗口/iframe）→ 未校验 High
- 禁止省略 origin 判断或用 `event.origin === '*'`；来自 iframe/父窗口的数据按不可信输入处理，做结构与类型校验
- 发送方 `targetOrigin` 必须显式指定，禁止 `'*'`；携带敏感数据时用 `'*'` → High
- 通道建立时校验一次不等于长期可信：后续每条消息仍须校验，会话标识/权限变更后重新校验
- 消息处理函数不得直接执行消息内容（`eval` / `new Function` / 动态 `import` 消息中的地址）

## 其他前端安全面

- 文件上传前端校验（类型/大小）只作体验兜底，服务端必须复核；文件名不参与服务端路径拼接
- 下载链接禁止用用户可控文件名直接拼接；`Content-Disposition` 由服务端控制
- 路由守卫只做导航与体验控制，权限判定以服务端为准；前端隐藏入口不等于安全
- 错误上报/日志禁止携带完整请求体、响应体中的凭据与个人信息
- iframe 嵌入第三方内容时配置 `sandbox`，仅开放必要能力
- 剪贴板、摄像头、地理位置等敏感 API 使用前有明确用户动作触发，不静默调用
- WebSocket 鉴权在建立连接时校验，消息体做结构校验；禁止把 token 放 URL query
