---
name: java-db-conventions
description: 仅限 Java 后端开发场景。数据库规范——MyBatisPlus 持久化用法、审计字段自动填充、Flyway 迁移。通用 DB 设计约定见 db-conventions。适用场景同前。
capabilities: ["db-design", "architecture", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 db-conventions 的 Java 实现配套，仅含 Java/Spring 特有实现细节。通用 DB 约定见 db-conventions。调用本 skill 须同时加载 db-conventions。

## 操作人来源

操作人标识从 JWT 还原：`OncePerRequestFilter` 校验 JWT 并将身份写入 SecurityContext，持久化层从中提取填充审计字段 `creator`/`updater`。

## MyBatisPlus 持久化用法

| 项 | 约定 |
|----|------|
| Mapper 包路径 | `{basePackage}.infrastructure.persistence`（由 `@MapperScan` 显式指定） |
| Mapper 注解 | 建议标注 `@Mapper` |
| PO 基类 | infrastructure 层定义 PO 基类统一审计字段，PO 继承之（注意：domain 实体按 DDD 包结构约定，独立于 PO，不继承该基类） |
| 查询方式 | 优先 `LambdaQueryWrapper` 面向对象方法；仅复杂多表关联/方言特性/Wrapper 难以表达时才写 XML SQL |
| 避免 | `select *`，防止映射不稳定 |
| Mapper XML | 语句间保持空行提升可读性 |
| 枚举映射 | 状态/类别等确定性字段在 DAO 层映射为枚举，经框架层统一枚举处理管道映射 DB TINYINT，业务代码禁止直接判断数值 |
| JSONB 映射 | 用具体 Java 类型 + typeHandler（需验证 MyBatisPlus 对 PG JSONB 适配，可能需自定义 typeHandler） |

使用 MyBatisPlus 标准 `BaseMapper` + `LambdaQueryWrapper`，不依赖第三方增强框架的自研 Wrapper。

## 审计字段自动填充

`creator`/`updater` 由 MyBatisPlus `MetaObjectHandler` 自动填充，业务代码不手动设值：

- PO 审计字段标注：`creator` 用 `@TableField(fill = FieldFill.INSERT)`，`updater` 用 `@TableField(fill = FieldFill.INSERT_UPDATE)`
- 实现 `MetaObjectHandler`，在 `insertFill`/`updateFill` 中从鉴权上下文取操作人标识注入
- 鉴权上下文由拦截器从 SecurityContext（JWT 还原的身份）提取操作人标识，请求级作用域
- `created_at`/`updated_at` 同理用 `MetaObjectHandler` 填充，或依赖 DB `DEFAULT now()` / `ON UPDATE`
- domain 实体不含审计字段，无 MyBatisPlus 注解（零框架依赖）；自动填充仅作用于 infrastructure 层 PO

## Flyway 迁移

- 脚本命名：`V{version}__{description}.sql`（如 `V1__init_schema.sql`）
- 脚本位置：`src/main/resources/db/migration/`
- 表结构变更由 Flyway 版本化管理，迁移脚本即变更记录，不另建 SQL 变更目录
- test profile 下 Flyway 禁用，测试用 H2（`MODE=PostgreSQL`）
