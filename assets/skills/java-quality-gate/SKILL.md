---
name: java-quality-gate
description: 仅限 Java 后端开发场景。Java 项目质量门工具集——Maven/Spotless/PMD/ArchUnit/JaCoCo/SonarQube。通用质量门流程见 quality-gate。
capabilities: ["quality-gate", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 quality-gate 的 Java 实现配套，仅含 Java 技术栈特有工具命令与输出解析。通用质量门流程见 quality-gate。调用本 skill 须同时加载 quality-gate。

## 通用步骤

### 必做检查清单

以下清单枚举所有检查项。每项不可跳跃——要么执行并报告结果，要么在提交报告中注明跳过理由及对应 issue：

| 序号 | 检查项 | skill 章节 | 报告要求 |
|------|--------|-----------|---------|
| 1 | 工具环境检查 | 第 0 节 | 逐项报告可用性，不可用须注明降级理由 |
| 2-6 | 全量生命周期：编译 + 格式 + 架构 + PMD + UT + 覆盖率 | 第 1～5 节 — `mvn verify -q` | 报告 BUILD SUCCESS/FAILURE、格式违规数、架构违规数、PMD 违规数和严重级别、测试通过率与覆盖率 |
| 7 | SonarQube 深度扫描 | 第 6 节 | 报告执行结果或降级理由 |
| 8 | 质量工具配置检查 | 第 7 节 | 报告通过或配置削弱清单 |
| 9 | 汇总与提交 | 第 9 节 | 提交检查结果 |

## 0. 工具环境检查

在执行工具检查前，先确保工具运行环境就绪。环境检查失败时先按自愈性步骤尝试恢复；不可自愈或自愈失败后，用 `question` 提请用户处理或裁定。用户裁定降级跳过时，在报告中注明降级理由，不阻塞其他检查。

使用编排会话提供的隔离标识 `<namespace>`（来自编排会话上下文）为 SonarQube 容器指定独立的 docker compose 项目名，避免多个并发 change 的容器互相冲突。

```bash
docker info
docker compose version
curl -sf http://localhost:9000/api/system/status | grep -q UP
sonar-scanner --version
```

| 检查项 | 命令 | 自愈性 | 失败后处理 |
|--------|------|-------|-----------|
| Docker daemon | `docker info` | 不可自愈 | `question` 用户（需宿主介入）→ 用户处理后重试或裁定降级跳过 |
| docker-compose | `docker compose version` | 不可自愈 | `question` 用户 → 用户处理后重试或裁定降级跳过 |
| SonarQube 服务 | `curl -sf http://localhost:9000/api/system/status \| grep -q UP` | 可自愈 | 先 `docker compose -p <namespace> -f <docker-compose-file> up -d sonarqube` 自愈；失败则 `question` 用户 → 裁定降级 |
| sonar-scanner CLI | `sonar-scanner --version` | 不可自愈 | `question` 用户（需安装 CLI）→ 用户处理后重试或裁定降级 |

## 1. 编译检查

```bash
mvn verify -q; echo "BUILD_STATUS=$?"
```

说明：`mvn verify` 包含 compile + test + spotless:check + pmd:check 等阶段。

- 通过：`BUILD_STATUS=0`
- 不通过：`BUILD_STATUS≠0` → 工具层 issue，severity=Critical，须修复

## 2. 代码格式检查

```bash
mvn spotless:check
```

- 通过：无格式违规，输出 "[INFO] Spotless check passed"
- 不通过：→ tool 类 issue，severity=Low，每条违规映射为一个 issue
  - 从 `spotless:check` 输出中提取违规文件路径
  - 修复方式：运行 `mvn spotless:apply`

## 3. 架构约束检查

```bash
mvn test -Dtest="*Architecture*,*ArchRule*"
```

- 通过：所有 ArchUnit 测试通过
- 不通过：→ tool 类 issue，severity=Medium，每条 ArchUnit 违规映射为一个 issue
  - expression: 从测试失败信息中提取违规类名和描述
  - 示例："Domain 层引入 org.springframework.stereotype.Service"

## 4. 代码质量检查

```bash
mvn pmd:check
```

### 阻塞级

PMD 检查返回非 0（有违规）即阻塞 task 完成。以下 PMD 规则集启用：

- `category/java/errorprone.xml`（错误模式：空 catch、compareToEquals 等）
- `category/java/bestpractices.xml`（最佳实践：unused imports、System.out 等）
- `category/java/bestpractices.xml` 中 `AvoidReassigningParameters`、`JUnitTestsShouldIncludeAssert` 等默认启用
- `category/java/design.xml`（设计：方法长度、圈复杂度、God class 等）
- `category/java/performance.xml`（性能：String 拼接、冗余对象创建等）

### 违规项 → issue 映射

| PMD 规则 | 优先级 | issue severity | 典型场景 |
|----------|--------|---------------|---------|
| System.out/err | 2 | Medium | `System.out.println(...)` |
| 空 catch 块 | 3 | High | `catch(Exception e) {}` |
| 方法过长 | 3 | Medium | 方法超过 100 行 |
| 圈复杂度过高 | 3 | Medium | CC > 15（方法级）、CC > 20（类级） |
| 未使用变量/import | 3 | Low | import 引用但未使用 |
| String 拼接 | 3 | Low | 循环内 `s += ...` |
| 未关闭资源 | 3 | High | 未使用 try-with-resources |
| 类级 @SuppressWarnings | 2 | Medium | 在类级别添加 @SuppressWarnings 抑制特定规则 |

### 输出解析

PMD 违规输出格式：
```
[WARNING] PMD Failure: <file>:<line> Rule:<rule> Priority:<N> <message>
```

从输出中逐行解析，提取 file / line / rule / message 字段。

## 5. 单元测试 + 覆盖率

```bash
mvn test
```

说明：`mvn verify` 已包含本阶段（生命周期内自动调用 `mvn test` + JaCoCo 覆盖率检查）。

排除 `ArchitectureTest`（已在第 3 节单独跑）。

- 通过：所有测试通过
- 不通过：→ 工具层 issue，severity 按测试类型区分
  - 业务逻辑测试失败 → High（功能回归）
  - 新增功能测试失败 → Medium（新代码 Bug）
  - 测试基础设施问题 → Critical（环境问题）

### 覆盖率（JaCoCo）

JaCoCo 已在 `pom.xml` 中配置，`mvn verify` 后自动在 `target/site/jacoco/` 下生成报告。解析 `jacoco.csv` 获取覆盖率数据：

```bash
cat target/site/jacoco/jacoco.csv
```

| 字段 | 含义 |
|------|------|
| INSTRUCTION_MISSED/COVERED | 字节码指令覆盖率 |
| BRANCH_MISSED/COVERED | 分支覆盖率 |
| LINE_MISSED/COVERED | 行覆盖率 |

覆盖率检查以 pom.xml 中 JaCoCo `<check>` 配置为准。可按包路径定义多层策略（如整体保底 + 核心包高要求），各层阈值从 pom.xml 中读取。
双层检查均在 `mvn verify` 中自动执行，任何一层不达标即 build 失败。

## 6. SonarQube 深度扫描

### 前置条件

本地 SonarQube Server 通过 `docker compose -p <namespace> -f <docker-compose-file> up -d sonarqube` 启动。

### 配置

`sonar-project.properties` 文件位于项目根目录。

### 执行

```bash
sonar-scanner -Dsonar.projectKey=<项目原key>-<namespace>
```

MUST 使用 `-Dsonar.projectKey` 指定含隔离标识 `<namespace>` 的项目 key（原始 key 从 `sonar-project.properties` 读取后追加 `-<namespace>`），禁止不加 `-Dsonar.projectKey` 覆盖直接执行 `sonar-scanner`。隔离标识来自编排会话上下文。

### 违规项 → issue 映射

| SonarQube severity | issue severity | 处理方式 |
|-------------------|---------------|---------|
| blocker | Critical | 阻塞，必须修复 |
| critical | High | 阻塞，必须修复 |
| major | Medium | 阻塞，必须修复 |
| minor | Low | 阻塞，建议修复 |
| info | Info | 不阻塞 |

SonarQube 规则 6,500+，覆盖 PMD 无法检测的安全漏洞、代码异味、Bug 模式和安全热点。

### 输出解析

从 `sonar-scanner` 输出或 SonarQube API 获取 `issues`，提取：
- `rule`（如 `java:S106`）
- `component`（文件路径）
- `line`（行号）
- `message`（描述）
- `severity`（BLOCKER/CRITICAL/MAJOR/MINOR/INFO）

## 7. 质量工具配置检查

```bash
git diff --name-only <baseRef>..HEAD | grep -E "(pmd-rules\.xml|sonar-project\.properties|pom\.xml)"
```

检查本轮 diff 中是否包含质量工具规则/配置文件的改动。若包含，逐一检查以下维度：

- 规则是否被删除或降级（如 PMD priority 从 1 改为 5，或规则项被整条移除）
- 是否新增了过宽的 exclude/include 配置（如排除整个命名空间、跳过核心架构检查）
- `pom.xml` 中 `spotless-maven-plugin` / `pmd-maven-plugin` 等质量插件配置是否被弱化（跳过执行、降低阻塞等级）

检查结果：

- 配置无削弱 → 通过
- 配置存在削弱 → 工具层 issue，severity=Medium，每条削弱映射为一个 issue

## 8. 工具输出 → 统一 issue dimension 映射表

每个工具的输出必须翻译为统一 issue 结构，并携带 `dimension` 字段归属于 5 维之一：

### 统一 issue 结构

```json
{
  "file": "<相对路径>",
  "line": <行号>,
  "dimension": "style|architecture|performance|security|maintainability",
  "severity": "Critical|High|Medium|Low|Info",
  "description": "<问题描述>",
  "suggestion": "<修改建议>"
}
```

### 映射规则

| 工具 | 原始分类/规则 | 映射 dimension |
|------|--------------|---------------|
| **PMD** | `Design` 规则 | `architecture` |
| **PMD** | `CodeStyle` 规则 | `style` |
| **PMD** | `ErrorProne` 规则 | `maintainability` |
| **PMD** | `BestPractices` 规则 | `maintainability` |
| **PMD** | `Performance` 规则 | `performance` |
| **SonarQube** | `VULNERABILITY` / `SECURITY_HOTSPOT` | `security` |
| **SonarQube** | `CODE_SMELL`（与可维护性相关） | `maintainability` |
| **SonarQube** | `CODE_SMELL`（与格式/命名相关） | `style` |
| **SonarQube** | `BUG` | `maintainability` |
| **Spotless** | 所有格式违规 | `style` |
| **ArchUnit** | 所有架构约束违规 | `architecture` |
| **UT 编译/运行失败** | 测试失败 | `maintainability` |

## 9. 汇总与提交

所有工具检查完成后，汇总检查结果并提交：
- issues：统一 issue 结构列表（每条携带 dimension）
- passed：true/false
- fixed_issue_ids / exempt_issue_ids：酌情传入

完成后清理隔离环境：`docker compose -p <namespace> down`（不影响其他 change 的容器）。
