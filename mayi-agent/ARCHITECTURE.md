# 架构说明

```text
Electron Main
├─ 窗口生命周期
├─ 系统能力与安全策略
└─ IPC Handler（连接 Agent Runtime 与 MCP）

Preload
└─ contextBridge 白名单 API

Vue Renderer
├─ router       页面与鉴权路由
├─ stores       登录状态、UI 状态
├─ layouts      客户端框架与侧边栏
├─ views        会话、任务、MCP、技能、文件库
├─ components   Logo、通用图标
└─ styles       Design Tokens 与基础样式
```

## 后续推荐分层

```text
src/main/
├─ agent/       模型与 Agent Runtime
├─ session/     会话生命周期与队列
├─ mcp/         MCP Server / Tool 管理
├─ skills/      技能与插件运行时
├─ files/       工作区与文件索引
└─ ipc/         按领域拆分 IPC

src/renderer/src/
├─ api/         类型安全的 IPC Client
├─ features/    按领域组织页面、组件、store
├─ shared/      通用 UI、类型、工具函数
└─ styles/      主题和设计令牌
```

当前已接入模型、会话、工作区文件工具和内置办公技能；本地工具通过路径检查、命令审计和用户授权控制风险。
