---
name: ddd-architecture
description: DDD 分层架构规范——四层结构、层间依赖、各层职责、CQRS、聚合设计、Repository 语义、领域事件、值对象、Port/Adapter。方法论本身语言无关。
capabilities: ["architecture"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

## 包结构（概念层）

```
{basePackage}
├── domain          ← 核心领域逻辑（聚合根、实体、值对象、领域服务、Repository 接口）
│   ├── model       ← 聚合根、实体、值对象（纯业务对象，零外部依赖）
│   ├── service     ← Domain Service
│   ├── repository  ← Repository 接口
│   └── exception   ← 领域异常
├── application     ← 用例编排（Command/Query 入口、应用层服务）
│   ├── command     ← 写操作命令
│   ├── query       ← 读操作查询
│   ├── service     ← Application Service
│   └── dto         ← 模块间传输 DTO
├── infrastructure  ← 技术实现（持久化、外部集成、ACL 适配）
└── interfaces      ← 外部访问入口（Controller、API 网关、消息监听）
```

## 层间依赖

```
interfaces → application → domain ← infrastructure
```

箭头方向即依赖方向：interfaces 依赖 application，application 依赖 domain，infrastructure 实现 domain 定义的 Port/Repository 接口。infrastructure 不依赖 interfaces，interfaces 不直接依赖 infrastructure。

## 各层职责

| 层 | 职责 | 禁止 |
|----|------|------|
| interfaces | 参数校验、调用 application、DTO 转换 | 写业务逻辑、直接访问 infrastructure/domain 实体 |
| application | 编排业务用例、事务边界、协调 domain service | 技术实现细节（SQL、HTTP、LLM 调用） |
| domain | 核心领域逻辑、聚合根行为、领域服务 | 任何框架依赖 |
| infrastructure | 技术实现：持久化、外部集成、ACL 转换 | 业务规则判断 |

## 通用语言（Ubiquitous Language）

每个 Bounded Context 必须维护一份术语表，记录业务名词及其含义。开发、产品、业务方统一使用此表沟通，代码命名以此为基准。

### 术语表位置

```
{basePackage}/domain/language.md
```

### 术语表格式

```
# {Bounded Context} — 通用语言

| 术语 | 英文名 | 含义 | 代码位置 |
|------|--------|------|---------|
| ... | ... | ... | ... |
```

### 命名规则

- 代码类名、方法名、字段名必须与术语表一致，禁止翻译/缩写
- 值对象用不可变类型，枚举用枚举类型，实体用引用类型——类型选择本身就是语言表达
- 跨 Bounded Context 的同一术语含义必须一致

## CQRS 读写分离

Command（写）和 Query（读）走不同路径，互不混淆：

```
Command 路径: Controller → ApplicationCommandService → Domain Model → Repository（写）
Query 路径:   Controller → ApplicationQueryService → 直接查询投影（DTO）
```

- Command 走 domain 层：调用聚合根行为 → Repository 持久化
- Query 不走 domain 层：直接映射到查询投影（DTO），禁止加载 domain 实体再转换
- Command 方法返回简单结果（仅 ID/成功/失败），不返回 domain 实体
- Query 方法返回值必须是 DTO，禁止返回 Entity 或 PO
- 同一用例中禁止混用 Command 和 Query 逻辑

## 充血模型

Domain 实体必须是充血模型——行为封装在实体内部，禁止仅 getter/setter 的贫血模型。

- 业务逻辑不得在 Service 中操作实体状态后再调用 save——改实体自身方法
- 判定：删掉所有 setter 后业务逻辑是否还能运转？能 → 充血；不能 → 贫血

## 聚合设计

| 原则 | 说明 |
|------|------|
| 聚合边界 = 事务边界 | 一个事务只修改一个聚合，跨聚合用最终一致性 |
| 聚合根是唯一入口 | 外部只能通过聚合根方法访问聚合内部 |
| 跨聚合引用仅 ID | 聚合 A 引用聚合 B 时只存 B 的 ID，不存对象引用 |
| 聚合内一致性 | 聚合根负责子实体一致性校验，禁止外部直接修改子实体 |

## Repository 领域语义

Repository 对 domain 层暴露集合语义，不暴露持久化语义：

- `findById` 返回 domain 实体，不存在则抛异常——领域层决定不存在语义
- 查询方法名具领域语义（`findActiveOrdersByCustomerId`），不暴露技术细节
- 领域查询接口在 domain 层定义，具体实现（含 SQL）在 infrastructure 层
- 纯查询投影（非 domain 实体）走 CQRS Query 路径，不经过 Repository

## Domain Event

- 领域事件定义在 domain 层，事件处理在 infrastructure 层
- 事件定义为不可变值对象，命名 `{Entity}{PastParticiple}Event`
- Application Service 在事务提交后发布事件
- 事件处理类在 infrastructure 层，使用事件总线或消息队列

## Factory

- 复杂领域对象创建逻辑归 Factory，不放在构造函数中
- 简单对象用静态工厂方法
- 复杂组装用 Domain Factory（domain 层），不依赖外部技术
- 涉及外部数据/技术实现的创建用 Application Factory（application 层）

## Specification

Specification 将业务规则封装为可组合的谓词对象，用于判定候选对象是否满足特定条件：

- 接口定义 `isSatisfiedBy(T candidate)` + `and/or/not` 组合方法
- 原子规则类以 `Spec` 后缀命名
- 组合通过链式调用，无需额外工厂
- 入参为领域实体或值对象，不在 Specification 中引入基础设施依赖

## Anti-Corruption Layer

防腐层（ACL）隔离外部模型与领域模型：

- ACL 位于 infrastructure 层
- 输入方向：ACL 将外部模型（第三方 API、遗留系统）转换为领域模型
- 输出方向：ACL 将领域模型转换为外部模型
- 约束：领域模型不依赖外部模型，ACL 转换方向仅为 infrastructure → domain

## Port / Adapter 模式

Domain 层定义 Port 接口（纯业务契约），Infrastructure 层实现 Adapter。依赖方向：domain → infrastructure（通过接口反转）。

## 共性能力基础设施化

应统一拦截/封装到 Infrastructure 层或框架级能力的横向逻辑，不得分散在各 Controller/Service 中逐点调用。

### 适用场景

| 类别 | 示例 | 上收方式 |
|------|------|---------|
| 横切关注点 | 鉴权·审计·日志·限流·幂等·事务 | 拦截器 / 过滤器 / AOP |
| 重复集成封装 | 外部 API 调用、序列化/转换 | 公共 Client/Adapter 基类 |
| 散落的全局配置 | 超时·重试·线程池·白名单 | 统一配置文件集中管理 |

### 判据

同一逻辑在 ≥2 处独立实现、属横向共性需求（非单点业务上下文特有）、新增场景漏调度即失效 → 必须基础设施化。
