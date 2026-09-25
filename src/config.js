const fs = require('node:fs');
const path = require('node:path');

function stripWrappingQuotes(value) {
  if (typeof value !== 'string' || value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

function loadEnvFile({ envPath = path.resolve(process.cwd(), '.env'), env = process.env } = {}) {
  if (!fs.existsSync(envPath)) {
    return { loaded: false, envPath };
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || env[key]) {
      continue;
    }

    const rawValue = line.slice(separatorIndex + 1).trim();
    env[key] = stripWrappingQuotes(rawValue);
  }

  return { loaded: true, envPath };
}

/**
 * 账号脱敏：只留前 3 位与（长度足够时的）后 3 位。
 * 推送正文里要带账号标识，但绝不能把完整账号写进日志 / 通知。
 */
function maskAccount(username) {
  if (!username) return '未配置';
  const head = username.substring(0, 3);
  const tail = username.length > 6 ? username.substring(username.length - 3) : '';
  return `${head}***${tail}`;
}

function getCredentials(options = {}) {
  const { env = process.env } = options;
  loadEnvFile(options);

  return {
    username: env.FRP_USERNAME,
    password: env.FRP_PASSWORD,
  };
}

module.exports = {
  loadEnvFile,
  getCredentials,
  maskAccount,
};
