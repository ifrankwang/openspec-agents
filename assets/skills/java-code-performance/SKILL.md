---
name: java-code-performance
description: Java 性能规范——N+1 查询防范、外部调用超时与重试、大文件流式读取、循环优化、对象创建优化、缓存策略、异步处理。仅在 Java 后端项目使用。
capabilities: ["performance", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本文列出**最低审查基线**，不限于所列维度。AI 审查时必须结合自身性能知识做拓展覆盖，下列任何可能遗漏的性能问题均须纳入审查。

## N+1 查询防范

- 列表查询必须用 MyBatis `collection`/`association` 嵌套映射或手动批量查询
- 禁止循环内逐条查询数据库 → Medium 级别 issue

## 外部调用超时与重试

- RestTemplate：通过 `SimpleClientHttpRequestFactory` 设 connectTimeout / readTimeout
- WebClient：通过 `HttpClient.responseTimeout()` / `.option()` 设超时
- Spring Cloud OpenFeign：`feign.client.config.<service>.connect-timeout` / `read-timeout`
- LLM 调用：默认超时 120s
- 所有外部调用必须有重试策略（含退避与熔断），禁止无限重试
- 所有超时值 > 0，普通 HTTP 建议 10-30s

## 大文件处理

- Excel 读取用 SXSSFWorkbook：`new SXSSFWorkbook(new XSSFWorkbook(inputStream), 100)`
- 禁止直接用 `XSSFWorkbook` 加载全量数据（OOM 风险）
- 大列表数据用分页查询 + Stream API 处理

## 循环优化

- 禁止循环内同步 I/O 调用（数据库、HTTP、LLM）→ High 级别 issue（循环内无超时的同步调用 → Critical）
- 循环内外部调用应在循环层级之上做批量聚合或异步并发

## 对象创建优化

- 避免循环内不必要的对象创建（在循环外创建可复用的对象）
- 使用 StringBuilder 替代循环内字符串拼接字符串 `s += ...` 模式

## 缓存策略

- 频繁访问且变化不频繁的数据应使用缓存（Spring Cache / Caffeine / Redis）
- 缓存粒度：按业务维度拆分而非全量缓存
- 注意缓存失效策略与数据一致性约束

## 异步处理

- 队列消费：确保线程池大小合理，不超过外部服务承载能力
- 异步任务须有超时保护和失败处理
