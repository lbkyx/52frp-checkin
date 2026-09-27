'use strict';

/**
 * 签到调度器：按配置的顺序依次尝试各个签到方法，第一个"成功/已签到"的结果即终止。
 *
 * 目前只保留浏览器自动化一种方式。曾经还有「方法A 纯 API 直签」作为首选，
 * 但它已于 2026-09-27 移除：站点对非浏览器发起的请求一律要求滑块验证
 * （`GET /api/user/slider-token` 恒定返回「请在签到时重新获取验证」），
 * 实测 GitHub Actions（美国）与香港服务器都是同样结果 —— 风控认的是
 * "非浏览器特征"，与出口地域无关，纯 API 在任何环境都签不上。
 * 保留调度器结构是为了未来若站点放宽策略，可以低成本加回新方式。
 *
 * 设计要点：
 * 1. 策略之间彼此独立，任一策略失败都不会中断整个流程（失败只是换下一种方式）；
 * 2. 每个策略必须返回统一结构（见 result.js），不允许抛异常穿过调度器；
 * 3. 每个尝试都留痕（耗时 + 原因），全部失败时把这些痕迹汇总成一条可读原因，
 *    杜绝静默失败。
 */

const { STATUS, createResult, isOkResult } = require('./result');
const { runBrowserCheckIn } = require('./browser');

const STRATEGIES = {
  browser: {
    id: 'browser',
    label: '浏览器自动化',
    run: runBrowserCheckIn,
  },
};

const DEFAULT_ORDER = ['browser'];

/**
 * 解析执行顺序配置。
 *   auto / 空           默认：浏览器自动化
 *   browser             显式只用浏览器
 *   含 api 的旧配置      自动丢弃 api（方法A 已移除），不至于让整条链路跑空
 */
function resolveOrder(raw) {
  const input = String(raw ?? 'auto').trim().toLowerCase();
  if (!input || input === 'auto' || input === 'a+b' || input === 'both') return [...DEFAULT_ORDER];

  const parts = input
    .split(/[,;+\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== 'api');

  if (parts.length === 0) return [...DEFAULT_ORDER];

  // 去重但保留顺序
  return [...new Set(parts)];
}

async function runCheckin(options = {}) {
  const {
    username,
    password,
    order = 'auto',
    timeoutMs,
    launchOptions,
    strategies = STRATEGIES,
    log = (...args) => console.log(...args),
    env = process.env,
  } = options;

  const sequence = resolveOrder(order);
  const attempts = [];

  log(`[调度] 执行顺序：${sequence.map((id) => strategies[id]?.label || `${id}(未知)`).join(' → ')}`);

  for (const id of sequence) {
    const strategy = strategies[id];

    if (!strategy || typeof strategy.run !== 'function') {
      const reason = `未注册的签到方法: ${id}`;
      log(`[调度] ${reason}，跳过`);
      attempts.push({ strategy: id, status: STATUS.SKIPPED, reason, durationMs: 0 });
      continue;
    }

    log('');
    log(`===== 尝试：${strategy.label} =====`);
    const startedAt = Date.now();

    let result;
    try {
      result = await strategy.run({ username, password, timeoutMs, launchOptions, log, env });
    } catch (error) {
      // 策略实现不应抛异常；这里兜底，保证一个策略崩溃不会拖垮整个调度
      result = createResult({
        status: STATUS.ERROR,
        strategy: id,
        message: '52frp签到失败',
        reason: `${strategy.label} 内部异常：${error?.message || error}`,
        raw: { kind: 'crash' },
      });
      log(`[调度] ${strategy.label} 内部异常：${error?.message || error}`);
    }

    const durationMs = Date.now() - startedAt;
    attempts.push({
      strategy: id,
      status: result.status,
      reason: result.reason,
      durationMs,
    });

    log(`[调度] ${strategy.label} 结束：${result.status}（耗时 ${Math.round(durationMs / 1000)}s）`);

    if (isOkResult(result)) {
      const failedBefore = attempts.filter((a) => a.status === STATUS.ERROR);
      if (failedBefore.length > 0) {
        log(`[调度] 前 ${failedBefore.length} 种方式失败，最终由「${strategy.label}」完成`);
      }
      return { ...result, attempts, usedFallback: failedBefore.length > 0 };
    }

    log(`[调度] 「${strategy.label}」未成功：${result.reason || result.status}`);

    if (attempts.length < sequence.length) {
      log('[调度] 继续尝试下一个方式...');
    }
  }

  // 全部失败：把每一步的原因拼成一条可读汇总
  const reasonParts = attempts.map((a) => {
    const label = strategies[a.strategy]?.label || a.strategy;
    return `【${label}】${a.reason || a.status}`;
  });

  return {
    ...createResult({
      status: STATUS.ERROR,
      strategy: null,
      message: '52frp签到失败',
      reason: `所有方式均失败：${reasonParts.join('；')}`,
      raw: { attempts },
    }),
    attempts,
    usedFallback: true,
  };
}

module.exports = {
  runCheckin,
  resolveOrder,
  STRATEGIES,
  DEFAULT_ORDER,
};
