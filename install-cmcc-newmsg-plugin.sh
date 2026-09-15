#!/bin/sh

# 5G 消息插件 - 安装程序
# 支持自动搜索 tgz 文件位置，本地找不到时自动下载

set -e

# 获取脚本所在目录（兼容 sh 和 bash）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TGZ_NAME="openclaw-cmcc-newmsg-channel-1.0.0.tgz"
TGZ_PATH=""
DOWNLOAD_URL="https://5gvas01.cmicmaap.com/aifile/public/file/openclaw-cmcc-newmsg-channel-1.0.0.tgz"
MIN_VERSION="2026.3.22"

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║           5G 消息插件 - 安装程序                      ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# 检查 OpenClaw 版本
check_openclaw_version() {
    echo "正在检查 OpenClaw 版本..." >&2

    # 获取版本号
    VERSION_OUTPUT=$(openclaw --version 2>&1) || {
        echo "错误：无法执行 openclaw 命令" >&2
        echo "请确保 openclaw 已正确安装并在 PATH 中" >&2
        return 1
    }

    # 提取版本号（匹配 x.y.z 格式）
    CURRENT_VERSION=$(echo "$VERSION_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

    # 版本比较（使用 sort -V）
    HIGHER_VERSION=$(printf '%s\n%s\n' "$CURRENT_VERSION" "$MIN_VERSION" | sort -V | tail -1)

    if [ "$HIGHER_VERSION" = "$MIN_VERSION" ] && [ "$CURRENT_VERSION" != "$MIN_VERSION" ]; then
        echo "❌ 错误：OpenClaw 版本过低"
        echo "   请先升级：openclaw update"
        return 1
    fi
}

# 执行版本检查
check_openclaw_version || exit 1

# 搜索 tgz 文件，找不到时自动下载
find_tgz() {
    echo "正在搜索安装包..." >&2

    # 优先检查当前目录
    if [ -f "./tmpsmschannel.tgz" ]; then
        echo "✓ 找到安装包: ./tmpsmschannel.tgz" >&2
        echo "./tmpsmschannel.tgz"
        return 0
    fi

    # 本地找不到，自动下载
    echo "" >&2
    echo "本地未找到安装包，尝试从服务器下载..." >&2
    echo "下载链接：$DOWNLOAD_URL" >&2

    local download_path="$SCRIPT_DIR/$TGZ_NAME"

    if curl -sL -o "$download_path" "$DOWNLOAD_URL"; then
        if [ -f "$download_path" ] && [ -s "$download_path" ]; then
            echo "✓ 下载成功：$download_path" >&2
            echo "$download_path"
            return 0
        else
            echo "错误：下载的文件为空" >&2
            rm -f "$download_path" 2>/dev/null
            return 1
        fi
    else
        echo "错误：无法下载安装包" >&2
        echo "请检查网络连接，或手动下载后放到脚本同一目录" >&2
        return 1
    fi
}

TGZ_PATH=$(find_tgz)

if [ ! -f "$TGZ_PATH" ]; then
    echo ""
    echo "错误: 找不到安装包 $TGZ_NAME"
    echo ""
    echo "请确保以下文件在同一目录："
    echo "  - install-cmcc-newmsg-plugin.sh"
    echo "  - $TGZ_NAME"
    echo ""
    echo "或者手动指定路径："
    echo "  TGZ_PATH=/path/to/$TGZ_NAME sh install-cmcc-newmsg-plugin.sh"
    exit 1
fi

if [ -z "$SMS_API_KEY" ]; then
    echo ""
    echo "┌─────────────────────────────────────────────────────────┐"
    echo "│  请获取您的 API Key 后粘贴到下方                        │"
    echo "│  获取方式: 短信/管理员通知/其他渠道                     │"
    echo "│  格式: ak_xxx 或 app_xxx                             │"
    echo "└─────────────────────────────────────────────────────────┘"
    echo ""
    printf "粘贴 API Key (ak_xxx / app_xxx): "
    read -r SMS_API_KEY
    echo ""
fi

case "$SMS_API_KEY" in
  ak_*|app_*) ;;
  *)
    echo "错误: API Key 必须以 ak_ 或 app_ 开头"
    exit 1
    ;;
esac

export SMS_API_KEY

# 清理函数：逆向 setup.js 的操作
cleanup_sms_config() {
    CONFIG_PATH="$HOME/.openclaw/openclaw.json"
    if [ -f "$CONFIG_PATH" ]; then
        # 使用 node 删除 cmcc-newmsg 配置（兼容性强）
        node -e "
            const fs = require('fs');
            const config = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf8'));
            let modified = false;
            if (config.channels && config.channels['cmcc-newmsg']) {
                delete config.channels['cmcc-newmsg'];
                modified = true;
            }
            if (config.plugins && config.plugins.allow) {
                const idx = config.plugins.allow.indexOf('cmcc-newmsg');
                if (idx > -1) {
                    config.plugins.allow.splice(idx, 1);
                    modified = true;
                }
            }
            if (config.plugins && config.plugins.entries && config.plugins.entries['cmcc-newmsg']) {
                delete config.plugins.entries['cmcc-newmsg'];
                modified = true;
            }
            if (modified) {
                fs.writeFileSync('$CONFIG_PATH', JSON.stringify(config, null, 2) + '\n', 'utf8');
                console.log('已清理 cmcc-newmsg 配置');
            }
        " 2>/dev/null || true
    fi
    rm -rf ~/.openclaw/extensions/cmcc-newmsg 2>/dev/null || true
}

# 检测是否安装了我们的旧版 sms 插件（plugin id 也是 "sms"）。
# 判断依据：~/.openclaw/openclaw.json 里 channels.sms 下存在 apiKey 字段。
# 官方 sms 没有 apiKey 字段，所以这个特征可以可靠区分。
# 退出码：0 = 检测到旧版 sms；1 = 未检测到。
detect_old_sms() {
    CONFIG_PATH="$HOME/.openclaw/openclaw.json"
    [ -f "$CONFIG_PATH" ] || return 1
    node -e "
        const fs = require('fs');
        try {
            const c = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf8'));
            const sms = c.channels && c.channels.sms;
            process.exit(sms && typeof sms === 'object' && sms.apiKey ? 0 : 1);
        } catch (e) { process.exit(1); }
    " 2>/dev/null
}

# 备用清理：手动从 openclaw.json 里删除旧 sms 的痕迹
# （channels.sms、plugins.allow 中的 sms、plugins.entries.sms）
# 同时删除 ~/.openclaw/extensions/sms 目录。
cleanup_old_sms_config() {
    CONFIG_PATH="$HOME/.openclaw/openclaw.json"
    if [ -f "$CONFIG_PATH" ]; then
        node -e "
            const fs = require('fs');
            const config = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf8'));
            let modified = false;
            if (config.channels && config.channels.sms) {
                delete config.channels.sms;
                modified = true;
            }
            if (config.plugins && config.plugins.allow) {
                const idx = config.plugins.allow.indexOf('sms');
                if (idx > -1) {
                    config.plugins.allow.splice(idx, 1);
                    modified = true;
                }
            }
            if (config.plugins && config.plugins.entries && config.plugins.entries.sms) {
                delete config.plugins.entries.sms;
                modified = true;
            }
            if (modified) {
                fs.writeFileSync('$CONFIG_PATH', JSON.stringify(config, null, 2) + '\n', 'utf8');
                console.log('已清理旧版 sms 配置');
            }
        " 2>/dev/null || true
    fi
    rm -rf ~/.openclaw/extensions/sms 2>/dev/null || true
}

echo "清理临时安装目录"
rm -rf ~/.openclaw/extensions/.openclaw-install-stage-* 2>/dev/null || true
echo ""
echo "正在检测旧版 sms 插件..."
if detect_old_sms; then
    echo ""
    echo "┌─────────────────────────────────────────────────────────┐"
    echo "│ ⚠ 检测到旧版 sms 插件                                    │"
    echo "└─────────────────────────────────────────────────────────┘"
    echo ""
    echo "正在卸载旧版 sms 插件..."
    echo "y" | openclaw plugins uninstall sms 2>/dev/null || {
        echo "openclaw 卸载失败，使用备用清理..."
        cleanup_old_sms_config
    }
    echo "✓ 旧版 sms 插件已卸载"
else
    echo "✓ 未检测到旧版 sms 插件（channels.sms 无 apiKey 字段）"
fi
echo ""
echo "正在清理旧插件..."
echo "y" | openclaw plugins uninstall cmcc-newmsg 2>/dev/null || {
    echo "openclaw 卸载失败，使用备用清理..."
    cleanup_sms_config
}

echo ""
echo "正在安装插件..."
if ! NPM_CONFIG_REGISTRY=https://registry.npmmirror.com openclaw plugins install "$TGZ_PATH"; then
    echo ""
    echo "⚠️ npm install 失败，可能需要修复 Git 配置"
    echo ""
    echo "┌─────────────────────────────────────────────────────────┐"
    echo "│ 检测到 npm install 失败，可能是 Git SSH 访问问题        │"
    echo "│                                                       │"
    echo "│ 建议操作：配置 git 使用 HTTPS 代替 SSH 访问 GitHub      │"
    echo "│ 执行命令：git config --global url.\"https://github.com/\".insteadOf \"ssh://git@github.com/\" │"
    echo "│                                                       │"
    echo "│ 这将修改全局 Git 配置，允许通过 HTTPS 克隆 GitHub 仓库    │"
    echo "└─────────────────────────────────────────────────────────┘"
    echo ""
    printf "是否执行 Git 配置修改？[Y/n]: "
    read -r CONFIRM_GIT
    case "$CONFIRM_GIT" in
        [Yy]*|"")
            echo "正在配置 Git..."
            git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
            echo "✓ Git 配置已更新"
            echo ""
            echo "正在重试安装..."
            rm -rf ~/.openclaw/extensions/cmcc-newmsg
            NPM_CONFIG_REGISTRY=https://registry.npmmirror.com openclaw plugins install "$TGZ_PATH"
            ;;
        [Nn]*)
            echo "已跳过 Git 配置修改"
            echo ""
            echo "提示：如果安装持续失败，请手动执行以下命令后重试："
            echo "  git config --global url.\"https://github.com/\".insteadOf \"ssh://git@github.com/\""
            exit 1
            ;;
    esac
fi

echo ""
echo "正在配置..."

SETUP_TMP=$(mktemp -d)
trap "rm -rf $SETUP_TMP" EXIT
tar -xzf "$TGZ_PATH" -C "$SETUP_TMP"

SMS_API_KEY="$SMS_API_KEY" node "$SETUP_TMP/package/bin/setup.js"

echo ""
echo "正在重启 Gateway..."

SYSTEMD_ACTIVE=$(systemctl --user is-active openclaw-gateway.service 2>/dev/null)
if [ "$SYSTEMD_ACTIVE" = "active" ]; then
    openclaw daemon restart
else
    openclaw gateway restart
fi

sleep 5

echo ""
echo "安装完成！"