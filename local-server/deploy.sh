#!/bin/bash
# ============================================
# 触摸玩偶 API 服务器 — 阿里云一键部署脚本
# ============================================
# 使用方式：SSH 到阿里云服务器后执行
#   wget -O deploy.sh https://raw.githubusercontent.com/Figri/touch-sensor-server/main/local-server/deploy.sh
#   chmod +x deploy.sh
#   sudo ./deploy.sh
# 或者手动复制粘贴执行
# ============================================

set -e

echo "========================================"
echo "  触摸玩偶 API 服务器部署"
echo "========================================"

# 1. 安装 Node.js 20.x
echo ""
echo "[1/5] 检查 Node.js..."
if command -v node &> /dev/null && node -v | grep -q "v2"; then
  echo "  Node.js 已安装: $(node -v)"
else
  echo "  正在安装 Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo "  Node.js 安装完成: $(node -v)"
fi

# 2. 安装 PM2
echo ""
echo "[2/5] 检查 PM2..."
if command -v pm2 &> /dev/null; then
  echo "  PM2 已安装"
else
  echo "  正在安装 PM2..."
  npm install -g pm2
  echo "  PM2 安装完成"
fi

# 3. 拉取代码
APP_DIR="/opt/touch-doll"
echo ""
echo "[3/5] 部署代码到 $APP_DIR..."
if [ -d "$APP_DIR" ]; then
  echo "  目录已存在，拉取最新代码..."
  cd "$APP_DIR"
  git pull || true
else
  git clone https://github.com/Figri/touch-sensor-server.git "$APP_DIR"
fi

cd "$APP_DIR/local-server"

# 4. 启动服务
echo ""
echo "[4/5] 启动 API 服务器..."
pm2 delete touch-doll 2>/dev/null || true
pm2 start server.js --name touch-doll
pm2 save

# 5. 设置开机自启
echo ""
echo "[5/5] 设置开机自启..."
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "========================================"
echo "  部署完成！"
echo "========================================"
echo ""
echo "服务器地址: http://$(curl -s ifconfig.me):3000/api/touch"
echo "健康检查:   http://$(curl -s ifconfig.me):3000/health"
echo ""
echo "常用命令:"
echo "  pm2 status          # 查看状态"
echo "  pm2 logs touch-doll # 查看日志"
echo "  pm2 restart touch-doll # 重启"
echo ""
echo "⚠️  请在阿里云控制台开放 3000 端口（TCP）："
echo "   服务器 → 防火墙 → 添加规则 → 端口 3000 / TCP"
echo ""
