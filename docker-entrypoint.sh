#!/bin/sh
set -e

# 确保挂载的宿主机目录对 node 用户可读可写
chown -R node:node /app/data /app/logs 2>/dev/null || true

# 降权切换为 node 用户运行服务
exec su-exec node "$@"
