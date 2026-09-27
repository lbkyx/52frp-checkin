# 52frp-checkin

52frp 自动签到脚本。用 Playwright 打开真实浏览器模拟人工操作（填账号、过滑块、点签到），
签完把结果推送到 Telegram / 企业微信 / 钉钉等 11 个渠道。

## 怎么跑

| 用法 | 适合谁 | 说明 |
| --- | --- | --- |
| **定时自动签到**（推荐） | 想要每天自动签、不用管 | 放在能稳定访问 52frp 的机器上跑 cron：国内/香港 VPS、云函数、或者你自己的电脑（开着机就行） |
| **手动跑一次** | 想先试试、或临时补签 | Fork 到 GitHub，在 Actions 页面点一下 |

> ⚠️ 不要只依赖 GitHub Actions 做定时签到。GitHub 的 runner 在海外，到 52frp 的源站
> 经常返回 522/524/525，实测失败率很高。仓库里虽然保留了 workflow，但它只适合手动触发。

---

## 一、定时自动签到（推荐）

在一台能正常打开 52frp 的机器上：

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

### 环境变量

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

---

## 二、Fork 到 GitHub 手动跑

1. **Fork** 这个仓库
2. **配置 Secrets**：`Settings` → `Secrets and variables` → `Actions` → `New repository secret`，
   添加的变量和上面「环境变量」那张表一样（`FRP_USERNAME` / `FRP_PASSWORD` + 你要用的推送渠道）
3. **启用 Actions**：进 `Actions` 页面，点 `I understand my workflows, go ahead and enable them`
4. **运行**：`Actions` → `Daily 52frp Check-in` → `Run workflow` → `Run workflow`

---

## 推送效果

大约 1～3 分钟后你会收到：

```text
✅ 52frp签到成功

2026-09-27 11:15:00 (UTC+8)
👤 账号：lbk***yx
————————————

签到天数：42 天
本次获得：256.00MB
累计获得：12.50GB
剩余流量：100.99GB
```

今天已经签过就推 `🔄 52frp今日已签到`，失败则推 `❌ 签到失败` 并附上原因，提醒你手动补签。

## 常见问题

**多久跑一次？** 一天一次就够。52frp 每天只能签到一次，重复提交会撞上「签到次数超限」。
脚本签到前会先查今日状态，已经签过就直接返回，不会重复点。

**失败了会怎样？** 一次运行内最多重试 3 轮（每轮换全新浏览器实例），全失败才推送失败通知。

**报 522 / 524 / 525 是什么问题？** 52frp 的 CDN 回源故障，脚本的重试就是在等它恢复。
如果你是从海外机器（比如 GitHub Actions）跑的，那基本就是网络问题，换台能直连的机器即可。

**账号安全吗？** 账号密码只存在 Secrets / 本地 `.env`（权限 600）里，不会写进代码；
日志和推送里的账号都是脱敏的，密码全程不打印。

## License

MIT
