---
name: java-code-style
description: Java 代码风格规范——Lombok 注解优先、日志约定、Swagger/SpringDoc 注解、.gitignore 必须项、命名约定。仅在 Java 后端项目使用。
capabilities: ["style", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本文列出**最低审查基线**，不限于所列维度。AI 审查时必须结合自身代码风格知识做拓展覆盖，下列任何可能遗漏的代码风格维度均须纳入审查。

## 日志规范

- Lombok 存在（pom.xml 中检测到 lombok 依赖）时必须用 `@Slf4j` 替代手动 `LoggerFactory.getLogger()`
- 检测方法：逐文件扫描 pom.xml 中是否含 `lombok` 依赖，若存在则该项目中所有新写/修改的类须使用 `@Slf4j` 生成 Logger 字段
- 范围控制：首轮审查仅对 diff 内新增/修改的类提出 issue（Low+ 阻塞），已存在的手动 Logger 按原严重级别正常提交
- Logger 字段名统一用 `log`
- 参数化日志：`log.info("order {} status {}", orderId, status)`，禁止字符串拼接构造日志消息
- 敏感数据（密码、Token、身份证号等）禁止出现在日志输出中

## Lombok 注解使用约束

项目引入 Lombok 时，如下场景必须优先使用 Lombok 注解而非手写等价代码：
- `@Getter` / `@Setter` — 替代手写 getter/setter（非贫血模型中业务行为不在此限）
- `@Builder` / `@Data` — 替代手写 builder / 值对象全部模板代码
- `@Slf4j` / `@Log4j2` — 替代手动 Logger 字段声明
- `@RequiredArgsConstructor` — 替代构造器注入的手动构造器（已有 DDD 构造器注入约束，此为补充方案）

异常情况：getter/setter 有额外业务逻辑时（如校验、计算），不强制用 `@Getter`/`@Setter`，须手写

## Swagger/SpringDoc 注解

引入 SpringDoc OpenAPI（`springdoc-openapi-starter-webmvc-ui`）后：
- Controller 类：`@Tag(name = "xxx相关接口")`
- 接口方法：`@Operation(summary = "xxx")`
- DTO 字段：`@Schema(description = "xxx")`

## .gitignore

必须包含：
```
target/
*.log
.idea/
*.iml
.env
```

## 命名规范

- 类名：PascalCase，业务领域名词
- 方法名：camelCase，动宾短语
- 常量：UPPER_SNAKE_CASE（static final 字段）
- 变量：camelCase，有业务含义
- 测试类：`{ClassName}Test`
- 测试方法：`test{MethodName}`
