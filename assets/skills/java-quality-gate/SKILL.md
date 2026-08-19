---
name: java-quality-gate
description: 仅限 Java 后端开发场景。Java 项目质量门工具集——Maven/Spotless/PMD/ArchUnit/JaCoCo/SonarQube。通用质量门流程见 quality-gate。
capabilities: ["quality-gate", "tech-stack-java"]
# 机器可读必做清单：与下方「必做检查清单」表格逐项一一对应（汇总与产出属流程元项，不作为必做申报项）。
# 第 2-6 行「全量生命周期」拆分为 compile/format/architecture/static_analysis/unit_test/coverage；
# 第 7 行「SonarQube 深度扫描」对应 deep_scan（quality-gate 第 6 类深度扫描的 Java 具体实现）。
must_do: ["env", "compile", "format", "architecture", "static_analysis", "unit_test", "coverage", "deep_scan", "config_check"]
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
| 9 | 汇总与产出 | 第 9 节 | 产出检查结果与 issue 清单 |

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

`<docker-compose-file>` 优先取项目根目录下含 sonarqube 服务的 `docker-compose*.yaml`。

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
- `category/java/bestpractices.xml`（最佳实践：unused imports、System.out、AvoidReassigningParameters、JUnitTestsShouldIncludeAssert 等）
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

> 本表为高频示例（非穷举），规则为常见俗名；官方全名与分类见 `reference/pmd-rules.md`，未收录规则按「PMD 规则语义定位」方法论直拉官方源。

### 输出解析

PMD 违规输出格式：
```
[WARNING] PMD Failure: <file>:<line> Rule:<rule> Priority:<N> <message>
```

从输出中逐行解析，提取 file / line / rule / message 字段。

机器检索违规清单首选 `target/pmd.xml`（结构化、`<violation>` 一行一元素、rule 属性可直接 grep）。若 pom 未配置 `format=xml` 导致该文件不存在，先执行 `mvn pmd:pmd -Dpmd.format=xml` 生成。多模块项目到各模块 `target/` 目录查找。

不解析 HTML 报告（`target/reports/pmd.html` 体积大、格式脆弱，仅适合人工阅读）。

`target/pmd.xml` 被 `<suppressedviolation>` 污染（全量规则集 + 抑制配置时）时，改用自定义 ruleset 生成的干净报告，或读取 `mvn pmd:check` 非 -q 形态 console 输出中的 `[WARNING] PMD Failure` 行。

### 覆盖范围

PMD 全量报告中的每条违规均须纳入问题清单，不因文件不在本次修改范围或经基线对比确认为存量而省略。

### 测量与复现

pom 中 maven-pmd-plugin 显式配置的 `<rulesets>` 会覆盖命令行 `-Dpmd.rulesets`，修改生效规则集须改 pom 配置，勿用命令行参数覆盖。

生成干净报告：自定义 ruleset 运行 `mvn pmd:pmd`，生成的 `target/pmd.xml` 不含全量规则集 + 抑制配置产生的 `<suppressedviolation>` 污染，可直接 grep 按 rule 过滤。

PMD CLI 手动运行需完整 classpath：用 `mvn dependency:build-classpath` 自动生成，禁止手工枚举 jar（classpath 缺 jar 是高频失败源）。

改动规则/阈值前先在最小项目实测规则效果再落地。

### PMD 规则语义定位（检索方法论）

以工具输出为入口：`mvn pmd:check` 违规清单按 `rule` 字段去重，仅对命中规则做语义定位，不预置全量规则内容。

确定项目实际 PMD 版本：读 `mvn dependency:tree -Dincludes=net.sourceforge.pmd` 实际解析的 pmd-core/pmd-java 版本，或 pom 显式配置的 PMD 版本；不得仅凭 maven-pmd-plugin 版本号推断（3.22.0 起默认 PMD 7，且 pom 可覆盖插件默认版本）。

直拉官方规则定义（首选）：`https://raw.githubusercontent.com/pmd/pmd/pmd_releases/<实际版本>/pmd-java/src/main/resources/category/java/<分类>.xml`，从 `<rule name="...">` 节点读取默认阈值 property、判定逻辑（xpath 或规则类）、externalInfoUrl；版本无法确定时降级用 `main` 分支（注意 main 为开发分支，内容代表未来版本）。

文档锚点核对：`https://docs.pmd-code.org/pmd-doc-<实际版本>/pmd_rules_java_<分类>.html#<规则全名小写>`（锚点即规则全名小写）。

兜底：经文档检索渠道（定义见 README「文档检索渠道」）语义定位规则所属分类，结果与上述官方源交叉核对；注意区分同族易混规则（如 TooManyMethods / NcssCount / ExcessiveMethodLength）。

外查结果（规则全名/默认阈值/语义）写入 issue 描述；需要规则索引时读取 `reference/pmd-rules.md`。

### CPD 重复代码检查

若项目 `maven-pmd-plugin` 配置了 `cpd-check` goal，则随 `mvn verify` 一并执行；未启用则本检查项跳过，不强制项目启用。

重复块明细以 `target/cpd.xml` 为主解析来源。`cpd-check` 执行时在该文件生成报告，`<duplication>` 元素下逐 `<file>` 属性列出重复块的文件与起止行列（PMD 7 的 file 元素含 line/endline/column/endcolumn 属性）。重复块跨文件时，同一块对应的全部位置均须记录。

控制台输出默认只有汇总行，逐位置明细行仅开启 `pmd.verbose=true` 或 `pmd.printFailingErrors=true` 时输出：

```
CPD Failure: Found 14 lines of duplicated code at locations:
    <绝对路径> line 42
```

`CPD Failure` 行单独成行，下一行以 4 空格缩进列出重复位置、每文件一行；日志级别随版本而异（旧版 `[INFO]`、新版 `[WARNING]`）。汇总行表述随 maven-pmd-plugin 版本变化：3.26+ 为 `CPD <版本> has found N duplications`（以 `[WARNING]` 或失败时随异常 `[ERROR]` 呈现），3.22 及以前为 `You have N CPD duplications. For more details see: <path>`。位置明细以 `cpd.xml` 为准，不受版本差异影响。

映射口径：每处重复块映射为一条 issue，description 列出该块全部文件位置，不按位置拆分多条。严重级别沿用上方逐条映射惯例——逻辑重复方法 → Medium、纯数据字段 → Low，不走「mvn verify 失败 → Critical」路径。

## 5. 单元测试 + 覆盖率

```bash
mvn test
```

说明：`mvn verify` 已包含本阶段（生命周期内自动调用 `mvn test` + JaCoCo 覆盖率检查）。

`mvn test` 实际全量运行全部测试，其中 `ArchitectureTest` 已在第 3 节单独执行，本节不重复计数、不重复报告其执行结果。

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

`jacoco.csv` 的完整列序为 `GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,BRANCH_COVERED,LINE_MISSED,LINE_COVERED,COMPLEXITY_MISSED,COMPLEXITY_COVERED,METHOD_MISSED,METHOD_COVERED`，每个计数器按 MISSED 在前、COVERED 在后排列。

覆盖率聚合按计数器列求和后计算：`LINE 覆盖率 = ΣLINE_COVERED / (ΣLINE_MISSED + ΣLINE_COVERED)`，INSTRUCTION、BRANCH 同理。

`jacoco.csv` 每行对应一个含代码的 class，不包含汇总行，对所有数据行按计数器列求和即为总体统计；若数据中出现 `CLASS=Total` 行（由部分工具导出），跳过该行避免双计数。

核心包过滤：核心包范围以 `<project-specific:jacoco-core-packages>` 占位符表示，由项目填充具体包路径；项目未填充该占位符时仅报告整体覆盖率。

覆盖率检查以 pom.xml 中 JaCoCo `<check>` 配置为准。可按包路径定义多层策略（如整体保底 + 核心包高要求），各层阈值从 pom.xml 中读取。
双层检查均在 `mvn verify` 中自动执行，任何一层不达标即 build 失败。

## 6. SonarQube 深度扫描

### 前置条件

本地 SonarQube Server 通过 `docker compose -p <namespace> -f <docker-compose-file> up -d sonarqube` 启动。

### 扫描前准备

以 `<项目原key>-<namespace>` 作为 project key，经 SonarQube Web API 完成 project 预创建、new code 定义设置与一次性认证 token 生成。

#### admin 凭据来源

Web API 管理操作（project 预创建、new code 定义设置、token 生成与回收）所用的 admin 凭据按以下回退链取得：

1. 项目 `sonar-project.properties` 的 `sonar.login` / `sonar.password`
2. docker-compose 中 SonarQube 服务环境变量（如 `SONAR_SECURITY_LOCALSTARTUPPASSWORD`）
3. 社区版本地部署默认 `admin/admin`

这些凭据仅用于本地 dev 部署的 project 预创建与一次性 token 生命周期。禁止把 admin 凭据写进扫描参数（扫描本身走 token 注入）；`sonar.login` 语义是 scanner 侧认证，Web API 管理操作须以用户名+密码形态使用。

#### 判断 project 存在性并预创建

先经 Web API 查询 project 是否已存在，不存在才创建：

```bash
curl -sf -u admin:<admin密码> "http://localhost:9000/api/projects/search?project=<项目原key>-<namespace>"
curl -sf -X POST -u admin:<admin密码> "http://localhost:9000/api/projects/create?key=<项目原key>-<namespace>&name=<项目原key>-<namespace>"
```

MUST 先 search 再 create：create 对已存在的 key 返回 HTTP 400，必须以 search 结果判断存在性，禁止直接 create。project key 即 `<项目原key>-<namespace>`。

#### 设置 new code 定义

将 project 的 new code 定义设置为 `NUMBER_OF_DAYS`，天数固定 30：

```bash
curl -sf -X POST -u admin:<admin密码> "http://localhost:9000/api/new_code_periods/set?project=<项目原key>-<namespace>&type=NUMBER_OF_DAYS&value=30"
```

set 后须验证定义生效：

```bash
curl -sf -u admin:<admin密码> "http://localhost:9000/api/new_code_periods/show?project=<项目原key>-<namespace>&branch=main"
```

验证命令返回 `type=NUMBER_OF_DAYS` 且 `value=30` 即生效。Community Edition 下 new code 定义为 branch 级存储，set 时未指定 branch 即落 main branch 级；`show` 不带 `branch` 参数只读取 project 级定义（branch_uuid 为空），恒返回全局继承的 `PREVIOUS_VERSION`，属正常现象，不作为设置失败判据。扫描 main branch 时读取 main branch 级定义，new code 期判定不受影响。

#### 生成一次性认证 token

扫描前用 admin 凭据生成一次性 token，token 值仅本次响应返回一次，扫描结束后回收：

```bash
curl -sf -X POST -u admin:<admin密码> "http://localhost:9000/api/user_tokens/generate?name=<唯一token名>"
```

MUST token 名唯一（如附时间戳或随机后缀），token 值只在生成响应中返回一次，须在后续扫描命令中引用。admin 凭据按上方 `admin 凭据来源` 回退链取得。

### 配置

`sonar-project.properties` 文件位于项目根目录。

### 执行

```bash
SONAR_TOKEN=<token> sonar-scanner \
  -Dsonar.projectKey=<项目原key>-<namespace> \
  -Dsonar.scm.enabled=true \
  -Dsonar.scm.provider=git
```

MUST 使用 `-Dsonar.projectKey` 指定含隔离标识 `<namespace>` 的项目 key（原始 key 从 `sonar-project.properties` 读取后追加 `-<namespace>`），禁止不加 `-Dsonar.projectKey` 覆盖直接执行 `sonar-scanner`。隔离标识来自编排会话上下文。

非 worktree 场景下，MUST 追加 SCM 集成参数 `-Dsonar.scm.enabled=true -Dsonar.scm.provider=git`，git blame 提供代码行修改时间戳，是 new code 期判定的数据基础。SCM 参数经命令行显式传入，禁止改动 `sonar-project.properties`，避免影响质量门配置检查。若因 SCM 集成故障导致扫描失败或 new code 期数据异常，按下方降级判据降级。

非 worktree 场景下，当项目 `sonar-project.properties` 含 `sonar.scm.disabled=true` 时，需在上方命令显式追加 `-Dsonar.scm.disabled=false` 覆盖（`sonar.scm.disabled` 是 SCM 集成总开关，`-Dsonar.scm.enabled=true` 会被其压制）；覆盖失败按下方降级判据降级。

token 经 `SONAR_TOKEN` 环境变量注入（等价写法：`-Dsonar.token=<token>`）。

### 取 new code 期间 issue

经 Web API 查询 new code 期 issue：

```bash
curl -sf -u <token>: "http://localhost:9000/api/issues/search?inNewCodePeriod=true&statuses=OPEN,CONFIRMED,REOPENED&componentKeys=<项目原key>-<namespace>"
```

该端点不返回安全热点，热点经下方独立端点获取。

MUST 使用 `inNewCodePeriod=true` 限定 new code 期，`componentKeys` 传单个 project key。new code 期过滤仅 `inNewCodePeriod` 参数可用（SonarQube 10.0 已移除旧的 leak period 过滤参数）。查询须携带认证，token 复用本流程生成的一次性 token，以 Basic auth 形式经 `-u <token>:` 传入（token 作用户名、密码留空），否则默认开启 forceAuthentication 时返回 401。`inNewCodePeriod` 仅限定 new code 期，不含状态过滤，会返回期内所有状态的 issue（含已关闭 CLOSED FIXED）。MUST 追加 `statuses=OPEN,CONFIRMED,REOPENED` 限定未解决 issue；已关闭 issue 不属本轮待处理项，不得据此误判排除/抑制配置未生效或触发重扫。

### 规则语义定位

issue 的 `rule` 字段（如 `java:S106`）即 SonarSource 官方全名，作为反查入口。

Web API 精确反查：`curl -u <token>:` 调 `/api/rules/search?rule_key=<rule 字段>`（可按需 `&f=` 限定字段），从响应的 `name` 取规则标题、`descriptionSections[].content`（HTML，9.5+ 标准字段）取语义、`severity`/`type` 取分类。

认证与时序：复用「取 new code 期间 issue」生成的一次性 token（Basic auth，token 作用户名密码留空），反查须在 token 回收前完成（取 issue → 反查规则语义 → 回收 token）；匿名不可靠（实例默认强制认证，且 2026.2 起匿名用户拿到的描述字段被混淆）。

外查结果（规则全名/语义/severity）写入 issue 描述。

### 安全热点（独立端点）

`/api/issues/search` 不返回安全热点，热点属独立类别，须经专用端点获取。

先查 `new_security_hotspots` 指标判断 new code 期热点存量：

```bash
curl -sf -u <token>: "http://localhost:9000/api/measures/component?component=<项目原key>-<namespace>&metricKeys=new_security_hotspots"
```

存量 > 0 时经热点专用端点拉取：

```bash
curl -sf -u <token>: "http://localhost:9000/api/hotspots/search?projectKey=<项目原key>-<namespace>&inNewCodePeriod=true&status=TO_REVIEW"
```

MUST 携带 `inNewCodePeriod=true` 限定 new code 期、`status=TO_REVIEW` 限定待评审热点，否则返回全项目历史存量热点。仅报告待评审热点，已审 SAFE/FIXED 不纳入。

Security Hotspot 不可用 NOSONAR 注释抑制。平台状态标注（SAFE/FIXED 等）仅作用于当前 SonarQube 项目的 issue 实例；本编排下每次 change 使用独立项目 key（`<项目原key>-<namespace>`，namespace 按变更隔离），平台状态不随代码跨 change 继承，同一代码问题在新项目的全量扫描中以 OPEN 状态重新出现；跨 change 持续豁免的结论承载位置由编排层定义。命中项目级豁免清单的存量热点按 Info 提报，不重新豁免。

热点无 BLOCKER/CRITICAL 分级体系，按 `vulnerabilityProbability` 映射 issue severity：HIGH → High、MEDIUM → Medium、LOW → Low；TO_REVIEW 表示待评审而非已确认缺陷。违规映射沿用第 8 节映射表 `SECURITY_HOTSPOT → security`。

### 质量门禁与代码规模指标

扫描后一次调用获取质量门禁结果与代码规模指标：

```bash
curl -sf -u <token>: "http://localhost:9000/api/measures/component?component=<项目原key>-<namespace>&metricKeys=alert_status,ncloc,new_lines"
```

- `alert_status`：质量门禁结果（OK/ERROR）。ERROR 时经 `/api/qualitygates/project_status?projectKey=<项目原key>-<namespace>` 解析 `conditions` 字段，定位失败的具体 metric 以产出可定位 issue；亦可读 `sonar-scanner` 输出尾部的 `QUALITY GATE STATUS` 行（PASSED/FAILED）快速判断，失败时仍须以 conditions 定位具体 metric
- `ncloc` / `new_lines`：代码规模指标，供降级判据使用；`new_lines=0` 表示 new code 期无新增行，按下方降级判据触发全量口径

### 回收一次性认证 token

```bash
curl -sf -X POST -u admin:<admin密码> "http://localhost:9000/api/user_tokens/revoke?name=<唯一token名>"
```

MUST 扫描结束即回收 token，禁止遗留长期有效的未回收凭证。

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

### 降级条件

判定条件（扫描前预判）：`[ -f .git ]`（`.git` 为 gitdir 文件，指向 worktree 关联的仓库）或 `git rev-parse --git-dir` 返回含 `/worktrees/` 的路径时，判定当前部署形态为 git worktree。命中 worktree 时跳过 SCM-enabled 扫描尝试，直接进入降级全量扫描；预跳过后的首次扫描即本次全量扫描结果，按第 8 节 dimension 映射统一提交，并在报告注明 SCM 因 worktree 跳过、按降级口径处理。

当 SCM 时间戳不可靠导致 new code 期无法正确识别时，降级为全量 issue 口径。

降级判据（满足其一即触发）：
- scanner 日志出现 git blame 相关警告（如 SCM 信息获取失败、blame 执行失败）
- SCM 集成运行时不可用——scanner 报告无法打开 git 仓库（典型于 git worktree 部署形态，worktree 的 `.git` 为 gitdir 文件，内嵌 JGit 无法解析），或项目 `sonar-project.properties` 存在 `sonar.scm.disabled=true`（已显式 `-Dsonar.scm.disabled=false` 覆盖后仍失败）
- `.git/shallow` 文件存在（shallow clone 历史不完整）
- 全新仓库或 squash 导入，无历史可溯源
- `new_lines` 与 `ncloc` 指标对比异常（new code 期行数明显偏离预期，`new_lines=0` 即触发降级）

降级处理：
- 优先复用本次已 ANALYSIS SUCCESSFUL 的全量扫描结果，禁止为修复 SCM 无限重扫（SCM 覆盖尝试最多 1 次）
- 全量扫描结果按第 8 节 dimension 映射表统一提交，按原始严重级别，不区分是否本轮引入；命中项目级豁免清单的存量问题除外（按 Info 提报，不重新豁免，清单命中由视图标注，无需在此探测）
- 状态过滤独立于期界过滤，new code 查询与降级全量查询两条路径均须带 `statuses=OPEN,CONFIRMED,REOPENED`

## 7. 质量工具配置检查

```bash
git diff --name-only <baseRef>..HEAD | grep -E "(pmd-rules\.xml|sonar-project\.properties|pom\.xml)"
```

检查本轮 diff 中是否包含质量工具规则/配置文件的改动。若包含，逐一检查以下维度：

- 规则是否被删除或降级（如 PMD priority 从 1 改为 5，或规则项被整条移除）
- 是否新增了过宽的 exclude/include 配置（如排除整个命名空间、跳过核心架构检查）
- `pom.xml` 中 `spotless-maven-plugin` / `pmd-maven-plugin` 等质量插件配置是否被弱化（跳过执行、降低阻塞等级）
- `pmd-maven-plugin` 的 CPD 配置是否被弱化（`cpd-check` goal 被移除、`<minimumTokens>` 被过度调高、`<excludes>` 或 `excludeFromFailureFile` 过宽排除——均属弱化形态）

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
| **PMD** | `category/java/design.xml` 规则 | `architecture` |
| **PMD** | `category/java/codestyle.xml` 规则 | `style` |
| **PMD** | `category/java/errorprone.xml` 规则 | `maintainability` |
| **PMD** | `category/java/bestpractices.xml` 规则 | `maintainability` |
| **PMD** | `category/java/performance.xml` 规则 | `performance` |
| **PMD** | CPD 重复代码 | `maintainability` |
| **SonarQube** | `VULNERABILITY` / `SECURITY_HOTSPOT` | `security` |
| **SonarQube** | `CODE_SMELL`（与可维护性相关） | `maintainability` |
| **SonarQube** | `CODE_SMELL`（与格式/命名相关） | `style` |
| **SonarQube** | `BUG` | `maintainability` |
| **Spotless** | 所有格式违规 | `style` |
| **ArchUnit** | 所有架构约束违规 | `architecture` |
| **UT 编译/运行失败** | 测试失败 | `maintainability` |

## 9. 汇总与产出

所有工具检查完成后，汇总检查结果并产出检查结果与 issue 清单：
- 通过/不通过结论：不通过须有至少一个 Low 及以上 issue 作为理由
- issues：统一 issue 结构列表（每条携带 dimension）
- 修复/豁免归属：已修复条目与申请豁免条目按需列出对应 issue id

完成后清理隔离环境：

1. **删除本 change 隔离项目**：先经 Web API 查询确认项目存在（`/api/projects/search?project=<项目原key>-<namespace>`），确认存在后调用 `/api/projects/delete?project=<项目原key>-<namespace>` 删除；delete 返回 404（项目不存在）视为已删除（幂等）。admin 凭据按第 6 节「admin 凭据来源」回退链取得。项目删除后如需重扫，由「判断 project 存在性并预创建」节的 search-then-create 逻辑自动重建，无需人工干预。
2. `docker compose -p <namespace> down`（不影响其他 change 的容器）。

清理后自检：无残留服务进程、无残留隔离容器、无残留隔离扫描分析项目（按隔离标识查询不存在），全部无残留即通过。
