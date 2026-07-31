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

- **API 调用者不需要管容器生命周期** — 调 navigate 时容器自动启动，空闲自动关闭
- **noVNC** — 浏览器打开即可远程操作 Chrome，不需要客户端
- **双运行模式** — 启动会话时传 `browserMode: "vnc"` 或 `"headless"`；Headless 容器不启动桌面和 noVNC
- **指纹隔离** — 每个 profile 独立浏览器指纹，通过 Chrome 扩展注入

同一个 Profile 的用户目录不能同时被 VNC 和 Headless 两个 Chrome 进程打开。启动不同模式时服务端会先停止旧容器，再按新模式启动；Profile 的登录态和数据目录保持不变。

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

# 启动 Headless 采集会话
curl -X POST http://localhost:3000/browsers/1/start \
  -H "Content-Type: application/json" \
  -d '{"browserMode":"headless"}'

# 列表
curl http://localhost:3000/profiles
```

### 浏览器操作

启动会话后，所有操作自动连接对应模式的 Chrome。旧调用如果没有显式启动会话，仍默认启动 VNC，保持兼容。

```bash
# 启动 Headless 会话；同一个 Profile 也可以之后切换回 VNC
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

# 获取 noVNC 地址；如果当前是 Headless，会切换为 VNC 会话
curl http://localhost:3000/browsers/1/vnc

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
| `POST` | `/browsers/:id/start` | 启动或切换浏览器会话（body: `browserMode`） |
| `POST` | `/browsers/:id/stop` | 停止当前浏览器会话，保留 Profile 数据 |
| `POST` | `/browsers/:id/navigate` | 导航 |
| `POST` | `/browsers/:id/execute` | 执行 JS |
| `GET` | `/browsers/:id/cookies` | 全量 cookies |
| `POST` | `/browsers/:id/screenshot` | 截图（base64） |
| `GET` | `/browsers/:id/vnc` | noVNC 地址 |
| `GET` | `/health` | 健康检查 |

`browserMode` 不属于 Profile，只能传给 `POST /browsers/:id/start`。Profile 创建和修改接口不需要运行模式。启动 Headless 后，导航、执行脚本、Cookie、页面操作和 CDP 截图接口都会复用 Headless 会话；VNC、剪贴板和文件上传接口要求当前会话是 VNC。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `IDLE_TIMEOUT_MS` | `600000` | 空闲超时（ms），默认 10 分钟 |
| `HOST_DATA_DIR` | `./data` | 数据���录（Docker 部署时需设为宿主机绝对路���） |

## 模块

| 模块 | 职责 |
|------|------|
| `containerManager` | Docker 容器生命周期（启动/停止/恢复） |
| `browserConnector` | CDP ���接池，自动重连 |
| `api` | HTTP 端点，编排容器+连接+操作 |
| `profileStore` | Profile CRUD，JSON 文件存储 |
| `fingerprintEngine` | 指纹生成 + Chrome 扩展构建 |
