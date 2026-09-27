#!/usr/bin/env node

/**
 * 52frp 自动签到（Playwright 浏览器自动化）
 *
 * 用真实浏览器模拟人工操作：打开登录页 → 填账号密码 → 过滑块 → 点签到。
 *
 * 配置：
 *   FRP_USERNAME / FRP_PASSWORD   必填
 *   TG_BOT_TOKEN / TG_CHAT_ID 等   推送渠道，见 .env.example
 *
 * 可选配置：
 *   FRP_BROWSER_CHANNEL   浏览器通道，默认 chromium
 *   FRP_BROWSER_HEADLESS  是否无头，默认 true（无显示器 / cron 环境可直接跑）
 *   FRP_TIMEOUT_MS        整体超时（毫秒）
 *
 * 用法：
 *   node checkin-v2.js              # 只签到，结果打到 stdout
 *   ./run-daily.sh                  # 签到 + 推送
 */

const { getCredentials, maskAccount } = require('./src/config');
const { runCheckin, buildNotice, resolveOrder, STRATEGIES, STATUS } = require('./src/checkin');

function readArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : null;
}

function resolveStrategy() {
  // --strategy / CHECKIN_STRATEGY 仅为兼容旧配置保留，
  // 无论传什么都归一为浏览器方式（见 src/checkin/runner.js 的 resolveOrder）。
  return readArg('strategy') || process.env.CHECKIN_STRATEGY || 'browser';
}

async function main() {
  const { username, password } = getCredentials();

  console.log('='.repeat(50));
  console.log('52frp 自动签到 v2（浏览器自动化）');
  console.log('='.repeat(50));
  console.log(`账号: ${maskAccount(username)}`);

  if (!username || !password) {
    console.error('');
    console.error('错误: 请先配置 FRP_USERNAME 和 FRP_PASSWORD');
    console.error('');
    console.error('方式1: 环境变量');
    console.error('  FRP_USERNAME=xxx FRP_PASSWORD=yyy node checkin-v2.js');
    console.error('');
    console.error('方式2: .env 文件');
    console.error('  cp .env.example .env   # 编辑填入账号密码');
    console.error('  node checkin-v2.js');
    process.exit(1);
  }

  const strategy = resolveStrategy();
  const order = resolveOrder(strategy);
  console.log(
    `[配置] 执行顺序: ${order.map((id) => STRATEGIES[id]?.label || id).join(' → ') || '(空)'}`
  );
  console.log('');

  let result;
  try {
    result = await runCheckin({
      username,
      password,
      order: strategy,
      timeoutMs: process.env.FRP_TIMEOUT_MS ? Number.parseInt(process.env.FRP_TIMEOUT_MS, 10) : undefined,
    });
  } catch (error) {
    // 调度器内部不应抛到这里；万一抛了也必须留下可读原因，不能静默退出
    console.error('');
    console.error('='.repeat(50));
    console.error(`错误: 签到调度异常: ${error?.message || error}`);
    console.error('='.repeat(50));
    console.error('');
    console.log(`CHECKIN_RESULT: 52frp签到失败\n\n失败原因：签到调度异常（${error?.message || error}）\n\n请手动签到一次，避免断签`);
    process.exit(1);
  }

  const notice = buildNotice(result, { attempts: result.attempts || [] });

  console.log('');
  console.log('='.repeat(50));
  console.log(`结果: ${result.status}`);
  console.log(`执行方式: ${result.strategy ? STRATEGIES[result.strategy]?.label || result.strategy : '无（全部失败）'}`);
  for (const attempt of result.attempts || []) {
    console.log(`  - ${STRATEGIES[attempt.strategy]?.label || attempt.strategy}: ${attempt.status}（${Math.round(attempt.durationMs / 1000)}s）${attempt.reason ? ` — ${attempt.reason}` : ''}`);
  }
  if (result.status === STATUS.ERROR) {
    console.error(`失败原因: ${result.reason}`);
  }
  console.log('='.repeat(50));
  console.log('');

  // CHECKIN_RESULT 之后的行才会被 workflow 收集进推送，推送文案必须完整放这里
  console.log(`CHECKIN_RESULT: ${notice}`);

  if (result.status === STATUS.SUCCESS || result.status === STATUS.ALREADY) {
    process.exit(0);
  }
  process.exit(1);
}

main();
