const test = require('node:test');
const assert = require('node:assert');

const {
  sendNotification,
  buildPushContent,
  buildTitle,
  buildContent,
  PUSH_CHANNELS,
} = require('../src/notify');
const {
  pushPlus,
  pushTelegram,
  pushDingTalk,
  pushWebhook,
  pushWxPusher,
} = require('../src/notify/channels');

// ---- 测试用工具 ----

/** 所有推送相关的环境变量名，测试前统一清掉，避免本地环境串味 */
const PUSH_ENV_NAMES = [
  ...new Set(PUSH_CHANNELS.flatMap((channel) => channel.env)),
  'PUSHPLUS_CHANNEL',
  'DINGTALK_SECRET',
  'FEISHU_SECRET',
  'YUNHU_RECV_TYPE',
  'BARK_SERVER',
  'BARK_GROUP',
  'WXPUSHER_UIDS',
  'WXPUSHER_TOPIC_IDS',
  'WEBHOOK_METHOD',
  'WEBHOOK_CONTENT_TYPE',
  'WEBHOOK_HEADERS',
  'WEBHOOK_BODY',
  'FRP_USERNAME',
  'PUSH_TIMEOUT_MS',
  'PUSH_MAX_RETRY',
  'PUSH_RETRY_MIN_WAIT_MS',
  'PUSH_RETRY_MAX_WAIT_MS',
];

function clearPushEnv() {
  for (const name of PUSH_ENV_NAMES) delete process.env[name];
}

async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** 静音推送日志，让测试输出只保留断言失败信息 */
function silenceLogs() {
  const original = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  return () => {
    console.log = original.log;
    console.warn = original.warn;
  };
}

/**
 * 替换全局 fetch。
 * handler 返回 {status, text} 描述响应，或直接抛异常模拟网络错误。
 */
function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const result = await handler(String(url), init, calls.length);
    if (result && typeof result === 'object' && 'status' in result) {
      const text = result.text ?? '';
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        text: async () => text,
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(result ?? {}) };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const SUCCESS_MESSAGE = [
  '52frp签到成功',
  '',
  '签到天数：42 天',
  '本次获得：256.00MB',
  '剩余流量：100.99GB',
].join('\n');

const FAIL_MESSAGE = ['52frp签到失败', '', '失败原因：登录超时', '', '请手动签到一次，避免断签'].join('\n');

// ---- 统一推送内容 ----

test('buildPushContent: 成功结果生成标题与正文', () => {
  const { title, content } = buildPushContent(SUCCESS_MESSAGE, {
    username: 'testuser001',
    now: new Date('2026-09-25T03:15:00Z'),
  });

  assert.match(title, /^✅ 52frp签到成功$/);
  assert.match(content, /2026-09-25 11:15:00 \(UTC\+8\)/); // 时间按北京时间展示
  assert.match(content, /👤 账号：tes\*\*\*001/); // 账号脱敏
  assert.match(content, /签到天数：42 天/);
  assert.match(content, /剩余流量：100\.99GB/);
  assert.ok(!content.includes('52frp签到成功')); // 首行已作为标题，正文不重复
});

test('buildPushContent: 失败结果带 ❌ 且保留失败原因', () => {
  const { title, content } = buildPushContent(FAIL_MESSAGE, { username: 'abc' });
  assert.match(title, /^❌ 52frp签到失败$/);
  assert.match(content, /失败原因：登录超时/);
  assert.match(content, /请手动签到一次/);
});

test('buildPushContent: 已签到用 🔄，v1 的 error: 前缀也能识别', () => {
  assert.match(buildTitle('52frp今日已签到（无需重复签到）'), /^🔄/);
  assert.match(buildTitle('error:登录超时'), /^❌ 52frp 登录超时$/);
});

test('buildPushContent: 账号缺失或未配置时显示「未配置」而不是 undefined', async () => {
  assert.match(buildContent(SUCCESS_MESSAGE, { username: '' }), /👤 账号：未配置/);
  await withEnv({ FRP_USERNAME: undefined }, () => {
    assert.match(buildContent(SUCCESS_MESSAGE), /👤 账号：未配置/);
  });
});

test('buildPushContent: 空消息不崩且有兜底标题', () => {
  const { title, content } = buildPushContent('');
  assert.match(title, /52frp 自动签到通知/);
  assert.match(content, /未收到签到结果内容/);
});

// ---- 渠道启用与隔离 ----

test('sendNotification: 未配置任何渠道时跳过且不抛异常', async () => {
  clearPushEnv();
  const restore = silenceLogs();
  try {
    const summary = await sendNotification(SUCCESS_MESSAGE);
    assert.equal(summary.configured, 0);
    assert.equal(summary.success, 0);
    assert.equal(summary.allFailed, false);
    assert.equal(summary.results.length, PUSH_CHANNELS.length);
    assert.ok(summary.results.every((r) => r.enabled === false));
  } finally {
    restore();
  }
});

test('sendNotification: 只启用已配置的渠道，未配置的跳过', async () => {
  const fetchMock = mockFetch(() => ({ code: 200 }));
  const restore = silenceLogs();
  try {
    await withEnv({ PUSHPLUS_TOKEN: 'pk', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      const summary = await sendNotification(SUCCESS_MESSAGE);
      const enabled = summary.results.filter((r) => r.enabled).map((r) => r.name);
      assert.deepEqual(enabled, ['PushPlus']);
      assert.equal(summary.success, 1);
      assert.equal(fetchMock.calls.length, 1);
    });
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('sendNotification: 单渠道失败不影响其它渠道，也不向上抛', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('api.telegram.org')) throw new TypeError('fetch failed');
    return { code: 200 };
  });
  const restore = silenceLogs();
  try {
    await withEnv(
      {
        TG_BOT_TOKEN: 'bot-token',
        TG_CHAT_ID: '123456',
        PUSHPLUS_TOKEN: 'pk',
        PUSH_MAX_RETRY: '0',
        PUSH_RETRY_MIN_WAIT_MS: '1',
      },
      async () => {
        const summary = await sendNotification(SUCCESS_MESSAGE);
        const byName = Object.fromEntries(summary.results.map((r) => [r.name, r]));
        assert.equal(byName.Telegram.ok, false);
        assert.equal(byName.PushPlus.ok, true);
        assert.equal(summary.configured, 2);
        assert.equal(summary.success, 1);
        assert.equal(summary.allFailed, false);
      }
    );
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('sendNotification: 多渠道同时启用时并发发送', async () => {
  const fetchMock = mockFetch(() => ({ code: 0 }));
  const restore = silenceLogs();
  try {
    await withEnv(
      { SENDKEY: 'deer', SERVERCHAN_KEY: 'sct', WEBHOOK_URL: 'https://example.com/hook', PUSH_RETRY_MIN_WAIT_MS: '1' },
      async () => {
        const summary = await sendNotification(SUCCESS_MESSAGE);
        assert.equal(summary.configured, 3);
        assert.equal(summary.success, 3);
        assert.equal(fetchMock.calls.length, 3);
      }
    );
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

// ---- 超时与重试 ----

test('pushRequest: 5xx 会重试，重试后成功即算成功', async () => {
  const fetchMock = mockFetch((_url, _init, nth) => (nth === 1 ? { status: 500, text: 'boom' } : { code: 200 }));
  const restore = silenceLogs();
  try {
    await withEnv({ PUSHPLUS_TOKEN: 'pk', PUSH_MAX_RETRY: '2', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      const ok = await pushPlus('t', 'c');
      assert.equal(ok, true);
      assert.equal(fetchMock.calls.length, 2);
    });
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('pushRequest: 4xx 不重试，直接失败', async () => {
  const fetchMock = mockFetch(() => ({ status: 400, text: 'bad token' }));
  const restore = silenceLogs();
  try {
    await withEnv({ PUSHPLUS_TOKEN: 'pk', PUSH_MAX_RETRY: '2', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      const ok = await pushPlus('t', 'c');
      assert.equal(ok, false);
      assert.equal(fetchMock.calls.length, 1);
    });
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('pushRequest: 设置了请求超时（AbortSignal.timeout）', async () => {
  let signal = null;
  const fetchMock = mockFetch((_url, init) => {
    signal = init.signal;
    return { code: 200 };
  });
  const restore = silenceLogs();
  try {
    await withEnv({ PUSHPLUS_TOKEN: 'pk', PUSH_TIMEOUT_MS: '1234', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      await pushPlus('t', 'c');
      assert.ok(signal, '应传入超时信号');
      assert.equal(signal.aborted, false);
    });
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

// ---- 各渠道请求体 ----

test('PushPlus: 请求体带 token/title/content，配置了 channel 才带 channel', async () => {
  const fetchMock = mockFetch(() => ({ code: 200 }));
  const restore = silenceLogs();
  try {
    await withEnv({ PUSHPLUS_TOKEN: 'pk', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      await pushPlus('标题', '正文');
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.token, 'pk');
      assert.equal(body.title, '标题');
      assert.equal(body.content, '正文');
      assert.equal(body.channel, undefined);
    });
    await withEnv({ PUSHPLUS_TOKEN: 'pk', PUSHPLUS_CHANNEL: 'wechat', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      fetchMock.calls.length = 0;
      await pushPlus('标题', '正文');
      assert.equal(JSON.parse(fetchMock.calls[0].init.body).channel, 'wechat');
    });
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('Telegram: 只支持单文本字段，标题与正文拼成一段', async () => {
  const fetchMock = mockFetch(() => ({ ok: true }));
  const restore = silenceLogs();
  try {
    await withEnv({ TG_BOT_TOKEN: 'bot', TG_CHAT_ID: '42', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      await pushTelegram('标题', '正文');
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.chat_id, '42');
      assert.equal(body.text, '标题\n\n正文');
      assert.match(fetchMock.calls[0].url, /api\.telegram\.org\/botbot\/sendMessage/);
    });
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('钉钉: 配置了 secret 会给 webhook 追加签名参数', async () => {
  const fetchMock = mockFetch(() => ({ errcode: 0 }));
  const restore = silenceLogs();
  try {
    await withEnv(
      { DINGTALK_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=x', DINGTALK_SECRET: 'SEC1', PUSH_RETRY_MIN_WAIT_MS: '1' },
      async () => {
        assert.equal(await pushDingTalk('标题', '正文'), true);
        const url = fetchMock.calls[0].url;
        assert.match(url, /timestamp=\d+/);
        assert.match(url, /sign=/);
        const body = JSON.parse(fetchMock.calls[0].init.body);
        assert.equal(body.msgtype, 'markdown');
      }
    );
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('自定义 Webhook: 支持模板请求体与自定义请求头', async () => {
  const fetchMock = mockFetch(() => ({}));
  const restore = silenceLogs();
  try {
    await withEnv(
      {
        WEBHOOK_URL: 'https://example.com/hook',
        WEBHOOK_METHOD: 'PUT',
        WEBHOOK_HEADERS: '{"Authorization":"Bearer t"}',
        WEBHOOK_BODY: '{"msgtype":"text","text":{"content":"{text}"}}',
        PUSH_RETRY_MIN_WAIT_MS: '1',
      },
      async () => {
        assert.equal(await pushWebhook('标题', '正文'), true);
        const call = fetchMock.calls[0];
        assert.equal(call.init.method, 'PUT');
        assert.equal(call.init.headers.Authorization, 'Bearer t');
        const body = JSON.parse(call.init.body);
        assert.equal(body.msgtype, 'text');
        assert.equal(body.text.content, '标题\n\n正文');
      }
    );
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('自定义 Webhook: 模板非法 JSON 时回退默认请求体而不是崩掉', async () => {
  const fetchMock = mockFetch(() => ({}));
  const restore = silenceLogs();
  try {
    await withEnv({ WEBHOOK_URL: 'https://example.com/hook', WEBHOOK_BODY: '{oops', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      assert.equal(await pushWebhook('标题', '正文'), true);
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.title, '标题');
      assert.equal(body.content, '正文');
    });
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('WxPusher: 缺少接收人配置时跳过推送且不发请求', async () => {
  const fetchMock = mockFetch(() => ({ code: 1000 }));
  const restore = silenceLogs();
  try {
    await withEnv({ WXPUSHER_TOKEN: 'at', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      assert.equal(await pushWxPusher('标题', '正文'), false);
      assert.equal(fetchMock.calls.length, 0);
    });
    await withEnv({ WXPUSHER_TOKEN: 'at', WXPUSHER_UIDS: 'UID_1, UID_2', PUSH_RETRY_MIN_WAIT_MS: '1' }, async () => {
      assert.equal(await pushWxPusher('标题', '正文'), true);
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.deepEqual(body.uids, ['UID_1', 'UID_2']);
      assert.equal(body.contentType, 1);
    });
  } finally {
    fetchMock.restore();
    restore();
    clearPushEnv();
  }
});

test('渠道注册表: 每个渠道都有名称、触发变量与发送函数', () => {
  for (const channel of PUSH_CHANNELS) {
    assert.ok(channel.name, '渠道缺少名称');
    assert.ok(Array.isArray(channel.env) && channel.env.length > 0, `${channel.name} 缺少触发变量`);
    assert.equal(typeof channel.send, 'function', `${channel.name} 缺少 send`);
  }
});
