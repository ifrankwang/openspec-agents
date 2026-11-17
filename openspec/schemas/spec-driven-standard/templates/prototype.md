# Prototype（拟真原型）

<!-- The artifact is ONE self-contained file: prototype/index.html. It opens by
     double-clicking it, with no build step, no dev server and no backend call.
     Everything below is a required content block INSIDE that file: the screens
     are the rendered markup, the remaining blocks are visible panels or HTML
     comments beside the screens, so a reader who opens the file sees both the
     interface and the reasoning behind it. Do not emit a second document.

     Conditional scope: produce this artifact only when the change touches the
     visual, interaction or state presentation of a user-visible interface.
     When the change is logic-only, write a single declaration page stating
     「本变更不涉及用户可见界面」 plus one line of reasoning, and stop there. -->

## Prototype Scope（原型范围）

<!-- MANDATORY. One entry per user-visible surface this change touches: the
     screen or surface name, who uses it, and the scenario it serves. When the
     change is logic-only, keep the single declaration entry and leave the
     remaining sections out. -->

- <!-- 屏幕/界面名称 · 使用角色 · 使用场景 -->

## Screens（逐屏呈现）

<!-- MANDATORY when the prototype applies. One block per screen, each rendered
     as a real, navigable screen in the HTML file — not a description of one.
     Reuse the project's existing layout, components and copy rather than
     inventing a parallel visual language. Every screen carries its own notes
     panel stating which requirement and which design decision it embodies. -->

### <!-- 屏幕名称 -->

- Route / entry: <!-- 从哪个入口、哪个路由进入 -->
- Layout: <!-- 页面骨架：区块划分与先后顺序 -->
- Components: <!-- 复用项目里哪些组件；新建了哪些、为什么必须新建 -->
- Interactions: <!-- 用户在这个屏上能做哪些动作、各自的反馈 -->
- Notes: <!-- 旁注：对应 proposal 的哪条需求、对应 design 的哪条决策 -->

## Field Semantics（字段语义）

<!-- MANDATORY. One row per field the user can see or edit, on every screen.
     A field's semantic class MUST be carried by a visible, unambiguous cue;
     an empty box with grey placeholder text is never a cue. A placeholder shows
     the expected format, not whether the field is required. -->

| Screen | Field | Class | Visible cue in the prototype | Backend counterpart |
| --- | --- | --- | --- | --- |
| <!-- 屏 --> | <!-- 字段 --> | <!-- 必填 / 可选 / 禁用 / 只读 --> | <!-- 必填：标签后红色星号 + 提交时行内错误；禁用：灰底 + 不可聚焦；只读：无边框文本 + 复制可用 --> | <!-- 对应哪个 DTO 字段与校验注解；无后端写「前端本地」 --> |

<!-- The class and the backend counterpart must agree: a field shown as 必填
     is required in the schema and in validation too; a field shown as 禁用 or
     只读 is rejected if the client sends a changed value. A screen that says
     「必填」 while the backend treats the field as optional is a defect in this
     artifact, not a frontend detail to settle later. -->

## State Coverage（状态覆盖）

<!-- MANDATORY. Each state below must be reachable in the HTML file itself
     (a toggle, a second tab, or a clearly labelled variant block) so the user
     can see what the screen looks like without a backend. -->

- Empty data: <!-- 无数据时的呈现与引导动作 -->
- Loading: <!-- 加载中的骨架或提示；避免整屏白屏 -->
- Error: <!-- 出错信息的落位、可读文案与重试入口 -->
- <!-- 其它本变更特有的状态：无权限、只读、超额、冲突等 -->

## Design System Alignment（设计系统对齐）

<!-- MANDATORY. State which DESIGN.md tokens (color, spacing, typography, radius,
     state colors) and which status semantics the prototype uses, and where that
     file lives. When the project has no DESIGN.md, state that one was produced
     before this prototype and record its path. The prototype is the reference
     the implementation is measured against, so it must speak the project's
     existing visual language, not a new one. -->

## User Confirmation（用户确认）

<!-- MANDATORY before design.md and tasks.md are written. Give the user the file
     path and ask them to open it screen by screen. Record what they confirmed
     and what they asked to change, then mirror the same conclusion into the
     Users & Scenarios section of clarify.md. Any later change to the prototype
     requires a fresh confirmation. -->

- Confirmed screens: <!-- 用户逐屏确认了哪些屏 -->
- Requested changes: <!-- 用户要求改什么，改完是否重新确认 -->
