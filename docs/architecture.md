# Hive Browser 技术方案

## 要解决的问题

很多网站没有 API，只能通过浏览器登录态来做自动化。但本地电脑无法 7×24 在线，需要把浏览器放到服务器上。服务器上可能有几十上百个账号，不能全部同时开着。人工偶尔需要手动操作这些浏览器，不想重新登录；自动采集则不需要承担桌面和 VNC 的运行开销。

## 架构总览

```
Linux 服务器
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Hive Browser Server (Node.js)                      │
│  ├── HTTP API ── AI 自动化调用                       │
│  ├── Profile 管理（指纹、代理、账号配置）              │
│  └── 调度：按需启动/关闭 Chrome 容器                  │
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

每个 Profile 一次只运行一个容器，数据卷挂载 `user-data-dir` 做持久化。容器关了数据还在，下次启动登录态恢复。同一个 Profile 的 VNC 和 Headless 容器不能同时打开同一数据目录。

### 第二层：Hive Browser Server（我们的核心）

Node.js 服务，职责：
- **Profile 管理**：创建/删除/配置 profile（指纹、代理、默认 URL）
- **指纹注入**：每个 profile 生成唯一指纹，通过 Chrome 扩展注入
- **代理分配**：每个 profile 可配独立代理
- **HTTP API**：对外提供 navigate / execute / cookies / screenshot 等操作
- **容器调度**：按需启动/关闭 Docker 容器，不用的容器关掉省资源
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
POST /browsers/:id/vnc/release      撤销 VNC 控制并保留 Chromium 到空闲回收
```

采集冷启动默认使用 Headless。已有 VNC Chromium 时，采集通过 `/pages/*` 创建同 BrowserContext 的后台窗口，不启动第二个进程。VNC 活跃期间，旧 `navigate`、`execute` 和主页面全页截图不会操作人工前台。客户端关闭窗口或心跳超时后，服务端先停止 noVNC/x11vnc、断开现有远程连接，再删除租约；Chromium 本身继续服务连续采集，空闲 5 分钟后停止。

## Chrome 生命周期

```
空闲状态：容器关闭，user-data-dir 数据保留在磁盘
    │
    ▼  API 调用到达
启动容器 → 按本次会话的 browserMode 启动 Chrome → 登录态由 user-data-dir 自动恢复
    │
    ▼  API 主动 navigate 到 profile 配置的 URL
    │
    ▼  原生 CDP WebSocket 连接
执行操作 → 返回结果
    │
    ▼  持续有 API 调用：保持运行
    ▼  空闲超时（默认 5 分钟）：关闭容器，数据保留
    │
    ▼  Electron 客户端申请人工操作
无采集窗口时：停止 Headless → 启动 VNC → 启用 noVNC 控制通道
    │
    ▼  VNC 期间有采集任务
同一 Chromium 创建最小化后台窗口 → 完成后立即关闭
    │
    ▼  客户端关闭或租约超时
停止 noVNC/x11vnc → 保留 Chromium → 连续采集复用 / 空闲 5 分钟后停止
```

## 服务器重启

Hive Browser Server 重启时，Headless Docker 容器会被恢复并通过 CDP 重连。VNC 租约保存在服务端内存中，无法安全恢复；服务重启会清理没有可恢复租约的旧 VNC 容器，客户端需要重新打开 VNC。

## 规模

- 当前几十个账号：Docker Compose 足够
- 100 个账号：Docker Compose 仍然足够，同时在跑的可能只有 5-10 个
- 更大规模：考虑 Kubernetes

## 现有代码复用

| 模块 | 复用情况 |
|------|----------|
| `lib/containerManager.js` | Docker 容器及 VNC 控制通道生命周期 |
| `lib/browserConnector.js` | 原生 CDP 连接与后台采集窗口 |
| `lib/api.js` | Profile 锁、VNC 租约、空闲回收和 HTTP API |
| `lib/profileStore.js` | 通用 Profile 数据，不持久化运行模式 |
| `client/` | Electron 菜单栏客户端及 VNC 窗口 |

## 不做的事

- 不用 Browserless（许可证限制，场景不匹配）
- 不用 WebRTC（复杂，noVNC 够用）
- 不启动两个 Chromium 共享或复制同一 Profile
- 不做 Cookie 同步（同一个浏览器实例和 BrowserContext，不需要同步）
