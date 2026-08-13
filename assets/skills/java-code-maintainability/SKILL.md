---
name: java-code-maintainability
description: Java 代码可维护性规范——方法长度、类职责、异常处理、MapStruct 转换、魔法数提取、DRY 禁止、死代码、构建忽略项。仅在 Java 后端项目使用。
capabilities: ["maintainability", "tech-stack-java"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。
> 本文列出**最低审查基线**，不限于所列维度。AI 审查时必须结合自身可维护性知识做拓展覆盖，下列任何可能遗漏的可维护性问题均须纳入审查。

## 方法长度

- 单方法不超过 50 行（含空行和注释，不含花括号单独行）
- 超过且逻辑难以理解 → Medium 级别 issue
- 超过但逻辑清晰可读（如配置方法）→ Low 级别 issue

## 类单一职责

- 一个类不超过一个变更原因
- 明显多职责场景（如同时处理持久化 + 业务逻辑 + 序列化）→ Medium 级别 issue

## 异常处理

- 禁止吞掉异常（空 catch 块）→ High 级别 issue
- 禁止 `catch (Exception e)` 不加区分——优先捕获具体异常类型，多个异常类型分别处理或用多 catch 块 → Medium
- 使用 try-with-resources 确保资源自动关闭 → High 级别 issue（未关闭资源）

## MapStruct 转换

```java
@Mapper(componentModel = "spring")
public interface OrderConverter {
    Order toDomain(OrderPO po);
    OrderPO toPO(Order domain);
}
```

- 必须 `componentModel = "spring"`；字段映射用 `@Mapping(source, target)`
- 禁止手写 PO ↔ Domain 转换逻辑，必须用 MapStruct

## 魔法数提取常量

- 业务含义数字须提取为命名常量（`private static final ...`）
- 数字 0/1/-1 等通用值可不提取，但业务相关值如 `50000000`（高额订单阈值）必须提取

## DRY 违规

- 相同语义的代码段在 ≥3 处复用时必须提取为共享函数
- 违反 → Low+ 级别 issue

## 构建忽略项

- 构建产物目录（`target/`、`node_modules/`、`dist/`）不得提交仓库
- 已在 .gitignore 中配置即可

## 死代码

- 未使用的 import / 私有方法 / 字段 / 局部变量 → Low 级别 issue
- 注释掉的代码：零散行 → Low 级别 issue；注释掉的整段逻辑 → Medium 级别 issue（历史追溯依赖版本控制，注释掉的代码应删除而非保留）
- 不可达分支 / 失效条件判断 → Medium 级别 issue
- 未被引用的类 / 接口 → Medium 级别 issue
- 未使用的依赖 → Low 级别 issue
- 识别未使用字段/方法时排除框架反射与代码生成场景（如 MapStruct、MyBatis、Lombok）
