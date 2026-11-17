## Context

<!-- Background and current state -->

## Goals / Non-Goals

**Goals:**
<!-- What this design aims to achieve -->

**Non-Goals:**
<!-- What is explicitly out of scope -->

## Decisions

<!-- Key design decisions and rationale. For each: the choice, why, and alternatives considered. -->

## Data Model

<!-- MANDATORY when the change involves persistence. Complete DDL: CREATE TABLE with
     columns, types, constraints; field descriptions; indexes; audit fields.
     Follow the project's persistence conventions (AGENTS.md / openspec/config.yaml
     rules: table prefix, primary key strategy, logical delete, audit columns).
     If no persistence, state that explicitly. -->

## Rule Boundary Attachment

<!-- Required when this change adds or alters a business rule, validation or
     blocking check, or introduces/reorders an execution path; otherwise state
     「不适用」 with a one-line reason. State which action or layer the check is
     mounted on, and why no other flow reusing that action can trip it. -->

## Interface & Implementation Mapping（界面与实现映射）

<!-- MANDATORY when the change touches a user-visible interface; otherwise state
     「不适用」 with a one-line reason. One row per prototype screen: which
     components, routes and endpoints carry it, and whether the state markers
     and validation rules have a single source. A field marked 必填 in the
     prototype must be required in the schema and in validation too; 禁用 and
     只读 must be enforced server-side as well, not only greyed out in the UI. -->

| Screen | Components · routes · endpoints | State markers and validation share one source? |
| --- | --- | --- |
| <!-- 屏 --> | <!-- 组件 / 路由 / 接口 --> | <!-- 同源：是/否；不同源时写明哪一侧缺失、在哪个任务补齐 --> |

## Risks / Trade-offs

<!-- Known risks and trade-offs. Format: [Risk] → Mitigation -->

## Migration Plan

<!-- Steps to deploy, rollback strategy (if applicable). Omit if not applicable. -->

## Open Questions

<!-- Outstanding decisions or unknowns to resolve -->
