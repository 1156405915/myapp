# 蚂蚁（Mayi Agent）

基于 OpenCowork 产品能力重新规划的 Vue 3 + TypeScript + Vite + Electron 客户端骨架。

## 已完成

- 企业级登录页：账号登录、验证码登录、第三方登录交互占位。
- Electron 主进程与安全 Preload 桥接。
- Vue Router 路由守卫与 Pinia 登录状态。
- 固定底部账号信息、上方独立滚动的最近会话列表。
- 页面框架：聊天、任务、MCP 工具、技能、文件库。
- 自研蚂蚁 SVG Logo、设计令牌、响应式布局。
- Windows NSIS 打包配置。

## 技术栈

- Vue 3 + TypeScript
- Vite + electron-vite
- Electron
- Vue Router
- Pinia
- 原生 CSS Variables / Design Tokens

## 本地启动

```bash
npm install
npm run dev
```

## 类型检查与构建

```bash
npm run typecheck
npm run build
```

## Windows 打包

```bash
npm run package:win
```

安装包输出到 `release/`。

## 建议的本地目录

将项目解压或复制到：

```text
D:\chromeDownLoad\蚂蚁设计图\mayi-agent
```

## 演示登录

- 邮箱/用户名：任意非空内容
- 密码：至少 6 位

当前登录逻辑是前端演示实现，后续应替换为真实的 OAuth/OIDC 或企业统一身份认证接口。
