# CLAUDE.md

## Project Overview

**Hive Server** — 浏览器会话池服务器。在 Linux 服务器上管理多个隔离的 Chrome 实例（Docker 容器），通过 HTTP API 提供自动化操作，通过 noVNC 提供人工远程访问。

## Architecture

详细技术方案见 `docs/architecture.md`。

### Core Modules

- **server.js** — 入口，启动 API 服务
- **lib/api.js** — HTTP API（navigate, execute, cookies, screenshot）
- **lib/containerManager.js** — Docker 容器生命周期（start/stop/status）
- **lib/browserConnector.js** — CDP 连接管理（Puppeteer connect/reconnect）
- **lib/profileStore.js** — Profile 配置 CRUD
- **lib/fingerprintEngine.js** — 指纹生成 + Chrome 扩展构建

### Infrastructure

- **docker/Dockerfile** — Chrome + Xvfb + VNC + noVNC 容器镜像
- **docker/docker-compose.yml** — 容器编排
- **extensions/template/** — 指纹注入扩展模板

### Key Design Decisions

- Chrome 在 Docker 容器里运行（Xvfb，非 headless），Server 通过 CDP 远程连接
- 容器按需启动，空闲自动关闭，user-data-dir 持久化
- API 调用者不需要管容器生命周期
- Server 重启后通过 CDP 重连到运行中的容器
- 不用 --restore-last-session（干扰自动化），启动后主动 navigate 到 profile URL
- 人工操作通过 noVNC 网页，不需要客户端应用

### VNC 快捷键（Electron 客户端内）

剪贴板和文件上传通过 CDP 直通，不走 noVNC 的剪贴板（noVNC 不支持中文）。

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| Cmd/Ctrl + V | 粘贴 | 本地剪贴板 → CDP `Input.insertText` → 远程 Chrome |
| Cmd/Ctrl + C | 复制 | 远程 Chrome `getSelection()` → 本地剪贴板 |
| Cmd/Ctrl + U | 上传文件 | 本地文件 → 容器 /tmp → xdotool 输入路径到文件对话框 |

**文件上传流程**：先在 VNC 里点击网页的上传按钮（文件对话框弹出），再按 Cmd+U 选择本地文件。文件名仅支持英文/数字（xdotool 无法输入中文路径）。

## Development

```bash
npm run server    # 启动 API 服务
```

## Origin

从 hive-browser (Electron 桌面应用) 演化而来。复用了指纹生成、代理管理、输入校验等模块，但去掉了 Electron 依赖和 Mac 窗口管理代码，改为 Docker 容器 + noVNC 架构。
