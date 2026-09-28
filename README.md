# 52frp-checkin

52frp 自动签到脚本。用 Playwright 打开真实浏览器模拟人工操作（填账号、过滑块、点签到），
签完把结果推送到 Telegram / 企业微信 / 钉钉等 11 个渠道。

## 怎么用

在一台能正常打开 52frp 的机器上跑（国内/香港 VPS、云函数、或者你自己的电脑，开着机就行），
用 cron 每天定时触发一次：

```bash
git clone https://github.com/lbkyx/52frp-checkin.git /opt/52frp-checkin
cd /opt/52frp-checkin
npm ci
node node_modules/playwright/cli.js install chromium

cp .env.example .env && chmod 600 .env   # 填账号和推送渠道
./run-daily.sh                            # 先手动跑一次验证
```

验证通过后加一条 cron（每天 11:15，**注意机器的时区**）：

```cron
15 11 * * * /opt/52frp-checkin/run-daily.sh >> /var/log/52frp-checkin.log 2>&1
```

`run-daily.sh` 一次完成「签到 + 推送」，输出实时写入日志，并且带并发锁 ——
cron 和手动执行撞到一起时会自动跳过，不会开两个浏览器抢同一个账号。

想临时补签一次，直接跑 `./run-daily.sh` 即可。

仓库里另有一个 GitHub Actions workflow 可以手动触发，但 GitHub 的 runner 在海外、
到 52frp 源站经常返回 5xx，成功率不高，别指望它做定时签到。

## 配置

复制 `.env.example` 为 `.env` 后填写。**必填**只有两个：

| 变量 | 说明 |
| --- | --- |
| `FRP_USERNAME` | 52frp 账号 / 手机号 / 邮箱 |
| `FRP_PASSWORD` | 52frp 密码 |

推送渠道**强烈建议至少配一个**，否则签没签上你不知道。配了哪个就发哪个，可以同时配多个；
没配的自动跳过，单个渠道挂了也不影响签到结果。

| 渠道 | 要填的变量 |
| --- | --- |
| Telegram | `TG_BOT_TOKEN` + `TG_CHAT_ID` |
| 企业微信群机器人 | `WECOM_BOT_WEBHOOK` |
| 钉钉机器人 | `DINGTALK_WEBHOOK`（开了加签再加 `DINGTALK_SECRET`） |
| 飞书机器人 | `FEISHU_WEBHOOK`（开了加签再加 `FEISHU_SECRET`） |
| PushPlus（可转微信） | `PUSHPLUS_TOKEN`（+ 可选 `PUSHPLUS_CHANNEL`） |
| Server酱 | `SERVERCHAN_KEY` |
| PushDeer | `SENDKEY` |
| Bark（iOS） | `BARK_KEY` |
| WxPusher | `WXPUSHER_TOKEN` + `WXPUSHER_UIDS`（或 `WXPUSHER_TOPIC_IDS`） |
| 云湖 | `YUNHU_TOKEN` + `YUNHU_RECV_ID` |
| 自定义 Webhook | `WEBHOOK_URL` |

## 推送效果

大约 1～3 分钟后你会收到：

```text
✅ 52frp签到成功

2026-01-01 00:00:00 (UTC+8)
👤 账号：<脱敏后的账号，如 ab***yz>
————————————

签到天数：<N> 天
本次获得：<本次签到获得的流量>
累计获得：<累计获得的流量>
剩余流量：<账号剩余流量>
```

今天已经签过就推 `🔄 52frp今日已签到`，失败则推 `❌ 签到失败` 并附上原因，提醒你手动补签。

## 常见问题

**多久跑一次？** 一天一次就够。52frp 每天只能签到一次，重复提交会撞上「签到次数超限」。
脚本签到前会先查今日状态，已经签过就直接返回，不会重复点。

**失败了会怎样？** 一次运行内最多重试 5 轮（间隔 45s / 60s / 90s / 120s 递增），
总预算 30 分钟，全失败才推送失败通知。轮数和预算都能用 `FRP_ROUNDS`、
`FRP_TOTAL_BUDGET_MS` 改。

**每次都要重新登录吗？** 不用。登录态和已下载的页面资源存在 `.browser-profile/` 里，
下次运行会先带着上次的 cookie 直接打开签到页：cookie 还有效就直接签到，
连账号密码和滑块都不用走；失效了才重新登录并覆盖保存。
这也顺带解决了跨境机器上最头疼的问题 —— 5MB 的主 bundle 只要成功下载过一次，
之后基本都从本地读，不再依赖网络。想强制重新登录就把这个目录删掉。

**从境外机器跑要注意什么？** 打开串行预热（默认已开，见 `.env.example` 的
`FRP_PRELOAD`）。境外到站点 CDN 的典型症状是：单独 curl 每个资源都 200，
浏览器一次性并发拉 30 多个却大面积 522。预热会在正式打开页面之前，
把静态资源**一个一个排队**拉进缓存，把并发请求数压下来，成功率提升很明显。
链路本来就好的机器可以用 `FRP_PRELOAD=0` 关掉省时间。

**报 522 / 524 / 525 是什么问题？** 52frp 的 CDN 回源故障，脚本的重试就是在等它恢复。
如果是从海外机器跑的，基本就是网络不通，换台能直连站点的机器即可。

**账号安全吗？** 账号密码只存在本地 `.env`（权限 600）里，不会写进代码；
日志和推送里的账号都是脱敏的，密码全程不打印。

## License

MIT
