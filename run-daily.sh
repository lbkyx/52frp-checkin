#!/bin/sh
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
# 退出码沿用签到脚本：成功 / 今日已签到 = 0，失败 = 1。

set -u

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

output=$("$NODE" checkin-v2.js 2>&1)
status=$?
printf '%s\n' "$output"

# 只取 CHECKIN_RESULT 及其之后的行送进推送，避免把调试日志也推给用户
result=$(printf '%s\n' "$output" | sed -n '/^CHECKIN_RESULT: /,$ { s/^CHECKIN_RESULT: //; p; }')
[ -z "$result" ] && result="签到脚本执行完成，但未解析到结果"

"$NODE" push_notification.js "$result"

exit $status
