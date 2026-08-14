---
name: java-security
description: Java 后端安全实现规范（security-baseline 的 Java 配套）。MyBatisPlus 注入防护、POI OOM 防范、LangChain4j 安全配置、Spring 安全配置、SLF4J 日志脱敏。
capabilities: ["security", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本文是 security-baseline 的 Java 实现配套，仅含 Java/Spring 技术栈特有的实现细节。调用本 skill 须同时加载 security-baseline（通用原则在此）。通用原则见 security-baseline。

## MyBatisPlus 数据安全

**参数绑定（防 SQL 注入）**：
```java
@Select("SELECT * FROM {table_name} WHERE id = #{id}")
EntityPO selectById(@Param("id") Long id);
```

XML Mapper 和注解 SQL 必须使用 `#{param}` 形式，严禁 `+` 字符串拼接。`${}` 仅可用于表名列名等不可参数化的位置，且值须白名单校验。

**PO ↔ Domain 转换**：使用 MapStruct Converter（按项目 MapStruct 规范）

## Apache POI

**大文件流式读取**：
```java
SXSSFWorkbook wb = new SXSSFWorkbook(new XSSFWorkbook(inputStream), 100);
```

禁止直接用 `XSSFWorkbook` 加载全量数据（OOM 风险）。测试底稿放 `src/test/resources/`。导出使用 `XSSFComment` 添加批注、`XSSFCellStyle` 设置样式。

## LangChain4j

- API Key 从环境变量读取，见 security-baseline §凭证管理
- 生产环境关闭请求/响应日志，见 security-baseline §日志脱敏 和 §LLM 调用安全
- 调用超时默认 120s（Spring 配置见 application.yml）
- 测试仅断言响应结构，见 security-baseline §LLM 调用安全

## Spring 安全配置

**文件上传**：
- `spring.servlet.multipart.max-file-size` 限制文件大小，值按项目实际业务需求配置
- Controller 层校验 MIME / Content-Type，见 security-baseline §文件上传安全

**跨环境凭证一致性**（见 security-baseline §凭证管理）：
- docker-compose 中的密码与 application-*.yml 中的密码必须一致
- `.env` 不得提交仓库

## SLF4J 日志脱敏

- 参数化日志（SLF4J 语法）：`log.info("{} {}", user.getId(), action)`
- 通用原则见 security-baseline §日志脱敏

## 外部调用超时（Spring HTTP 客户端）

- RestTemplate：通过 `SimpleClientHttpRequestFactory` 设 connectTimeout / readTimeout
- WebClient：通过 `HttpClient.responseTimeout()` / `.option()` 设超时
- Spring Cloud OpenFeign：`feign.client.config.<service>.connect-timeout` / `read-timeout`
- 所有超时值 > 0，普通 HTTP 建议 10-30s
- 通用原则见 security-baseline §外部调用超时与重试
