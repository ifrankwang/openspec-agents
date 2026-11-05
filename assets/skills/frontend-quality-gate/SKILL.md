---
name: frontend-quality-gate
description: 仅限 Vue / React 前端项目场景。前端项目质量门工具集——tsc 编译、Prettier 格式、dependency-cruiser 分层规则、ESLint 静态分析、Vitest 单测、覆盖率阈值、SonarQube（SonarJS）深度扫描。通用质量门流程见 quality-gate。
capabilities: ["quality-gate"]
stacks: ["frontend"]
frameworks: ["vue", "react"]
# 检查项与下方「必做检查清单」表格逐项一一对应（汇总与产出属流程元项，不作为检查项）。
# 第 2-6 行「全量检查」含编译/格式/架构/静态分析/单测/覆盖率，第 7 行「SonarQube 深度扫描」
# 是 quality-gate 第 6 类深度扫描的前端具体实现。
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本 skill 是 quality-gate 的前端实现配套，仅含前端技术栈特有工具命令与输出解析。通用质量门流程见 quality-gate。调用本 skill 须同时加载 quality-gate。

## 通用步骤

### 必做检查清单

以下清单枚举所有检查项。每项不可跳跃——要么执行并报告结果，要么在报告中注明跳过理由及对应问题项：

| 序号 | 检查项 | skill 章节 | 报告要求 |
|------|--------|-----------|---------|
| 1 | 工具环境检查 | 第 0 节 | 逐项报告可用性，不可用须注明降级理由 |
| 2-6 | 全量检查：编译 + 格式 + 架构 + 静态分析 + 单测 + 覆盖率 | 第 1～6 节 | 报告编译退出码、格式违规文件数、架构违规条数、ESLint 违规数与严重级别、测试通过率与覆盖率数字 |
| 7 | SonarQube 深度扫描 | 第 7 节 | 报告执行结果或降级理由 |
| 8 | 质量工具配置检查 | 第 8 节 | 报告通过或配置削弱清单 |
| 9 | 汇总与产出 | 第 9 节 | 产出检查结果与问题项清单 |

## 0. 工具环境检查

在执行工具检查前，先确保工具运行环境就绪。环境检查失败时先尝试恢复；不可恢复时提请用户处理或裁定。用户裁定降级跳过时，在报告中注明降级理由，不阻塞其他检查。

```bash
node -v
pnpm -v
pnpm exec tsc -v
pnpm exec prettier -v
pnpm exec eslint -v
pnpm exec depcruise --version
pnpm exec vitest --version
```

- Node 版本以项目 `.nvmrc` / `package.json` 的 `engines` 为准，不以本机全局版本代替
- 一律用 `pnpm exec <tool>` 调用项目安装版本；禁止 `npx <tool>`（会隐式下载另一版本，规则集与结果不可复现）
- 工具未安装属环境缺失，补装开发依赖后复跑；禁止以"项目没配"为由跳过对应检查项

SonarQube 深度扫描另需确认：

```bash
docker info
docker compose version
curl -sf http://localhost:9000/api/system/status | grep -q UP
sonar-scanner --version
```

使用运行环境提供的隔离标识 `<namespace>` 为 SonarQube 容器指定独立 docker compose 项目名，避免并行任务的实例互相冲突。SonarQube 实例与扫描项目均须按隔离标识隔离（独立 compose 项目名 + 项目 key 后缀，见第 7 节），禁止复用宿主既有实例/项目。

## 1. 编译检查

```bash
pnpm exec vue-tsc --noEmit; echo "TSC_STATUS=$?"
# 非 Vue 项目
pnpm exec tsc --noEmit; echo "TSC_STATUS=$?"
```

- 退出码为唯一判据，不依赖输出尾部行做判断
- 以项目 tsconfig 的 `strict` 为基准；本轮变更若关闭/放宽 strict、`noImplicitAny`、`strictNullChecks`，按第 8 节配置削弱处理
- 编辑器的虚拟类型检查不参与，一律以 CLI 结果为准
- 不通过：按 `文件(行,列): error TSxxxx` 逐条解析，每条诊断映射为一个问题项，severity=High（编译阻断）
- 禁止用 `pnpm build` 替代编译检查：构建含打包与压缩，诊断信息被加工/截断，且失败原因混杂

## 2. 代码格式检查

```bash
pnpm exec prettier --check --ignore-unknown .
```

- 通过：退出码 0，无格式违规
- 不通过：从输出中提取 `[warn] <文件>` 行，每个违规文件映射一个问题项，severity=Low
- 修复方式：`pnpm exec prettier --write --ignore-unknown .`
- `.prettierignore` 过宽豁免（把业务源码目录排除）归第 8 节处理，不在此处重复

## 3. 架构约束检查

```bash
pnpm exec depcruise src --config .dependency-cruiser.cjs --output-type err; echo "DEPCRUISE_STATUS=$?"
```

- 通过：退出码 0 且无规则命中
- 不通过：`--output-type err` 每行形如 `error <规则名>: <源> → <目标>`，逐条映射一个问题项
  - 分层/依赖方向违规（下层依赖上层、组件引用页面、api 层引用业务模块）→ severity=Medium
  - 循环依赖 → severity=High
  - 跨 feature 直接引用内部文件 → severity=Medium
- 结构化定位：`--output-type json > depcruise.json`，用 `jq '.summary'` 核对命中数；不同 CLI 版本对 JSON 模式的退出码处理不一致，因此以 `--output-type err` 的文本与退出码为判据，JSON 仅用于取文件与行号
- 规则文件缺失时，先在项目内确认是否已有架构规则（grep `dependency-cruiser`、`.dependency-cruiser.cjs`）；确实没有则报告"架构规则未配置"，属项目基线缺失，不伪造规则结果

## 4. 静态代码分析

```bash
pnpm exec eslint . --max-warnings=0 --format json > eslint.json; echo "ESLINT_STATUS=$?"
jq -r '.[] | .filePath as $f | .messages[] | "\($f):\(.line):\(.column) [\(.ruleId)] \(.message)"' eslint.json
```

- `--max-warnings=0` 保证 warning 也阻塞，不因默认 warn 级别漏报
- 以 JSON 输出逐文件逐消息解析，禁止只看汇总行数

### 规则 → severity 映射

| ESLint 规则 | 问题项严重级别 | 典型场景 |
|-------------|----------------|---------|
| `@typescript-eslint/no-explicit-any` | Medium | 滥用 any 绕过类型 |
| `@typescript-eslint/no-unused-vars` | Low | 未使用变量/参数 |
| `no-console` | Low | 生产代码残留 console.log |
| `eqeqeq` | Low | `==` 隐式转换 |
| `vue/no-mutating-props` | High | 子组件直接修改父级数据 |
| `vue/multi-word-component-names` | Low | 组件名与原生元素冲突 |
| `react-hooks/exhaustive-deps` | Medium | 副作用依赖不完整导致陈旧闭包 |
| `import/no-cycle` | Medium | 模块循环依赖 |
| `no-eval` / `no-implied-eval` | High | 动态执行字符串 |
| `no-unsanitized/property`（引入时） | High | 未净化 HTML 赋值 |

> 本表为高频示例（非穷举），规则为常见俗名；未收录规则按规则语义定位后套用统一严重级别。项目实际规则名以 ESLint 输出为准。

### 压制识别

- 本轮新增 `eslint-disable` / `eslint-disable-next-line` / `@ts-ignore` 无理由注释 → 按被压制规则的级别记录，且不低于 Low
- 理由注释存在但压制的规则与理由不匹配（如用格式化理由压制空 catch）→ 同原级别
- 配置层 `off`/`warn`、`ignorePatterns` 扩大归第 8 节

## 5. 单元测试

```bash
pnpm exec vitest run; echo "VITEST_STATUS=$?"
```

- 通过：退出码 0 且全部用例通过
- 不通过：失败用例逐条映射问题项
  - 业务逻辑断言失败 → High（功能回归）
  - 新增功能用例失败 → Medium（新代码缺陷）
  - 环境/配置/依赖缺失导致无法运行 → Critical（环境问题）
- 全量执行，禁止只跑变更文件代替全量；存量失败按原严重级别记录，不得以"非本轮引入"静默丢弃
- 快照失败先核对是否本轮预期变更；无预期仍失败按测试失败处理
- 项目 `package.json` 若封装了 `pnpm test`（run + coverage 组合），以脚本命令为准，避免与 CI 口径分叉

## 6. 覆盖率

```bash
pnpm exec vitest run --coverage; echo "COVERAGE_STATUS=$?"
```

- 数据源：`coverage/coverage-summary.json`（istanbul json-summary reporter，V8 与 istanbul provider 均输出该文件；vitest 配置 `coverage.reporter` 须含 `json-summary`）
- 读取方式：

```bash
jq '{lines: .total.lines.pct, branches: .total.branches.pct, functions: .total.functions.pct, statements: .total.statements.pct}' coverage/coverage-summary.json
```

- 阈值：以 `vitest.config.ts` 的 `coverage.thresholds` 为准，不达标即构建失败并映射问题项
  - 整体阈值不达标 → Medium
  - 核心目录阈值不达标 → High
  - 核心目录范围以项目配置为准（占位符 `<project-specific:coverage-core-paths>`，由项目填充具体路径）；未填充时只报告整体覆盖率
- 覆盖率聚合按 json-summary 的 total 统计，不按单文件平均（单文件平均会掩盖大文件缺口）
- 只允许排除类型声明、mock 数据、storybook 等无逻辑文件；把业务逻辑文件移出统计按第 8 节配置削弱处理

## 7. SonarQube 深度扫描（SonarJS）

前端与后端使用同一 SonarQube 平台，获得一致的扫描体验：本地 Docker SonarQube Server + `sonar-scanner`，前端规则由 SonarJS 提供。

### 前置条件与隔离

- compose 项目名：`docker compose -p <namespace> -f <docker-compose-file> up -d sonarqube`
- 项目 key：`<项目原key>-<namespace>`，扫描项目同样按隔离标识隔离
- admin 凭据用于预创建项目与一次性 token（仅本地 dev 部署）；扫描本身走 token，不把 admin 凭据写进扫描参数

### 扫描参数

项目 `sonar-project.properties` 示例（按项目实际调整）：

```properties
sonar.projectKey=<项目原key>-<namespace>
sonar.projectName=<项目原key>-<namespace>
sonar.sources=src
sonar.tests=src,tests,e2e
sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.exclusions=node_modules/**,dist/**,coverage/**,playwright-report/**,test-results/**
sonar.javascript.file.suffixes=.js,.jsx,.ts,.tsx,.vue
```

- 执行：`sonar-scanner -Dsonar.projectKey=<项目原key>-<namespace>`
- 结果拉取：`/api/issues/search?componentKeys=<key>&types=BUG,VULNERABILITY,CODE_SMELL&ps=500`
- 质量门状态：`/api/qualitygates/project_status?projectKey=<key>`
- 每条扫描结果提取 file / line / rule / severity / message，按 SonarQube 原始严重级别保留（BLOCKER→Critical、CRITICAL→Critical、MAJOR→High/Medium、MINOR→Low、INFO→Info），映射不明确的按同维度统一判例处理
- 深度扫描与 ESLint 结果去重：同一文件同一行同一语义只保留一条，优先 SonarQube（规则更全）

### 降级口径

- Docker/SonarQube/scanner 任一不可用，且无法在合理时间内恢复 → 记录降级理由，其余检查项照常执行，不阻塞全部检查
- 降级不等于通过：报告中须写明"深度扫描未执行"及原因

## 8. 质量工具配置检查

检查本轮变更中是否包含质量工具规则/配置文件的改动。若包含，逐项检查：

| 配置对象 | 削弱信号 |
|----------|---------|
| tsconfig | 关闭/放宽 `strict`、`noImplicitAny`、`strictNullChecks`、`noUnusedLocals` |
| ESLint 配置 | 规则改 off/warn、新增过宽 `ignorePatterns`、放宽 globals、整文件 `eslint-disable` |
| Prettier | `.prettierignore` 豁免业务源码目录、配置项被改成不检查 |
| dependency-cruiser | 删除规则、severity 降级、过宽 `exclude`/`doNotFollow` |
| Vitest | 覆盖率阈值下调、`coverage.exclude` 扩大把业务文件移出统计、跳过测试文件 |
| size-limit / browserslist | 体积阈值上调、目标浏览器扩充无理由 |
| CI 脚本 | 命令加 `|| true`、`--passWithNoTests`、`--no-frozen-lockfile` 等跳过手段 |

- 配置无削弱 → 通过
- 存在削弱 → 每个削弱点一个问题项：规则/阈值/严格性被关闭或放宽 → 至少 Low；关键质量规则关闭或覆盖率门槛取消 → High
- 压制不消除问题本身，不得单独作为检查通过的依据；新增压制须附明确理由，无理由或不合理的压制按原问题级别记录，且不得低于 Low 级

## 9. 工具输出 → 统一问题结构

每个工具的输出必须翻译为统一问题结构（维度与字段口径同通用质量门），按前端工具映射：

| 工具 | dimension 取值 |
|------|---------------|
| tsc | 按诊断语义取 style / maintainability / architecture |
| prettier | style |
| dependency-cruiser | architecture |
| eslint | 按规则语义取 style / maintainability / performance / security / architecture |
| vitest | maintainability（测试缺陷）/ architecture（测试结构） |
| vitest coverage | maintainability |
| sonarqube | 按 SonarJS 规则类型映射 |

- 每条违规一项，附文件、行号、描述、修复建议；禁止只给汇总数字
- 无法可靠归类的边界情况按原始严重级别保留，不做静默降级

## 10. 汇总与产出

全部检查完成后，产出检查结果与问题项清单（含通过/不通过结论），并注明降级项与跳过理由。
