---
name: java-dev-practices
description: Java 开发实践规范——构建命令、代码质量工具、测试策略、提交规范、Spring Boot 配置、开发流程。不定义质量规则，质量规则由各质量维度 skill 覆盖。仅在 Java 后端项目使用。
capabilities: ["dev-practices", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

## 构建命令

```bash
mvn verify                            # 全量验证（单次覆盖全部质量检查）
mvn spotless:apply                    # 自动格式化
mvn compile                           # 编译
mvn test                              # 运行测试
```

- `mvn verify` 为全量验证命令，单次执行即覆盖编译、测试、spotless:check、pmd:check、JaCoCo 覆盖率。构建成败以 `mvn verify -q; echo "BUILD_STATUS=$?"` 的退出码为唯一判据，不依赖肉眼从输出尾部寻找 BUILD SUCCESS/FAILURE 行（`-q` 静默模式抑制 INFO 级 BUILD 行，输出过长时尾部亦不可靠）
- 确认结果时禁止重复执行同一构建命令，单次执行已覆盖全量质量检查；修复后复验属正常重跑
- 需要抽查输出细节时使用非 `-q` 形态 + `grep -E "Tests run|ERROR|jacoco|spotless|pmd"` 提取关键行，禁止仅以 `tail`/`head` 截断输出导致结论行丢失后重跑

## 代码质量工具

**Spotless**（Palantir Java Format）：
- 提交前执行 `mvn spotless:apply` 格式化，`mvn spotless:check` 必须通过
- 配置在 pom.xml `spotless-maven-plugin`

**PMD**：
- 规则集定义按项目级 pmd-rules.xml

**SonarLint**：IDE 建议安装 SonarLint 插件，尽量修复提示问题

## 测试规范

**命名规范**：
- 测试类：`{ClassName}Test`（如 `OrderServiceTest`）
- 测试方法：`test{MethodName}`（如 `testCreateOrder`）

**分层策略**：
- Domain service 测试用纯 JUnit，零 Spring 依赖（domain 层本就无框架依赖）
- 优先切片测试 + `@Import` 组装所需 Bean，避免滥用全量 `@SpringBootTest`（启动慢、依赖环境）
- 仅跨多层集成测试时才用 `@SpringBootTest` + `@ActiveProfiles("test")`

**测试数据库**：
- 默认 H2 内存库（`MODE=PostgreSQL` 兼容模式）
- 配置见 `src/test/resources/application-test.yml`

**WireMock**：
- Stub 位置：`src/test/resources/mock/mappings/`
- 响应体位置：`__files/`
- 用于模拟外部 HTTP 服务

**ArchUnit**：
- 验收 Domain 层零框架依赖
- 验收层间依赖方向（interfaces → application → domain ← infrastructure）
- 依赖：`archunit-junit5`

**测试数据**：
- XLSX 测试文件 → `src/test/resources/`
- 配置文件 → `application-test.yml`

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：
```
feat(domain): 新增 Xxx 值对象
fix(infra): 修复 N+1 查询问题
refactor(app): 重构 XxxService
test(domain): 补充 DomainRuleEngine 测试
docs: 更新 AGENTS.md
chore: 升级依赖版本
```

提交粒度：每个独立子任务至少一个 commit；修复审查反馈时 commit message 引用审查报告问题编号。

## 新功能开发

- 编写单元测试覆盖全部验收条件，测试先行
- 实现代码使测试通过，保持最小实现
- 重构消除重复、改善可读性，测试须持续通过
- 通过代码质量检查（spotless:check + pmd:check）
- 完整测试套件通过

## Bug 修复

- 从问题表象逐层追溯根因，基于事实定位系统性根因
- 修复方案针对根因而非表象
- 编写回归测试覆盖该场景

## 调试

- 使用日志框架输出，禁止直接输出到标准输出
- 任务完成前清理所有仅为调试目的添加的日志
- 生产环境可用的日志使用 info 级别并标注业务含义

## Spring Boot 启动与配置

**启动命令**：`mvn spring-boot:run` 或 `java -jar`

**健康检查**：`/actuator/health`（需引入 actuator starter）

**配置文件分层**：
- `application.yml` — 公共配置
- `application-dev.yml` — 开发环境
- `application-prod.yml` — 生产环境
- `application-test.yml` — 测试环境

**文件上传**：`spring.servlet.multipart.max-file-size: 20MB`，Controller 层须做文件类型白名单校验

**CORS**：开发环境允许前端跨域
