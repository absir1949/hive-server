# Hive Server

浏览器会话池服务器。在 Linux 服务器上管理多个隔离的 Chrome 实例（Docker 容器），通过 HTTP API 提供自动化操作，通过 noVNC 提供人工远程访问。

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
│  ┌─────────────┐  ┌─────────────┐           │
│  │ Chrome+Xvfb │  │ Chrome+Xvfb │  ...      │
│  │ +VNC+noVNC  │  │ +VNC+noVNC  │           │
│  │ profile 1   │  │ profile 2   │           │
│  └─────────────┘  └─────────────┘           │
└─────────────────────────────────────────────┘
```

- **API 调用者不需要管容器生命周期** — 调 navigate 时容器自动启动，空闲自动关闭
- **noVNC** — 浏览器打开即可远程操作 Chrome，不需要客户端
- **指纹隔离** — 每个 profile 独立浏览器指纹，通过 Chrome 扩展注入

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
# 创建 profile
curl -X POST http://localhost:3000/profiles \
  -H "Content-Type: application/json" \
  -d '{"name":"Shop 1","url":"https://example.com"}'

# 列表
curl http://localhost:3000/profiles
```

### 浏览器操作

所有操作自动启动容器 + 连接 Chrome，调用者无需关心。

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

# 获取 noVNC 地址
curl http://localhost:3000/browsers/1/vnc
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
| `POST` | `/browsers/:id/navigate` | 导航 |
| `POST` | `/browsers/:id/execute` | 执行 JS |
| `GET` | `/browsers/:id/cookies` | 全量 cookies |
| `POST` | `/browsers/:id/screenshot` | 截图（base64） |
| `GET` | `/browsers/:id/vnc` | noVNC 地址 |
| `GET` | `/health` | 健康检查 |

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
