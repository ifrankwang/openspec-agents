---
name: db-conventions
description: 数据库设计通用约定——表命名、主键选择、审计字段、逻辑删除、索引命名、确定性标记（状态/类别）与字典字段、操作人来源链路。技术栈无关（不绑定具体 SQL 方言）。
capabilities: ["db-design", "architecture"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

## 表结构规范

| 项 | 约定 | 说明 |
|----|------|------|
| 表名前缀 | `{project_prefix}_` + 业务域名 | 如 `{project_prefix}_order`、`{project_prefix}_order_item` |
| 主键 | UUID | 全局唯一，不含业务含义 |
| 状态/类别等确定性标记 | TINYINT | 确定性取值集（码集固定，非字典管理） |
| 字典类标记 | VARCHAR（原值 code） | 非确定性取值集，由字典动态管理 |
| 半结构化字段 | JSON / JSONB | 建索引（如 GIN）加速查询 |

数据库类型和具体 SQL 语法由项目技术栈确定。

## 审计字段

所有表必须包含以下审计字段（字段名固定，SQL 类型按项目 DB 调整）：

| 字段 | 含义 | 备注 |
|------|------|------|
| `created_at` | 创建时间 | NOT NULL |
| `updated_at` | 更新时间 | NOT NULL |
| `creator` | 创建人标识 | NOT NULL |
| `updater` | 更新人标识 | NOT NULL |
| `deleted_at` | 逻辑删除时间 | NULL = 未删除 |

## 逻辑删除

采用 `deleted_at IS NOT NULL` 表示已删除，配合**部分唯一索引**约束未删除行的唯一性：

```sql
-- 仅对未删除行建立唯一约束，已删除行不受限
CREATE UNIQUE INDEX uk_{table}_{column} ON {table} (business_key) WHERE deleted_at IS NULL;
```

部分唯一索引方案（`WHERE deleted_at IS NULL`）比用 `deleted` 字段存主键值的方案语义更清晰。

## 索引命名

| 类型 | 前缀 | 示例 |
|------|------|------|
| 唯一索引 | `uk_` | `uk_order_code` |
| 普通索引 | `idx_` | `idx_order_item_order` |
| 部分唯一索引 | `uk_` + `WHERE deleted_at IS NULL` | 见上方逻辑删除 |

索引名使用 snake_case。

## 操作人来源（概念层）

典型鉴权链路：后端通过 OAuth2/OIDC 授权码流程登录并签发标准 JWT，操作人标识从 JWT 还原：

1. 安全过滤器校验 JWT，将身份写入请求上下文
2. 拦截器从请求上下文取操作人标识，写入请求级鉴权上下文
3. 持久化层从鉴权上下文取标识填充 `creator`/`updater` 审计字段

具体 IDP（如 Azure AD、Keycloak）和框架实现按项目技术栈选择。
