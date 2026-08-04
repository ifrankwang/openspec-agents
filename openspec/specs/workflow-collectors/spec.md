# workflow-collectors Specification

## Purpose
TBD - created by archiving change workflow-engine. Update Purpose after archive.
## Requirements
### Requirement: CollectorAdapter 接口
收集器 SHALL 通过 CollectorAdapter 接口接入，接口包含 `name`、`pollIntervalMs`（默认 30000）、`pull`、`transform`、`writeback`。`transform` 产出初始 WorkItem（phase=todo、suspended=false、children 为空、tags 为空）。`writeback` 返回成功与否及失败原因。

#### Scenario: 定时拉取
- **WHEN** 引擎按 adapter 的 pollIntervalMs 触发 pull
- **THEN** 收集器拉取外部项并经 transform 写入状态文件，与已有项按外部 id 去重

#### Scenario: 写回失败记录
- **WHEN** writeback 返回失败
- **THEN** 引擎记录 lastAttempt 与 error，且不阻塞引擎调度

### Requirement: OpenSpec 收集器
系统 SHALL 提供 OpenSpec 收集器 adapter，扫描目标仓库的 openspec changes 并 transform 为 task WorkItem。

#### Scenario: 拉取 OpenSpec change
- **WHEN** OpenSpec 收集器执行 pull
- **THEN** 返回 openspec/changes 下未归档的 change 项，并被 transform 为 task WorkItem

### Requirement: ADO 收集器占位实现
系统 SHALL 提供 ADO 收集器 adapter 的占位实现，保持接口可调用且不抛错，为后续接入真实 ADO 预留。

#### Scenario: 占位拉取不报错
- **WHEN** ADO 收集器执行 pull
- **THEN** 返回空列表且不抛异常，引擎正常继续

### Requirement: 自定义 adapter 注册
系统 SHALL 支持注册自定义 CollectorAdapter，注册后按声明的 pollIntervalMs 参与调度。

#### Scenario: 注册自定义 adapter 生效
- **WHEN** 注册一个自定义 CollectorAdapter
- **THEN** 引擎按该 adapter 的轮询间隔执行 pull 并纳入同一去重与调度流程

