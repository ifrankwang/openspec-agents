---
name: java-api-conventions
description: 仅限 Java 后端开发场景。接口层 Java/Spring 实现规范——Spring 注解、Swagger/SpringDoc 注解、R<T> 统一返回、@RestControllerAdvice 异常处理。通用 REST 设计原则见 api-conventions。适用场景同前。
capabilities: ["api-design", "architecture", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 api-conventions 的 Java 实现配套，仅含 Java/Spring 特有实现细节。通用 REST 设计原则见 api-conventions。调用本 skill 须同时加载 api-conventions。

## Controller 层规范

| # | 规则 | 说明 |
|---|------|------|
| 1 | 必须用 `@RestController` | |
| 2 | `@Validated` + `jakarta.validation` 校验参数 | 注解加在 DTO 字段上，入口触发校验 |
| 3 | 统一返回 `R<T>` | 除文件下载等特殊场景外 |

## 统一返回 R<T>

所有接口统一返回 `R<T>` 包装，成功用 `R.success(data)`，失败携带业务错误码与消息。结构约定：

- `code`：业务错误码（数字），成功时为 0 或约定成功值
- `message`：错误描述，支持 `{}` 动态占位参数
- `data`：业务数据泛型

## 异常响应体系

Controller 层不直接处理异常，由全局 `@RestControllerAdvice` 处理器按异常类型映射 HTTP 状态码。

业务错误码作为 `R<T>` 响应体中独立数字字段，与 HTTP 状态码解耦：HTTP 码供客户端/网关判断大类，业务错误码供前端精确分支处理。
