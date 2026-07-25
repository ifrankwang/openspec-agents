---
name: api-test
description: Web 应用 API 自动化测试规范——.http 脚本格式、目录结构、SQL 前置数据脚本、认证发现、覆盖标准与执行方式。
capabilities: ["api-testing"]
boundary_hints:
  directories: ["api-tests/"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

## 目录结构

API 测试素材独立于项目源代码目录（不放入 src/test/ 等构建工具测试源码目录），避免与单元测试混淆。

```
<project-root>/api-tests/
  ├── data/        # SQL 前置数据脚本（按场景准备数据库数据）
  └── script/      # API 测试脚本
```

目录位置可据项目现有惯例微调，但必须与构建工具的测试源码目录隔离。

## 脚本格式

API 测试脚本使用 IntelliJ IDEA HTTP Client（.http 文件）格式。每个场景以 `###` 分隔。

```http
### 正常路径：创建资源
POST {{BASE_URL}}/api/v1/resources
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{"name": "测试数据"}

> {%
    client.test("创建资源返回 201", function() {
        client.assert(response.status === 201, "期望 201，实际 " + response.status);
    });
%}

### 边界：缺必填字段
POST {{BASE_URL}}/api/v1/resources
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{}

> {%
    client.test("缺必填字段返回 4xx", function() {
        client.assert(response.status >= 400 && response.status < 500, "期望 4xx，实际 " + response.status);
    });
%}

### 边界：非法值
POST {{BASE_URL}}/api/v1/resources
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{"name": ""}

> {%
    client.test("非法值返回 4xx", function() {
        client.assert(response.status >= 400 && response.status < 500, "期望 4xx，实际 " + response.status);
    });
%}
```

## 存量迁移

若 `api-tests/script/` 目录已存在 shell（`.sh`）+ curl + jq 旧版脚本，逐文件转为 `.http` 格式：
- 每个 `curl` 命令及其 headers 和 body 转为一条 `###` 分隔的请求
- 状态码和字段校验的 shell 断言（`jq` + `if`）转为 `client.test()` + `client.assert()`
- Shell 变量（如 `BASE`, `TOKEN`）转为 `{{ }}` 环境变量，来源写入 `api-tests/http-client.env.json`
- 迁移后删除 `.sh` 文件，不留残余

## SQL 前置数据脚本

SQL 脚本按场景准备无法通过接口构造的数据库数据（历史数据状态、多表联动前置条件）。要求幂等：

- PostgreSQL: `INSERT INTO ... ON CONFLICT DO NOTHING`
- MySQL: `INSERT IGNORE INTO ...`
- H2: `MERGE INTO ...` 或 `INSERT ... ON CONFLICT DO NOTHING`

按项目实际 DB 类型选择写法。

## 认证发现

API 测试脚本运行前需获取有效认证凭证。常见模式：

1. **Dev-only login 端点**：检查项目配置中是否有 profile 专属的免登入口（如 local/dev profile 下的登录 API）
2. **静态 Token**：检查项目是否有 dev profile 专属的 JWT 密钥配置，可用相同密钥签发测试 token
3. **Basic Auth**：检查项目安全配置中 dev profile 是否有固定凭证或免登入口
4. **无认证**：若 dev profile 完全关闭认证，无需 token

从项目配置文件和安全配置类中查找。

## 执行顺序

```
1. SQL 数据脚本 → 2. 启动服务 → 3. API 测试脚本 → 4. 停止服务
```

- SQL 在前：先准备数据，再启动应用确保应用启动时读取到完整数据
- 启动服务：按项目构建文件确定的启动方式（mvn / gradle / npm 等）
- API 脚本：依赖运行中的服务
- 停止服务：测试完成后清理

## 覆盖要求

API 测试脚本必须覆盖所有新增/变更接口：

| 维度 | 覆盖内容 |
|------|---------|
| 正常路径 | 按 spec 请求结构传入合法值，验证响应状态码(2xx) 和响应结构 |
| 关键边界 | 缺必填字段 → 4xx；非法值(空串/超长/类型错误) → 4xx；极值 → 正确响应或合理错误 |

## 脚本执行

API 变更时须同步创建/更新 api-tests/script/ 下对应 .http 测试脚本，以及 api-tests/data/ 下 SQL 前置数据脚本。
API 验证须通过 .http 兼容执行工具运行脚本——不得使用 curl、wget 等通用 HTTP 命令行工具替代。

## 测试方式

API 验证须通过 `api-tests/script/` 下的 `.http` 脚本执行，不得使用 shell 命令或临时脚本替代。
