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
│  │ 一个 Profile 可按会话选择 VNC 或 Headless      │    │
│  │ Profile 数据持久化，运行模式不写入 Profile     │    │
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

### 第一层：Chrome 运行环境（现成，不自己造）

用现成的 Docker 镜像（如 `kasmweb/chrome` 或基于 `selenium/standalone-chrome` 改造），每个容器按启动会话时传入的 `browserMode` 选择运行链路：
- `vnc`：Chromium 跑在 Xvfb 虚拟显示器里，启动 VNC/noVNC 和 CDP
- `headless`：Chromium 使用 `--headless=new`，只启动 CDP，不启动桌面、输入法和 noVNC

每个 Profile 一次只运行一个容器，数据卷挂载 `user-data-dir` 做持久化。容器关了数据还在，下次启动登录态恢复。同一个 Profile 的 VNC 和 Headless 容器不能同时打开同一数据目录，切换会话模式时服务端会先停止旧容器。

### 第二层：Hive Browser Server（我们的核心）

Node.js 服务，职责：
- **Profile 管理**：创建/删除/配置 profile（指纹、代理、默认 URL）
- **指纹注入**：每个 profile 生成唯一指纹，通过 Chrome 扩展注入
- **代理分配**：每个 profile 可配独立代理
- **HTTP API**：对外提供 navigate / execute / cookies / screenshot 等操作
- **容器调度**：按需启动/关闭 Docker 容器，不用的容器关掉省资源
- **运行模式**：按浏览器会话选择 VNC 登录或 Headless 采集，不写入 Profile
- **CDP 连接**：通过 Puppeteer 连接到容器里的 Chrome，执行自动化操作

### 第三层：客户端（纯消费者）

- **Center**：Web 管理面板，调 API 查看状态、触发操作
- **人工操作**：启动 VNC 会话后通过 noVNC 地址直接操作服务器上的 Chrome
- **AI**：启动 Headless 会话后调 HTTP API 做自动化

不需要 Mac 客户端应用。Headless 会话没有 VNC 地址，只通过 API/CDP 使用。

## API 设计

对 AI 和 Center：
```
GET  /browsers                      列出所有 profile 及状态
POST /browsers/:id/start             启动/切换会话，body: { browserMode }
POST /browsers/:id/stop              停止会话，保留 Profile 数据
POST /browsers/:id/navigate         导航到 URL（自动启动容器）
POST /browsers/:id/execute          执行 JS
GET  /browsers/:id/cookies          获取 cookie
POST /browsers/:id/screenshot       截图
GET  /browsers/:id/vnc              启动/切换到 VNC 并获取 noVNC 地址
```

采集调用方应先调用 `POST /browsers/:id/start` 并传 `browserMode: "headless"`，之后的 navigate / execute 等操作会复用该会话。VNC 入口会自动启动或切换到 VNC。旧调用没有显式启动会话时默认使用 VNC。空闲一段时间后容器自动关闭，但最近选择的会话模式会在当前 Server 进程内保留。

## Chrome 生命周期

```
空闲状态：容器关闭，user-data-dir 数据保留在磁盘
    │
    ▼  API 调用到达
启动容器 → 按本次会话的 browserMode 启动 Chrome → 登录态由 user-data-dir 自动恢复
    │
    ▼  API 主动 navigate 到 profile 配置的 URL
    │
    ▼  Puppeteer 通过 CDP 连接
执行操作 → 返回结果
    │
    ▼  持续有 API 调用：保持运行
    ▼  空闲超时（如 10 分钟）：关闭容器，数据保留
    │
    ▼  人工要看？
noVNC 连接 → 直接看到 Chrome 窗口 → 操作完断开 → 容器继续跑或空闲关闭
```

## 服务器重启

Hive Browser Server 重启时，正在跑的 Docker 容器不受影响。Server 重新扫描运行中的容器，通过 CDP 重连。零中断。

## 规模

- 当前 13 个账号：Docker Compose 足够
- 100 个账号：Docker Compose 仍然足够，同时在跑的可能只有 5-10 个
- 更大规模：考虑 Kubernetes

## 现有代码复用

| 模块 | 复用情况 |
|------|----------|
| 指纹生成 (`lib/fingerprintGenerator.js`) | 直接复用 |
| 代理管理 (`lib/proxyManager.js`) | 直接复用 |
| 输入校验 (`lib/inputValidator.js`) | 直接复用 |
| Chrome 参数构建 (`src/platform/base.js`) | 复用 `buildChromeArgs`、`generateProfileExtension` |
| HTTP API (`httpServer.js`) | 改造：底层从 windowManager 换成 Docker 容器管理 |
| Profile 管理 | 改造：去掉 Electron 依赖 |
| Electron 客户端代码 | 不再需要（noVNC 替代） |

## 不做的事

- 不用 Browserless（许可证限制，场景不匹配）
- 不用 WebRTC（复杂，noVNC 够用）
- 不做 cookie 同步（同一个浏览器实例，不需要同步）
- 不做 Mac 原生客户端（noVNC 网页替代）
