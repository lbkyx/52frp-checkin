'use strict';

/**
 * 推送请求的公共层。
 *
 * 之所以抽这一层：十几个推送渠道的 HTTP 调用长得都差不多，但「超时 / 重试 /
 * 成功判据 / 失败日志脱敏」这些事每个渠道都得做一遍，散在各处必然写得不一致。
 * 渠道实现只负责回答两件事——请求体长什么样、什么样的响应算成功——其余统一在这里处理。
 *
 * 容错约定（保证推送不拖累签到主流程）：
 *   - 任何异常都在本文件内收敛成 false，绝不向上抛；
 *   - 只有网络异常、429、5xx 才重试，4xx（key 写错之类）立即放弃，不做无意义重试；
 *   - 单个请求带硬超时，避免某个渠道挂死拖垮整轮推送。
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRY = 2;
const DEFAULT_RETRY_MIN_WAIT_MS = 1_000;
const DEFAULT_RETRY_MAX_WAIT_MS = 8_000;
const RESPONSE_LOG_LIMIT = 200;

/** 读取环境变量，去掉首尾空白；不存在返回兜底值 */
function readEnv(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  return value === '' ? fallback : value;
}

/** 读取数值型环境变量；非法值回退默认，避免出现 NaN 超时 */
function readNumber(name, fallback) {
  const raw = readEnv(name, '');
  if (raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBool(name, fallback = false) {
  const raw = readEnv(name, '').toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 截断响应文本再入日志：避免大段 HTML 或回显敏感信息的响应体刷屏 */
function truncate(text, limit = RESPONSE_LOG_LIMIT) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > limit ? `${value.slice(0, limit)}...(已截断)` : value;
}

function safeJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

/** 仅限流与服务端错误值得重试 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * fetch 的错误全都是 TypeError / DOMException，没有状态码可看，
 * 只能从错误名和常见网络错误码上判断是否值得重试。
 */
function isRetryableError(error) {
  if (!error) return false;
  const name = error.name || '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (error instanceof TypeError) return true; // fetch 的网络层错误
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed/i.test(
    error.message || ''
  );
}

function retryWait(attempt, maxRetry, minWait, maxWait) {
  if (attempt >= maxRetry) return null;
  return Math.min(minWait * 2 ** attempt, maxWait);
}

function pickFailMessage(data, failMsgKeys) {
  for (const key of failMsgKeys) {
    const value = data?.[key];
    if (value) return String(value);
  }
  return '';
}

/**
 * 发一次推送请求，返回是否成功（永不抛异常）。
 *
 * @param {object} options
 * @param {string} options.name        渠道名，只用于日志
 * @param {string} options.url         目标地址
 * @param {string} [options.method]    POST（默认）/ PUT
 * @param {object} [options.json]      JSON 请求体
 * @param {object} [options.form]      表单请求体（与 json 二选一）
 * @param {object} [options.headers]   额外请求头
 * @param {(data: object, response: Response) => boolean} [options.successCheck] 成功判据
 * @param {string[]} [options.failMsgKeys] 从响应里取失败说明的字段名，按序尝试
 */
async function pushRequest(options) {
  const {
    name,
    url,
    method = 'POST',
    json,
    form,
    headers,
    successCheck,
    failMsgKeys = ['message'],
  } = options;

  const timeoutMs = readNumber('PUSH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const maxRetry = readNumber('PUSH_MAX_RETRY', DEFAULT_MAX_RETRY);
  const minWait = readNumber('PUSH_RETRY_MIN_WAIT_MS', DEFAULT_RETRY_MIN_WAIT_MS);
  const maxWait = readNumber('PUSH_RETRY_MAX_WAIT_MS', DEFAULT_RETRY_MAX_WAIT_MS);

  const finalHeaders = { ...(headers || {}) };
  let body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    if (!hasHeader(finalHeaders, 'content-type')) {
      finalHeaders['Content-Type'] = 'application/json';
    }
  } else if (form !== undefined) {
    body = new URLSearchParams(form).toString();
    if (!hasHeader(finalHeaders, 'content-type')) {
      finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: finalHeaders,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await response.text();

      if (!response.ok) {
        const wait = retryWait(attempt, maxRetry, minWait, maxWait);
        if (wait !== null && isRetryableStatus(response.status)) {
          console.warn(
            `${name}: 推送失败 HTTP ${response.status}，${(wait / 1000).toFixed(1)}s 后重试（${attempt + 1}/${maxRetry}）`
          );
          await sleep(wait);
          continue;
        }
        console.warn(`${name}: 推送失败 HTTP ${response.status}${text ? ` ${truncate(text)}` : ''}`);
        return false;
      }

      const data = safeJson(text);
      let ok = false;
      try {
        ok = successCheck ? Boolean(successCheck(data, response)) : true;
      } catch (error) {
        console.warn(`${name}: 成功判据执行异常 ${error?.message || error}`);
        ok = false;
      }

      if (ok) {
        console.log(`${name}: 推送成功`);
        return true;
      }

      const failMsg = pickFailMessage(data, failMsgKeys) || truncate(text);
      console.warn(`${name}: 推送失败${failMsg ? ` ${failMsg}` : '（响应未给出原因）'}`);
      return false;
    } catch (error) {
      const wait = retryWait(attempt, maxRetry, minWait, maxWait);
      const reason = error?.message || String(error);
      if (wait !== null && isRetryableError(error)) {
        console.warn(
          `${name}: 推送异常 ${reason}，${(wait / 1000).toFixed(1)}s 后重试（${attempt + 1}/${maxRetry}）`
        );
        await sleep(wait);
        continue;
      }
      console.warn(`${name}: 推送异常 ${reason}`);
      return false;
    }
  }

  return false;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRY,
  DEFAULT_RETRY_MIN_WAIT_MS,
  DEFAULT_RETRY_MAX_WAIT_MS,
  RESPONSE_LOG_LIMIT,
  readEnv,
  readNumber,
  readBool,
  sleep,
  truncate,
  safeJson,
  isRetryableStatus,
  isRetryableError,
  pushRequest,
};
