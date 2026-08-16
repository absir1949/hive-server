# Hive Browser 技术方案

## 要解决的问题

很多网站没有 API，只能通过浏览器登录态来做自动化。部分平台的关键 Cookie 是进程级 session cookie，即使挂载了 `user-data-dir`，关闭 Chromium 后也不保证能恢复。因此系统要同时满足：已启动的认证会话持续运行，人工远程控制可按需启停，未启动的 Profile 不会被保活任务自动拉起。

## 架构总览

```
Linux 服务器
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Hive Browser Server (Node.js)                      │
│  ├── HTTP API ── AI 自动化调用                       │
│  ├── Profile 管理（指纹、代理、账号配置）              │
│  └── 调度：按需启动，显式停止 Chrome 容器              │
│                                                     │
│  Docker 容器 × N（按需启动）                          │
│  ┌──────────────────────────────────────────────┐    │
│  │ 一个 Profile 同时只运行一个 Chromium          │    │
│  │ VNC 前台 + 最小化后台采集窗口                 │    │
│  └──────────────────────────────────────────────┘    │
│                                                     │
│  Docker Compose 编排                                 │
└───────────────┬──────────────────┬──────────────────┘
                │                  │
         ┌──────▼──────┐    ┌─────▼──────┐
         │ Center      │    │ Mac 浏览器  │
         │ 管理面板     │    │ 打开 noVNC  │
         │ 调 API      │    │ 手动操作    │
         └─────────────┘    └────────────┘
```

## 三层分工

### 第一层：Chrome 运行环境

使用项目内 `docker/` 构建的 `hive-chrome` 镜像，每个容器按启动会话时传入的 `browserMode` 选择运行链路：
- `vnc`：Chromium 跑在 Xvfb 虚拟显示器里，提供 CDP；VNC/noVNC 控制通道由租约按需启停
- `headless`：Chromium 使用 `--headless=new`，只启动 CDP，不启动桌面、输入法和 noVNC

每个 Profile 一次只运行一个容器，数据卷挂载 `user-data-dir` 持久化普通浏览器数据。`user-data-dir` 不是 session cookie 备份：容器停止仍可能丢失登录态。同一个 Profile 的运行模式在 Chromium 存活期间不可切换，切换前必须显式停止。

### 第二层：Hive Browser Server（我们的核心）

Node.js 服务，职责：
- **Profile 管理**：创建/删除/配置 profile（指纹、代理、默认 URL）
- **指纹注入**：每个 profile 生成唯一指纹，通过 Chrome 扩展注入
- **代理分配**：每个 profile 可配独立代理
- **HTTP API**：对外提供 navigate / execute / cookies / screenshot 等操作
- **容器调度**：按需启动 Docker 容器，只响应显式停止/删除，不做认证会话的空闲回收
- **运行模式**：按浏览器会话选择 VNC 登录或 Headless 采集，不写入 Profile
- **CDP 连接**：通过原生 CDP HTTP/WebSocket 操作 Chrome，不依赖页面焦点
- **后台采集窗口**：在同一 BrowserContext 创建最小化、不聚焦的独立窗口，共享 Cookie 和站点存储
- **VNC 租约**：申请时启动 noVNC/x11vnc，释放或过期时停止控制通道并断开已有连接

### 第三层：客户端（纯消费者）

- **Center**：Web 管理面板，调 API 查看状态、触发操作
- **Electron 客户端**：申请并维持 VNC 租约，展示 noVNC 窗口，关闭时先释放租约
- **AI**：直接调 HTTP API，默认按需启动 Headless 做自动化

只有 Electron 客户端申请 VNC 租约；Headless 会话没有 VNC 地址，只通过 API/CDP 使用。

## API 设计

对 AI 和 Center：
```
GET  /browsers                      列出所有 profile 及状态
POST /browsers/:id/start             显式启动/切换会话，默认 Headless
POST /browsers/:id/stop              停止会话，保留 Profile 数据
POST /browsers/:id/navigate         导航到 URL（自动启动容器）
POST /browsers/:id/execute          执行 JS
GET  /browsers/:id/cookies          获取 cookie
POST /browsers/:id/screenshot       截图
POST /browsers/:id/pages/new        创建最小化后台采集窗口
POST /browsers/:id/pages/:pageId/execute    在后台窗口执行 JS
POST /browsers/:id/pages/:pageId/screenshot 截取后台窗口
POST /browsers/:id/pages/:pageId/close      关闭后台窗口
GET  /browsers/:id/vnc              获取 VNC 租约并返回 noVNC 地址
POST /browsers/:id/vnc/heartbeat    刷新 VNC 租约
POST /browsers/:id/vnc/release      撤销 VNC 控制，保留 Chromium 认证会话
```

采集冷启动默认使用 Headless。已有 VNC Chromium 时，采集和保活通过 `/pages/*` 创建同 BrowserContext 的后台窗口，不启动第二个进程，也不导航人工前台。VNC 活跃期间，旧 `navigate`、`execute` 和主页面全页截图不会操作人工前台。客户端关闭窗口或心跳超时后，服务端只停止 noVNC/x11vnc 并断开远程连接，Chromium 继续运行。

## Chrome 生命周期

```
未启动：只有 Profile 配置，不占用浏览器资源
    │
    ▼  API 调用到达
启动容器 → 按本次会话的 browserMode 启动 Chrome
    │
    ▼  API 主动 navigate 到 profile 配置的 URL
    │
    ▼  原生 CDP WebSocket 连接
执行操作 → 返回结果 → Chromium 持续运行
    │
    ▼  保活到期且容器仍在运行
创建最小化后台窗口 → 加载 Profile URL → 关闭后台窗口
    │
    ▼  Electron 客户端申请人工操作
运行模式为 VNC：启用 noVNC 控制通道；模式不匹配时返回 409，不隐式重启
    │
    ▼  VNC 期间有采集任务
同一 Chromium 创建最小化后台窗口 → 完成后立即关闭
    │
    ▼  客户端关闭或租约超时
停止 noVNC/x11vnc → 保留 Chromium 认证会话
    │
    ▼  只有显式 POST /stop 或删除 Profile
关闭 Chromium 容器（session cookie 可能丢失）
```

## 服务器重启

Hive Browser Server 进程重启时，会从 Docker 状态接管所有仍在运行的 Headless/VNC 容器。VNC 租约保存在服务端内存中，无法恢复；重启时会撤销遗留的 noVNC/x11vnc 控制通道，但不停止 Chromium。客户端需要重新申请 VNC 租约。

宿主机重启、Docker/Chromium 进程崩溃或显式停止不在这个恢复保证内；本方案没有伪装成已实现 session-cookie 导出/恢复。

## 规模

- 当前几十个账号：已启动会话持续占用 Chromium 内存，需按实际容量监控
- 不再使用空闲回收作为扩容手段；确认不再使用的 Profile 由调用方显式停止
- 更大规模：考虑 Kubernetes

## 现有代码复用

| 模块 | 复用情况 |
|------|----------|
| `lib/containerManager.js` | Docker 容器及 VNC 控制通道生命周期 |
| `lib/browserConnector.js` | 原生 CDP 连接与后台采集窗口 |
| `lib/api.js` | Profile 锁、持久会话边界、VNC 租约和 HTTP API |
| `lib/profileStore.js` | 通用 Profile 数据，不持久化运行模式 |
| `client/` | Electron 菜单栏客户端及 VNC 窗口 |

## 不做的事

- 不用 Browserless（许可证限制，场景不匹配）
- 不用 WebRTC（复杂，noVNC 够用）
- 不启动两个 Chromium 共享或复制同一 Profile
- 本阶段不做 session-cookie 导出/恢复；通过不自动结束 Chromium 来保持会话
