---
name: security-baseline
description: 数据安全通用审查基线。不限于所列维度。凭证管理、日志脱敏、注入防护、文件上传、LLM 调用安全、认证与会话、CORS、错误信息泄露、速率限制、XSS 输出编码。
capabilities: ["security"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本文列出**最低审查基线**，不限于所列维度。AI 审查时必须结合自身安全知识做拓展覆盖，下列任何可能遗漏的安全维度均须纳入审查。

## 凭证管理

- API Key / Token / 密码从环境变量或外部配置中心读取，禁止在代码、配置文件、注释中硬编码
- 跨环境凭证一致性：dev/staging/prod 各环境的凭证须与对应配置文件一致
- 敏感文件（.env / .secrets）不得提交仓库，已提交者立即轮换并移除
- 定期轮换密钥，禁止使用默认/弱凭据
- API Key / Token / 敏感标识通过 HTTP Header（`Authorization` / `X-API-Key`）或 Body 传递，禁止通过 GET 查询参数传递（防日志泄露、URL 缓存、Referrer 外泄）

## 日志脱敏

- 禁止在日志中输出：密码、Token、API Key、身份证号、手机号、银行卡号等 PII 和认证凭据
- 生产环境关闭请求/响应详细日志（如 LLM 调用的 log-requests / log-responses）
- 使用参数化日志 API 构造日志消息，禁止字符串拼接引入敏感数据
- 审计日志须脱敏后落盘

## 外部调用超时与重试

- 所有 HTTP / LLM / 消息队列 / RPC 调用必须有超时配置，不允许无超时的阻塞等待
- 循环内同步外部调用必须在循环层级之上做批量聚合或异步并发；循环内逐条同步调用视为 High 级别问题
- 外部调用须有重试策略（含退避与熔断），避免无限制重试

## 文件上传安全

- 限制上传文件大小，配置级别限流
- 按项目实际需求校验 MIME / Content-Type，不准使用与项目无关的硬编码白名单
- 上传接口对外暴露时必须有鉴权，内部接口也应有来源校验
- 文件存储路径须防路径遍历（使用随机名或用户 ID 隔离，不使用用户传入文件名）
- 上传文件存入非执行目录，防止 RCE

## 数据访问注入防护

- 所有 SQL / NoSQL / GraphQL 查询必须使用参数化绑定或预编译 API，严禁字符串拼接
- 白名单校验 + 参数化 API 双重防御，不依赖黑名单/转义
- 批量查询或 JOIN 替代循环内逐条查询（N+1 防范）
- 状态/类别等确定性标记优先使用枚举映射，不在业务代码中判断魔数

## LLM 调用安全

- API Key 从环境变量读取，禁止硬编码
- 生产环境关闭 prompt/response 详细日志
- 调用必须有超时配置；循环内调用 LLM 必须异步或有超时保护
- 自动化测试仅断言响应结构（JSON schema / HTTP status），不断言 LLM 输出内容
- 防 prompt injection：不将用户输入直接拼入 system prompt，对用户消息做输入边界隔离

## 认证与会话安全

- JWT：签名密钥强度合规，token 有过期时间，payload 不存放敏感数据
- cookie-based auth 必须启用 CSRF 防护
- 会话有超时策略（空闲超时 + 绝对超时）
- 认证凭据不出现在 URL 参数、日志、response body 中
- 密码传输必须加密（HTTPS），存储须加盐哈希
- 登录/OTP 类端点禁止暴露用户存在/不存在差异（枚举攻击防护）

## CORS 与安全响应头

- CORS：不允许 `Access-Control-Allow-Origin: *` 与凭据（credentials: include）同时使用
- 至少配置：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY/SAMEORIGIN`、`Content-Security-Policy`
- 默认拒绝，白名单放行特定 origin

## 错误处理与信息泄露

- 生产环境禁止输出 stack trace、SQL 语句、内部文件名路径等内部结构信息
- 统一错误响应体，不暴露用户是否存在、数据库结构等枚举信息
- 调试接口、管理接口、Swagger UI 在生产路由不得注册

## 输入校验（跨注入类型）

- 系统性覆盖各注入面：SQL 注入、命令注入（Shell 拼接）、路径遍历（文件路径拼接）、模板注入、NoSQL 注入
- 统一防御原则：白名单校验 + 安全 API（参数化/转义），不依赖黑名单
- 输入长度限制，对数值、枚举、文件扩展名等字段采用白名单校验

## 速率限制

- 登录、注册、密码重置、OTP 验证等认证类接口必须限流
- 通用 API 建议按用户/资源维度限流，防批量爬取
- 限流触发后返回 429 + Retry-After 头

## 输出编码（XSS 防护）

- 数据出站时按输出上下文做编码：HTML entity、JS 字符串、URL、CSS 上下文各有不同
- 禁止将用户可控内容直接拼入 HTML / XML / JavaScript / CSS 输出
- 文件下载 Content-Disposition 中的文件名须过滤或编码，防反射 XSS
- JSON API 响应中的字符串须做上下文安全编码

## 第三方依赖安全（SCA）

- 定期扫描项目依赖中的已知漏洞（CVE），纳入 CI/CD 流水线
- SCA 工具拦截 High+ 级别的漏洞引入，阻塞构建
- 维护软件物料清单（SBOM，SPDX/CycloneDX 格式），随发布物归档
- 防范 Dependency Confusion 攻击：私有包注册源优先于公共源，名称冲突时阻断构建
- 依赖许可合规检查（GPL/AGPL 等传染性许可评估），按项目开源策略执行
- 禁止引入已弃用或不再维护的依赖
