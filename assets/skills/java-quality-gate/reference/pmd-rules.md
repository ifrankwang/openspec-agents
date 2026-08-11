# PMD 规则索引

规则定义以官方源为准，本索引不记录阈值数值——阈值随 PMD 版本与项目 ruleset 配置变化，仅作导航。未收录规则按 SKILL.md「PMD 规则语义定位」方法论直拉官方源。

> 说明：ExcessiveMethodLength（design.xml）、UnusedImports（bestpractices.xml）为 PMD 6 规则，PMD 7 已移除（UnusedImports 由 codestyle 的 UnnecessaryImport 承接）；AvoidCatchingGenericException 在 PMD ≤7.17 属 design，7.18 起迁往 errorprone（design 留 deprecated 引用）；引用官方文档锚点时按项目实际 PMD 版本核对，命中此类历史规则名时以当前版本官方源反查为准。

| 规则全名 | 分类 | 判定逻辑类型 | 官方源 |
|----------|------|-------------|--------|
| `category/java/design.xml/TooManyMethods` | java/design | XPath | https://docs.pmd-code.org/pmd-doc-<版本>/pmd_rules_java_design.html#toomanymethods |
| `category/java/design.xml/NcssCount` | java/design | 规则类 | https://docs.pmd-code.org/pmd-doc-<版本>/pmd_rules_java_design.html#ncsscount |
| `category/java/design.xml/ExcessiveMethodLength` | java/design | 规则类 | https://docs.pmd-code.org/pmd-doc-<版本>/pmd_rules_java_design.html#excessivemethodlength |
| `category/java/design.xml/CyclomaticComplexity` | java/design | 规则类 | https://docs.pmd-code.org/pmd-doc-<版本>/pmd_rules_java_design.html#cyclomaticcomplexity |
| `category/java/errorprone.xml/AvoidCatchingGenericException` | java/errorprone | XPath | https://docs.pmd-code.org/pmd-doc-<版本>/pmd_rules_java_errorprone.html#avoidcatchinggenericexception |
| `category/java/bestpractices.xml/UnusedImports` | java/bestpractices | 规则类 | https://docs.pmd-code.org/pmd-doc-<版本>/pmd_rules_java_bestpractices.html#unusedimports |
| `category/java/bestpractices.xml/SystemPrintln` | java/bestpractices | XPath | https://docs.pmd-code.org/pmd-doc-<版本>/pmd_rules_java_bestpractices.html#systemprintln |
| `category/java/errorprone.xml/CloseResource` | java/errorprone | 规则类 | https://docs.pmd-code.org/pmd-doc-<版本>/pmd_rules_java_errorprone.html#closeresource |
