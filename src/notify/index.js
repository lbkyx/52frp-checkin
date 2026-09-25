'use strict';

/**
 * 推送层对外入口。
 *
 * 上层（workflow / CLI）只需要：
 *   const { sendNotification } = require('./src/notify');
 *   await sendNotification(checkinResultText);
 *
 * 行为约定：
 *   - 渠道按环境变量自动启用，没配的跳过，配了多个就并发都发；
 *   - 单个渠道失败只记录日志，不影响其它渠道，也不向调用方抛异常；
 *   - 返回每个渠道的结果，便于调用方决定要不要把运行标红。
 */

const { PUSH_CHANNELS } = require('./channels');
const { buildPushContent, buildTitle, buildContent, formatPushText, formatTime } = require('./content');
const { readEnv } = require('./request');

/**
 * 推送到所有已配置的渠道。
 *
 * @param {string} message 签到结果文本（通常来自 CHECKIN_RESULT 之后的内容）
 * @param {object} [options]
 * @param {string} [options.username] 账号标识来源，默认取 FRP_USERNAME（会脱敏）
 * @param {Date}   [options.now]
 * @param {Array}  [options.channels] 覆盖渠道列表（测试用）
 * @returns {Promise<{title: string, content: string, results: Array, success: number, configured: number, allFailed: boolean}>}
 */
async function sendNotification(message, options = {}) {
  const { channels = PUSH_CHANNELS } = options;
  const { title, content } = buildPushContent(message, options);

  const tasks = channels.map(async (channel) => {
    const missing = channel.env.filter((name) => !readEnv(name));
    if (missing.length > 0) {
      console.log(`${channel.name}: 未配置 ${missing.join('、')}，跳过推送`);
      return { name: channel.name, enabled: false, ok: false, error: null };
    }

    try {
      const ok = await channel.send(title, content);
      return { name: channel.name, enabled: true, ok: Boolean(ok), error: null };
    } catch (error) {
      // 理论上不会走到这里（渠道内部已收敛），兜住以防新增渠道忘了处理
      console.warn(`${channel.name}: 推送异常 ${error?.message || error}`);
      return { name: channel.name, enabled: true, ok: false, error: error?.message || String(error) };
    }
  });

  const settled = await Promise.allSettled(tasks);
  const results = settled.map((item, index) =>
    item.status === 'fulfilled'
      ? item.value
      : {
          name: channels[index]?.name || `#${index}`,
          enabled: true,
          ok: false,
          error: item.reason?.message || String(item.reason),
        }
  );

  const configured = results.filter((r) => r.enabled);
  const success = configured.filter((r) => r.ok).length;

  console.log(`[推送] 标题：${title}`);
  if (configured.length === 0) {
    console.log('[推送] 未配置任何推送渠道，跳过（签到结果只在 Actions 日志里可见）');
  } else {
    const summary = configured.map((r) => `${r.name}${r.ok ? '成功' : '失败'}`).join('、');
    console.log(`[推送] 已配置渠道：${summary}（成功 ${success}/${configured.length}）`);
  }

  return {
    title,
    content,
    results,
    success,
    configured: configured.length,
    allFailed: configured.length > 0 && success === 0,
  };
}

/** 列出当前已启用的渠道名，便于自检配置是否正确 */
function listConfiguredChannels(options = {}) {
  const { channels = PUSH_CHANNELS } = options;
  return channels.filter((channel) => channel.env.every((name) => readEnv(name))).map((c) => c.name);
}

module.exports = {
  sendNotification,
  listConfiguredChannels,
  buildPushContent,
  buildTitle,
  buildContent,
  formatPushText,
  formatTime,
  PUSH_CHANNELS,
};
