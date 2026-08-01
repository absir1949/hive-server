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
│  │ 一个 Profile 可先 VNC、再 Headless     │   │
│  │ Profile 数据持久化，运行模式属于会话   │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

- **默认 Headless** — 普通 API 和后台保活按需启动 Headless，不启动桌面和 noVNC
- **noVNC** — 浏览器打开即可远程操作 Chrome，不需要客户端
- **客户端 VNC 租约** — 只有 Electron 客户端打开 VNC；关闭窗口、后台超过 10 分钟或心跳超时后释放
- **双运行模式** — 同一 Profile 可在 Headless 和 VNC 之间切换，但两个 Chrome 不会同时运行
- **指纹隔离** — 每个 profile 独立浏览器指纹，通过 Chrome 扩展注入

同一个 Profile 的用户目录不能同时被 VNC 和 Headless 两个 Chrome 进程打开。切换时服务端会先停止旧容器，再按新模式启动；不复制 Profile，也不需要手动同步 Cookie，登录态和数据目录保持不变。

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

```bash
# 创建通用 Profile（不绑定浏览器运行模式）
curl -X POST http://localhost:3000/profiles \
  -H "Content-Type: application/json" \
  -d '{"name":"Shop 1","url":"https://example.com"}'

# 列表
curl http://localhost:3000/profiles
```

### 浏览器操作

普通操作会自动启动 Headless Chrome，调用方不需要传运行模式。也可以显式启动 Headless 会话：

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

# 客户端关闭窗口后释放 VNC；之前有 Headless 会话时会自动恢复
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
| `GET` | `/browsers/:id/vnc` | 获取 VNC 租约和 noVNC 地址 |
| `POST` | `/browsers/:id/vnc/heartbeat` | 刷新 VNC 租约 |
| `POST` | `/browsers/:id/vnc/release` | 释放 VNC 并按需恢复 Headless |
| `GET` | `/health` | 健康检查 |

`browserMode` 不属于 Profile。普通导航、脚本、Cookie、页面和截图接口默认使用 Headless；只有需要人工操作时，Electron 客户端调用 `/vnc` 获取租约。VNC 租约默认 2 分钟未收到心跳就释放，可通过 `VNC_LEASE_TTL_MS` 调整。

Electron 客户端的“运行中”只表示当前有可操作的 VNC 窗口；Headless 采集不会出现在客户端运行列表。VNC 窗口失焦、隐藏或最小化后默认保留 10 分钟，重新回到前台会继续保持；超过宽限时间自动释放 VNC 并关闭窗口。可在本机 `client/config.json` 增加 `vncBackgroundTimeoutMs` 调整该宽限时间。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `IDLE_TIMEOUT_MS` | `600000` | 空闲超时（ms），默认 10 分钟 |
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
