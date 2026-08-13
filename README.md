# Hive Server

浏览器会话池服务器。在 Linux 服务器上管理多个隔离的 Chrome 实例（Docker 容器），通过 HTTP API 提供自动化操作。Profile 保存账号和登录态，启动浏览器会话时再选择 VNC 人工登录或 Headless 自动采集。

## 架构

```
Linux 服务器
┌─────────────────────────────────────────────┐
│  Hive Server (Node.js)                      │
│  ├── HTTP API ── AI / Center 调用           │
│  ├── Profile 管理（指纹、代理、账号配置）     │
│  └── 调度：按需启动/关闭 Chrome 容器         │
│                                             │
│  Docker 容器 × N（按需启动）                 │
│  ┌──────────────────────────────────────┐   │
│  │ 一个 Profile 只运行一个 Chrome       │   │
│  │ VNC 前台 + CDP 后台采集窗口          │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

- **默认 Headless** — 普通 API 和后台保活按需启动 Headless，不启动桌面和 noVNC
- **noVNC** — 浏览器打开即可远程操作 Chrome，不需要客户端
- **后台采集窗口** — VNC 开启时，采集复用同一 Chrome；窗口创建时即最小化且不抢焦点
- **客户端 VNC 租约** — 关闭窗口、后台超过 5 分钟或心跳超时后停止 noVNC/x11vnc，并断开已有控制连接
- **空闲回收** — VNC 释放后不重启 Chrome；连续采集直接复用，整体空闲 5 分钟后再停止
- **指纹隔离** — 每个 profile 独立浏览器指纹，通过 Chrome 扩展注入

同一个 Profile 的用户目录不会被两个 Chrome 进程同时打开。Headless 存在未完成的后台采集窗口时，服务端会拒绝打开 VNC，避免中途停掉任务；VNC 关闭后则保留当前 Chrome 到空闲回收。采集窗口使用默认 BrowserContext，因此与 VNC 窗口共享 Cookie、LocalStorage 和 IndexedDB，不需要复制 Profile 或手动同步登录态。

## 快速开始

### 本地开发

```bash
npm install

# 构建 Chrome 镜像
docker build -t hive-chrome docker/

# 启动服务
npm run server
```

### 服务器部署

```bash
cp .env.example .env
# 编辑 .env，设置 DATA_DIR

docker compose up -d
```

## API

### Profile 管理

Hive Server 启动时会自动确保一个固定 ID 为 `render`、类型为 `render` 的系统渲染 Profile。
它不出现在默认 Profile 列表中；可通过 `GET /profiles?type=render` 查询，Center 直接使用固定 ID，无需另配。

```bash
# 创建通用 Profile（不绑定浏览器运行模式）
curl -X POST http://localhost:3000/profiles \
  -H "Content-Type: application/json" \
  -d '{"name":"Shop 1","url":"https://example.com"}'

# 列表
curl http://localhost:3000/profiles
```

### 浏览器操作

普通操作在冷启动时会自动启动 Headless Chrome；如果 VNC Chrome 已在运行，则直接复用它。调用方不需要传运行模式。也可以显式启动 Headless 会话：

```bash
# 显式启动 Headless 会话（通常直接调用 navigate 即可）
curl -X POST http://localhost:3000/browsers/1/start \
  -H "Content-Type: application/json" \
  -d '{"browserMode":"headless"}'
```

```bash
# 导航
curl -X POST http://localhost:3000/browsers/1/navigate \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

# 执行 JS
curl -X POST http://localhost:3000/browsers/1/execute \
  -H "Content-Type: application/json" \
  -d '{"script":"return document.title"}'

# 截图
curl -X POST http://localhost:3000/browsers/1/screenshot

# 获取 cookies
curl http://localhost:3000/browsers/1/cookies

# 客户端打开 VNC，响应中会返回 leaseId
curl http://localhost:3000/browsers/1/vnc

# 客户端持有 VNC 时定期发送心跳
curl -X POST http://localhost:3000/browsers/1/vnc/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"leaseId":"<leaseId>"}'

# 客户端关闭窗口后释放 VNC；Chrome 保留到整体空闲超时
curl -X POST http://localhost:3000/browsers/1/vnc/release \
  -H "Content-Type: application/json" \
  -d '{"leaseId":"<leaseId>"}'

# 显式停止当前会话，Profile 数据仍然保留
curl -X POST http://localhost:3000/browsers/1/stop
```

### 完整端点列表

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/profiles` | 创建 profile（name, url 必填） |
| `GET` | `/profiles` | 列表 |
| `GET` | `/profiles/:id` | 详情 |
| `PUT` | `/profiles/:id` | 修改 |
| `DELETE` | `/profiles/:id` | 删除（自动停容器） |
| `GET` | `/browsers` | 所有容器状态 |
| `POST` | `/browsers/:id/start` | 显式启动或切换浏览器会话（默认 `headless`） |
| `POST` | `/browsers/:id/stop` | 停止当前浏览器会话，保留 Profile 数据 |
| `POST` | `/browsers/:id/navigate` | 导航 |
| `POST` | `/browsers/:id/execute` | 执行 JS |
| `GET` | `/browsers/:id/cookies` | 全量 cookies |
| `POST` | `/browsers/:id/screenshot` | 截图（base64） |
| `POST` | `/browsers/:id/pages/new` | 创建共享登录态的最小化后台窗口 |
| `POST` | `/browsers/:id/pages/:pageId/execute` | 在指定后台采集页执行 JS |
| `POST` | `/browsers/:id/pages/:pageId/screenshot` | 截取指定后台采集页 |
| `POST` | `/browsers/:id/pages/:pageId/close` | 关闭后台窗口并释放 CDP 会话 |
| `GET` | `/browsers/:id/vnc` | 获取 VNC 租约和 noVNC 地址 |
| `POST` | `/browsers/:id/vnc/heartbeat` | 刷新 VNC 租约 |
| `POST` | `/browsers/:id/vnc/release` | 停止 VNC 控制通道，Chromium 留待采集或空闲回收 |
| `GET` | `/health` | 健康检查 |

`browserMode` 不属于 Profile。冷启动采集默认使用 Headless；只有需要人工操作时，Electron 客户端调用 `/vnc` 获取租约。VNC 存在时，采集应使用 `/pages/*` 后台窗口；主页导航、旧 `/execute` 脚本和主页全页截图会被拒绝，避免打断人工操作。VNC 租约默认 2 分钟未收到心跳就撤销控制通道，可通过 `VNC_LEASE_TTL_MS` 调整。

Electron 客户端的“运行中”只表示当前有可操作的 VNC 窗口；Headless 采集不会出现在客户端运行列表。VNC 窗口失焦、隐藏或最小化后默认保留 5 分钟，重新回到前台会继续保持；超过宽限时间自动释放 VNC 并关闭窗口。可在本机 `client/config.json` 增加 `vncBackgroundTimeoutMs` 调整该宽限时间。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `IDLE_TIMEOUT_MS` | `300000` | 空闲超时（ms），默认 5 分钟 |
| `VNC_LEASE_TTL_MS` | `120000` | VNC 心跳租约超时（ms），默认 2 分钟 |
| `HOST_DATA_DIR` | `./data` | 数据���录（Docker 部署时需设为宿主机绝对路���） |

## 模块

| 模块 | 职责 |
|------|------|
| `containerManager` | Docker 容器生命周期（启动/停止/恢复） |
| `browserConnector` | CDP ���接池，自动重连 |
| `api` | HTTP 端点，编排容器+连接+操作 |
| `profileStore` | Profile CRUD，JSON 文件存储 |
| `fingerprintEngine` | 指纹生成 + Chrome 扩展构建 |
