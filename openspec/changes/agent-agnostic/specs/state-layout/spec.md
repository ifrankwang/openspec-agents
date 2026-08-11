## ADDED Requirements

### Requirement: 状态目录中性化

编排状态（主状态、豁免清单、并发锁、worktree 指针）SHALL 存储于主仓库根 openspec/states/，MUST NOT 绑定任何 agent 目录布局。

#### Scenario: 新状态写入

任意 agent 发起 opx_init 后，{changeId}.json 与 exemptions.json 写入 openspec/states/，而非任何 agent 专属配置目录。

### Requirement: 旧目录自动迁移与双读兼容

读取时 SHALL 兼容旧 .opencode/.orchestrate_state/ 布局；首次新目录写入时 SHALL 幂等迁移旧数据（主状态/exemptions/锁/worktree context.json 指针），重复迁移 MUST NOT 产生副作用。

#### Scenario: 存量会话迁移

OpenCode 用户携带旧状态升级版本，首次运行 opx_status 即读到旧状态并迁移至 openspec/states/，再运行不重复迁移；旧文件在迁移期间仍可读。
