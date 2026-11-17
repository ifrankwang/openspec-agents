---
version: alpha
name: "示例视觉体系"                       # 换成项目或产品的视觉体系名
description: "面向一线运营，传达克制、可信、信息密度高的界面语言。"   # 一句话定位：面向谁、传达什么
colors:
  primary: "#1A1C1E"                      # 主文本与主操作；一个界面只由它承载最重要的那个动作
  secondary: "#6C7278"                    # 次要文本、边框、元信息
  tertiary: "#B8422E"                     # 唯一强调色，只给当前页面最重要的操作
  neutral: "#F7F5F2"                      # 页面底色
  surface: "#FFFFFF"                      # 卡片、表格、浮层底色
  on-surface: "#1A1C1E"                   # 卡片上的正文色
  error: "#B3261E"                        # 错误态，须与文字/图标同时出现
  success: "#1E6B3A"                      # 成功态，须与文字/图标同时出现
typography:
  headline-lg:
    fontFamily: "Public Sans"
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
  headline-md:
    fontFamily: "Public Sans"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
  body-md:
    fontFamily: "Public Sans"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
  label-sm:
    fontFamily: "Public Sans"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.02em
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
  button-primary-disabled:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.surface}"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: 10px
  input-field-invalid:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.sm}"
    padding: 10px
  badge-error:
    backgroundColor: "{colors.error}"
    textColor: "{colors.surface}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 4px
  badge-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.surface}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 4px
# 刻意不做的段落或令牌组在这里登记，校验器才不报缺失；示例：
# omitted:
#   - section: spacing
#     reason: "间距由组件默认内边距决定，暂不定义统一刻度"
---

## Overview

<!-- 写 2-4 句判断基准：品牌气质、目标用户、界面该唤起什么感觉。
     具体规则缺失时，后续所有视觉决策都回到这里找依据。 -->

界面服务于高频、长时的业务操作：信息密度优先于留白，层级靠字号与字重而不是装饰。
整体气质克制、可信，避免强渐变、大阴影与饱和色块；一个页面只允许一个强调色出现在最重要的操作上。

## Colors

<!-- 每个颜色一条：令牌名、取值、用在哪、为什么。颜色名与 front matter 的键一一对应。 -->

- **Primary (#1A1C1E)**：主文本与主操作，深墨色保证长文阅读的对比度与稳定感。
- **Secondary (#6C7278)**：次要文本、边框、元信息，退到背景层但不失可读性。
- **Tertiary (#B8422E)**：唯一强调色，只给当前页面最重要的动作，出现两次即失效。
- **Neutral (#F7F5F2)**：页面底色，比纯白柔和，长时间阅读不刺眼。
- **Surface (#FFFFFF)**：卡片与表格底色，与页面底色形成轻微层次。
- **Error (#B3261E) / Success (#1E6B3A)**：状态色，只作辅助；必须与文字或图标同时出现，不得单独承载状态。

## Typography

<!-- 说明字体选择与层级职责：标题用在哪、正文用在哪、标签与数字用在哪。 -->

- **Headline**：页面标题与区块标题，承载层级，不用于正文。
- **Body**：正文与表单内容，16px 起，行高 1.6 保证长文可读。
- **Label**：字段标签、表格表头、时间与编号等元信息，字号小但字重足够，不靠浅灰表达次要。

## Layout

<!-- 写栅格模型、最大宽度、间距节奏与分组原则。 -->

- 桌面端最大内容宽度 1200px，超出后居中留白，不横向拉伸表格与表单。
- 间距按 `spacing` 刻度取用，同一层级只用一档：区块之间 `lg`，区块内元素之间 `md`，紧密元素之间 `sm`。
- 相关内容用卡片分组，卡片内边距固定 `md`，不靠额外分割线堆叠层级。

## Elevation & Depth

<!-- 说明层级怎么表达：有阴影就写扩散、模糊与颜色；扁平界面就写用什么替代。 -->

不使用投影表达层级。层级由底色与边框承担：浮层用 `surface` + 1px `secondary` 边框，
临时浮出（下拉、气泡）额外加一圈极浅的扩散阴影，仅用于与背景分离，不用于强调。

## Shapes

<!-- 写圆角语言与适用范围。 -->

圆角统一走 `rounded` 刻度：按钮与输入框 `sm`，卡片 `md`，标签与头像 `full`。
同一视图内不混用锐角与圆角；表格单元格保持直角，避免与卡片圆角冲突。

## Components

<!-- 每个组件写外观 + 状态清单。状态必须同时给出视觉承载与程序承载，
     且不得只用颜色或灰度表达；具体条目按项目实际组件增删。 -->

| 组件 | 状态 | 视觉承载 | 程序承载 |
|------|------|----------|----------|
| 输入框 | 必填 | 标签右侧文字「必填」；标签样式与可选字段一致 | `required` 或 `aria-required="true"` |
| 输入框 | 可选 | 与必填同一标签样式，不靠灰色文字或浅字重区分 | 不声明必填属性 |
| 输入框 | 禁用 | 降低强调并在旁注说明不可用原因 | `disabled` 或 `aria-disabled="true"` |
| 输入框 | 只读 | 文字保持正常对比度、可聚焦、无禁用光标 | `readonly` 或 `aria-readonly="true"` |
| 输入框 | 出错 | 字段下方错误文案说明错在哪、怎么改；红色边框仅作辅助 | `aria-invalid="true"` + `aria-describedby` 指向错误文案 |
| 表格 | 空数据 | 文案「暂无数据」+ 主操作入口（新建、清除筛选） | `role="status"` 或等价可播报机制 |
| 表格 | 加载中 | 骨架行或「加载中」文案，外观与空态可区分 | `aria-busy="true"` |
| 危险按钮 | 点击前 | 红色仅作辅助，按钮文案写明动作对象 | 可键盘聚焦 |
| 危险按钮 | 确认 | 二次确认说明影响范围与是否可撤销，确认文案写具体动作（如「删除 3 个订单」） | 确认浮层可聚焦、`Esc` 可取消 |

按钮：主操作 `button-primary`，次要操作用描边样式，一屏只出现一个主操作。
变体（悬停、按下、禁用）已在上方令牌中分别定义，视觉差异不得只靠颜色深浅。

## Do's and Don'ts

- Do 用 `DESIGN.md` 的令牌取值，界面里不出现未登记的硬编码颜色与间距
- Do 让每个状态都有文字或图标说明，颜色只作辅助
- Do 让必填、可选、禁用、只读在视觉上互相可区分，且与程序属性一致
- Don't 把必填字段做成灰色文字或空心方块，那会被读成「可选、未勾选」
- Don't 只用颜色区分状态（红=错、绿=成功），灰度或色觉差异下会完全失效
- Don't 用禁用冒充只读，或用只读冒充禁用
- Don't 让空数据与加载中共用同一外观
- Don't 让错误提示只变红而不说明错在哪、怎么改
