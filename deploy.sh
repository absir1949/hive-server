#!/bin/bash
# deploy.sh — 一键部署 hive-server 到远程 Ubuntu 主机
#
# 用法:
#   ./deploy.sh              # 使用默认配置
#   ./deploy.sh --rebuild    # 强制重建所有镜像（包括 hive-chrome）
#
# 前提: SSH 免密登录已配置

set -e

# --- 配置 ---
REMOTE="ab@192.168.2.122"
REMOTE_DIR="~/docker/hive-server"
REBUILD_CHROME=false

for arg in "$@"; do
  case $arg in
    --rebuild) REBUILD_CHROME=true ;;
  esac
done

echo "=== 1. Git push ==="
# 确保本地改动已提交
if [ -n "$(git status --porcelain -- ':!client/config.json')" ]; then
  echo "ERROR: 有未提交的改动（client/config.json 除外），请先 commit"
  git status --short -- ':!client/config.json'
  exit 1
fi

git push 2>/dev/null || echo "Already up to date"

echo "=== 2. Remote git pull ==="
ssh "$REMOTE" "cd $REMOTE_DIR && git pull"

echo "=== 3. Build ==="
if [ "$REBUILD_CHROME" = true ]; then
  echo "Rebuilding hive-chrome image..."
  ssh "$REMOTE" "cd $REMOTE_DIR && DOCKER_BUILDKIT=0 docker build -t hive-chrome ./docker" 2>&1 | tail -3
fi

echo "Rebuilding hive-server image..."
ssh "$REMOTE" "cd $REMOTE_DIR && DOCKER_BUILDKIT=0 docker compose build hive-server" 2>&1 | tail -3

echo "=== 4. Restart ==="
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose down && docker compose up -d" 2>&1

echo "=== 5. Verify ==="
sleep 3
HEALTH=$(ssh "$REMOTE" "curl -sf http://localhost:\$(grep -oP 'PORT=\K\d+' $REMOTE_DIR/.env 2>/dev/null || echo 3000)/health" 2>/dev/null)
if [ "$HEALTH" = '{"status":"ok"}' ]; then
  echo "✓ Deploy success — server is healthy"
else
  echo "✗ Server not responding, check logs:"
  echo "  ssh $REMOTE 'cd $REMOTE_DIR && docker compose logs --tail 20'"
fi
