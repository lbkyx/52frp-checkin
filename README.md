# 52frp-checkin

基于 GitHub Actions 的 52frp 自动签到脚本。

内置**两种**签到实现，默认先走快的方法、失败自动回退：

| | 方法A：API 直签 | 方法B：浏览器自动化 |
| --- | --- | --- |
| 代码 | `src/checkin/api.js` | `src/browser.js`（经 `src/checkin/browser.js` 适配） |
| 是否启动浏览器 | 否，直接 HTTP 调用 | 是，Playwright + Chromium |
| 典型耗时 | 数秒 | 1～3 分钟 |
| 能否过滑块 | 不能，被风控就直接失败 | 能，自动拖动滑块 |
| 成功判据 | 复查接口 `signed_today === true` | 签到接口响应 + 页面证据分级 |

默认策略 `auto` = 方法A 先跑，失败（请求异常 / 接口返回错误 / 复查判定没签上）才回退方法B。
两种方式成功都会走同一套**多通道推送**（PushPlus / Telegram / Server酱 / Bark / 钉钉 / 飞书 /
企业微信 / WxPusher / PushDeer / 云湖 / 自定义 Webhook），配了哪个就发哪个。

## 工作原理

### 方法A：API 直签

```text
GET  https://www.52frp.com/user/              预热，取初始 Cookie（含 CSRF）
POST https://www.52frp.com/api/user/login      账号密码 → Bearer token
GET  https://www.52frp.com/api/user/sign/info  今日是否已签到
GET  https://www.52frp.com/api/user/slider-token  取一次性 slider_token
POST https://www.52frp.com/api/user/sign       提交签到
GET  https://www.52frp.com/api/user/sign/info  复查（唯一可信的成功判据）
```

登录后会下发 `hzfrp_user_csrf` Cookie，后续 POST 必须回传 `X-CSRF-Token`，否则 400。
**签到接口返回 200 只代表"请求被接受"，不代表真的签上了** —— 所以最后必须复查 `signed_today`，
复查不到 `true` 就判失败并回退方法B，绝不静默当成功。

### 方法B：浏览器自动化

模拟真实用户操作：

1. 打开登录页 → 自动填账号密码
2. 点击登录 → 检测滑块验证 → 自动拖动滑块到最右边
3. 滑块验证通过 → 再次点击登录完成登录
4. 登录成功 → 自动跳转签到页
5. 点击"立即签到"按钮 → 检查签到结果
6. 一次运行内最多 3 轮完整重试（每轮换全新浏览器实例，退避 45s / 75s）

**为什么还需要方法B？**
- 52frp 会校验请求特征（TLS 指纹 + 请求头组合），Node 的 `fetch` 指纹不是 Chrome，可能被直接拒
- 登录环节的滑块验证纯 API 过不了
- 浏览器方案更接近真实用户行为，是方法A 失效时的兜底

## Secrets 配置

在仓库 `Settings` → `Secrets and variables` → `Actions` 里添加：

| 名称 | 说明 |
| --- | --- |
| `FRP_USERNAME` | 52frp 账号 / 手机号 / 邮箱（推送正文里会脱敏显示） |
| `FRP_PASSWORD` | 52frp 密码 |
| `SENDKEY` | 可选，PushDeer pushkey |
| `SERVERCHAN_KEY` | 可选，Server酱 SendKey（形如 `SCTxxxxx`） |
| `PUSHPLUS_TOKEN` | 可选，PushPlus 推送 token |
| `PUSHPLUS_CHANNEL` | 可选，PushPlus 发送渠道，例如 `wechat` 或 `webhook` |
| `TG_BOT_TOKEN` | 可选，Telegram Bot token |
| `TG_CHAT_ID` | 可选，Telegram 接收消息的 chat ID；需与 `TG_BOT_TOKEN` 同时配置 |
| `DINGTALK_WEBHOOK` | 可选，钉钉机器人 Webhook |
| `DINGTALK_SECRET` | 可选，钉钉机器人加签密钥（机器人开启加签校验时必填） |
| `FEISHU_WEBHOOK` | 可选，飞书机器人 Webhook |
| `FEISHU_SECRET` | 可选，飞书机器人加签密钥（同上） |
| `WECOM_BOT_WEBHOOK` | 可选，企业微信群机器人 Webhook |
| `YUNHU_TOKEN` | 可选，云湖机器人 token |
| `YUNHU_RECV_ID` | 可选，云湖接收人 ID；需与 `YUNHU_TOKEN` 同时配置 |
| `YUNHU_RECV_TYPE` | 可选，云湖接收类型，`group`（默认）或 `private` |
| `BARK_KEY` | 可选，Bark 推送 key |
| `BARK_SERVER` | 可选，Bark 服务地址，默认 `https://api.day.app` |
| `BARK_GROUP` | 可选，Bark 消息分组 |
| `WXPUSHER_TOKEN` | 可选，WxPusher appToken |
| `WXPUSHER_UIDS` | 可选，WxPusher 接收用户 UID，多个用逗号分隔 |
| `WXPUSHER_TOPIC_IDS` | 可选，WxPusher 主题 ID，多个用逗号分隔 |
| `WEBHOOK_URL` | 可选，自定义 Webhook 地址 |
| `WEBHOOK_METHOD` | 可选，`POST`（默认）或 `PUT` |
| `WEBHOOK_CONTENT_TYPE` | 可选，`json`（默认）或 `form` |
| `WEBHOOK_HEADERS` | 可选，JSON 对象字符串，追加/覆盖请求头 |
| `WEBHOOK_BODY` | 可选，JSON 对象模板，支持 `{title}` / `{content}` / `{text}` 占位符 |

只有 `FRP_USERNAME` / `FRP_PASSWORD` 是必填的，其余全是**可选**：
配了才启用对应渠道，一个都不配就只把结果打进 Actions 日志。

## 使用方式

### 1. Fork 仓库

把这个仓库 Fork 到你自己的 GitHub 账号。

### 2. 配置 Secrets

至少配置：

- `FRP_USERNAME`
- `FRP_PASSWORD`

推送渠道**至少要配一个**，否则签到了也不知道结果。可以同时配置多个，
脚本会并发发送同一份内容；未配置的渠道自动跳过，单个渠道失败也不影响其它渠道和签到结果。

**已支持的渠道（配对应变量即启用）**

| 渠道 | 需要的 Secrets | 备注 |
| --- | --- | --- |
| PushDeer | `SENDKEY` | [pushdeer.com](https://pushdeer.com) 自建或官方服务 |
| Server酱 | `SERVERCHAN_KEY` | Server酱³ 的 SendKey |
| Telegram | `TG_BOT_TOKEN` + `TG_CHAT_ID` | 两个都要配，缺一个就跳过 |
| PushPlus | `PUSHPLUS_TOKEN`（+ 可选 `PUSHPLUS_CHANNEL`） | 可转发到微信服务号 |
| 钉钉机器人 | `DINGTALK_WEBHOOK`（+ 可选 `DINGTALK_SECRET`） | 开启加签时必填 secret |
| 飞书机器人 | `FEISHU_WEBHOOK`（+ 可选 `FEISHU_SECRET`） | 同上 |
| 企业微信机器人 | `WECOM_BOT_WEBHOOK` | 群机器人 Webhook 地址 |
| 云湖机器人 | `YUNHU_TOKEN` + `YUNHU_RECV_ID` | `YUNHU_RECV_TYPE` 默认 `group` |
| Bark | `BARK_KEY`（+ 可选 `BARK_SERVER` / `BARK_GROUP`） | iOS 推送 |
| WxPusher | `WXPUSHER_TOKEN` + `WXPUSHER_UIDS` 或 `WXPUSHER_TOPIC_IDS` | 两个接收人配置都没有时跳过 |
| 自定义 Webhook | `WEBHOOK_URL` | 增强项见下 |

**配置示例：Telegram**

- `TG_BOT_TOKEN` —— Telegram Bot token（找 @BotFather 创建机器人获得）
- `TG_CHAT_ID` —— 接收消息的 chat ID（可通过 @userinfobot 查询自己的 ID）

**配置示例：企业微信机器人**

在群里添加群机器人，复制 Webhook 地址填进 `WECOM_BOT_WEBHOOK` 即可：

```text
WECOM_BOT_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx
```

消息以 Markdown 形式发送，正文里的特殊字符会自动转义。

**配置示例：钉钉机器人（加签）**

```text
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx
DINGTALK_SECRET=SECxxxxxxxx
```

只填 `DINGTALK_WEBHOOK` 也能发（机器人未开启加签时）；开启加签后必须同时填 secret，
脚本会自动追加 `timestamp` / `sign` 参数。

**配置示例：自定义 Webhook**

默认以 JSON 方式 POST 以下字段，HTTP 2xx 即视为成功：

```json
{ "title": "✅ 52frp签到成功", "content": "……", "text": "✅ 52frp签到成功\n\n……" }
```

想对接有固定请求体格式的服务，用 `WEBHOOK_BODY` 自定义（`{title}` / `{content}` / `{text}`
三个占位符会被替换，换行和引号会正确转义）：

```text
WEBHOOK_URL=https://example.com/notify
WEBHOOK_METHOD=POST
WEBHOOK_CONTENT_TYPE=json
WEBHOOK_HEADERS={"Authorization":"Bearer xxxx"}
WEBHOOK_BODY={"msgtype":"text","text":{"content":"{text}"}}
```

> 微信本身不提供个人消息接口，所以「推送到微信」走的是 PushPlus / WxPusher 这类第三方转发服务：
> 在 pushplus.plus 用微信扫码登录拿到 token，再由它把消息转发到你的微信服务号。

### 推送的容错与调优

- 每个渠道单独带超时（`PUSH_TIMEOUT_MS`，默认 15s），只对网络异常 / 429 / 5xx 做指数退避重试
  （`PUSH_MAX_RETRY`，默认 2 次）；4xx（key 写错之类）立即放弃
- 单个渠道失败只记日志，不影响其它渠道，也不会让签到运行标红
- 若希望「已配置的渠道全失败」时把这一步标红，配置 `PUSH_STRICT=1`
  （workflow 里走仓库 Variables：`PUSH_TIMEOUT_MS` / `PUSH_MAX_RETRY` / `PUSH_STRICT`）

## 推送内容格式

所有渠道共用同一份标题与正文，由 `src/notify/content.js` 统一拼装：

- **标题**：由签到结果首行推导，带状态前缀 —— `✅` 成功 / `🔄` 今日已签到 / `❌` 失败
- **正文**：执行时间（北京时间）、脱敏后的账号标识、签到结果详情（签到天数 / 本次获得 /
  剩余流量等），失败时附带失败原因与手动签到提醒

Telegram / PushDeer / Bark / WxPusher 这类只有单文本字段的渠道，按「标题 + 空行 + 正文」发送；
钉钉 / 飞书 / 企业微信以 Markdown 卡片发送。

```text
✅ 52frp签到成功

2026-09-25 11:15:00 (UTC+8)
👤 账号：tes***001
————————————

签到天数：42 天
本次获得：256.00MB
累计获得：12.50GB
剩余流量：100.99GB
```

### 3. 启用 GitHub Actions

进入仓库的 `Actions` 页面，启用工作流。

### 4. 运行

- 手动运行：`Actions` → `Daily 52frp Check-in` → `Run workflow`
- 定时运行：默认每天北京时间 **11:15** 执行

## 本地运行

```bash
# 复制环境变量模板
cp .env.example .env
# 编辑 .env 填入账号密码

node checkin-v2.js               # v2：API 直签优先，失败回退浏览器（推荐）
node checkin.js                  # v1：只用浏览器
```

或者直接：

```bash
FRP_USERNAME='your_username' FRP_PASSWORD='your_password' node checkin-v2.js
```

### 选择执行方式

`CHECKIN_STRATEGY`（或 CLI 参数 `--strategy=`）：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 方法A → 失败回退方法B |
| `api` | 只用方法A，失败就直接报失败（不启动浏览器） |
| `browser` | 只用方法B，等同 v1 行为 |
| `browser,api` | 自定义顺序 |

```bash
node checkin-v2.js --strategy=api       # 只验证方法A 通不通
node checkin-v2.js --strategy=browser   # 只验证方法B
```

GitHub Actions 手动运行时，workflow 的 `strategy` 下拉框可直接选这些值；
定时运行固定用 `auto`。

### 验证两条路径都通

```bash
# 1) 只跑方法A：看是否 success / already_signed，或给出明确的失败原因
node checkin-v2.js --strategy=api

# 2) 只跑方法B：确认浏览器方案仍然可用
node checkin-v2.js --strategy=browser

# 3) 跑完整回退链路（把方法A 逼失败，看是否自动切到方法B）：
#    临时把 FRP_PASSWORD 改错再跑 auto，方法A 会在登录环节失败并回退
node checkin-v2.js
```

方法A 是否可用，取决于 52frp 当时的风控状态。判断依据看日志：

```text
[调度] 「API 直签（方法A）」未成功：登录：站点要求滑块验证，纯 API 无法完成（…）
[调度] 继续尝试下一个方式...
```

出现这行说明方法A 被风控拦了、正在回退 —— 这是预期行为，不是 bug。

## 输出示例

脚本最后会输出一行 `CHECKIN_RESULT:`，其后直到输出末尾的所有内容会被 workflow 收集，
交给 `push_notification.js` 推送到所有已配置的渠道（标题、时间、账号标识由推送层补齐）。

本次运行完成签到：

```text
CHECKIN_RESULT: 52frp签到成功

签到天数：42 天
本次获得：256M
累计获得：12.5G
剩余流量：100.99G

签到方式：本次运行自动签到成功
```

今天已经签到过了（手动签到，或当天更早的一次运行已签到）：

```text
CHECKIN_RESULT: 52frp今日已签到（无需重复签到）

签到天数：42 天
本次获得：256M
累计获得：12.5G
剩余流量：100.99G

签到方式：本次运行前已完成（手动签到或当天更早的一次运行），脚本未重复签到
```

签到状态通过返回值区分：

- `status: success` —— 本次运行完成签到
- `status: already_signed` —— 本轮开始时就已签到，`details.signKind = 'already'`

v2 的推送里会多一行「执行方式」，说明这次是哪一种方式签上的：

```text
CHECKIN_RESULT: 52frp签到成功

签到方式：本次运行自动签到成功

签到天数：42 天
本次获得：256M
累计获得：12.5G
剩余流量：100.99G

执行方式：浏览器自动化（方法B）

备注：API 直签（方法A）失败后，回退到上述方式完成
```

若方法B 某一轮遇到站点/CDN 临时故障、靠后面几轮才成功，日志里会有 `[重试] 第 N 轮成功`。
全部方式都失败时，推送会列出每一种方式的失败原因，并提示手动签到。

## 签到状态的判定原则

判定「今天是否已签到」分两级证据，`src/browser.js` 的 `checkSignedToday()` 返回结果里带
`reliable` 字段：

**硬证据（reliable: true）** —— 可以下结论：

- 页面上的「上次签到」日期 == 今天 → 已签到
- 页面上的「上次签到」日期不是今天 → 未签到
- 页面明确写着「您今天已经签到过了」→ 已签到
- 「立即签到」按钮可见且可点击 → 未签到
- 签到接口明确返回「已签到 / 重复签到 / 签到成功 / 签到失败」→ 以接口为准

**软证据（reliable: false）** —— 只是**嫌疑**，不能据此跳过签到：

- 签到按钮被禁用
- 按钮不可见，但页面上出现「已签到」字样
- 页面上出现「签到成功」「恭喜获得」

之所以这么分，是因为踩过一个坑：脚本曾把页面上的「签到成功」当成"今天已签到"，
直接跳过点击，结果推送"已签到"但实际上根本没签 —— 而「签到成功」是**结果提示**，
页面没渲染完整、说明文案、历史记录都可能让它出现，它不是**状态证据**。

现在的策略是：只有硬证据才允许跳过点击；拿到软证据时照样点签到按钮，
由签到接口给出最终答案。点击之后，「本次运行前就已完成」也只认接口的说法
（点完按钮页面显示「已签到」本来就是本次点击造成的，不能反推成之前就签过）。

## 项目结构

```text
.
├── .github/workflows/daily-checkin.yml
├── checkin.js                # v1 入口：只用浏览器
├── checkin-v2.js             # v2 入口：多方式 + 自动回退（默认）
├── src/
│   ├── browser.js            # 方法B：浏览器签到核心模块
│   ├── config.js             # 账号配置读取（环境变量 / .env）+ 账号脱敏
│   ├── notify/
│   │   ├── index.js          # 推送层入口：按环境变量并发启用已配置渠道
│   │   ├── channels.js       # 各渠道实现 + 渠道注册表 PUSH_CHANNELS
│   │   ├── content.js        # 统一标题/正文（时间、账号脱敏、结果详情）
│   │   └── request.js        # 公共请求层：超时、重试、失败日志脱敏
│   └── checkin/
│       ├── index.js          # 统一签到层对外入口
│       ├── runner.js         # 调度器：按序尝试、失败回退、汇总原因
│       ├── result.js         # 统一返回结构 + 推送文案拼装
│       ├── api.js            # 方法A：纯 API 直签
│       └── browser.js        # 方法B 适配器（归一化返回值）
├── push_notification.js      # 推送 CLI 入口（workflow 调用的就是它）
├── .env.example
└── README.md
```

## 扩展新的签到方式

所有策略都实现同一个接口，注册进 `src/checkin/runner.js` 的 `STRATEGIES` 即可，
调度器和推送层不用改：

```js
const { STATUS, createResult } = require('./result');

// ctx: { username, password, timeoutMs, launchOptions, log, env }
async function runMyStrategy(ctx) {
  // 1. 每一步都要打日志
  ctx.log('[方法C] 开始...');

  // 2. 失败不要抛异常，返回统一结果（抛了调度器也会兜住，但原因会不清晰）
  return createResult({
    status: STATUS.SUCCESS,      // success | already_signed | error | skipped
    strategy: 'mine',
    message: '52frp签到成功',
    reason: null,                // 失败时给可读原因
    metrics: {                   // 取不到就留 null，推送层显示「未取到」
      totalSignDays: null,
      todayRewardBytes: null,
      totalRewardBytes: null,
      remainingBytes: null,
    },
    raw: {},                     // 原始证据，便于事后排查
  });
}
```

约定：

- 只有 `success` / `already_signed` 会被调度器认定为"这一天已经签到了"并终止流程
- `error` / `skipped` 会让调度器继续尝试下一个策略
- 结果里必须能回答"到底签上没签上"，不允许出现"请求发出去了但不知道成没成"就算成功

## 扩展新的推送渠道

渠道注册表是数据驱动的：在 `src/notify/channels.js` 里写一个函数，再往 `PUSH_CHANNELS` 加一行即可，
超时、重试、日志、失败隔离都由 `src/notify/request.js` 统一处理：

```js
async function pushMyChannel(title, content) {
  const key = readEnv('MY_CHANNEL_KEY');
  if (!key) return false;

  return pushRequest({
    name: '我的渠道',
    url: 'https://example.com/send',
    json: { key, text: formatPushText(title, content) },
    successCheck: (data) => data.code === 0,   // 什么叫成功
    failMsgKeys: ['message'],                  // 失败时从响应里取哪个字段做日志
  });
}

const PUSH_CHANNELS = [
  // ...
  { name: '我的渠道', env: ['MY_CHANNEL_KEY'], send: pushMyChannel },
];
```

约定：

- `env` 列出的变量**全部非空**才启用该渠道，否则自动跳过（不会因半个配置报错）
- 函数只回答"请求体长什么样、什么算成功"，网络异常 / 超时 / 重试交给 `pushRequest`
- 函数名与渠道名保持一致，便于从日志定位
- 新增后记得把对应的 Secret 加进 `.github/workflows/daily-checkin.yml` 的
  `Send notifications` 步骤 —— Actions 只会透传显式列出的 secret

## 复用方法A 的注意事项

**依赖**

- 只需要 Node 18+（用到内置 `fetch` 和 `Headers.getSetCookie()`），**不新增任何 npm 依赖**
- 不需要浏览器，方法A 成功时完全不加载 Playwright（`require('../browser')` 是惰性的）
- 方法B 仍然需要 `npm ci` + Playwright Chromium

**请求频率限制**

- 52frp 签到每天只有 1 次，重复提交会撞上"签到次数超限"；因此方法A 在提交签到这一步**不做重试**，
  且签到前先查 `sign/info`，已签到就直接返回、不再提交
- 一次完整的方法A 会发出 6～7 个请求。每天只跑一次，量级很小；但**不要**为了"提高成功率"
  反复手动触发，同一天多次触发会消耗站点额度并可能触发风控
- 撞到 429 /「已达上限」时，日志会明确标注 `rate-limit`，此时当天再试也没意义

**合规风险**

- 这是**本人账号**的自动化签到，账号密码只存在 GitHub Secrets，不要写进代码或日志
  （日志里账号已做脱敏，密码全程不打印）
- 站点侧有反爬/风控是正常的商业行为，脚本只在每天一次的频率下模拟手工操作，
  不做高频轮询、不抓取数据、不批量注册账号
- 方法A 通过伪造 Chrome 的请求头（UA / `Sec-Ch-Ua` / `Sec-Fetch-*`）贴近真实浏览器行为，
  这一点从 Cloudflare Worker 迁移到 GitHub Actions 后依然成立；
  若站点后续加强校验，方法A 会稳定失败 —— 这正是要保留方法B 兜底的原因
- 若站点服务条款明确禁止自动化访问，请自行评估后再启用

## 开发

首次运行前需要安装 Playwright：

```bash
npm install
npx playwright install chromium
```

## License

MIT