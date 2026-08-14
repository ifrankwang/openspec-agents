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
### 正常路径：创建订单
POST {{BASE_URL}}/api/v1/orders
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{"orderNo": "SO202608140001", "customerName": "华东供应链", "amount": 12800.50, "status": "CREATED"}

> {%
    client.test("创建订单返回 201", function() {
        client.assert(response.status === 201, "期望 201，实际 " + response.status);
        client.assert(response.body.data.orderNo === "SO202608140001", "订单号回显不一致");
    });
%}

### 边界：缺必填字段（缺 orderNo）
POST {{BASE_URL}}/api/v1/orders
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{"customerName": "华东供应链"}

> {%
    client.test("缺必填字段返回 4xx", function() {
        client.assert(response.status >= 400 && response.status < 500, "期望 4xx，实际 " + response.status);
    });
%}

### 边界：非法值（orderNo 为空串）
POST {{BASE_URL}}/api/v1/orders
Content-Type: application/json
Authorization: Bearer {{TOKEN}}

{"orderNo": "", "customerName": "华东供应链"}

> {%
    client.test("非法值返回 4xx", function() {
        client.assert(response.status >= 400 && response.status < 500, "期望 4xx，实际 " + response.status);
    });
%}
```

## 旧脚本迁移

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
1. **MUST** 启动基础设施（Docker compose 项目名带隔离标识：`docker compose -p <namespace> up -d`，避免与并发 change 的容器冲突）
2. **MUST** 准备 SQL 前置数据（写入本 change 的隔离容器内 DB）
3. **MUST** 启动服务（端口用编排会话建议端口：`--server.port=<建议端口>`，避免并发 change 端口冲突）
4. API 测试脚本（BASE_URL 使用上述端口）
5. **MUST** 停止服务并清理隔离环境（`docker compose -p <namespace> down`），随后幂等自检：本 change 隔离标识下无残留容器（`docker compose -p <namespace> ps` 为空）、建议端口无进程监听
```

以上第 1、2、3、5 条为 MUST：隔离（独立 compose 项目名、隔离 DB、建议端口、down 清理）是并发安全硬约束，不适用本文件开头「项目规范优先」的推荐豁免。

- SQL 在前：先准备数据，再启动应用确保应用启动时读取到完整数据
- 隔离标识 `<namespace>` 与建议端口来自编排会话上下文
- 启动服务：按项目构建文件确定的启动方式（mvn / gradle / npm 等），端口用编排会话建议端口
- API 脚本：BASE_URL 使用上述建议端口，依赖运行中的服务
- 停止服务：测试完成后停止服务并清理隔离环境

## 覆盖要求

API 测试脚本必须覆盖所有新增/变更接口：

| 维度 | 覆盖内容 |
|------|---------|
| 正常路径 | 按 spec 请求结构传入合法值，验证响应状态码(2xx) 和响应结构 |
| 关键边界 | 缺必填字段 → 4xx；非法值(空串/超长/类型错误) → 4xx；极值 → 正确响应或合理错误 |
| 业务闭环 | spec 含列表/详情/状态流转/删除接口时，测试须端到端闭环：创建后用返回标识在列表/详情检索成功、状态变更后可见性反映、删除/停用后不可见 |

spec 描述为多个行为一并发生的（如状态变更与数据入队），每个行为都须有断言证据；断言范围不限于响应状态码与响应结构，须覆盖变更引发的真实行为（状态落库、消息入队、下游可消费等连带效果）。

「业务闭环」与「一并操作行为组」划界：行为组=同一请求内多个行为同时发生的断言；闭环=跨请求链路的可见性验证（创建 → 检索 → 变更 → 删除），二者互补，均须覆盖。

## 测试数据

http 请求体与 SQL 前置数据均按 spec 业务语义构造：使用真实字段值与业务含义明确的数据（如按 spec 字段语义构造的订单号、状态名、业务名称），禁止无意义占位值（如「测试数据」「aaa」「test1」）。列表/详情检索断言须基于真实业务标识（创建接口返回的 id/编码），使检索结果可预期、可追溯。

## 适用范围

涉及业务逻辑改动，且导致接口契约或数据口径变化时，属于 API 变更范围，MUST 执行本章所有后续约束。

以下情况不属于 API 变更，可豁免本章约束：
- 纯配置文件（非接口契约配置）、构建脚本、GitHub Actions、Docker 文件
- 仅 SQL init 文件改动且无 API 契约影响
- 纯格式、注释、import 排序等无逻辑变更
- 仅测试代码变更（无生产代码、接口契约、构建与测试配置改动）
- 纯文档变更

## 执行约束

MUST 遵守以下约束，不得以编译通过或单元测试通过替代 API 测试：

- MUST 不得以接口返回成功与状态字段正确作为唯一验收；spec 含一并操作行为组时，须提供每个行为真实发生的断言证据。

### 脚本准备

MUST 确保 api-tests/script/ 目录下存在与所有变更接口对应的 .http 测试脚本：
- 已有对应脚本 → 更新为匹配变更后契约
- 尚无对应脚本 → 创建新脚本（不得因尚无已有脚本而跳过创建），同步准备 api-tests/data/ 下 SQL 前置数据脚本

### 脚本执行

API 验证须通过 .http 兼容执行工具运行脚本——不得使用 curl、wget 等通用 HTTP 命令行工具替代。

#### 执行工具

API 测试脚本使用 IntelliJ HTTP Client CLI（`ijhttp`）执行，它是 JetBrains 官方提供的独立 CLI 工具，与 IDE 中 .http 文件的解析器和执行引擎完全一致。

- **工具**: `ijhttp`（IntelliJ HTTP Client CLI）
- **安装 (macOS)**: `brew install --cask ijhttp`
- **Docker**: `docker pull jetbrains/intellij-http-client`
- **直接下载**: `curl -f -L -o ijhttp.zip "https://jb.gg/ijhttp/latest"`
- **执行**: `ijhttp api-tests/script/<文件名>.http`
- **批量执行**: `ijhttp api-tests/script/*.http`
- **环境变量**: `ijhttp <文件> --env-file api-tests/http-client.env.json --env <环境名>`
- **测试报告 (JUnit XML)**: `ijhttp <文件>.http --report`
- **依赖**: 需 Java 17+（macOS 可用 `brew install --cask temurin` 安装）

API 验证须通过 `api-tests/script/` 下的 `.http` 脚本执行，不得使用 shell 命令或临时脚本替代。
