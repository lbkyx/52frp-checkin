const test = require('node:test');
const assert = require('node:assert');

const {
  STATUS,
  createResult,
  isOkResult,
  buildNotice,
  formatTrafficCompact,
} = require('../src/checkin/result');
const { resolveOrder, runCheckin, STRATEGIES } = require('../src/checkin/runner');
const { classifyBrowserFailure, toMetrics } = require('../src/checkin/browser');

// ---- 测试用工具 ----

function noopLog() {}

const CREDENTIALS = { username: 'tester', password: 'secret' };

// ---- result.js ----

test('createResult 归一化指标并拒绝未知状态', () => {
  const ok = createResult({
    status: STATUS.SUCCESS,
    strategy: 'browser',
    message: 'ok',
    metrics: { totalSignDays: '12', todayRewardBytes: null },
  });

  assert.strictEqual(ok.status, 'success');
  assert.strictEqual(ok.metrics.totalSignDays, 12);
  assert.strictEqual(ok.metrics.todayRewardBytes, null);
  assert.strictEqual(ok.reason, null);

  assert.throws(() => createResult({ status: 'weird', message: 'x' }), /未知的签到状态/);
});

test('只有 success / already_signed 才算签到完成', () => {
  assert.ok(isOkResult({ status: STATUS.SUCCESS }));
  assert.ok(isOkResult({ status: STATUS.ALREADY }));
  assert.ok(!isOkResult({ status: STATUS.ERROR }));
  assert.ok(!isOkResult({ status: STATUS.SKIPPED }));
  assert.ok(!isOkResult(null));
});

test('formatTrafficCompact 缺值显示未取到', () => {
  assert.strictEqual(formatTrafficCompact(null), '未取到');
  assert.strictEqual(formatTrafficCompact(2.5 * 1024 ** 3), '2.50GB');
});

test('buildNotice 失败时列出原因，不静默', () => {
  const result = createResult({
    status: STATUS.ERROR,
    strategy: null,
    message: '52frp签到失败',
    reason: '所有方式均失败',
  });
  const notice = buildNotice(result, {
    attempts: [{ strategy: 'browser', status: 'error', reason: '执行超时' }],
    strategyLabels: { browser: '浏览器自动化' },
  });

  assert.ok(notice.includes('失败原因'));
  assert.ok(notice.includes('浏览器自动化'));
  assert.ok(notice.includes('请手动签到一次'));
});

// ---- runner.js ----

test('resolveOrder 一律归一为浏览器方式', () => {
  assert.deepStrictEqual(resolveOrder('auto'), ['browser']);
  assert.deepStrictEqual(resolveOrder(undefined), ['browser']);
  assert.deepStrictEqual(resolveOrder(''), ['browser']);
  assert.deepStrictEqual(resolveOrder('browser'), ['browser']);
  // 旧配置里残留的值必须被丢弃，而不是让整条链路跑空
  assert.deepStrictEqual(resolveOrder('api'), ['browser']);
  assert.deepStrictEqual(resolveOrder('browser,api'), ['browser']);
  assert.deepStrictEqual(resolveOrder('api,browser'), ['browser']);
});

test('浏览器方式成功即终止，不重复执行', async () => {
  let browserRuns = 0;

  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'auto',
    log: noopLog,
    strategies: {
      browser: {
        id: 'browser',
        label: 'B',
        run: async () => {
          browserRuns++;
          return createResult({ status: STATUS.SUCCESS, strategy: 'browser', message: 'ok' });
        },
      },
    },
  });

  assert.strictEqual(result.status, STATUS.SUCCESS);
  assert.strictEqual(result.strategy, 'browser');
  assert.strictEqual(browserRuns, 1);
  assert.strictEqual(result.usedFallback, false);
});

test('已签到时直接返回，不重复提交', async () => {
  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'browser',
    log: noopLog,
    strategies: {
      browser: {
        id: 'browser',
        label: 'B',
        run: async () =>
          createResult({
            status: STATUS.ALREADY,
            strategy: 'browser',
            message: 'ok',
            metrics: { totalSignDays: 14 },
          }),
      },
    },
  });

  assert.strictEqual(result.status, STATUS.ALREADY);
  assert.strictEqual(result.metrics.totalSignDays, 14);
  assert.strictEqual(result.usedFallback, false);
});

test('全部方式失败时汇总原因，不丢任何一条', async () => {
  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'auto',
    log: noopLog,
    strategies: {
      browser: {
        id: 'browser',
        label: 'B',
        run: async () => createResult({ status: STATUS.ERROR, strategy: 'browser', reason: '执行超时' }),
      },
    },
  });

  assert.strictEqual(result.status, STATUS.ERROR);
  assert.strictEqual(result.strategy, null);
  assert.match(result.reason, /执行超时/);
  assert.strictEqual(result.attempts.length, 1);
});

test('未知策略被跳过且不影响后续方式', async () => {
  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'sms,browser',
    log: noopLog,
    strategies: {
      browser: { id: 'browser', label: 'B', run: async () => createResult({ status: STATUS.ALREADY, strategy: 'browser' }) },
    },
  });

  assert.strictEqual(result.status, STATUS.ALREADY);
  assert.strictEqual(result.attempts[0].status, STATUS.SKIPPED);
  assert.match(result.attempts[0].reason, /未注册/);
});

test('策略内部抛异常不会拖垮调度', async () => {
  const result = await runCheckin({
    ...CREDENTIALS,
    order: 'browser',
    log: noopLog,
    strategies: {
      browser: {
        id: 'browser',
        label: 'B',
        run: async () => {
          throw new Error('boom');
        },
      },
    },
  });

  assert.strictEqual(result.status, STATUS.ERROR);
  assert.match(result.reason, /boom/);
  assert.match(result.attempts[0].reason, /boom/);
});

test('默认策略注册表只剩 browser', () => {
  assert.deepStrictEqual(Object.keys(STRATEGIES), ['browser']);
  assert.strictEqual(typeof STRATEGIES.browser.run, 'function');
});

// ---- browser.js 适配器 ----

test('浏览器结果映射成统一结构', () => {
  const metrics = toMetrics({
    signStats: { totalSignDays: 16, totalRewardBytes: 3 * 1024 ** 3 },
    dashboardStats: { todayRewardBytes: 250 * 1024 ** 2, remainingBytes: 11 * 1024 ** 3 },
  });

  assert.deepStrictEqual(metrics, {
    totalSignDays: 16,
    totalRewardBytes: 3 * 1024 ** 3,
    todayRewardBytes: 250 * 1024 ** 2,
    remainingBytes: 11 * 1024 ** 3,
  });
});

test('浏览器失败原因分类', () => {
  assert.strictEqual(classifyBrowserFailure(Object.assign(new Error('Cannot find module playwright'), {})).kind, 'dependency');
  assert.strictEqual(classifyBrowserFailure(Object.assign(new Error('登录失败：账号密码错误'), { kind: 'credentials' })).kind, 'auth');
  assert.strictEqual(classifyBrowserFailure(Object.assign(new Error('页面结构变化'), { kind: 'structure' })).kind, 'structure');
  assert.strictEqual(classifyBrowserFailure(new Error('something else')).kind, 'unknown');
});
