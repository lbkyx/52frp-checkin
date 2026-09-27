#!/bin/bash
# 52frp 每日签到入口 —— 供 cron / 宝塔计划任务调用。
#
# 做的事情与 GitHub Actions 里的 workflow 一致：
#   1. 跑 checkin-v2.js（浏览器自动化签到）
#   2. 把 "CHECKIN_RESULT: " 之后的内容交给 push_notification.js 推送
#
# 用法：
#   ./run-daily.sh
#
# 凭据放在脚本同目录的 .env（参考 .env.example），权限建议 600：
#   FRP_USERNAME / FRP_PASSWORD   必填
#   TG_BOT_TOKEN / TG_CHAT_ID      Telegram 推送（其他渠道见 .env.example）
#
# 输出是实时的（边跑边往 stdout 写），所以在宝塔「计划任务 → 日志」里
# 执行过程中就能看到进度；一次完整签到约 2～3 分钟。
#
# 退出码沿用签到脚本：成功 / 今日已签到 = 0，失败 = 1。

set -uo pipefail

# /usr/bin/node 在装了宝塔的机器上是「命令行版本」软链，会跟随面板切换版本；
# 其它环境直接用 PATH 里的 node。
if command -v node >/dev/null 2>&1; then
  NODE=node
elif [ -x /usr/bin/node ]; then
  NODE=/usr/bin/node
else
  echo "错误: 找不到 node，请先安装 Node.js" >&2
  exit 1
fi

# 以脚本自身位置定位项目目录，本地与 /opt/52frp-checkin 都能直接跑
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR" || exit 1

# 并发保护：cron 与手动「执行」撞到一起时会起两个浏览器抢同一账号，
# 后者直接跳过（而不是排隊，避免当天多次重复签到）。
LOCK=/tmp/52frp-checkin.lock
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 已有签到任务在运行，本次跳过"
  exit 0
fi

TMPLOG=$(mktemp)
trap 'rm -f "$TMPLOG"' EXIT

# tee 让输出实时落到调用方的日志（cron 重定向 / 宝塔页面），同时留一份解析结果
"$NODE" checkin-v2.js 2>&1 | tee "$TMPLOG"
status=$?

# 只取 CHECKIN_RESULT 及其之后的行送进推送，避免把调试日志也推给用户
result=$(sed -n '/^CHECKIN_RESULT: /,$ { s/^CHECKIN_RESULT: //; p; }' "$TMPLOG")
[ -z "$result" ] && result="签到脚本执行完成，但未解析到结果"

"$NODE" push_notification.js "$result"

exit $status
