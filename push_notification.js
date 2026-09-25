#!/usr/bin/env node

/**
 * 多通道推送入口（CLI + 模块复用）。
 *
 * 用法（workflow 里就是这么调的）：
 *   node push_notification.js "$CHECKIN_MESSAGE"
 *
 * 入参是签到脚本输出的结果文本，标题 / 时间 / 账号标识由 src/notify 统一补齐，
 * 再按环境变量自动启用的渠道各发一份。
 *
 * 环境变量（全部可选，配了才启用对应渠道，详见 README）：
 *   SENDKEY / SERVERCHAN_KEY / TG_BOT_TOKEN+TG_CHAT_ID / PUSHPLUS_TOKEN+PUSHPLUS_CHANNEL /
 *   DINGTALK_WEBHOOK+DINGTALK_SECRET / FEISHU_WEBHOOK+FEISHU_SECRET / WECOM_BOT_WEBHOOK /
 *   YUNHU_TOKEN+YUNHU_RECV_ID / BARK_KEY / WXPUSHER_TOKEN / WEBHOOK_URL
 *
 * 调优参数：
 *   PUSH_TIMEOUT_MS          单渠道请求超时，默认 15000
 *   PUSH_MAX_RETRY           可重试错误的最大重试次数，默认 2
 *   PUSH_RETRY_MIN_WAIT_MS   重试初始退避，默认 1000（指数退避）
 *   PUSH_RETRY_MAX_WAIT_MS   退避上限，默认 8000
 *   PUSH_STRICT              设为 1/true 时，已配置的渠道全失败才让本步骤失败退出；
 *                            默认不开启 —— 推送失败不应该把签到运行标红
 */

const { sendNotification, PUSH_CHANNELS, buildPushContent } = require('./src/notify');
const { readBool } = require('./src/notify/request');
const { loadEnvFile } = require('./src/config');

// 旧版导出的两个单渠道函数保留同名导出（签名改为 (title, content)，与统一内容格式一致）
const { pushPlus: sendPushPlus, pushTelegram: sendTelegram } = require('./src/notify/channels');

async function main() {
  // 本地跑时允许从 .env 读推送配置（Actions 里没有 .env，等同空操作）
  loadEnvFile();

  const message = process.argv.slice(2).join(' ').trim();

  if (!message) {
    console.error('Usage: node push_notification.js <checkin_message>');
    process.exit(1);
  }

  let summary;
  try {
    summary = await sendNotification(message);
  } catch (error) {
    // sendNotification 内部已经逐个渠道兜底了异常，走到这里说明是构建内容之类的意外错误
    console.error(`推送失败: ${error?.message || error}`);
    process.exit(1);
  }

  if (summary.allFailed) {
    console.error(`已配置的 ${summary.configured} 个推送渠道全部失败，详见上方各渠道日志`);
    if (readBool('PUSH_STRICT', false)) {
      process.exit(1);
    }
    console.log('提示: 未开启 PUSH_STRICT，推送失败不影响本次运行的最终状态');
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  sendNotification,
  sendPushPlus,
  sendTelegram,
  buildPushContent,
  PUSH_CHANNELS,
};
