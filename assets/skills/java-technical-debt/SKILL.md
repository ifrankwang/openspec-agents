---
name: java-technical-debt
description: 仅限 Java 后端开发场景。Java 项目技术债识别（架构维度）——Spring 版本 EOL、javax→jakarta 迁移残留、双持久层并存、手写基础设施 vs 框架内置、临时方案固化、契约不一致（枚举 vs 数字码）等 Java 特有形态。通用技术债识别框架见 technical-debt。
capabilities: ["architecture", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 technical-debt 的 Java 实现配套，仅含 Java/Spring 技术栈特有的债务形态。通用技术债识别框架见 technical-debt。调用本 skill 须同时加载 technical-debt。

## 过时技术选型（Java 形态）

- Spring Boot / Spring Framework 版本已 EOL（官方支持周期结束）仍在使用，且无升级计划
- 框架/库级弃用 API 大面积使用——整个组件被官方替换（如旧版 Web 框架、旧缓存客户端、旧消息客户端），区别于单点方法 `@Deprecated`（单点 API 弃用不作架构债务，按维护性规范处理）

## 技术迁移债（Java 形态）

- javax → jakarta 迁移残留：代码中 `javax.*` 与 `jakarta.*` 混用，迁移只完成部分模块
- Spring 大版本升级中断：项目声明目标版本但代码仍大量依赖旧版特性，升级中途停止

## 平行实现与迁移缺失（Java 形态）

- 双持久层并存：MyBatis 与 JPA 同时承载同类数据访问
- 双消息框架并存：新旧消息客户端/中间件同时使用
- 手写基础设施 vs 框架内置：手写限流/线程池/缓存等与 Spring 内置能力（Spring Cache、Resilience4j 等）功能重叠

## 临时方案固化（Java 形态）

- 临时 mock bean（`@Primary`/`@MockBean` 声明的临时代替 Bean）进入生产长期滞留
- `@Profile` 临时 profile（mock/local 专用分支）长期保留且被生产路径依赖
- 绕过分层直连的 hack：Service 直连 Mapper、Controller 直连 Repository/外部服务

## 契约不一致与模型漂移（Java 形态）

- 同一状态/类型字段一处为枚举、另一处为 Integer/String 数字码
- 金额字段一处 BigDecimal、另一处 Double（精度不一致）
- 时间字段一处 LocalDateTime、另一处 String 或 java.util.Date
