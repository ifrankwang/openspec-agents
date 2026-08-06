---
name: java-quality-tool-improve
description: 仅限 Java 后端开发场景。工具规则改进指南。Quality reviewer（architecture/maintainability/style/performance/security）加载，用于将 Java 项目中可工具化的 pattern 转化为具体的 ArchUnit / PMD / Spotless / SonarQube 规则草案。skill 提供各场景下工具配置改动的信号表与规则模板。
capabilities: ["tool-improvement", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

## 识别可工具化 pattern

以下信号表明一个问题可能可以工具化：

| 信号 | 示例 | 对应工具 |
|------|------|---------|
| 包/层依赖违规 | domain 层 import Spring 注解；interfaces 层直连 infrastructure 层 | ArchUnit |
| 特定注解/命名模式违规 | 类级别 @SuppressWarnings | ArchUnit 或 PMD |
| 特定方法签名模式违规 | domain 实体暴露 public setter | ArchUnit |
| 代码结构/复杂度违规 | 方法超 100 行 | PMD |
| 格式化违规 | 缩进/换行不符合团队约定 | Spotless |
| 安全漏洞模式 | SQL 拼接、硬编码凭证 | SonarQube |
| 覆盖率误报 | DTO/POJO/Lombok/配置类被覆盖率检查标记为未覆盖 | JaCoCo/SonarQube |

## 规则草案模板

### ArchUnit 规则

规则建议须附规则代码正文与验证命令。agent 必须按以下顺序自行推断规则文件路径，**禁止预设固定路径**：

1. **查现有测试**：扫描项目已有 ArchUnit 测试文件（grep `ArchUnit`、`archunit`），沿用其所在包路径和目录结构
2. **查构建配置**：如无现有 ArchUnit 测试，读取 `pom.xml` / `build.gradle` / `build.gradle.kts` 确定测试源目录（默认 `src/test/java`）和项目组/包前缀
3. **兜底**：以上均无可用信息时，从项目源码文件推断基础包 + 测试源目录 `src/test/java`

规则内容按检测到的项目分层/模块约定编写 ArchUnit 断言：

```java
@Test
void {testMethodName}() {
    classes()
        .that().{条件}
        .should().{约束}
        .check(importedClasses());
}
```

- **验证命令**：agent 按实际创建的文件名（含包路径）拼接，格式 `mvn test -Dtest="{全限定类名}"`——禁止预设通配模式，因各项目测试类命名规则不同

### PMD 规则

规则建议须附待追加 XML 块与验证命令：

```xml
<!-- 规则文件位置：src/main/resources/pmd-rules.xml -->
<!-- 在 <ruleset> 中追加以下规则 -->

<rule name="{规则名}"
      language="java"
      message="{违规信息}"
      class="{PMD 规则类名}"
      priority="{1-5，1=最高}">
    <description>{规则描述}</description>
    <priority>{1-5}</priority>
    <properties>
        <property name="xpath" value="{XPath 表达式}" />
    </properties>
</rule>
```

- PMD 规则文件位置：`src/main/resources/pmd-rules.xml`
- 新增规则追加在 `<ruleset>` 元素内
- 验证命令：`mvn pmd:check`

对于简单模式，推荐使用 XPath 规则；复杂逻辑使用 Java 规则类（需放在独立模块中）。

### Spotless 规则

Spotless 使用 Palantir Java Format，自定义空间有限。多数格式问题通过更新 pom.xml 中的 `spotless-maven-plugin` 配置实现：

- 规则位置：`pom.xml` → `spotless-maven-plugin` 配置块
- 验证命令：`mvn spotless:check`
- 自动修复：`mvn spotless:apply`

### SonarQube 规则

SonarQube 使用内置规则库（6,500+），一般无需自定义规则。工具改进集中在**抑制误报**：

- **框架误报**：POJO 类使用 MapStruct、MyBatis、Lombok 时私有字段被误判为未使用 → 在 `sonar-project.properties` 加 exclusion 排除特定目录/文件
- **精准抑制**：某规则对特定文件模式产生误报 → 用 `sonar.issue.ignore.multicriteria` 按规则 ID + 文件模式抑制

```
# 完全排除扫描（该目录不参与任何规则检查）；覆盖率误报请用 sonar.coverage.exclusions，见下
sonar.exclusions=**/generated/**,**/model/*.java

# 按规则+模式精准抑制
sonar.issue.ignore.multicriteria=e1
sonar.issue.ignore.multicriteria.e1.ruleKey=java:S1068
sonar.issue.ignore.multicriteria.e1.resourceKey=**/model/*.java
```

- **覆盖率排除**：POJO/DTO/Lombok/配置类/生成代码等不需单元测试的类被覆盖率检查误报为"未覆盖"时，用 `sonar.coverage.exclusions` 按通配模式跳过覆盖率计算：

  ```
  # 按通配模式跳过覆盖率计算（仍参与其他规则扫描）
  sonar.coverage.exclusions=**/model/*.java,**/dto/*.java,**/generated/**
  ```

  - `sonar.exclusions` 是完全排除扫描（该目录不参与任何规则检查），`sonar.coverage.exclusions` 仅跳过覆盖率计算、仍参与其他规则扫描。对 POJO/DTO 等应优先用 `sonar.coverage.exclusions`，避免完全排除导致漏检安全规则。
- **误报抑制与门禁**：项目须通过质量门禁。门禁不通过时先分析是否为误报导致，参照本节排除/抑制方式处理，不得为凑覆盖率扩大排除范围。排除范围仅限确实不需要单元测试的类，过度排除属质量配置削弱。

- 配置文件位置：`sonar-project.properties`
- 验证命令：`sonar-scanner -X`

### JaCoCo 排除规则

不需单元测试的类（包括但不限于：POJO / DTO / Lombok 注解类、`@Configuration` / `@ConfigurationProperties` 配置类、常量 / 枚举类、`@SpringBootApplication` 启动类、纯接口（无 default 方法）、生成代码）被覆盖率检查误报为"未覆盖"时，在 `jacoco-maven-plugin` 的 `<configuration><excludes>` 中追加 `<exclude>` 条目，排除范围与 SonarQube 覆盖率排除口径一一对应：

```xml
<!-- 规则文件位置：pom.xml → jacoco-maven-plugin <configuration><excludes> 中追加 -->
<excludes>
    <exclude>**/model/*.class</exclude>
    <exclude>**/dto/*.class</exclude>
    <exclude>**/generated/**</exclude>
</excludes>
```

- 排除范围仅限确实不需要单元测试的类，不得为凑覆盖率扩大排除范围——过度排除属质量配置削弱。
- 验证命令：`mvn verify -q; echo "BUILD_STATUS=$?"`（含 JaCoCo check 阶段）或 `mvn jacoco:check`，构建成败以退出码为判据

## 规则与 severity 映射

| 来源 | 级别 | 严重级别 |
|------|------|---------------|
| ArchUnit 违规 | — | Medium |
| PMD priority 1 | — | High |
| PMD priority 2 | — | Medium |
| PMD priority 3 | — | Low |
| SonarQube blocker | — | Critical |
| SonarQube critical | — | High |
| SonarQube major | — | Medium |
| SonarQube minor | — | Low |
| Spotless 违规 | — | Low |


