/**
 * 纯浏览器签到模块 - 不调用任何 API
 *
 * 流程：
 * 1. 打开登录页，自动填账号密码
 * 2. 点击登录后检测滑块验证，自动完成滑块
 * 3. 登录成功后跳转签到页
 * 4. 点击"立即签到"按钮
 * 5. 检查签到结果并返回
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const LOGIN_PAGE = 'https://www.52frp.com/user/#/auth/login';
const SIGN_PAGE = 'https://www.52frp.com/user/#/welfare/sign';
const DASHBOARD_PAGE = 'https://www.52frp.com/user/#/dashboard/overview';
const DEFAULT_TIMEOUT_MS = 60_000;
const SIGN_DATE_TIMEZONE = 'Asia/Shanghai';

/**
 * 浏览器 profile 目录名（默认放在工作目录下）。
 *
 * 用持久化 profile 而不是每次 newContext() 的理由：
 * 签到页是 5MB 级的 Vue SPA，跨境链路上单是主 bundle 就要 6~10 秒，
 * 而且经常撞上 522/525。每次运行都从头下载等于每轮重新赌一次网络。
 * 持久化之后 cookie 与 HTTP 缓存都落在磁盘上 —— 只要成功加载过一次，
 * 之后再跑基本不再依赖网络，最大的失败面直接消失。
 */
const DEFAULT_PROFILE_DIR = '.browser-profile';

/** 会话复用判定：直接打开签到页后，等多久判断「已登录 / 被弹回登录页」 */
const SESSION_PROBE_TIMEOUT_MS = 25_000;

/** 会话判定期间的轮询间隔（ms） */
const SESSION_PROBE_POLL_MS = 500;

/** 单个失败资源的重试退避基数（ms）：第 n 次重试前等 n * 这个值 */
const ASSET_RETRY_BACKOFF_MS = 800;
const LOGIN_PAGE_RENDER_PATTERNS = [
  { source: '登录|账号|账户' },
  { source: 'Account\\s*Login', flags: 'i' },
  { source: 'Please enter (?:account|your password)', flags: 'i' },
  { source: 'Please slide to verify', flags: 'i' },
  { source: '\\bRemember password\\b', flags: 'i' },
  { source: '\\bForgot password\\b', flags: 'i' },
  { source: '\\bLogin\\b', flags: 'i' },
];

// ---------------------------------------------------------------------------
// 稳定性增强
//
// GitHub Actions 的 runner 位于海外机房，访问 52frp 国内的 CDN 边缘节点时
// 经常撞上分钟级的回源故障（522 / 524 / 525）。一旦 JS bundle 拉取失败，
// SPA 就没有可执行的代码，页面全白（body 文本长度 = 0）。
//
// 应对思路不是让单次请求变得更强，而是：
//   1) 在一次运行内多来几轮，每轮都是全新的浏览器实例（New browser per round）
//   2) 尽早识别回源故障，别傻等到超时
//   3) 砍掉与签到无关的第三方请求，缩小失败面
// ---------------------------------------------------------------------------

/** CDN / 源站回源类错误码：命中即可判定为「站点侧故障，可自愈」 */
const UPSTREAM_ERROR_CODES = [
  500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530,
];

/** 登录页：单轮内的重试次数与退避序列（ms） */
const LOGIN_PAGE_MAX_ATTEMPTS = 3;
const LOGIN_PAGE_BACKOFF_MS = [0, 6_000, 12_000];
const LOGIN_GOTO_ATTEMPTS = 2;

/** 登录页：各项等待的上限（ms）。刻意收紧，把时间留给「整轮重来」 */
const LOGIN_GOTO_TIMEOUT_MS = 30_000;
const LOGIN_NETWORKIDLE_TIMEOUT_MS = 15_000;
const LOGIN_RENDER_TIMEOUT_MS = 20_000;

/** 渲染检测的轮询间隔（ms） */
const LOGIN_RENDER_POLL_MS = 500;

/** 每轮完整流程之间的间隔（ms）：给源站留出恢复时间 */
const ROUND_BACKOFF_MS = [45_000, 75_000];

/** 与签到无关、却要跨洋请求的第三方资源 */
const THIRD_PARTY_HOST_PATTERNS = [
  /^api\.iconify\.design$/i,
  /^api\.unisvg\.com$/i,
  /^api\.simplesvg\.com$/i,
  /^fonts\.googleapis\.com$/i,
  /^fonts\.gstatic\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)clarity\.ms$/i,
  /(^|\.)baidu\.com$/i,
  /(^|\.)bdstatic\.com$/i,
  /(^|\.)yandex\.(ru|com)$/i,
];

/** 无论什么模式都放行的域名（含同源） */
const FIRST_PARTY_HOST_PATTERNS = [
  /(^|\.)52frp\.com$/i,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 第三方资源屏蔽模式：off | safe（默认）| strict */
function resolveBlockThirdPartyMode() {
  const raw = (process.env.FRP_BLOCK_THIRD_PARTY || 'safe').trim().toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'strict' || raw === 'whitelist') return 'strict';

  return 'safe';
}

function isUpstreamError(status) {
  return UPSTREAM_ERROR_CODES.includes(Number(status));
}

function getUrlHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null; // data: / blob: 等非标准地址
  }
}

/** host + pathname，用于日志/报错里定位具体是哪个资源挂在回源上（不带 query，避免刷屏） */
function getUrlPath(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return String(rawUrl || '');
  }
}

function shouldBlockUrl(rawUrl, mode) {
  if (mode === 'off') return false;

  const host = getUrlHost(rawUrl);
  if (!host) return false; // 解析不了的一律放行，避免误伤

  if (FIRST_PARTY_HOST_PATTERNS.some((re) => re.test(host))) return false;
  if (mode === 'strict') return true; // 严格模式：非 52frp 域名一律拦

  return THIRD_PARTY_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * 屏蔽与签到无关的第三方资源，并对已知失败过的同源资源做**单资源重试**。
 *
 * 为什么要做单资源重试：一个页面要加载几十个资源，跨境链路上每个都有
 * 10~30% 的概率撞上 522，于是「全部成功」的概率低到几乎不可能
 * （0.7^30 ≈ 0.02%）。整页重载对这个问题毫无帮助 —— 它把已经成功的资源
 * 也一起重来了，失败的那几个照样靠运气。
 *
 * 改成对每个失败资源单独重试 3 次后，单资源失败率降到 0.3^4 ≈ 0.8%，
 * 整页成功率回到 0.992^30 ≈ 79%。这是数量级的差别。
 *
 * @param {page} page
 * @param {'off'|'safe'|'strict'} mode
 * @param {{ badAssets?: Set<string> }} [options]
 *   badAssets：本次运行内返回过 5xx 的 URL 集合（跨 attempt 累积，不清理）。
 *   命中时不再走浏览器缓存，而是主动重取并重试；没命中的请求照常 continue，
 *   让缓存该生效的生效。
 */
async function installResourceBlocker(page, mode, { badAssets = null } = {}) {
  const blocked = { count: 0 };
  const retried = { count: 0, fixed: 0 };
  const retryLimit = resolveEnvInt('FRP_ASSET_RETRY', 3);

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (mode !== 'off' && shouldBlockUrl(url, mode)) {
      blocked.count += 1;
      route.abort().catch(() => {});
      return;
    }

    // 只对「同源 + GET + 之前 5xx 过」的资源做重试，其余走正常缓存
    const retryable = (
      badAssets
      && badAssets.size > 0
      && badAssets.has(url)
      && retryLimit > 0
      && request.method() === 'GET'
      && FIRST_PARTY_HOST_PATTERNS.some((re) => re.test(getUrlHost(url) || ''))
    );

    if (!retryable) {
      route.continue().catch(() => {});
      return;
    }

    let response = null;
    let attempts = 0;

    for (let i = 0; i <= retryLimit; i++) {
      if (i > 0) await sleep(ASSET_RETRY_BACKOFF_MS * i);
      attempts = i + 1;

      try {
        response = await route.fetch();
        if (!isUpstreamError(response.status())) break;
      } catch {
        response = null; // 网络层直接失败，继续重试
      }
    }

    retried.count += 1;

    if (!response) {
      // 重试全部失败：如实交给浏览器，让它记录成资源错误（ diagnosis 需要）
      route.abort().catch(() => {});
      return;
    }

    if (!isUpstreamError(response.status())) {
      retried.fixed += 1;
      console.log(`[网络] 重取成功 (第 ${attempts} 次): ${getUrlPath(url)}`);
    }

    await route.fulfill({ response }).catch(() => {});
  });

  if (mode === 'off') {
    console.log('[网络] 第三方资源屏蔽：已关闭');
  } else {
    console.log(`[网络] 第三方资源屏蔽：已启用 (mode=${mode})`);
  }

  console.log(`[网络] 失败资源自动重试：已启用（每个最多重试 ${retryLimit} 次）`);

  page.once('close', () => {
    if (blocked.count > 0) {
      console.log(`[网络] 本轮共拦截 ${blocked.count} 个第三方请求`);
    }
    if (retried.count > 0) {
      console.log(`[网络] 本轮重取 ${retried.count} 个失败资源，救回 ${retried.fixed} 个`);
    }
  });
}

/**
 * 设置 HTTP 缓存开关（默认启用）。
 *
 * 启用后静态资源会随持久化 profile 落到磁盘，下一次运行可以直接命中本地缓存，
 * 不再依赖那条经常 522 的跨境链路。
 */
async function configureHttpCache(context, page) {
  const cacheEnabled = resolveCacheEnabled();

  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: !cacheEnabled });
    console.log(`[网络] HTTP 缓存：${cacheEnabled ? '已启用（随 profile 持久化，跨运行复用）' : '已关闭'}`);
    return true;
  } catch (error) {
    console.log(`[网络] 无法通过 CDP 设置缓存（${error.message}），使用浏览器默认行为`);
    return false;
  }
}

function isLoginPageRenderedText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 20) return false;

  return LOGIN_PAGE_RENDER_PATTERNS.some(({ source, flags = '' }) => (
    new RegExp(source, flags).test(normalized)
  ));
}

/**
 * 轮询等待登录页渲染完成。
 *
 * 相比旧的 `page.waitForFunction`：
 * - 一旦检测到回源错误立刻返回，不再白等到超时（旧版每次傻等 25s）
 * - 文案没命中时，退化为检查账号/密码输入框是否存在（兜底判据，抗改版）
 */
async function waitForLoginPageRendered(page, { timeoutMs, upstreamErrors }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (upstreamErrors && upstreamErrors.length > 0) {
      return { rendered: false, abortedByUpstream: true };
    }

    try {
      const textMatched = await page.evaluate((patterns) => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length <= 20) return false;

        return patterns.some(({ source, flags = '' }) => (
          new RegExp(source, flags).test(text)
        ));
      }, LOGIN_PAGE_RENDER_PATTERNS);

      if (textMatched) return { rendered: true };

      // 兜底：文案改了没关系，只要登录表单的结构在，就认为页面已经可用
      const inputs = await page.evaluate(() => ({
        password: document.querySelectorAll('input[type="password"]').length,
        others: document.querySelectorAll('input:not([type="password"])').length,
      }));

      if (inputs.password > 0 && inputs.others > 0) {
        console.log('[页面] 文案未命中，但已存在账号/密码输入框 → 兜底判定为已渲染');
        return { rendered: true, viaFallback: true };
      }
    } catch {
      // 页面正在导航，evaluate 会抛错，下一轮轮询再来
    }

    await sleep(LOGIN_RENDER_POLL_MS);
  }

  return { rendered: false };
}

/**
 * 判断当前落在哪个视图：签到页（说明登录态有效）/ 登录页（需要账号密码）/ 未知。
 *
 * 站点是 hash 路由 SPA：`/user/#/welfare/sign` 和 `/user/#/auth/login`
 * 请求的是同一份 HTML，Vue 按 hash 决定渲染什么。所以直接打开签到页时，
 * 登录态有效就直接渲染签到页，无效会被前端路由守卫弹回登录页 —— 这个差别
 * 就是"cookie 还能不能用"的答案，不需要额外发请求去探测。
 *
 * @returns {Promise<{view: 'sign'|'login'|'unknown', abortedByUpstream?: boolean}>}
 */
async function waitForAppView(page, { timeoutMs = SESSION_PROBE_TIMEOUT_MS, upstreamErrors = null } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (upstreamErrors && upstreamErrors.length > 0) {
      return { view: 'unknown', abortedByUpstream: true };
    }

    try {
      const state = await page.evaluate(() => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        return {
          url: window.location.href,
          textLength: text.length,
          // 「立即签到」按钮：未签到时才在
          hasSignButton: [...document.querySelectorAll('button')].some((b) =>
            /立即\s*(?:签到|Check-in)/i.test(String(b.textContent || '').trim())
          ),
          // 「上次签到：2026-09-27」这类字段：签到页骨架的一部分，已签到时也在
          hasLastSignField: /上次(?:签到|Check-in)\s*[:：]?\s*\d/i.test(text),
          hasPasswordInput: document.querySelectorAll('input[type="password"]').length > 0,
        };
      });

      // 被弹回登录页，或登录表单已经渲染出来 —— 都说明登录态没了
      if (state.url.includes('/auth/login') || state.hasPasswordInput) {
        return { view: 'login' };
      }

      // 签到页的硬特征
      if (state.hasSignButton || state.hasLastSignField) {
        return { view: 'sign' };
      }

      // 停在签到路由上且页面确实渲染出了内容（不是骨架屏那点字数）→ 判为已登录。
      // 阈值取 200：骨架屏/导航栏撑不到这个长度，真正的内容页才有。
      if (state.url.includes('/welfare/sign') && state.textLength > 200) {
        return { view: 'sign', viaTextLength: true };
      }
    } catch {
      // 页面正在导航，evaluate 会抛错，下一轮轮询再来
    }

    await sleep(SESSION_PROBE_POLL_MS);
  }

  return { view: 'unknown' };
}

/** 等登录表单真正可填（密码输入框出现），避免刚跳转就开始 fill */
async function waitForLoginFormReady(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const inputs = await page.evaluate(() => ({
        password: document.querySelectorAll('input[type="password"]').length,
        others: document.querySelectorAll('input:not([type="password"])').length,
      }));

      if (inputs.password > 0 && inputs.others > 0) return true;
    } catch {
      // 导航中，下一轮再来
    }

    await sleep(SESSION_PROBE_POLL_MS);
  }

  return false;
}

function getTodaySignDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SIGN_DATE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function trafficTextToBytes(value) {
  if (!value) return null;

  const match = String(value).trim().match(/^([\d.]+)\s*(TB|GB|MB|KB|B)$/i);
  if (!match) return null;

  const number = Number(match[1]);
  const unit = match[2].toUpperCase();
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return Math.round(number * 1024 ** powers[unit]);
}

function formatTrafficCompact(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';

  const trim = (value) => value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');

  if (bytes >= 1024 ** 4) return `${trim((bytes / 1024 ** 4).toFixed(2))}T`;
  if (bytes >= 1024 ** 3) return `${trim((bytes / 1024 ** 3).toFixed(2))}G`;
  if (bytes >= 1024 ** 2) return `${trim((bytes / 1024 ** 2).toFixed(2))}M`;
  if (bytes >= 1024) return `${trim((bytes / 1024).toFixed(2))}K`;
  return `${Math.round(bytes)}B`;
}

function cleanBodyLine(line) {
  return String(line || '')
    .replace(/\[MT\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBodyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(cleanBodyLine)
    .filter(Boolean);
}

function getValueBeforeLabel(text, label) {
  const lines = getBodyLines(text);
  const labelIndex = lines.findIndex((line) => line === label || line.includes(label));
  if (labelIndex > 0) {
    return lines[labelIndex - 1];
  }
  return null;
}

function normalizeTrafficText(value) {
  return value ? String(value).replace(/\s+/g, '') : null;
}

function parseTrafficAtLine(lines, index) {
  const line = lines[index] || '';
  const trafficMatch = line.match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);
  if (trafficMatch) {
    return normalizeTrafficText(`${trafficMatch[1]}${trafficMatch[2]}`);
  }

  const numberOnly = line.match(/^([\d.]+)$/);
  const nextUnit = lines[index + 1]?.match(/^(TB|GB|MB|KB|B)$/i);
  if (numberOnly && nextUnit) {
    return normalizeTrafficText(`${numberOnly[1]}${nextUnit[1]}`);
  }

  const unitOnly = line.match(/^(TB|GB|MB|KB|B)$/i);
  const previousNumber = lines[index - 1]?.match(/^([\d.]+)$/);
  if (unitOnly && previousNumber) {
    return normalizeTrafficText(`${previousNumber[1]}${unitOnly[1]}`);
  }

  return null;
}

function lineMatchesAny(line, patterns) {
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return pattern.test(line);
    }
    return line.includes(pattern);
  });
}

function findNumberNearLabel(lines, labelPatterns, order = ['after', 'before']) {
  const offsets = [1, 2, 3];
  for (let index = 0; index < lines.length; index++) {
    if (!lineMatchesAny(lines[index], labelPatterns)) continue;

    for (const direction of order) {
      for (const offset of offsets) {
        const targetIndex = direction === 'after' ? index + offset : index - offset;
        const match = lines[targetIndex]?.match(/(\d+)\s*(?:天|day|days)?\b/i);
        if (match) return Number(match[1]);
      }
    }
  }

  return null;
}

function findTrafficNearLabel(lines, labelPatterns, order = ['after', 'before']) {
  const offsets = [1, 2, 3];
  const candidates = [];

  for (let index = 0; index < lines.length; index++) {
    if (!lineMatchesAny(lines[index], labelPatterns)) continue;

    for (const direction of order) {
      for (const offset of offsets) {
        const targetIndex = direction === 'after' ? index + offset : index - offset;
        const traffic = parseTrafficAtLine(lines, targetIndex);
        if (traffic) {
          candidates.push(traffic);
        }
      }
      if (candidates.length > 0) break;
    }
  }

  return candidates;
}

async function saveDebugArtifacts(page, label) {
  const dir = process.env.FRP_DEBUG_DIR || 'debug-artifacts';
  await fs.mkdir(dir, { recursive: true }).catch(() => {});

  const safeLabel = String(label || 'debug').replace(/[^a-zA-Z0-9_.-]+/g, '-');
  const base = path.join(dir, safeLabel);

  const url = page.url();
  const html = await page.content().catch((error) => `<!-- failed to read content: ${error.message} -->`);
  const text = await page.locator('body').innerText().catch((error) => `failed to read body text: ${error.message}`);

  await fs.writeFile(`${base}.url.txt`, `${url}\n`).catch(() => {});
  await fs.writeFile(`${base}.html`, html).catch(() => {});
  await fs.writeFile(`${base}.txt`, text).catch(() => {});
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

  console.log(`[调试] 已保存页面调试文件: ${base}.{png,html,txt,url.txt}`);
}

async function extractSignStats(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const lines = getBodyLines(bodyText);

  // 累计签到天数（多种格式）
  const daysMatch = bodyText.match(/累计签到\s*[:：]?\s*(\d+)\s*天/) ||
                    bodyText.match(/累计\s*(\d+)\s*天/) ||
                    bodyText.match(/签到\s*(\d+)\s*天/);
  const daysBeforeLabel = getValueBeforeLabel(bodyText, '累计签到');
  const daysBeforeLabelMatch = daysBeforeLabel ? daysBeforeLabel.match(/(\d+)\s*天?/) : null;
  const daysNearLabel = findNumberNearLabel(lines, [/累计(?:签到|Check-in)/i], ['after', 'before']);
  
  // 累计签到获得的流量（优先匹配）
  const totalRewardMatch = bodyText.match(/累计签到\s*[:：]?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i) ||
                          bodyText.match(/签到获得\s*[:：]?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i) ||
                          bodyText.match(/累计\s*[:：]?\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i);
  const rewardBeforeLabel = getValueBeforeLabel(bodyText, '签到获得');
  const rewardBeforeLabelMatch = rewardBeforeLabel ? rewardBeforeLabel.match(/([\d.]+\s*(?:TB|GB|MB|KB|B))/i) : null;
  const rewardNearLabel = findTrafficNearLabel(lines, [/^(?:签到获得|Check-in获得)$/i], ['before', 'after'])[0];

  const totalSignDays = daysMatch ? Number(daysMatch[1]) : (daysBeforeLabelMatch ? Number(daysBeforeLabelMatch[1]) : daysNearLabel);
  const totalRewardText = normalizeTrafficText(totalRewardMatch ? totalRewardMatch[1] : (rewardBeforeLabelMatch ? rewardBeforeLabelMatch[1] : rewardNearLabel));

  return {
    totalSignDays,
    totalRewardText,
    totalRewardBytes: trafficTextToBytes(totalRewardText),
    rawText: bodyText,
  };
}

function pickLargestTrafficText(candidates) {
  const normalized = candidates
    .filter(Boolean)
    .map((value) => String(value).replace(/\s+/g, ''))
    .map((value) => ({ text: value, bytes: trafficTextToBytes(value) }))
    .filter((item) => Number.isFinite(item.bytes) && item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  return normalized[0] || { text: null, bytes: null };
}

async function extractDashboardStats(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const lines = getBodyLines(bodyText);

  const todayRewardMatch = bodyText.match(/本次(?:签到|Check-in)获得\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/i);
  const todayRewardNearLabel = findTrafficNearLabel(lines, [/本次(?:签到|Check-in)获得/i], ['after', 'before'])[0];
  const remainingCandidates = [
    ...Array.from(bodyText.matchAll(/([\d.]+\s*(?:TB|GB|MB|KB|B))\s*剩余流量/ig)).map((match) => match[1]),
    ...Array.from(bodyText.matchAll(/剩余流量\s*([\d.]+\s*(?:TB|GB|MB|KB|B))/ig)).map((match) => match[1]),
    ...findTrafficNearLabel(lines, [/剩余(?:流量|Traffic)/i], ['before', 'after']),
  ];

  const todayRewardText = todayRewardMatch ? todayRewardMatch[1].replace(/\s+/g, '') : todayRewardNearLabel;
  const remainingBest = pickLargestTrafficText(remainingCandidates);

  return {
    todayRewardText,
    todayRewardBytes: trafficTextToBytes(todayRewardText),
    remainingText: remainingBest.text,
    remainingBytes: remainingBest.bytes,
    remainingCandidates,
    rawText: bodyText,
  };
}

async function waitForDashboardStats(page, timeoutMs = 15_000) {
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10_000) }).catch(() => {});

  try {
    await page.waitForFunction(
      () => {
        const text = (document.body?.innerText || '').replace(/\[MT\]/g, '');
        return (
          /本次(?:签到|Check-in)获得/i.test(text) &&
          /剩余(?:流量|Traffic)/i.test(text)
        );
      },
      { timeout: timeoutMs }
    );
  } catch {}

  await page.waitForTimeout(1200);
}

async function loadDashboardStats(page, dashboardUrl) {
  await waitForDashboardStats(page);
  let stats = await extractDashboardStats(page);

  if (stats.todayRewardBytes && stats.remainingBytes) {
    return stats;
  }

  console.log('[主页] 首次提取统计不完整，刷新个人主页后重试...');

  if (dashboardUrl) {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForDashboardStats(page);
    stats = await extractDashboardStats(page);
  }

  if (stats.todayRewardBytes && stats.remainingBytes) {
    return stats;
  }

  console.log('[主页] 仪表盘仍未提取完整，继续使用当前可得数据');
  return stats;
}

/**
 * 生成签到结果文案。
 *
 * @param {'success'|'already'} kind
 *   success —— 由本次运行完成签到
 *   already —— 脚本点签到之前今日签到就已完成（用户手动签的，或当天更早的一次运行签的）
 */
function buildResultTemplate(signStats, dashboardStats, kind = 'success') {
  const days = Number.isFinite(signStats?.totalSignDays) ? signStats.totalSignDays : '未取到';
  const todayReward = Number.isFinite(dashboardStats?.todayRewardBytes) && dashboardStats.todayRewardBytes > 0
    ? formatTrafficCompact(dashboardStats.todayRewardBytes)
    : '未取到';
  const totalReward = signStats?.totalRewardText ? signStats.totalRewardText.replace(/B$/, '') : '未取到';
  const remaining = dashboardStats?.remainingText ? dashboardStats.remainingText.replace(/B$/, '') : '未取到';

  const isAlready = kind === 'already';

  const lines = [
    isAlready ? '52frp今日已签到（无需重复签到）' : '52frp签到成功',
    '',
    `签到天数：${days} 天`,
    `本次获得：${todayReward}`,
    `累计获得：${totalReward}`,
    `剩余流量：${remaining}`,
  ];

  if (isAlready) {
    lines.push('', '签到方式：本次运行前已完成（手动签到或当天更早的一次运行），脚本未重复签到');
  } else {
    lines.push('', '签到方式：本次运行自动签到成功');
  }

  return lines.join('\n');
}

/** 从「已签到」判定的来源描述里，判断这一天到底是不是本次运行才签上的 */
function resolveSignKind(signInfo) {
  return /已经签到|已签到/i.test(String(signInfo || '')) ? 'already' : 'success';
}

/**
 * 启动持久化浏览器，必要时清掉陈旧锁再重试。
 *
 * Chromium 会在 profile 目录里放一个 SingletonLock，正常退出时会删掉；
 * 但如果上一次是被 kill、机器重启或超时强杀，这个锁就会残留下来，
 * 之后**每一次**运行都会以 "Failed to create a ProcessSingleton" 直接失败 ——
 * 对无人值守的 cron 来说是致命的：一次异常就把定时任务永久钉死。
 *
 * 锁本身只是个指向「主机名-pid」的符号链接，对应进程已经不存在时清掉是安全的。
 */
async function launchPersistentBrowser(profileDir, options) {
  try {
    return await chromium.launchPersistentContext(profileDir, options);
  } catch (error) {
    const message = String(error?.message || '');
    const isStaleLock = /ProcessSingleton|SingletonLock|profile is already in use/i.test(message);

    if (!isStaleLock) throw error;

    await fs.rm(path.join(profileDir, 'SingletonLock'), { force: true }).catch(() => {});
    await fs.rm(path.join(profileDir, 'SingletonCookie'), { force: true }).catch(() => {});
    console.log('[浏览器] 检测到上一次异常退出残留的 SingletonLock，已清理并重试');

    return chromium.launchPersistentContext(profileDir, options);
  }
}

function resolveHeadless() {
  if (typeof process.env.FRP_BROWSER_HEADLESS === 'string') {
    return process.env.FRP_BROWSER_HEADLESS === 'true';
  }

  // 默认无头：cron / 无显示器的服务器起不了有头浏览器。
  // 需要肉眼观察时显式设 FRP_BROWSER_HEADLESS=false 并自备 Xvfb。
  return true;
}

function resolveChannel() {
  // 默认 chromium：msedge 只在装了 Edge 的桌面机上存在，
  // 无头服务器上会直接报 "Chromium distribution 'msedge' is not found"。
  return process.env.FRP_BROWSER_CHANNEL || 'chromium';
}

/**
 * 持久化 profile 目录。
 *
 * 用 launchPersistentContext 让 cookie / localStorage / HTTP 缓存跨轮次、
 * 跨运行保留。目录不存在时会自动创建。
 *
 * 注意：同一个 profile 目录不能被两个 Chromium 实例同时打开（会有 SingletonLock）。
 * 定时任务侧已经用 flock 做了互斥，这里不再额外加锁。
 */
function resolveProfileDir() {
  const raw = (process.env.FRP_PROFILE_DIR || '').trim();
  if (raw) return path.resolve(raw);

  return path.resolve(process.cwd(), DEFAULT_PROFILE_DIR);
}

/**
 * 是否启用 HTTP 缓存。
 *
 * 早期版本是**主动禁用**缓存的，理由是「别反复拿到 CDN 缓存的错误响应」——
 * 但那个理由站不住：禁缓存只影响浏览器本地缓存，CDN 边缘缓存不受我们控制；
 * 副作用却是每次运行都要重新下载那 5MB bundle，得不偿失。
 *
 * 现在默认启用。5xx 不会被 Chromium 启发式缓存（RFC 7234 的可启发缓存状态码
 * 不含 5xx），另外 installResourceBlocker 会对本次运行内返回过 5xx 的 URL
 * 追加 no-cache 请求头，双保险。真遇到缓存导致的怪问题时用 FRP_CACHE_ENABLED=0 退回。
 */
function resolveCacheEnabled() {
  const raw = (process.env.FRP_CACHE_ENABLED || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;

  return true;
}

/**
 * 检测并完成滑块验证
 *
 * 常见滑块类型：
 * - 自定义拖动滑块: .drag_verify, .dv_handler (52frp 使用这种)
 * - TencentCaptcha: .tcaptcha, #tcaptcha
 * - GeeTest: .geetest_slider, ._geetest_slide_handle
 * - Aliyun: #aliyun-captcha
 */
async function handleSliderVerification(page, timeoutMs = 30_000) {
  console.log('[滑块] 检测滑块验证...');

  // 等待滑块元素出现
  let sliderBox = null;
  let sliderHandle = null;

  // 优先检测 52frp 使用的滑块类型
  const sliderPatterns = [
    { container: '.drag_verify', handler: '.dv_handler' },  // 52frp 类型
    { container: '.tcaptcha', handler: '.tcaptcha-slider-btn' },
    { container: '.geetest_slider', handler: '.geetest_slider_button' },
    { container: '#aliyun-captcha', handler: '' },
    { container: '.slider', handler: '' },
    { container: '[class*="slider"]', handler: '' },
  ];

  for (const pattern of sliderPatterns) {
    try {
      const containerLocator = page.locator(pattern.container);
      if (await containerLocator.count() > 0) {
        sliderBox = containerLocator.first();
        console.log(`[滑块] 找到滑块容器: ${pattern.container}`);

        // 尝试找把手
        if (pattern.handler) {
          const handleLocator = sliderBox.locator(pattern.handler);
          if (await handleLocator.count() > 0) {
            sliderHandle = handleLocator.first();
            console.log(`[滑块] 找到滑块把手: ${pattern.handler}`);
          }
        }

        // 如果没找到指定把手，尝试常见把手选择器
        if (!sliderHandle) {
          const handleSelectors = [
            '.dv_handler',
            '.tcaptcha-slider-btn',
            '.geetest_slider_button',
            '[class*="handler"]',
            '[class*="drag"]',
            'div[role="slider"]',
          ];
          for (const hSel of handleSelectors) {
            const hLoc = sliderBox.locator(hSel);
            if (await hLoc.count() > 0) {
              sliderHandle = hLoc.first();
              console.log(`[滑块] 找到滑块把手: ${hSel}`);
              break;
            }
          }
        }

        // 如果还没找到，尝试从容器直接拖动
        if (!sliderHandle) {
          sliderHandle = sliderBox;
          console.log('[滑块] 使用容器本身作为拖动目标');
        }

        break;
      }
    } catch {
      continue;
    }
  }

  if (!sliderBox || await sliderBox.count() === 0) {
    console.log('[滑块] 未检测到滑块，可能不需要验证');
    return { handled: false, reason: 'no_slider_detected' };
  }

  // 获取滑块位置
  const boxBounds = await sliderBox.boundingBox();
  if (!boxBounds) {
    return { handled: false, reason: 'cannot_get_bounds' };
  }

  console.log(`[滑块] 滑块位置: x=${boxBounds.x.toFixed(1)}, y=${boxBounds.y.toFixed(1)}, w=${boxBounds.width}, h=${boxBounds.height}`);

  // 计算拖动距离和起点
  let startX, startY, endX, endY;

  if (sliderHandle) {
    const handleBounds = await sliderHandle.boundingBox();
    if (handleBounds) {
      // 从把手中心开始
      startX = handleBounds.x + handleBounds.width / 2;
      startY = handleBounds.y + handleBounds.height / 2;
      // 拖动到容器最右侧（确保拖到底，多留 5px 冗余）
      endX = boxBounds.x + boxBounds.width - 5;
      endY = startY;
      console.log(`[滑块] 把手位置: x=${handleBounds.x.toFixed(1)}, y=${handleBounds.y.toFixed(1)}`);
    } else {
      // 无法获取把手位置，使用容器
      startX = boxBounds.x + 20;
      startY = boxBounds.y + boxBounds.height / 2;
      endX = boxBounds.x + boxBounds.width - 5;  // 拖到最右边
      endY = startY;
    }
  } else {
    startX = boxBounds.x + 20;
    startY = boxBounds.y + boxBounds.height / 2;
    endX = boxBounds.x + boxBounds.width - 5;  // 拖到最右边
    endY = startY;
  }

  console.log(`[滑块] 拖动路径: (${startX.toFixed(1)}, ${startY.toFixed(1)}) → (${endX.toFixed(1)}, ${endY.toFixed(1)})`);

  // 使用 Playwright 的真实鼠标事件进行拖动
  // 关键：必须使用 page.mouse API，不能用 JS 模拟事件
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.waitForTimeout(150);

  // 分段移动，模拟人类行为（有轻微抖动）
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    // 添加随机垂直抖动模拟人手不稳
    const jitterY = (Math.random() - 0.5) * 4;
    const currentX = startX + (endX - startX) * progress;
    const currentY = startY + jitterY;

    await page.mouse.move(currentX, currentY);
    // 每步间隔模拟人类操作速度（40-80ms）
    await page.waitForTimeout(40 + Math.random() * 40);
  }

  await page.mouse.up();

  console.log('[滑块] 拖拽完成，等待验证结果...');
  await page.waitForTimeout(2000);

  // 检查滑块是否消失或验证成功
  const stillVisible = await sliderBox.count().catch(() => 0);
  if (stillVisible === 0) {
    console.log('[滑块] 滑块已消失，验证成功');
    return { handled: true, success: true };
  }

  // 检查滑块是否显示为通过状态（例如进度条已满）
  try {
    const progressBar = sliderBox.locator('.dv_progress_bar, .progress_bar, [class*="progress"]');
    if (await progressBar.count() > 0) {
      const progressWidth = await progressBar.first().evaluate(el => {
        const style = window.getComputedStyle(el);
        return parseFloat(style.width) || el.offsetWidth;
      });
      if (progressWidth > boxBounds.width * 0.8) {
        console.log(`[滑块] 进度条已满 (${progressWidth}px)，验证成功`);
        return { handled: true, success: true };
      }
    }
  } catch {}

  // 检查成功提示
  const successToast = await page.locator('.el-message--success, .success, [class*="success"]').count();
  if (successToast > 0) {
    console.log('[滑块] 检测到成功提示');
    return { handled: true, success: true };
  }

  console.log('[滑块] 滑块仍然显示，尝试重试...');
  return { handled: true, success: false, reason: 'slider_still_visible' };
}

async function clickLoginButton(page) {
  console.log('[登录] 查找登录按钮...');

  const buttonName = /^(登录|Login)$/i;
  const strategies = [
    { name: 'role按钮', locator: page.getByRole('button', { name: buttonName }) },
    { name: 'button文本', locator: page.locator('button').filter({ hasText: buttonName }) },
    { name: 'Element Plus主按钮', locator: page.locator('.el-button.el-button--primary').filter({ hasText: buttonName }) },
  ];

  for (const strategy of strategies) {
    const count = await strategy.locator.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = strategy.locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;

      const text = await candidate.innerText().catch(() => '');
      console.log(`[登录] 找到按钮 (${strategy.name}): "${text.trim()}"`);
      await candidate.click();
      console.log('[登录] 已点击登录按钮');
      return { clicked: true, strategy: strategy.name, text: text.trim() };
    }
  }

  console.log('[登录] 未找到登录按钮');
  return { clicked: false, reason: 'login_button_not_found' };
}

/**
 * 等待签到页真正渲染出可判定的内容。
 *
 * 只等 networkidle + 固定 sleep 是不够的：跨境链路上页面常常只渲染一半，
 * 此时「上次签到日期」「立即签到按钮」都还没有，后续判定就是在残缺数据上做判断
 * （2026-09-19 的误报正是这么来的）。这里显式等到二者之一出现为止。
 */
async function waitForSignPageReady(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => ({
        text: document.body?.innerText || '',
        hasSignButton: [...document.querySelectorAll('button')].some((b) =>
          /立即\s*(?:签到|Check-in)/i.test(String(b.textContent || '').trim())
        ),
      }));

      if (/上次(?:签到|Check-in)\s*[:：]?\s*\d/i.test(state.text) || state.hasSignButton) {
        return { ready: true };
      }
    } catch {
      // 页面正在导航，下一轮再来
    }

    await sleep(500);
  }

  return { ready: false };
}

/**
 * 等待登录成功
 */
async function waitForLoginSuccess(page, timeoutMs = 30_000) {
  console.log('[登录] 等待登录完成...');

  try {
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        // 登录成功后 URL 会变化，不再包含 /auth/login
        return url.includes('/user/') && !url.includes('/auth/login');
      },
      { timeout: timeoutMs }
    );
    console.log('[登录] URL 已变化，登录成功');
    return true;
  } catch {
    // 检查是否有错误提示
    const errorToast = await page.locator('.el-message--error, .error, [class*="error"]').count();
    if (errorToast > 0) {
      const errorText = await page.locator('.el-message--error').first().innerText().catch(() => '未知错误');
      console.log(`[登录] 错误提示: ${errorText}`);
      return false;
    }

    console.log('[登录] 超时，未检测到登录成功');
    return false;
  }
}

/**
 * 检查是否已签到。
 *
 * 曾经踩过的坑（2026-09-19）：`successPatterns` 里的「签到成功」是**结果提示**，
 * 不是**状态证据**。签到页哪怕没签到，页面上也可能出现这四个字（残缺渲染的页面、
 * 说明文案、历史记录等都会命中）。把它用在「点击前是否已签到」的判断上，
 * 会让脚本认为今天已签到而跳过点击 —— 结果是推送"已签到"但实际根本没签。
 *
 * 因此判定分两级：
 * - reliable（硬证据）：上次签到日期 == 今天、页面明确写「您今天已经签到过了」、
 *   接口返回已签到 —— 只有这些能作为「今天已签到」的结论
 * - 软证据：按钮禁用/不可见、出现「签到成功」等模糊文案 —— 可能只是页面没渲染完，
 *   不能据此跳过签到，必须继续走点击流程，让签到接口给出最终答案
 *
 * @param {Object} [options]
 * @param {boolean} [options.allowSuccessPatterns=false]
 *   是否把「签到成功」「恭喜获得」计为已签到。只有**点击签到之后**才应开启。
 */
async function checkSignedToday(page, options = {}) {
  const { allowSuccessPatterns = false } = options;

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const normalizedBodyText = cleanBodyLine(bodyText);

  // 硬证据 1：上次签到日期就是今天（最可靠）
  const today = getTodaySignDate();
  const lastSignMatch = normalizedBodyText.match(/上次(?:签到|Check-in)\s*[:：]?\s*(\d{4}-\d{2}-\d{2}|\d{4}\.\d{2}\.\d{2}|\d{2}-\d{2}|\d{2}\.\d{2})/i);
  if (lastSignMatch) {
    let lastSignDate = lastSignMatch[1];
    // 处理不同日期格式
    if (lastSignDate.length === 5) {
      // MM-DD 或 MM.DD 格式，需要补年份
      const year = new Date().toLocaleDateString('en-CA', { timeZone: SIGN_DATE_TIMEZONE }).split('-')[0];
      lastSignDate = `${year}-${lastSignDate.replace('.', '-')}`;
    } else if (lastSignDate.includes('.')) {
      // YYYY.MM.DD 格式，转换为 YYYY-MM-DD
      lastSignDate = lastSignDate.replace('.', '-').replace('.', '-');
    }
    if (lastSignDate === today) {
      console.log(`[签到判断] 上次签到日期为今天 (${today})，判断为已签到（硬证据）`);
      return { signed: true, reliable: true, pattern: `上次签到日期: ${today}` };
    }

    // 有日期但不是今天 → 明确未签到，这是硬证据，直接终结判断（不再看按钮/文案）
    console.log(`[签到判断] 上次签到日期为 ${lastSignDate}，不是今天 (${today})，判断为未签到（硬证据）`);
    return { signed: false, reliable: true, pattern: `上次签到日期: ${lastSignDate}` };
  }

  // 硬证据 2：页面明确写了「今天已经签到过」
  const explicitPatterns = [
    '您今天已经签到过了',
    '今天已经签到过了',
    '您今天已经Check-in过了',
    '今天已经Check-in过了',
  ];
  for (const pattern of explicitPatterns) {
    if (normalizedBodyText.includes(pattern)) {
      return { signed: true, reliable: true, pattern: `页面提示: ${pattern}` };
    }
  }

  // 软证据：结果类提示文案。只在点击签到之后才认（allowSuccessPatterns）
  if (allowSuccessPatterns) {
    const successPatterns = ['签到成功', '恭喜获得'];
    for (const pattern of successPatterns) {
      if (normalizedBodyText.includes(pattern)) {
        return { signed: true, reliable: false, pattern: `成功提示: ${pattern}` };
      }
    }
  }

  // 检测签到按钮是否存在且可见
  const signButton = page.getByRole('button', { name: /立即(?:签到|Check-in)/i });
  const buttonVisible = await signButton.isVisible().catch(() => false);
  const buttonCount = await signButton.count().catch(() => 0);
  const buttonEnabled = buttonCount > 0 ? await signButton.first().isEnabled().catch(() => true) : false;

  if (buttonVisible && buttonCount > 0 && buttonEnabled) {
    // 签到按钮可见且可点 → 未签到（硬证据）
    console.log('[签到判断] 检测到「立即签到」按钮可见，判断为未签到');
    return { signed: false, reliable: true };
  }

  if (buttonVisible && buttonCount > 0 && !buttonEnabled) {
    console.log('[签到判断] 签到按钮已禁用，疑似已签到（软证据，仍需接口确认）');
    return { signed: true, reliable: false, pattern: '签到按钮已禁用' };
  }

  // 签到按钮不可见或不存在
  if (normalizedBodyText.includes('已签到') || normalizedBodyText.includes('已经签到') || normalizedBodyText.includes('今日已签')) {
    console.log('[签到判断] 签到按钮不可见，页面显示已签到状态（软证据，仍需接口确认）');
    return { signed: true, reliable: false, pattern: '按钮不可见且页面显示已签到' };
  }

  // 按钮不可见且无明确状态：多半是页面还没渲染完，属于「不知道」而非「已签到」
  console.log('[签到判断] 未取到任何已签到证据（页面可能尚未渲染完整），保守判断为未签到');
  return { signed: false, reliable: false };
}

/**
 * 关闭可能阻挡点击的公告遮罩层
 *
 * 52frp 登录后可能会显示全屏公告弹窗，拦截所有点击事件。
 * 此函数检测并关闭这类遮罩层，确保后续操作能正常执行。
 */
async function dismissBlockingOverlays(page) {
  // 检测常见的遮罩层选择器
  const overlaySelectors = [
    '.announcement-fullscreen-overlay',
    '.announcement-overlay',
    '.fullscreen-overlay',
    '[class*="announcement-fullscreen"]',
    '[class*="announcement"][class*="overlay"]',
  ];

  for (const selector of overlaySelectors) {
    const overlay = page.locator(selector);
    const count = await overlay.count().catch(() => 0);

    if (count > 0) {
      console.log(`[遮罩] 检测到遮罩层: ${selector}`);

      // 尝试多种方式关闭
      const closeStrategies = [
        // 1. 点击遮罩层内的关闭按钮
        { name: '我知道了', locator: overlay.locator('button:has-text("我知道了")').first() },
        { name: '确定', locator: overlay.locator('button:has-text("确定")').first() },
        { name: '关闭', locator: overlay.locator('button:has-text("关闭")').first() },
        { name: 'OK', locator: overlay.locator('button:has-text("OK")').first() },
        { name: '关闭图标', locator: overlay.locator('.el-dialog__close, [aria-label="Close"], .close-btn').first() },
      ];

      for (const strategy of closeStrategies) {
        const btnCount = await strategy.locator.count().catch(() => 0);
        if (btnCount > 0) {
          console.log(`[遮罩] 尝试点击: ${strategy.name}`);
          await strategy.locator.click().catch(() => {});
          await page.waitForTimeout(500);

          // 检查遮罩层是否消失
          const remaining = await overlay.count().catch(() => 0);
          if (remaining === 0) {
            console.log(`[遮罩] 已通过 ${strategy.name} 关闭`);
            return true;
          }
        }
      }

      // 2. 尝试 Escape 键
      console.log('[遮罩] 尝试 Escape 键');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const afterEscape = await overlay.count().catch(() => 0);
      if (afterEscape === 0) {
        console.log('[遮罩] 已通过 Escape 关闭');
        return true;
      }

      // 3. 最后手段：强制移除 DOM 元素
      console.log('[遮罩] 强制移除遮罩层 DOM');
      await overlay.evaluate(el => el.remove()).catch(() => {});
      return true;
    }
  }

  return false;
}

/**
 * 检测 52frp 上游 5xx（Cloudflare 522/525 等）渲染出的服务端错误页。
 *
 * 这类页面只有 “Sorry, there was an error on the server” + “Go Home”，
 * 没有任何签到按钮；此前 fallback 策略会误点到 “Go Home”，
 * 导致日志显示“已点击签到按钮”却根本不是在签到。
 */
async function detectServerErrorPage(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const normalized = cleanBodyLine(bodyText);

  const match = normalized.match(/Sorry, there was an error on the server[\s\S]*/i);
  if (match) {
    return match[0].slice(0, 200);
  }

  return null;
}

/**
 * 查找并点击签到按钮
 */
async function clickSignButton(page) {
  console.log('[签到] 查找签到按钮...');

  // 先关闭可能阻挡点击的遮罩层
  await dismissBlockingOverlays(page);

  // 上游 5xx 错误页没有任何签到按钮，直接放弃，避免误点 “Go Home”
  const serverError = await detectServerErrorPage(page);
  if (serverError) {
    console.log(`[签到] 检测到服务端错误页: ${serverError}`);
    return { clicked: false, serverError };
  }

  // 多种方式查找按钮
  // 站点文案会中英混排（[MT] 立即Check-in），所以一律用正则而不是字面量
  const signTextPattern = /(?:立即)?\s*(?:签到|Check-in)/i;
  const strategies = [
    { name: 'role按钮', locator: page.getByRole('button', { name: /立即(?:签到|Check-in)/i }) },
    { name: '文本过滤', locator: page.locator('button').filter({ hasText: /立即(?:签到|Check-in)/i }) },
    { name: 'primary按钮', locator: page.locator('button.el-button--primary') },
    { name: 'sign类按钮', locator: page.locator('button[class*="sign"]') },
    { name: '任意签到文本', locator: page.locator('button, [role="button"]') },
  ];

  for (const strategy of strategies) {
    try {
      const count = await strategy.locator.count();
      for (let index = 0; index < count; index++) {
        const button = strategy.locator.nth(index);
        const text = await button.innerText().catch(() => '');
        const trimmed = text.trim();

        // 兜底策略会命中页面上任意 primary 按钮（如错误页的 “Go Home”），
        // 必须带签到字样才允许点击。
        if (!signTextPattern.test(trimmed)) {
          continue;
        }

        console.log(`[签到] 找到按钮 (${strategy.name}): "${trimmed}"`);

        // 尝试多种点击方式，优先使用 Playwright 真实指针点击。
        // 52frp 的签到会依赖页面先获取 slider-token，再由真实按钮事件提交。
        // JS evaluate click() 在 GitHub Actions 中曾触发 /user/sign，但服务端返回
        // “签到失败，请稍后重试”，所以只能作为最后 fallback。
        let clicked = false;
        
        // 方式1: 真实点击
        try {
          await button.scrollIntoViewIfNeeded().catch(() => {});
          await button.click({ timeout: 30_000 });
          console.log('[签到] 已点击签到按钮（真实点击）');
          clicked = true;
        } catch (e) {
          console.log('[签到] 真实点击失败，尝试 force click:', e.message);
        }

        // 方式2: force click
        if (!clicked) {
          try {
            await button.click({ force: true });
            console.log('[签到] 已点击签到按钮（force模式）');
            clicked = true;
          } catch (e) {
            console.log('[签到] force click 失败，尝试 JS evaluate:', e.message);
          }
        }

        // 方式3: 直接调用 JavaScript click()，只作为最后兜底
        if (!clicked) {
          try {
            await button.evaluate(el => el.click());
            console.log('[签到] 已点击签到按钮（JS evaluate）');
            clicked = true;
          } catch (e) {
            console.log('[签到] JS evaluate 失败，尝试 dispatchEvent');
            // 方式4: dispatchEvent
            try {
              await button.dispatchEvent('click');
              console.log('[签到] 已点击签到按钮（dispatchEvent）');
              clicked = true;
            } catch (e2) {
              console.log('[签到] dispatchEvent 也失败:', e2.message);
            }
          }
        }

        return { clicked, buttonText: trimmed };
      }
    } catch (e) {
      console.log(`[签到] 策略 ${strategy.name} 失败: ${e.message}`);
    }
  }

  return { clicked: false };
}

/**
 * 等待签到结果
 */
async function waitForSignResult(page, timeoutMs = 30_000) {
  console.log('[签到] 等待签到结果...');

  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return (
          text.includes('您今天已经签到过了') ||
          text.includes('今天已经签到过了') ||
          text.includes('签到成功') ||
          text.includes('恭喜') ||
          Boolean(document.querySelector('.el-message, .el-notification'))
        );
      },
      { timeout: timeoutMs }
    );
  } catch {
    // 继续检查最终状态
  }

  await page.waitForTimeout(1000);
}

async function waitForSignRequest(page, timeoutMs = 15_000) {
  try {
    const response = await page.waitForResponse(
      (res) => res.request().method() === 'POST' && /\/user\/sign(?:\?|$)/.test(res.url()),
      { timeout: timeoutMs }
    );

    const text = await response.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    console.log(`[签到] 捕获签到请求: ${response.status()} ${response.url()}`);
    console.log(`[签到] 响应原文（前500字符）: ${text.slice(0, 500)}`);
    if (json) {
      console.log(`[签到] 响应 JSON: ${JSON.stringify(json).slice(0, 500)}`);
      const message = json.message || json.msg || json.error || json.detail || json.info || json.result;
      if (message) {
        console.log(`[签到] 接口返回消息: ${message}`);
      }
    } else {
      console.log(`[签到] 响应无法解析为 JSON，原文前200字符: ${text.slice(0, 200)}`);
    }

    return {
      seen: true,
      status: response.status(),
      url: response.url(),
      text,
      json,
    };
  } catch {
    console.log('[签到] 未捕获到签到请求');
    return { seen: false };
  }
}

function inferSignStateFromRequest(signRequest) {
  if (!signRequest?.seen) return { signed: false };

  const json = signRequest.json || null;
  const message = json
    ? String(json.message || json.msg || json.error || json.detail || '')
    : '';
  const raw = message || String(signRequest.text || '');

  if (/签到失败|失败|稍后重试|错误|error/i.test(raw)) {
    return { signed: false, reliable: true, pattern: '接口返回失败' };
  }

  if (/今天已经签到过了|您今天已经签到过了|已签到|已经签到/i.test(raw)) {
    return { signed: true, reliable: true, pattern: '接口返回已签到' };
  }

  if (/签到成功|成功|恭喜/i.test(raw)) {
    return { signed: true, reliable: true, pattern: '接口返回签到成功' };
  }

  // 如果响应码为 200 且有 data 字段，且无明确失败消息，视为可能成功
  // 注意：这里原本误用了未定义的 `text` 变量（应为 raw），会抛 ReferenceError
  if (signRequest.status === 200 && json && json.data && !/失败|error|错误|稍后重试/i.test(raw)) {
    console.log(`[签到] 检测到 200 + data 字段，视为可能成功`);
    return { signed: true, reliable: true, pattern: '接口返回 200 且有 data 字段' };
  }

  return { signed: false, reliable: false };
}

/**
 * 纯浏览器签到主函数
 *
 * @param {Object} options
 * @param {string} options.username - 账号
 * @param {string} options.password - 密码
 * @param {number} options.timeoutMs - 超时时间
 * @param {Object} options.launchOptions - Playwright 启动选项
 * @returns {Promise<{status: string, message: string, details?: Object}>}
 */
async function attemptCheckInOnce({
  username,
  password,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  launchOptions = {},
  round = 1,
}) {
  if (!username || !password) {
    const err = new Error('缺少账号或密码，请配置 FRP_USERNAME 和 FRP_PASSWORD');
    err.retryable = false;
    throw err;
  }

  const blockMode = resolveBlockThirdPartyMode();
  const debugLabel = (label) => `round${round}-${label}`;
  const profileDir = resolveProfileDir();

  await fs.mkdir(profileDir, { recursive: true }).catch(() => {});

  /**
   * 持久化 profile（而非每次 newContext）：
   * cookie 与 HTTP 缓存都落盘，跨轮次、跨运行复用。首次成功之后，
   * 那 5MB 的主 bundle 基本都从本地读，不再依赖动不动就 522 的跨境链路。
   */
  const context = await launchPersistentBrowser(profileDir, {
    headless: resolveHeadless(),
    channel: resolveChannel(),
    args: process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : [],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
    ignoreHTTPSErrors: true,
    ...launchOptions,
  });

  console.log(`[浏览器] 持久化 profile: ${profileDir}`);

  // persistent context 启动时会自带一个 about:blank 页，优先复用它
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  /** 本次运行内返回过 5xx 的 URL：重试时强制回源，不读本地缓存里的错误响应 */
  const badAssets = new Set();

  // 砍掉与签到无关的第三方请求，缩小跨境链路上的失败面
  await installResourceBlocker(page, blockMode, { badAssets });

  // 收集 JS 控制台错误，用于诊断 Vue SPA 渲染失败
  const jsErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      jsErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    jsErrors.push(`[pageerror] ${err.message}`);
  });

  const steps = [];
  let loginSuccess = false;
  let sliderHandled = false;
  let sessionReused = false;
  let dashboardUrl = null;
  let dashboardStats = null;
  let beforeStats = null;

  /**
   * 加载 SPA 并判断落在哪个视图（签到页 = 登录态有效 / 登录页 = 需要账号密码）。
   *
   * 直接打开签到页而不是登录页：hash 路由下两个地址取的是同一份 HTML 和同一份
   * 主 bundle，所以省不掉那次下载；但打开签到页时，登录态有效就直接进签到，
   * 无效才被弹回登录 —— 顺带把「cookie 还能不能用」也测了，不额外发请求。
   *
   * 相比旧版的三处改动：
   * 1. 监听响应状态码，命中回源错误（522/524/525 等）立即放弃本次等待，不再傻等超时；
   *    同时把这些 URL 记进 badAssets，重试时强制回源
   * 2. 不再清空 cookie —— cookie 现在是要复用的资产，只有确认要走账号密码登录时才清
   * 3. 视图判据见 waitForAppView
   */
  async function loadAppWithRetry(maxRetries = LOGIN_PAGE_MAX_ATTEMPTS) {
    /**
     * 两份数组，职责不同：
     * - upstreamErrorsAll：跨 attempt 累积，用于最终的报错详情
     *   最后一次 attempt 很可能一个响应都收不到（整个页面根本没加载起来），
     *   如果只用当次的数据，报错里就会出现「（未知）」——恰好在诊断最需要信息的时候丢掉线索。
     * - upstreamErrors：仅当次 attempt，用于 waitForLoginPageRendered 的「提前中断等待」
     *   必须每次清空，否则会把上一次的错误状态带到新一轮。
     */
    const upstreamErrorsAll = [];
    const upstreamErrors = [];

    const onResponse = (response) => {
      if (isUpstreamError(response.status())) {
        const entry = `${response.status()} ${getUrlPath(response.url())}`;
        upstreamErrors.push(entry);
        if (!upstreamErrorsAll.includes(entry)) upstreamErrorsAll.push(entry);
        // 记进坏名单：本次运行内再请求这个 URL 时强制回源，别读本地缓存里那份错误响应
        badAssets.add(response.url());
      }
    };
    page.on('response', onResponse);

    try {
      await configureHttpCache(context, page);

      let sawUpstreamError = false;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        upstreamErrors.length = 0;

        if (attempt > 1) {
          const backoffMs = LOGIN_PAGE_BACKOFF_MS[attempt - 1]
            ?? LOGIN_PAGE_BACKOFF_MS[LOGIN_PAGE_BACKOFF_MS.length - 1];
          console.log(`[页面] 第 ${attempt} 次重试加载（等待 ${Math.round(backoffMs / 1000)}s）...`);
          await sleep(backoffMs);
          // 这里不清 cookie：cookie 是要复用的资产。
          // 只有「确认要走账号密码登录」时才会清（见主流程），避免误伤有效登录态。
        }

        // 第一步：加载页面 HTML
        // 直接进签到页 —— hash 路由下它和登录页取的是同一份 HTML 与同一份主 bundle，
        // 省不掉下载；但登录态有效就直接停在签到页，无效才被弹回登录页，顺带把
        // 「cookie 还能不能用」也测了，不用额外发请求。
        let gotoOk = false;
        for (let gt = 1; gt <= LOGIN_GOTO_ATTEMPTS; gt++) {
          try {
            await page.goto(SIGN_PAGE, {
              waitUntil: 'domcontentloaded',
              timeout: LOGIN_GOTO_TIMEOUT_MS,
            });
            gotoOk = true;
            break;
          } catch (gotoErr) {
            console.log(`[页面] goto 失败 (尝试 ${gt}/${LOGIN_GOTO_ATTEMPTS}): ${String(gotoErr.message).split('\n')[0]}`);
            if (gt < LOGIN_GOTO_ATTEMPTS) await sleep(2000);
          }
        }

        if (!gotoOk) {
          if (attempt < maxRetries) continue;
          const err = new Error('签到页加载失败：多次 goto 均失败（站点/CDN 不可达）');
          err.kind = 'upstream';
          throw err;
        }

        // 第二步：等待网络空闲
        await page
          .waitForLoadState('networkidle', { timeout: LOGIN_NETWORKIDLE_TIMEOUT_MS })
          .catch(() => {});

        // 第三步：判断落在哪个视图（命中回源错误会提前返回 unknown）
        const probe = await waitForAppView(page, {
          timeoutMs: LOGIN_RENDER_TIMEOUT_MS,
          upstreamErrors,
        });

        if (probe.view === 'sign') {
          console.log(`[页面] 已渲染签到页 → 登录态有效 (attempt ${attempt}/${maxRetries})`);
          await sleep(1000);
          return { view: 'sign' };
        }

        if (probe.view === 'login') {
          // 刚跳转过来时表单可能还没渲染完，等它可填再交回主流程
          const formReady = await waitForLoginFormReady(page, 15_000);
          if (formReady) {
            console.log(`[页面] 已跳转登录页 → 需要账号密码 (attempt ${attempt}/${maxRetries})`);
            await sleep(1000);
            return { view: 'login' };
          }
          console.log(`[页面] 已跳转登录页但表单尚未就绪 (attempt ${attempt}/${maxRetries})`);
        }

        // 未判定 —— 记录诊断信息并重试
        const hitUpstream = upstreamErrors.length > 0;
        if (hitUpstream) sawUpstreamError = true;

        const bodyLen = (await page.locator('body').innerText().catch(() => '')).length;
        console.log(`[页面] 未能判定视图 (body 文本长度=${bodyLen}, attempt ${attempt}/${maxRetries})`);

        if (hitUpstream) {
          console.log(
            `[页面] 上游回源错误 (本轮累计 ${upstreamErrorsAll.length} 条, 去重前5): `
            + `${[...new Set(upstreamErrorsAll)].slice(0, 5).join(' | ')}`
          );
        } else if (jsErrors.length > 0) {
          console.log(`[页面] JS 错误 (${jsErrors.length} 条, 去重前5): ${[...new Set(jsErrors)].slice(0, 5).join(' | ')}`);
        }

        if (attempt < maxRetries) continue;

        await saveDebugArtifacts(page, debugLabel(`view-unknown-attempt${attempt}`));

        if (sawUpstreamError) {
          const err = new Error(
            `站点/CDN 上游故障：页面资源返回 5xx（${[...new Set(upstreamErrorsAll)].slice(0, 3).join('; ') || '未知'}），稍后重试通常可自愈`
          );
          err.kind = 'upstream';
          throw err;
        }

        const err = new Error(
          `页面结构可能已变化：既没渲染出签到页也没渲染出登录页，且未检测到资源错误（JS 错误: ${[...new Set(jsErrors)].slice(0, 3).join('; ') || '无'}）`
        );
        err.kind = 'structure';
        throw err;
      }

      // 所有 attempt 都没能判定（极端情况）：保守当作需要登录
      return { view: 'login' };
    } finally {
      page.off('response', onResponse);
    }
  }

  try {
    // 步骤 1: 打开应用（直接进签到页，顺带判定登录态是否还有效）
    console.log('[1/5] 打开应用并检测登录态...');
    steps.push('open_app');
    const { view } = await loadAppWithRetry();

    if (view === 'sign') {
      // 会话复用：cookie 还有效，直接进签到环节，省掉填表与滑块
      sessionReused = true;
      loginSuccess = true;
      dashboardUrl = DASHBOARD_PAGE;
      console.log('[2/5] 复用上次登录态（cookie 有效），跳过账号密码与滑块');
      steps.push('session_reused');
      dashboardStats = await loadDashboardStats(page, dashboardUrl);
    } else {
      // 登录态失效：清掉残留 cookie，用账号密码重新登录（新 cookie 会随 profile 落盘）
      console.log('[2/5] 登录态失效，改用账号密码登录...');
      steps.push('fill_credentials');
      await context.clearCookies().catch(() => {});



      // 多种方式查找输入框（更稳健）
      const usernameStrategies = [
        page.getByPlaceholder(/账户|手机号|邮箱|用户名|账号/),
        page.locator('input[type="text"]').first(),
        page.locator('input:not([type="password"])').first(),
        page.locator('input').first(),
      ];
      const passwordStrategies = [
        page.getByPlaceholder(/密码/),
        page.locator('input[type="password"]').first(),
        page.locator('input').filter({ has: page.locator('[class*="password"]') }).first(),
      ];

      let usernameInput = null;
      let passwordInput = null;

      for (const strategy of usernameStrategies) {
        try {
          if (await strategy.count() > 0) {
            usernameInput = strategy;
            break;
          }
        } catch {}
      }
      for (const strategy of passwordStrategies) {
        try {
          if (await strategy.count() > 0) {
            passwordInput = strategy;
            break;
          }
        } catch {}
      }

      if (!usernameInput || !passwordInput) {
        await saveDebugArtifacts(page, debugLabel('login-inputs-not-found'));
        throw new Error('未找到登录输入框，页面可能未正确加载');
      }

      await usernameInput.fill(username);
      await passwordInput.fill(password);
      console.log(`[输入] 账号已填入，密码已填入`);

      // 步骤 3: 点击登录并处理滑块
      console.log('[3/5] 点击登录...');
      steps.push('click_login');

      const loginClickResult = await clickLoginButton(page);
      if (!loginClickResult.clicked) {
        await saveDebugArtifacts(page, 'login-button-not-found');
        throw new Error('未找到登录按钮');
      }

      // 等待一下让滑块可能出现
      await page.waitForTimeout(1500);

      // 检测并处理滑块
      const sliderResult = await handleSliderVerification(page, 30_000);
      sliderHandled = sliderResult.handled;

      if (sliderResult.handled && !sliderResult.success) {
        // 滑块拖拽后仍未通过，可能需要重试
        console.log('[滑块] 第一次拖拽未通过，尝试第二次...');

        // 有些滑块需要等待重置
        await page.waitForTimeout(1000);

        const retryResult = await handleSliderVerification(page, 20_000);
        if (retryResult.handled && !retryResult.success) {
          console.log('[滑块] 重试仍未通过，可能需要手动介入');
        }
      }

      // 滑块验证通过后，再次点击登录按钮完成登录
      if (sliderResult.handled && sliderResult.success) {
        console.log('[登录] 滑块验证通过，再次点击登录...');
        const retryLoginClickResult = await clickLoginButton(page);
        if (!retryLoginClickResult.clicked) {
          await saveDebugArtifacts(page, debugLabel('login-button-not-found-after-slider'));
          throw new Error('滑块验证通过后未找到登录按钮');
        }
        await page.waitForTimeout(2000);
      }

      // 等待登录成功
      loginSuccess = await waitForLoginSuccess(page, 25_000);

      // 登录页是 Vue SPA，滑块通过后的二次点击在 CI 上偶发不跳转。
      // 这跟账号密码无关，页内重新提交一次通常就过去了；
      // 直接判成凭证错误会连带取消后面的重试轮次，代价太大。
      for (let attempt = 1; attempt <= 2 && !loginSuccess; attempt++) {
        if (!page.url().includes('/auth/login')) break;

        console.log(`[登录] 仍在登录页，重新提交登录 (${attempt}/2)...`);
        await page.waitForTimeout(2000);
        await dismissBlockingOverlays(page);

        const reClick = await clickLoginButton(page);
        if (!reClick.clicked) {
          console.log('[登录] 重试时未找到登录按钮');
          break;
        }

        await page.waitForTimeout(1500);
        const retrySlider = await handleSliderVerification(page, 20_000);
        if (retrySlider.handled && retrySlider.success) {
          await clickLoginButton(page).catch(() => {});
        }

        loginSuccess = await waitForLoginSuccess(page, 20_000);
      }

      if (!loginSuccess) {
        // 页内重试也没用，才认为是凭证问题；重试多少次都没意义，直接终止
        const currentUrl = page.url();
        if (currentUrl.includes('/auth/login')) {
          const err = new Error('登录失败：可能账号密码错误或滑块验证未通过');
          err.retryable = false;
          err.kind = 'credentials';
          throw err;
        }
      }

      dashboardUrl = page.url();
      dashboardStats = await loadDashboardStats(page, dashboardUrl);
    }

    // 步骤 4: 跳转签到页
    console.log('[4/5] 跳转签到页...');
    steps.push('goto_sign');

    await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await waitForSignPageReady(page).then(({ ready }) => {
      if (!ready) {
        console.log('[签到] 警告：签到页关键内容未出现，页面可能未渲染完整（判定结果可信度下降）');
      }
    });
    await page.waitForTimeout(1000);
    beforeStats = await extractSignStats(page);

    // 检查是否已签到
    const beforeCheck = await checkSignedToday(page);
    if (beforeCheck.signed && beforeCheck.reliable) {
      const template = buildResultTemplate(beforeStats, dashboardStats, 'already');
      console.log(`[签到] ${beforeCheck.pattern}`);
      console.log('[签到] 今日签到在本轮运行之前就已存在，按「已签到」上报');
      return {
        status: 'already_signed',
        message: template,
        details: {
          steps,
          loginSuccess,
          sliderHandled,
          sessionReused,
          signStats: beforeStats,
          dashboardStats,
          template,
          signedBy: 'already',
          signKind: 'already',
        },
      };
    }

    if (beforeCheck.signed) {
      // 只有软证据（按钮禁用 / 页面出现「签到成功」等模糊文案）——
      // 很可能是页面没渲染完整，不能据此跳过签到，否则会误报「已签到」而实际漏签。
      // 继续往下走点击流程，由签到接口给出最终结论。
      console.log(`[签到] 疑似已签到但证据不足（${beforeCheck.pattern}），不跳过，继续尝试点击签到`);
    }

    // 步骤 5: 点击签到（含重试逻辑，应对 API 返回 "签到失败，请稍后重试"）
    console.log('[5/5] 点击签到按钮...');
    steps.push('click_sign');

    const MAX_SIGN_RETRIES = 3;
    let signRequest = { seen: false };
    let afterCheck = { signed: false };
    let requestCheck = { signed: false };
    let afterStats = beforeStats;
    let signRetries = 0;

    while (signRetries < MAX_SIGN_RETRIES) {
      if (signRetries > 0) {
        console.log(`[签到] 第 ${signRetries + 1}/${MAX_SIGN_RETRIES} 次重试签到...`);
        // 重新加载签到页获取新的 slider_token
        await page.goto(SIGN_PAGE, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await waitForSignPageReady(page).catch(() => ({ ready: false }));
        await page.waitForTimeout(1000);
        await dismissBlockingOverlays(page);
        // 重新检查是否已签到（同样要求硬证据：上一轮只是点击失败，不等于已签到）
        const retryBeforeCheck = await checkSignedToday(page);
        if (retryBeforeCheck.signed && retryBeforeCheck.reliable) {
          console.log(`[签到] 重试时发现已签到: ${retryBeforeCheck.pattern}`);
          afterStats = await extractSignStats(page);
          const retryTemplate = buildResultTemplate(afterStats, dashboardStats, 'already');
          return {
            status: 'already_signed',
            message: retryTemplate,
            details: {
              steps,
              loginSuccess,
              sliderHandled,
              sessionReused,
              signStats: afterStats,
              dashboardStats,
              template: retryTemplate,
              signedBy: 'already',
              signKind: 'already',
            },
          };
        }
      }

      const signRequestPromise = waitForSignRequest(page);
      const clickResult = await clickSignButton(page);

      if (!clickResult.clicked) {
        // 上游 5xx 错误页：页内重试无意义，直接给出明确原因，交给外层换一轮重试
        if (clickResult.serverError) {
          throw new Error(`签到页服务端错误（上游 5xx）：${clickResult.serverError}`);
        }

        if (signRetries + 1 < MAX_SIGN_RETRIES) {
          console.log('[签到] 未找到签到按钮，将重试...');
          signRetries++;
          continue;
        }
        const bodyText = await page.locator('body').innerText().catch(() => '');
        console.log('[签到] 页面内容预览:', bodyText.substring(0, 500));
        throw new Error('未找到签到按钮');
      }

      // 点击成功后，检测并处理可能出现的签到滑块验证
      console.log('[签到] 准备检测签到滑块...');
      await page.waitForTimeout(1500);
      const signSliderResult = await handleSliderVerification(page, 20_000);
      console.log('[签到] 滑块检测完成, handled:', signSliderResult.handled, 'success:', signSliderResult.success);
      if (signSliderResult.handled) {
        console.log('[签到滑块] 处理结果:', signSliderResult.success ? '验证通过' : '验证失败');
        if (signSliderResult.success) {
          await page.waitForTimeout(2000);
          const stillHasSignButton = await page.getByRole('button', { name: '立即签到' }).count();
          if (stillHasSignButton > 0) {
            console.log('[签到] 滑块验证后再次点击签到按钮...');
            await dismissBlockingOverlays(page);
            await page.getByRole('button', { name: '立即签到' }).first().click().catch(() => {});
            await page.waitForTimeout(1500);
          }
        }
      }

      await dismissBlockingOverlays(page);
      await page.waitForTimeout(1000);

      signRequest = await signRequestPromise;
      await waitForSignResult(page);

      // 点击之后才认可「签到成功」这类结果提示文案（此时它确实是本次操作的结果）
      afterCheck = await checkSignedToday(page, { allowSuccessPatterns: true });
      requestCheck = inferSignStateFromRequest(signRequest);
      afterStats = await extractSignStats(page);

      // 判断是否需要重试
      if (afterCheck.signed || requestCheck.signed) {
        break; // 成功，退出重试循环
      }

      // 检查 API 是否返回了可重试的错误
      const apiMsg = signRequest?.json?.message || '';
      if (/签到失败|稍后重试|失败/i.test(apiMsg)) {
        console.log(`[签到] API 返回: "${apiMsg}"，准备重试 (${signRetries + 1}/${MAX_SIGN_RETRIES})`);
        signRetries++;
        continue;
      }

      // 未检测到明确成功/失败 → 也重试
      console.log(`[签到] 未检测到明确结果，准备重试 (${signRetries + 1}/${MAX_SIGN_RETRIES})`);
      signRetries++;
    }

    let afterDashboardStats = dashboardStats;
    if (dashboardUrl) {
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      afterDashboardStats = await loadDashboardStats(page, dashboardUrl);
    }

    if (afterCheck.signed || requestCheck.signed) {
      const signInfo = requestCheck.pattern || afterCheck.pattern;
      // 「本次运行前就已完成」只能由**接口**认定。页面文案不可信：
      // 点完按钮后页面显示「已签到」正是本次点击造成的结果，不能反推成之前就签过；
      // 而页面上的「签到成功」也可能是没渲染完整时残留的静态文案。
      // 反过来，若接口明确回了「已签到 / 重复签到」，那才是真的早就签过了。
      const signKind = /已经签到|已签到|重复签到/i.test(String(requestCheck.pattern || '')) ? 'already' : 'success';
      if (signKind === 'already') {
        console.log(`[签到] 签到接口明确返回已签到（${signInfo}），按「已签到」上报`);
      } else {
        console.log(`[签到] 按「本次运行自动签到成功」上报（判定来源: ${signInfo || '未取到'}）`);
      }
      const template = buildResultTemplate(afterStats, afterDashboardStats, signKind);

      return {
        status: 'success',
        message: template,
        details: {
          steps,
          loginSuccess,
          sliderHandled,
          sessionReused,
          signStats: afterStats,
          dashboardStats: afterDashboardStats,
          template,
          signRequest,
          signInfo,
          signedBy: signKind === 'already' ? 'already' : 'script',
          signKind,
        },
      };
    }

    // 检查是否有 toast 提示
    const toastLocator = page.locator('.el-message, .el-notification').last();
    const toastCount = await toastLocator.count();
    if (toastCount > 0) {
      const toastText = await toastLocator.innerText().catch(() => '');
      if (toastText.includes('成功')) {
        const template = buildResultTemplate(afterStats, afterDashboardStats, 'success');
        return {
          status: 'success',
          message: template,
          details: {
            steps,
            loginSuccess,
            sliderHandled,
            sessionReused,
            signStats: afterStats,
            dashboardStats: afterDashboardStats,
            template,
            signedBy: 'script',
            signKind: 'success',
          },
        };
      }

      throw new Error(`签到失败: ${toastText}`);
    }

    const bodyPreview = await page.locator('body').innerText().catch(() => '');
    console.log('[签到] 最终页面内容预览:', bodyPreview.substring(0, 1000));
    throw new Error('未检测到签到成功或失败提示');

  } finally {
    // persistent context 关闭即等同于关闭浏览器（没有单独的 browser 对象）
    await context.close().catch(() => {});
    console.log(`[清理] 第 ${round} 轮浏览器已关闭`);
  }
}

/**
 * 对外入口：在**一次运行内**做多轮完整重试。
 *
 * 为什么是「整轮重来」而不是「调大单次重试次数」：
 * runner 在海外机房，访问国内 CDN 时遇到的是分钟级回源故障，
 * 单轮内的重试只会反复撞上同一次故障；拉开时间间隔、换全新浏览器实例，
 * 才真正给自己多一次机会。而且成功时第一轮就返回，不额外花时间。
 *
 * 环境变量：
 *   FRP_ROUNDS              最大轮数（默认 3）
 *   FRP_TOTAL_BUDGET_MS     总预算，超时则不再开新轮（默认 18 分钟）
 *   FRP_BLOCK_THIRD_PARTY   第三方资源屏蔽模式 off|safe|strict（默认 safe）
 */
async function pureBrowserCheckIn(options = {}) {
  const {
    username,
    password,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    launchOptions = {},
  } = options;

  const maxRounds = resolveEnvInt('FRP_ROUNDS', 3);
  const totalBudgetMs = resolveEnvInt('FRP_TOTAL_BUDGET_MS', 18 * 60 * 1000);
  const startedAt = Date.now();
  let lastError = null;

  console.log('='.repeat(50));
  console.log('52frp 纯浏览器签到（无 API）');
  console.log('='.repeat(50));
  console.log(`[配置] 最大轮数=${maxRounds} 总预算=${Math.round(totalBudgetMs / 60_000)}分钟`);
  console.log('');

  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      const elapsed = Date.now() - startedAt;
      const remainingMs = totalBudgetMs - elapsed;

      if (remainingMs <= 0) {
        console.log(`[重试] 总预算已用尽（${Math.round(elapsed / 1000)}s），不再开始第 ${round} 轮`);
        break;
      }

      const plannedMs = ROUND_BACKOFF_MS[round - 2] ?? ROUND_BACKOFF_MS[ROUND_BACKOFF_MS.length - 1];
      // 剩余预算不够时不必傻等满，直接开始这一轮
      const waitMs = Math.min(plannedMs, remainingMs);
      if (waitMs < plannedMs) {
        console.log(`[重试] 剩余预算不足以等待 ${Math.round(plannedMs / 1000)}s，缩短为 ${Math.round(waitMs / 1000)}s`);
      } else {
        console.log(`[重试] 等待 ${Math.round(waitMs / 1000)}s 后开始第 ${round}/${maxRounds} 轮...`);
      }
      await sleep(waitMs);
    }

    console.log(`===== 第 ${round}/${maxRounds} 轮 =====`);

    try {
      const result = await attemptCheckInOnce({
        username,
        password,
        timeoutMs,
        launchOptions,
        round,
      });

      if (round > 1) {
        console.log(`[重试] 第 ${round} 轮成功`);
      }

      if (result?.details) {
        result.details.rounds = round;
      }

      return result;
    } catch (error) {
      lastError = error;
      console.log(`[重试] 第 ${round}/${maxRounds} 轮失败: ${error.message}`);

      if (error?.retryable === false) {
        console.log('[重试] 该错误不可重试，已终止后续轮次');
        throw error;
      }
    }
  }

  const finalError = lastError ?? new Error('签到失败：所有轮次均未成功');
  finalError.rounds = maxRounds;
  throw finalError;
}

module.exports = {
  pureBrowserCheckIn,
  attemptCheckInOnce,
  shouldBlockUrl,
  waitForLoginPageRendered,
  waitForAppView,
  waitForLoginFormReady,
  resolveProfileDir,
  resolveCacheEnabled,

  waitForSignPageReady,
  handleSliderVerification,
  clickLoginButton,
  checkSignedToday,
  clickSignButton,
  detectServerErrorPage,
  dismissBlockingOverlays,
  extractDashboardStats,
  extractSignStats,
  buildResultTemplate,
  resolveSignKind,
  getUrlPath,
  loadDashboardStats,
  waitForDashboardStats,
  formatTrafficCompact,
  isLoginPageRenderedText,
  trafficTextToBytes,
  waitForLoginSuccess,
  waitForSignResult,
  waitForSignRequest,
  inferSignStateFromRequest,
};
