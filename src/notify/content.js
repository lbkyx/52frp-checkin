'use strict';

/**
 * 统一推送内容。
 *
 * 各渠道共用同一份「标题 + 正文」，避免同一个签到结果在不同渠道里长得不一样。
 * 签到脚本只负责把结果文本（CHECKIN_RESULT 之后的内容）交给推送层，
 * 标题、时间、账号标识都在这里补齐。
 *
 * 正文固定包含四类信息（能取到就填，取不到显示「未取到」而不是编造）：
 *   执行时间 / 账号标识 / 签到结果（含流量变化）/ 失败原因
 */

const { maskAccount } = require('../config');

const TITLE_MAX_LENGTH = 60;

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * 按 UTC+8 输出时间。
 * GitHub Actions 的 runner 是 UTC，直接用本地时间会显示成凌晨，
 * 而签到的 cron 是按北京时间配的，所以这里固定换算成北京时间。
 */
function formatTime(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} (UTC+8)`
  );
}

/** 给标题加一个一眼能看出成败的前缀 */
function statusEmoji(line) {
  if (/失败|错误|异常|error/i.test(line)) return '❌';
  if (/已签到|无需重复|repeat/i.test(line)) return '🔄';
  if (/成功/.test(line)) return '✅';
  return '📋';
}

function firstNonEmptyLine(body) {
  return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

/**
 * 由签到结果文本推导标题：取第一条非空行（v1 的 `error:xxx` 也一并规范化）。
 */
function buildTitle(body) {
  const first = firstNonEmptyLine(body);
  if (!first) return '📋 52frp 自动签到通知';

  let title = first.replace(/^(CHECKIN_RESULT|error)\s*[:：]\s*/i, '').trim();
  if (!title) title = '52frp 自动签到通知';
  if (!/^52frp/i.test(title)) title = `52frp ${title}`;
  if (title.length > TITLE_MAX_LENGTH) title = `${title.slice(0, TITLE_MAX_LENGTH)}...`;

  return `${statusEmoji(first)} ${title}`;
}

/**
 * 正文 = 固定头部（时间 / 账号）+ 签到结果详情。
 * 首行已经被用作标题，正文中不再重复（单行消息则保留原文，避免丢信息）。
 */
function buildContent(body, options = {}) {
  const { now = new Date(), username = process.env.FRP_USERNAME } = options;

  const lines = [formatTime(now), `👤 账号：${maskAccount(username)}`, '————————————'];

  const trimmed = String(body || '').replace(/^(CHECKIN_RESULT)\s*[:：]\s*/i, '').trim();
  if (trimmed) {
    const rest = trimmed.split(/\r?\n/);
    rest.shift(); // 首行已作为标题
    const detail = rest.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '');
    if (detail) lines.push('', detail);
  } else {
    lines.push('', '（未收到签到结果内容）');
  }

  return lines.join('\n');
}

/** 把标题与正文拼成单段文本，供只支持单文本字段的渠道使用 */
function formatPushText(title, content) {
  return `${title}\n\n${content}`;
}

/**
 * 由签到结果文本生成统一推送内容。
 * @param {string} message 签到脚本输出的结果文本
 * @param {{now?: Date, username?: string}} options
 * @returns {{title: string, content: string}}
 */
function buildPushContent(message, options = {}) {
  const body = String(message ?? '').trim();
  return {
    title: buildTitle(body),
    content: buildContent(body, options),
  };
}

module.exports = {
  TITLE_MAX_LENGTH,
  formatTime,
  statusEmoji,
  buildTitle,
  buildContent,
  buildPushContent,
  formatPushText,
};
