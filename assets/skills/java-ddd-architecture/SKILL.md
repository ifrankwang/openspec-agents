---
name: java-ddd-architecture
description: 仅限 Java 后端开发场景。DDD 四层分层与六边形（Hexagonal）两种架构风格 Java 实现——Java 代码实现规范、Spring DI、MapStruct、ArchUnit 规则。DDD 方法论见 ddd-architecture。适用场景同前。
capabilities: ["architecture", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 ddd-architecture 的 Java 实现配套，仅含 Java/Spring 特有实现细节。DDD 方法论见 ddd-architecture。调用本 skill 须同时加载 ddd-architecture。

## 包结构

> 概念见 ddd-architecture，以下为 Java 实现示例。

\`\`\`
{basePackage}
├── domain
│   ├── model        ← 聚合根、实体、值对象（纯 POJO，零框架依赖）
│   │   ├── event    ← 领域事件定义（record）
│   │   └── spec     ← Specification 业务规则组合
│   ├── service      ← Domain Service 接口 + 实现（核心领域逻辑）
│   ├── repository   ← Repository 接口（不含实现）
│   ├── factory      ← 领域工厂（复杂对象创建）
│   └── exception    ← 领域异常类 + ErrorCode 常量（零框架依赖）
├── application
│   ├── command      ← 写操作命令对象
│   ├── query        ← 读操作查询对象
│   ├── service      ← Application Service（编排用例，不含技术实现）
│   └── dto          ← 应用层 DTO（模块间传输）
├── infrastructure
│   ├── persistence  ← PO、Mapper、对象转换器
│   ├── llm          ← LLM 适配器
│   ├── excel        ← POI 解析器/写入器
│   ├── auth         ← 认证适配器
│   ├── desensitize  ← 脱敏适配器
│   ├── external     ← 外部查询适配器（search-provider 等）
│   ├── acl          ← Anti-Corruption Layer（外部模型 ↔ 领域模型转换）
│   ├── queue        ← 消息队列适配器
│   └── config       ← Spring 配置 Bean
└── interfaces
    ├── controller   ← REST Controller（仅参数校验 + 调用 application）
    ├── security     ← 登录接口 / JWT 过滤器 / SecurityConfig
    ├── dto          ← 接口层 DTO（入参/出参）
    └── assembler    ← DTO ↔ Domain 转换器
```

**六边形（Hexagonal）包组织**

内核保留 `domain` + `application` 两个包共同构成应用内核；`interfaces` 包承担 **driving adapter（入站适配器）** 角色，`infrastructure` 包承担 **driven adapter（出站适配器）** 角色。包结构沿用上表，仅角色语义调整：

| 包 | 六边形角色 | 说明 |
|----|-----------|------|
| `domain` | 内核 | driven port 定义处（Repository、EventPublisher、OrderGenerationPort 等接口） |
| `application` | 内核 | driving port 定义处（ApplicationService 接口） |
| `interfaces` | driving adapter（入站） | Controller 等外部入口调用 application 定义的端口接口 |
| `infrastructure` | driven adapter（出站） | 实现 domain 定义的 Port 接口（持久化、LLM、外部集成等） |

## 层间依赖

> 概念见 ddd-architecture，以下为 Java 实现示例。

\`\`\`
interfaces → application → domain ← infrastructure
```

箭头方向即依赖方向：interfaces 依赖 application，application 依赖 domain，infrastructure 依赖 domain（实现 domain 定义的 Port/Repository 接口）。infrastructure 不依赖 interfaces，interfaces 不直接依赖 infrastructure。

**六边形**：依赖规则不变，仅换角色表述——driving adapter（interfaces）依赖 application 定义的 driving port（ApplicationService 接口）；driven adapter（infrastructure）实现 domain 定义的 driven port（Repository、EventPublisher、OrderGenerationPort 等接口）。adapter 之间无依赖，内核不依赖 adapter。

## 各层职责

> 概念见 ddd-architecture，以下为 Java 实现示例。

| 层 | 职责 | 禁止 |
|----|------|------|
| interfaces | 参数校验、调用 application、DTO 转换 | 写业务逻辑、直接访问 infrastructure/domain 实体 |
| application | 编排业务用例、事务边界、协调 domain service | 技术实现细节（SQL、HTTP、LLM 调用） |
| domain | 核心领域逻辑、聚合根行为、领域服务 | 任何框架依赖（Spring/MyBatis/Spring AI） |
| infrastructure | 技术实现：持久化、外部集成、消息队列、ACL 转换 | 业务规则判断 |

六边形视角下，interfaces 即 driving adapter（入站适配器），infrastructure 即 driven adapter（出站适配器），职责与禁止项对应不变。

## CQRS 读写分离

> 概念见 ddd-architecture，以下为 Java 实现示例。

Command（写）和 Query（读）走不同路径，互不混淆：

```
Command 路径: Controller → ApplicationCommandService → Domain Model → Repository（写）
Query 路径:   Controller → ApplicationQueryService → 直接查询投影（DB/DTO）
```

- Command 走 domain 层：调用聚合根行为 → Repository 持久化
- Query 不走 domain 层：直接映射到查询投影（DTO），禁止加载 domain 实体再转换
- Command 方法返回 `void` 或 `CommandResult`（仅 ID/成功/失败），不返回 domain 实体
- Query 方法返回值必须是 DTO，禁止返回 Entity 或 PO
- 同一用例中禁止混用 Command 和 Query 逻辑——读方法不修改状态，写方法不返回查询结果

```java
// 正确：Command
public class CreateOrderService {
    private final OrderRepository repository;
    private final EventPublisher eventPublisher;

    public CommandResult execute(CreateOrderCommand cmd) {
        Order order = repository.findById(OrderId.of(cmd.orderId()));
        order.create(cmd.customer());
        eventPublisher.publish(new OrderCreatedEvent(order.getId()));
        return CommandResult.of(order.getId().value());
    }
}

// 正确：Query
public class OrderListQueryService {
    private final OrderListQueryDao dao; // 直接映射到投影，不走 domain

    public List<OrderSummaryDto> execute(OrderListQuery query) {
        return dao.findByStatus(query.status());
    }
}
```

## 充血模型

> 概念见 ddd-architecture，以下为 Java 实现示例。

Domain 实体必须是充血模型——行为封装在实体内部，禁止仅 getter/setter 的贫血模型。

```java
// 正确：充血模型
public class Order {
    private OrderId id;
    private OrderStatus status;
    private List<Invoice> invoices;

    public Invoice addInvoice(Customer customer, BigDecimal amount) {
        if (this.status != OrderStatus.PENDING) {
            throw new IllegalStateException("订单未处理中，不可添加发票");
        }
        var invoice = new Invoice(customer, amount);
        this.invoices.add(invoice);
        return invoice;
    }

    public void create(Customer customer) {
        if (this.status != OrderStatus.DRAFT) {
            throw new IllegalStateException("草稿状态才能创建");
        }
        this.status = OrderStatus.PENDING;
    }
}

// 错误：贫血模型
public class Order {
    private Long id;
    private String status;
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
}
```

- 业务逻辑不得在 Service 中操作实体状态后再调用 save——改实体自身方法
- 判定：删掉所有 setter 后业务逻辑是否还能运转？能 → 充血；不能 → 贫血

## 聚合设计

> 概念见 ddd-architecture，以下为 Java 实现示例。

| 原则 | 说明 |
|------|------|
| 聚合边界 = 事务边界 | 一个事务只修改一个聚合，跨聚合用最终一致性 |
| 聚合根是唯一入口 | 外部只能通过聚合根方法访问聚合内部 |
| 跨聚合引用仅 ID | 聚合 A 引用聚合 B 时只存 `B.id`，不存 B 对象引用 |
| 聚合内一致性 | 聚合根负责子实体一致性校验，禁止外部直接修改子实体 |

```java
// 聚合根 Order 引用子实体 Invoice，外部通过聚合根访问
public class Order {
    private OrderId id;
    private List<Invoice> invoices; // 子实体，聚合内

    public Invoice addInvoice(Customer customer, BigDecimal amount) {
        // 聚合根负责校验一致性
        var invoice = new Invoice(customer, amount);
        this.invoices.add(invoice);
        return invoice;
    }
}

// 跨聚合引用：只存 ID，不存对象
public class Order {
    private OrderId id;
    private String customerId; // 仅 ID 引用跨聚合
}
```

## Repository 领域语义

> 概念见 ddd-architecture，以下为 Java 实现示例。

Repository 对 domain 层暴露集合语义，不暴露持久化语义：

```java
// 正确：集合语义
public interface OrderRepository {
    Order findById(OrderId id);
    void add(Order order);
    void remove(OrderId id);
}

// 错误：CRUD 语义
public interface OrderRepository {
    OrderPO selectById(Long id);
    int insert(OrderPO po);
    int update(OrderPO po);
}
```

- `findById` 返回 domain 实体，不返回 `Optional`（不存在则抛异常——领域层决定不存在语义）
- 查询方法名具领域语义：`findActiveOrdersByCustomerId`，非 `selectByCondition`
- 领域查询接口（`find*`）在 domain 层定义，具体实现（含 SQL）在 infrastructure 层
- 纯查询投影（非 domain 实体）走 CQRS Query 路径，不经过 Repository

## Domain Event

> 概念见 ddd-architecture，以下为 Java 实现示例。

领域事件定义在 domain 层，事件处理在 infrastructure 层：

```java
// domain/model/event/OrderCompletedEvent.java — record，不可变
public record OrderCompletedEvent(
    OrderId orderId,
    LocalDateTime completedAt
) {}

// domain/service/EventPublisher.java — Port 接口，零框架依赖
public interface EventPublisher {
    void publish(Object event);
}

// infrastructure/event/SpringEventPublisherAdapter.java
@Component
public class SpringEventPublisherAdapter implements EventPublisher {
    private final ApplicationEventPublisher publisher;

    public SpringEventPublisherAdapter(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    @Override
    public void publish(Object event) {
        publisher.publishEvent(event);
    }
}
```

- 命名规范：`{Entity}{PastParticiple}Event`（如 `OrderCompletedEvent`）
- 事件定义用 `record`，不可变，统一在 `domain/model/event` 包
- Application Service 在事务提交后调用 `eventPublisher.publish(event)`
- 事件处理类（Event Handler）在 infrastructure 层，使用 `@EventListener` 或消息队列

## Factory

> 概念见 ddd-architecture，以下为 Java 实现示例。

复杂领域对象创建逻辑归 Factory，不放在构造函数中：

```java
// domain/model/OrderFactory.java — 复杂初始化
public class OrderFactory {
    public static Order createNew(CustomerRequest request, Customer customer) {
        // 复杂初始化逻辑：校验、组装、生成 ID
        var id = OrderId.generate();
        var invoices = new ArrayList<Invoice>();
        return new Order(id, customer, request, invoices);
    }
}
```

- 简单对象用静态工厂方法 `of(...)`：`OrderId.of("xxx")`
- 复杂组装用 Domain Factory（domain 层），不依赖外部技术
- 涉及外部数据/技术实现的创建用 Application Factory（application 层），调用 Port 获取数据后创建

## Specification

> 概念见 ddd-architecture，以下为 Java 实现示例。

Specification 将业务规则封装为可组合的谓词对象，用于判定候选对象是否满足特定条件：

```java
// domain/model/spec/Specification.java
public interface Specification<T> {
    boolean isSatisfiedBy(T candidate);

    default Specification<T> and(Specification<T> other) {
        return new AndSpecification<>(this, other);
    }

    default Specification<T> or(Specification<T> other) {
        return new OrSpecification<>(this, other);
    }

    default Specification<T> not() {
        return new NotSpecification<>(this);
    }
}
```

组合实现：

```java
// domain/model/spec/AndSpecification.java
public record AndSpecification<T>(Specification<T> left, Specification<T> right) implements Specification<T> {
    @Override
    public boolean isSatisfiedBy(T candidate) {
        return left.isSatisfiedBy(candidate) && right.isSatisfiedBy(candidate);
    }
}

// domain/model/spec/OrSpecification.java
public record OrSpecification<T>(Specification<T> left, Specification<T> right) implements Specification<T> {
    @Override
    public boolean isSatisfiedBy(T candidate) {
        return left.isSatisfiedBy(candidate) || right.isSatisfiedBy(candidate);
    }
}

// domain/model/spec/NotSpecification.java
public record NotSpecification<T>(Specification<T> target) implements Specification<T> {
    @Override
    public boolean isSatisfiedBy(T candidate) {
        return !target.isSatisfiedBy(candidate);
    }
}
```

使用场景：

- **领域层业务规则校验**：组合多个原子规则判定实体状态是否满足条件，避免 if-else 散落在 Service 中
- **Repository 查询过滤**：将 Specification 作为 Repository 查询参数，使查询条件可复用、可组合

```java
// 原子规则实现
public class HighValueOrderSpec implements Specification<Order> {
    private static final BigDecimal HIGH_VALUE_THRESHOLD = new BigDecimal("50000000");
    @Override
    public boolean isSatisfiedBy(Order order) {
        return order.getTotalAmount().compareTo(HIGH_VALUE_THRESHOLD) >= 0;
    }
}

public class OverdueOrderSpec implements Specification<Order> {
    @Override
    public boolean isSatisfiedBy(Order order) {
        return order.hasOverdueItems();
    }
}

// 组合规则 + Repository 查询
public class OrderService {
    private final OrderRepository repository;

    public List<Order> findHighRiskOrders() {
        var highValue = new HighValueOrderSpec();
        var overdue = new OverdueOrderSpec();
        return repository.findSatisfying(highValue.or(overdue));
    }
}
```

- 原子规则类以 `Spec` 后缀命名，放在 `domain/model/spec` 包
- 组合通过接口默认方法链式调用，无需额外工厂
- 入参为领域实体或值对象，不在 Specification 中引入基础设施依赖

## Anti-Corruption Layer

> 概念见 ddd-architecture，以下为 Java 实现示例。

防腐层（ACL）隔离外部模型与领域模型：

```
infrastructure/acl/
├── ExternalSearchClient.java          ← 外部 API 调用
├── ExternalResponseConverter.java     ← 外部模型 → 领域模型转换
└── OrderExternalConverter.java        ← 输出方向：领域模型 → 外部模型
```

- ACL 位于 `infrastructure/acl` 包
- 输入方向：ACL 将外部模型（第三方 API、遗留系统、旧数据库）转换为领域模型
- 输出方向：ACL 将领域模型转换为外部模型
- 约束：领域模型不依赖外部模型，ACL 转换方向仅为 infrastructure → domain

六边形视角下，ACL 属 driven adapter（出站适配器）中的转换组件，方向约束同"adapter → 内核"。

**正反对照——外部系统名不得上浮到内核与 interfaces 层**：

```java
// 错误：application/interfaces 层出现外部系统名
public class SapCustomerService {
    public SapCustomerResponse queryFromErp(String sapOrderNo) {
        // 外部系统名进入接口/方法/DTO 命名
    }
}

// 正确：内核侧接口/DTO 用领域语义命名
public interface SearchPort {                       // domain 定义的 Port，领域语义命名
    SearchResultDto search(SearchQuery query);
}

// 正确：外部系统名仅出现在 infrastructure/acl 包（实现类、转换类）
public class SearchProviderClient {                 // infrastructure/acl 实现类
    private final ExternalSearchClient externalSearchClient;  // 外部 API 调用下沉在 acl 包内
}
```

## 核心规则

> 概念见 ddd-architecture，以下为 Java 实现示例。

| # | 规则 | 违反后果 |
|---|------|---------|
| 1 | Domain 层零框架依赖（不 import Spring、MyBatis、Spring AI、infrastructure、interfaces 的任何类） | ArchUnit 编译/测试失败 |
| 2 | 依赖方向不可逆（infrastructure 不得依赖 interfaces） | 循环依赖、架构腐化 |
| 3 | Interface 层不直接依赖 Infrastructure 层 | 架构违规 |
| 4 | 依赖注入使用构造器注入，禁止 `@Autowired`/`@Resource` 字段注入 | 测试困难、隐式依赖 |
| 5 | 值对象使用 `final` 字段，无 setter | 可变状态 bug |
| 6 | 枚举类型统一在 Domain 层定义 | 层级混乱 |
| 7 | 每个包必须有 `package-info.java` | 包文档缺失 |
| 8 | Domain 实体为纯 POJO，不继承任何框架基类（如 MyBatisPlus 的 BaseEntity） | 破坏零框架依赖约束 |
| 9 | interfaces 层不直接暴露 domain 实体，须经 assembler 转为 DTO | 层级泄露、API 契约与内部模型耦合 |
| 10 | 领域异常类（BusinessException 及其子类、ErrorCode）统一放在 `domain/exception` 包 | 异常分散在各层导致循环依赖 |
| 11 | Command 方法禁止返回 domain 实体，应返回 `void` 或 `CommandResult` | 层间耦合、副作用隐患 |
| 12 | Query 方法禁止修改状态，返回值必须是 DTO 或投影，禁止返回 Entity/PO | 读写混淆、CQRS 失效 |
| 13 | 禁止贫血 domain 实体——实体须包含行为方法，setter 不得用于业务状态变更 | 领域逻辑散落在 Service 中 |
| 14 | 聚合根须维护聚合内一致性，禁止外部直接修改子实体属性 | 聚合边界失效、数据不一致 |
| 15 | 跨聚合仅通过 ID 引用，禁止持有其他聚合的对象引用 | 聚合边界模糊、事务扩散 |
| 16 | Repository 禁止向 domain 层暴露 PO 或持久化语义（save/update/delete） | 领域层泄漏技术细节 |
| 17 | Domain Event 在 domain 层定义（`domain/model/event`），infrastructure 层实现 handler | 领域层依赖事件框架 |
| 18 | ACL 只允许 infrastructure → domain 方向，领域模型不依赖外部模型 | 外部模型污染领域层 |
| 19 | 外部系统命名禁止上浮——application 接口方法、DTO 类名/字段名、interfaces 层 DTO 禁止出现外部系统名（第三方/遗留系统/中间件名），须用领域语义命名；外部系统名仅限 infrastructure（ACL/适配器/配置） | 接口契约污染、架构腐化 |
| 20 | 命名须体现语义并遵循统一语言——类/方法/字段命名与术语表一致，禁止泛化命名（如 process/handle/data）掩盖真实意图，禁止同名不同义造成混淆 | 可读性下降、概念混淆 |
| 21 | 禁止另起一套逻辑——同类能力已有既有实现时须复用或扩展，确需平行引入（新旧并存）时须附带既有实现的迁移方案 | 同类能力多套方案并存、技术债累积 |

**声明**：上表同时适用于四层与六边形两种风格。六边形风格下"domain"指内核（domain + application 合并语义），多数规则表述不变——规则 1（内核零框架依赖）、规则 2（依赖方向不可逆）、规则 3、规则 8、规则 9、规则 16、规则 18、规则 19、规则 20、规则 21 在两种风格下均一致。仅 Port 定义位置相关条目注明差异：规则 17 的领域事件契约仍在内核（domain/model/event）定义、事件 handler 实现仍在 infrastructure；Repository、EventPublisher、OrderGenerationPort 等 Port 接口在四层下固定定义于 domain，六边形下可为 domain（driven port）或 application（driving port），但全项目须一致。

## Port / Adapter 模式

> 概念见 ddd-architecture，以下为 Java 实现示例。

Port 接口是内核（domain + application）定义的纯业务契约，Adapter 是技术适配组件，按方向分两类。

**driven port / driven adapter（出站）**：port 由 domain 定义，adapter 在 infrastructure 实现。

\`\`\`java
// domain/service/OrderGenerationPort.java — driven port，零框架依赖
public interface OrderGenerationPort {
    OrderInfo generate(OrderData data);
}

// infrastructure/llm/LlmOrderGenAdapter.java — driven adapter（出站）实现
@Component
public class LlmOrderGenAdapter implements OrderGenerationPort {
    // 内部使用 Spring AI ChatModel
}
\`\`\`

**driving port / driving adapter（入站）**：port 由 application 定义，adapter 在 interfaces 实现。

\`\`\`java
// application/service/OrderService.java — driving port，用例入口
public interface OrderService {
    CommandResult createOrder(CreateOrderCommand cmd);
}

// driving port 由 application 层应用服务实现（use case，同 CQRS 章节 CreateOrderService 模式），经 Spring 注入到 driving adapter

// interfaces/controller/OrderController.java — driving adapter（入站）调用端口
@RestController
public class OrderController {
    private final OrderService orderService; // driving port，由 Spring 注入 application 层应用服务实现

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping("/orders")
    public CommandResult createOrder(@RequestBody CreateOrderCommand cmd) {
        return orderService.createOrder(cmd);
    }
}
\`\`\`

四层分层下两类分别落在 interfaces 与 infrastructure；六边形下即 driving adapter 与 driven adapter。

## 共性能力基础设施化

> 概念见 ddd-architecture，以下为 Java 实现示例。

应统一拦截/封装到 Infrastructure 层或框架级能力的横向逻辑，不得分散在各 Controller/Service 中逐点调用。

### 适用场景

| 类别 | 示例 | 上收方式 |
|------|------|---------|
| 横切关注点 | 鉴权·审计·日志·限流·幂等·事务 | Filter / Interceptor / AOP（@Around/@Before/@After） |
| 共性策略约束（全局） | 文件类型·大小限制、权限规则、脱敏规则 | 先判是否全局（跨多接口/模块），若是 → 放入 Infrastructure 层统一 Filter 或 @ControllerAdvice；若是单模块 → 控制在 Application Service 门面 |
| 重复集成封装 | 外部 API 调用、序列化/转换、连接管理 | 公共 Client/Adapter 基类，一次封装全局复用 |
| 散落的全局配置 | 超时·重试·线程池·白名单 | 统一在 application.yml / @ConfigurationProperties 集中管理 |

### 判据

同一逻辑在 ≥2 处独立实现、属横向共性需求（非单点业务上下文特有）、新增场景漏调度即失效 → 必须基础设施化。

## Spring DI

> 概念见 ddd-architecture，以下为 Java 实现示例。

\`\`\`java
// 正确：构造器注入
@RestController
public class OrderController {
    private final OrderService orderService;
    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }
}

// 错误：字段注入
@Autowired private OrderService orderService;
```
