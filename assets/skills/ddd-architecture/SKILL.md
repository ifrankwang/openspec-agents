---
name: ddd-architecture
description: DDD 架构规范——四层分层与六边形（Hexagonal）两种包组织风格、层间依赖、各层职责、风格判定、CQRS、聚合设计、Repository 语义、领域事件、值对象、Port/Adapter。方法论本身语言无关。
capabilities: ["architecture"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

## 包结构（概念层）

同一套依赖原则有两种包组织方式，均属合法实现，采用哪种由项目声明（见"架构风格判定"）。两者不是互斥架构，而是同一依赖方向的两种包组织视角。

**方式一：四层分层**

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

**方式二：六边形（Hexagonal）**

六边形按"内核 ↔ 适配器"组织，内核承载全部领域与应用逻辑，外部依赖以适配器形式接入：

```
{basePackage}
├── domain            ← 内核组成：核心领域逻辑、driven port 接口
├── application       ← 内核组成：用例编排、driving port 接口
├── driving adapter   ← 入站适配器：外部访问入口，调用 application 定义的 driving port
└── driven adapter    ← 出站适配器：技术实现，实现 domain 定义的 driven port
```

- **内核** = domain + application：domain 承载核心领域逻辑（聚合根、实体、值对象、领域服务）并定义 driven port（持久化、外部集成等能力契约）；application 承载用例编排（Command/Query 入口、应用层服务）并定义 driving port（外部用例入口契约）
- **driving adapter（入站）** 对应外部访问入口（API 网关、消息监听等），把外部调用翻译为内核用例
- **driven adapter（出站）** 对应技术实现（持久化、外部集成、ACL 适配），把内核契约翻译为具体技术调用

四层与六边形的对应关系见"两种风格的双向映射"。

## 层间依赖

**四层分层**：

```
interfaces → application → domain ← infrastructure
```

箭头方向即依赖方向：interfaces 依赖 application，application 依赖 domain，infrastructure 实现 domain 定义的 Port/Repository 接口。infrastructure 不依赖 interfaces，interfaces 不直接依赖 infrastructure。

**六边形**：

```
driving adapter → application → domain ← driven adapter
```

依赖一律指向内核（domain + application）：driving adapter 依赖 application 定义的 driving port（入站端口），driven adapter 实现 domain 定义的 driven port（出站端口）并依赖该接口。adapter 之间无依赖，内核不依赖任何 adapter。依赖倒置只发生在 driven 方向——driven adapter 依赖内核定义的 Port 接口，而非反向。

## 两种风格的双向映射

四层分层与六边形是同一套依赖原则（依赖一律指向内核）的两种包组织视角，对应关系如下：

| 四层分层 | 六边形 | 说明 |
|---------|--------|------|
| domain + application | 应用内核 | 内核由领域与应用逻辑共同构成，domain 是内核的一部分 |
| interfaces | driving adapter（入站适配器） | 外部访问入口，调用内核 |
| infrastructure | driven adapter（出站适配器） | 技术实现，依赖内核定义的 Port 接口 |

依赖方向在两种视角下完全一致：外部入口（interfaces / driving adapter）→ 内核（application → domain）← 技术实现（infrastructure / driven adapter）。

## 架构风格判定

两种风格不是互斥选择，判定项目采用哪种包组织视角，依据以下特征对照：

| 识别特征 | 四层分层 | 六边形 |
|---------|---------|--------|
| 包组织方式 | 显式 interfaces / application / domain / infrastructure 四层 | 显式内核与适配器边界（adapter/in、adapter/out，或 interfaces/infrastructure 承担 adapter 语义） |
| Port 接口定义位置 | domain 层 | 内核（domain 定义 driven port，application 定义 driving port） |
| 外部访问入口定位 | interfaces 层 | driving adapter（入站） |
| 技术实现定位 | infrastructure 层 | driven adapter（出站） |

混杂场景兜底：项目 design/架构文档已声明架构风格的，以声明为准；未声明时按四层分层认定。Port 定义位置差异（domain 或 application）不单独构成问题；四层风格项目以 interfaces/infrastructure 承担 adapter 语义的组织方式不视为违规。

## 各层职责

| 层 | 职责 | 禁止 |
|----|------|------|
| interfaces | 参数校验、调用 application、DTO 转换 | 写业务逻辑、直接访问 infrastructure/domain 实体 |
| application | 编排业务用例、事务边界、协调 domain service | 技术实现细节（SQL、HTTP、LLM 调用） |
| domain | 核心领域逻辑、聚合根行为、领域服务 | 任何框架依赖 |
| infrastructure | 技术实现：持久化、外部集成、ACL 转换 | 业务规则判断 |

六边形视角下，interfaces 即 driving adapter（入站适配器），infrastructure 即 driven adapter（出站适配器），职责与禁止项对应不变。

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

### 命名合理性判据

命名规则与判据分工互补：命名规则定义静态一致性约束——代码命名必须与术语表一致；命名合理性判据是判定标准，识别命名是否体现意图、是否造成混淆、是否出现漂移，修正动作即对一致性约束的执行。

- 命名须实际体现概念意图，禁止用泛化命名（如 process/handle/data/info）掩盖真实语义
- 同义概念全库统一命名，禁止同名不同义或近义不同名造成场景混淆
- 代码命名偏离术语表即为漂移信号，识别后回溯术语表修正，回归一致性约束

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

Repository 语义与架构风格无关，四层与六边形均适用：契约（接口）定义在核心（domain），实现落在基础设施/出站侧。

Repository 对 domain 层暴露集合语义，不暴露持久化语义：

- `findById` 返回 domain 实体，不存在则抛异常——领域层决定不存在语义
- 查询方法名具领域语义（`findActiveOrdersByCustomerId`），不暴露技术细节
- 领域查询接口在 domain 层定义，具体实现（含 SQL）在 infrastructure 层
- 纯查询投影（非 domain 实体）走 CQRS Query 路径，不经过 Repository

## Domain Event

Domain Event 语义与架构风格无关，四层与六边形均适用：事件契约定义在 domain/内核，事件处理实现落在 infrastructure/出站侧。

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

六边形视角下，ACL 属 driven adapter（出站适配器）中的转换组件，方向约束同"adapter → 内核"。

## 外部系统命名隔离

命名基准是领域术语表（见「通用语言」章节），外部系统名不属于领域语言。外部系统（第三方 API、遗留系统、中间件）的命名与模型只允许出现在 infrastructure 层（四层）/ driven adapter（六边形），禁止通过接口契约上浮到内核与外部访问入口。

- 接口/方法命名用领域语义：Port 接口名与方法名（如 CustomerQueryPort.queryCustomer）禁止出现外部系统名（如 SapQueryPort、queryFromErp）
- DTO 命名用领域语义：application/interfaces 层 DTO 类名与字段名（如 CustomerDetailResponse）禁止出现外部系统名（如 SapCustomerResponse、字段 sapOrderNo）
- 跨层传输的数据须经 ACL/assembler 转换为领域语义对象，外部模型类型禁止出现在内核与 interfaces 层的接口签名中
- 外部系统名仅限 infrastructure 层实现类、ACL 转换类与配置（如 SapClient、ErpOrderConverter）

六边形视角下，外部系统名仅限 driven adapter（出站适配器）实现类与配置。

## Port / Adapter 模式

Port 接口是内核（domain + application）定义的纯业务契约，Adapter 是实现契约的技术适配组件，按方向分两类：

- **driving port / driving adapter（入站）**：driving port 由 application 定义（外部用例入口契约），由 application 层应用服务实现；driving adapter 在外部访问入口调用该端口。依赖方向：外部入口 → application。
- **driven port / driven adapter（出站）**：driven port 由 domain 定义（持久化、外部集成等能力契约），driven adapter 在基础设施/出站侧实现。依赖方向：infrastructure 依赖 domain 的 Port 接口（依赖倒置）。

四层分层下两类分别落在 interfaces 与 infrastructure；六边形下即 adapter/in 与 adapter/out（或由 interfaces/infrastructure 承担 adapter 角色）。

## Infrastructure 协议层隔离

Infrastructure 层必须通过协议层（内核定义的 driven port：Repository、领域事件 Port、外部集成 Port 等）向业务/应用暴露能力，业务/应用只面向协议层编程，禁止直接依赖具体基础设施实现类。协议层是业务/应用与具体 infra 之间的唯一通道，确保 infra 层可更换具体技术栈而不影响应用。

- 每项 infra 能力（持久化、消息、外部集成、缓存、文件、LLM 等）在引入前必须先在内核定义对应 Port 接口，再由 infrastructure 提供 Adapter 实现
- domain/application/interfaces 只允许依赖 Port 接口，禁止 import/调用具体基础设施实现类（具体 Client、Mapper、SDK、模板类等）
- 更换具体技术栈时，仅新增或替换 infrastructure 内的 Adapter 实现，不得改动 domain/application/interfaces 的接口与代码
- 无协议层直接调用具体 infra 实现，或业务/应用层出现具体技术栈类型，均视为架构违规

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

## 方案复用与平行实现

同类能力已有既有实现时，新方案须复用或扩展现有实现，禁止另起一套逻辑——引入与既有实现功能重叠的新实现且不改动原实现，导致同类能力多套方案并存。

### 适用场景

已有手工实现的限流基础框架，新方案引入新限流框架且不动原代码——同类能力多套方案并存，维护与认知成本翻倍。

### 判据

同类能力已有既有实现 → 优先复用或扩展既有实现。确需平行引入（新旧并存）时，方案须附带既有实现的迁移方案。
