'use strict';

/**
 * 各推送渠道的实现 + 渠道注册表。
 *
 * 约定：
 *   - 每个函数签名统一为 (title, content) => Promise<boolean>，未配置时返回 false；
 *   - 函数内部不 try/catch，异常交给 request.js 收敛、再由 index.js 兜底记录；
 *   - 新增渠道只需要在这里写一个函数，并往 PUSH_CHANNELS 里加一行。
 */

const crypto = require('node:crypto');

const { pushRequest, readEnv } = require('./request');
const { formatPushText } = require('./content');

/** 只支持单文本字段的渠道，统一用「标题 + 空行 + 正文」 */
function text(title, content) {
  return formatPushText(title, content);
}

/** 钉钉 / 飞书 / 企业微信的 Markdown 需要转义，否则正文里的 # * 等字符会破坏排版 */
function escapeMarkdown(value) {
  if (!value) return value;
  return String(value).replace(/([\\`*_{}[\]()#+\-.!>])/g, '\\$1');
}

// ---------------------------------------------------------------- PushDeer

async function pushDeer(title, content) {
  const key = readEnv('SENDKEY');
  if (!key) return false;

  return pushRequest({
    name: 'PushDeer',
    url: 'https://api2.pushdeer.com/message/push',
    json: { pushkey: key, text: text(title, content), type: 'text' },
    successCheck: (data) => data.code === 0,
    failMsgKeys: ['message', 'error'],
  });
}

// ---------------------------------------------------------------- Server酱

async function pushServerChan(title, content) {
  const key = readEnv('SERVERCHAN_KEY');
  if (!key) return false;

  return pushRequest({
    name: 'Server酱',
    url: `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`,
    form: { title, desp: content },
    successCheck: (data) => data.code === 0,
    failMsgKeys: ['message'],
  });
}

// ---------------------------------------------------------------- Telegram

const TELEGRAM_MAX_LENGTH = 4000;
const TELEGRAM_TRUNCATE_LENGTH = 3990;

async function pushTelegram(title, content) {
  const token = readEnv('TG_BOT_TOKEN');
  const chatId = readEnv('TG_CHAT_ID');
  if (!token || !chatId) return false;

  let message = text(title, content);
  if (message.length > TELEGRAM_MAX_LENGTH) {
    message = `${message.slice(0, TELEGRAM_TRUNCATE_LENGTH)}\n...`;
  }

  return pushRequest({
    name: 'Telegram',
    url: `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
    json: { chat_id: chatId, text: message },
    successCheck: (data) => data.ok === true,
    failMsgKeys: ['description'],
  });
}

// ---------------------------------------------------------------- PushPlus

async function pushPlus(title, content) {
  const token = readEnv('PUSHPLUS_TOKEN');
  if (!token) return false;

  const payload = {
    token,
    title,
    content,
    template: 'html',
  };

  // PUSHPLUS_CHANNEL 是老配置，继续沿用：不填就按 PushPlus 后台的默认渠道发
  const channel = readEnv('PUSHPLUS_CHANNEL');
  if (channel) payload.channel = channel;

  return pushRequest({
    name: 'PushPlus',
    url: 'https://www.pushplus.plus/send',
    json: payload,
    successCheck: (data) => data.code === 200,
    failMsgKeys: ['msg', 'message'],
  });
}

// ---------------------------------------------------------------- 钉钉机器人

async function pushDingTalk(title, content) {
  let webhookUrl = readEnv('DINGTALK_WEBHOOK');
  if (!webhookUrl) return false;

  const secret = readEnv('DINGTALK_SECRET');
  if (secret) {
    const timestamp = String(Date.now());
    const sign = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}\n${secret}`)
      .digest('base64');
    const separator = webhookUrl.includes('?') ? '&' : '?';
    webhookUrl = `${webhookUrl}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  } else {
    console.warn(
      '钉钉机器人: DINGTALK_WEBHOOK 已配置但 DINGTALK_SECRET 缺失，' +
        '将发送无签名请求（机器人若开启了加签校验会失败）'
    );
  }

  return pushRequest({
    name: '钉钉机器人',
    url: webhookUrl,
    json: {
      msgtype: 'markdown',
      markdown: {
        title: escapeMarkdown(title),
        text: `### ${escapeMarkdown(title)}\n\n${escapeMarkdown(content)}`,
      },
    },
    successCheck: (data) => data.errcode === 0,
    failMsgKeys: ['errmsg', 'message'],
  });
}

// ---------------------------------------------------------------- 飞书机器人

async function pushFeishu(title, content) {
  const webhookUrl = readEnv('FEISHU_WEBHOOK');
  if (!webhookUrl) return false;

  const payload = {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: escapeMarkdown(title) },
        template: 'blue',
      },
      elements: [{ tag: 'markdown', content: escapeMarkdown(content) }],
    },
  };

  const secret = readEnv('FEISHU_SECRET');
  if (secret) {
    // 飞书签名：以「时间戳\n密钥」为 key、空字符串为 message 做 HMAC-SHA256
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = crypto
      .createHmac('sha256', `${timestamp}\n${secret}`)
      .update('')
      .digest('base64');
  } else {
    console.warn(
      '飞书机器人: FEISHU_WEBHOOK 已配置但 FEISHU_SECRET 缺失，' +
        '将发送无签名请求（机器人若开启了加签校验会失败）'
    );
  }

  return pushRequest({
    name: '飞书机器人',
    url: webhookUrl,
    json: payload,
    successCheck: (data) => data.code === 0 || data.StatusCode === 0,
    failMsgKeys: ['msg', 'message'],
  });
}

// ---------------------------------------------------------------- 企业微信机器人

async function pushWecomBot(title, content) {
  const webhookUrl = readEnv('WECOM_BOT_WEBHOOK');
  if (!webhookUrl) return false;

  return pushRequest({
    name: '企业微信机器人',
    url: webhookUrl,
    json: {
      msgtype: 'markdown',
      markdown: { content: `### ${escapeMarkdown(title)}\n\n${escapeMarkdown(content)}` },
    },
    successCheck: (data) => data.errcode === 0,
    failMsgKeys: ['errmsg', 'message'],
  });
}

// ---------------------------------------------------------------- 云湖机器人

async function pushYunhu(title, content) {
  const token = readEnv('YUNHU_TOKEN');
  const recvId = readEnv('YUNHU_RECV_ID');
  if (!token || !recvId) return false;

  const recvType = readEnv('YUNHU_RECV_TYPE', 'group');
  if (recvType !== 'group' && recvType !== 'private') {
    console.warn(`云湖机器人: YUNHU_RECV_TYPE 值 '${recvType}' 非法，应为 group 或 private，使用默认值 group`);
  }

  return pushRequest({
    name: '云湖机器人',
    url: 'https://chat-go.jwzhd.com/open-apis/v1/bot/send-message',
    json: {
      token,
      recvId,
      recvType: recvType === 'private' ? 'private' : 'group',
      contentType: 1,
      content: `**${escapeMarkdown(title)}**\n\n${escapeMarkdown(content)}`,
    },
    successCheck: (data) => data.code === 1,
    failMsgKeys: ['msg', 'message'],
  });
}

// ---------------------------------------------------------------- Bark

async function pushBark(title, content) {
  const key = readEnv('BARK_KEY');
  if (!key) return false;

  const server = readEnv('BARK_SERVER', 'https://api.day.app').replace(/\/+$/, '');
  const payload = {
    title,
    body: content,
    isArchive: 1,
  };
  const group = readEnv('BARK_GROUP');
  if (group) payload.group = group;

  return pushRequest({
    name: 'Bark',
    url: `${server}/${encodeURIComponent(key)}`,
    json: payload,
    successCheck: (data) => data.code === 200,
    failMsgKeys: ['message'],
  });
}

// ---------------------------------------------------------------- WxPusher

function splitList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function pushWxPusher(title, content) {
  const token = readEnv('WXPUSHER_TOKEN');
  if (!token) return false;

  const uids = splitList(readEnv('WXPUSHER_UIDS'));
  const topicIds = splitList(readEnv('WXPUSHER_TOPIC_IDS')).map((id) => Number(id));

  if (uids.length === 0 && topicIds.length === 0) {
    console.warn('WxPusher: 需再配置 WXPUSHER_UIDS 或 WXPUSHER_TOPIC_IDS，否则服务端无法定位接收人，跳过推送');
    return false;
  }

  return pushRequest({
    name: 'WxPusher',
    url: 'https://wxpusher.zjiecode.com/api/send/message',
    json: {
      appToken: token,
      content: text(title, content),
      summary: title,
      contentType: 1,
      uids,
      topicIds,
    },
    successCheck: (data) => data.code === 1000,
    failMsgKeys: ['msg', 'message'],
  });
}

// ---------------------------------------------------------------- 自定义 Webhook

/**
 * 自定义 Webhook：通用兜底渠道，可对接任意自研 / 第三方服务。
 *
 * 默认以 JSON 方式 POST {"title", "content", "text"}，HTTP 2xx 即视为成功。
 * 可选增强（不配置就用默认行为）：
 *   WEBHOOK_METHOD        POST（默认）或 PUT
 *   WEBHOOK_CONTENT_TYPE  json（默认）或 form（表单编码）
 *   WEBHOOK_HEADERS       JSON 对象字符串，追加/覆盖请求头，如 {"Authorization":"Bearer xxx"}
 *   WEBHOOK_BODY          JSON 对象模板，支持 {title} / {content} / {text} 三个占位符，
 *                         用于适配钉钉、企业微信、Gotify 等有固定请求体格式的服务
 */
async function pushWebhook(title, content) {
  const url = readEnv('WEBHOOK_URL');
  if (!url) return false;

  const rawMethod = readEnv('WEBHOOK_METHOD', 'POST').toUpperCase();
  const method = rawMethod === 'PUT' ? 'PUT' : 'POST';
  if (method !== rawMethod) {
    console.warn(`自定义 Webhook: WEBHOOK_METHOD 值 '${rawMethod}' 非法，应为 POST 或 PUT，使用默认值 POST`);
  }

  const useForm = readEnv('WEBHOOK_CONTENT_TYPE', 'json').toLowerCase() === 'form';
  const headers = {};

  const rawHeaders = readEnv('WEBHOOK_HEADERS');
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(headers, Object.fromEntries(Object.entries(parsed).map(([k, v]) => [String(k), String(v)])));
      } else {
        console.warn('自定义 Webhook: WEBHOOK_HEADERS 不是 JSON 对象，已忽略');
      }
    } catch {
      console.warn('自定义 Webhook: WEBHOOK_HEADERS 解析失败（需为合法 JSON 对象），已忽略');
    }
  }

  let payload = {
    title,
    content,
    text: text(title, content),
  };

  const template = readEnv('WEBHOOK_BODY');
  if (template) {
    // 占位符替换为 JSON 字符串的内层（去首尾引号），保证换行/引号不破坏 JSON 结构
    let rendered = template;
    for (const [placeholder, value] of [
      ['{title}', title],
      ['{content}', content],
      ['{text}', text(title, content)],
    ]) {
      rendered = rendered.split(placeholder).join(JSON.stringify(value).slice(1, -1));
    }
    try {
      const parsed = JSON.parse(rendered);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed;
      } else {
        console.warn('自定义 Webhook: WEBHOOK_BODY 解析后不是 JSON 对象，已回退默认请求体');
      }
    } catch {
      console.warn('自定义 Webhook: WEBHOOK_BODY 解析失败（需为合法 JSON 对象），已回退默认请求体');
    }
  }

  return pushRequest({
    name: '自定义 Webhook',
    url,
    method,
    headers,
    ...(useForm ? { form: payload } : { json: payload }),
    successCheck: null, // 2xx 即成功
  });
}

// ---------------------------------------------------------------- 渠道注册表

/**
 * 数据驱动的渠道列表：新增渠道只改这一处。
 * 每项: { name, env, send }
 *   name —— 日志里的渠道名
 *   env  —— 全部非空才启用该渠道（缺任意一个就跳过，不会因半个配置而报错）
 *   send —— (title, content) => Promise<boolean>
 */
const PUSH_CHANNELS = [
  { name: 'PushDeer', env: ['SENDKEY'], send: pushDeer },
  { name: 'Server酱', env: ['SERVERCHAN_KEY'], send: pushServerChan },
  { name: 'Telegram', env: ['TG_BOT_TOKEN', 'TG_CHAT_ID'], send: pushTelegram },
  { name: 'PushPlus', env: ['PUSHPLUS_TOKEN'], send: pushPlus },
  { name: '钉钉机器人', env: ['DINGTALK_WEBHOOK'], send: pushDingTalk },
  { name: '飞书机器人', env: ['FEISHU_WEBHOOK'], send: pushFeishu },
  { name: '企业微信机器人', env: ['WECOM_BOT_WEBHOOK'], send: pushWecomBot },
  { name: '云湖机器人', env: ['YUNHU_TOKEN', 'YUNHU_RECV_ID'], send: pushYunhu },
  { name: 'Bark', env: ['BARK_KEY'], send: pushBark },
  { name: 'WxPusher', env: ['WXPUSHER_TOKEN'], send: pushWxPusher },
  { name: '自定义 Webhook', env: ['WEBHOOK_URL'], send: pushWebhook },
];

module.exports = {
  PUSH_CHANNELS,
  pushDeer,
  pushServerChan,
  pushTelegram,
  pushPlus,
  pushDingTalk,
  pushFeishu,
  pushWecomBot,
  pushYunhu,
  pushBark,
  pushWxPusher,
  pushWebhook,
  escapeMarkdown,
};
