/**
 * Provider 密钥加密存储：AES-256-GCM + scrypt 派生主密钥。
 *
 * 安全约束：
 * - 主密钥来自环境变量 FLOWAGENT_SECRET_KEY（scrypt + 固定盐派生）：未设置、短于 8 字符视为未设置，
 *   8-31 字符视为强度不足（告警一次）——两者均不启用加密能力；
 * - 密文格式 `v1:<ivB64>:<tagB64>:<dataB64>`，GCM 认证标签保证篡改可检测；
 * - 任何日志/异常消息不得包含明文密钥或密钥派生材料。
 */

import { Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** 主密钥来源环境变量名 */
export const SECRET_KEY_ENV = 'FLOWAGENT_SECRET_KEY';

/** scrypt 固定盐（非保密，仅用于派生域分离） */
const KDF_SALT = 'flowagent-provider-config';

/** AES-256 密钥长度（字节） */
const KEY_LENGTH = 32;

/** GCM 推荐 IV 长度（字节） */
const IV_LENGTH = 12;

/** GCM 认证标签长度（字节） */
const TAG_LENGTH = 16;

/** 启用加密能力的最短主密钥长度（推荐 `openssl rand -hex 32` 生成，即 64 字符） */
const MIN_SECRET_LENGTH = 32;

/** 弱密钥告警下限：低于该长度视为未设置（不告警） */
const WEAK_SECRET_LENGTH = 8;

/** 密文格式版本前缀 */
const PAYLOAD_PREFIX = 'v1';

const logger = new Logger('ProviderCrypto');

/** 上次弱密钥告警对应的密钥值（同一密钥只告警一次，避免每次调用刷日志） */
let weakSecretWarned: string | null = null;

/** 加密/解密失败的统一异常（消息为中文，绝不携带密钥材料或密文内容） */
export class SecretEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretEncryptionError';
  }
}

/** 加密能力未启用（FLOWAGENT_SECRET_KEY 未设置或长度不足）时抛出 */
export class SecretEncryptionDisabledError extends SecretEncryptionError {}

let cachedSecret: string | null = null;
let cachedKey: Buffer | null = null;

/**
 * 从环境变量派生 32 字节主密钥（scrypt）。
 * 未设置、短于 WEAK_SECRET_LENGTH（视为未设置，不告警）或不足 MIN_SECRET_LENGTH（视为强度不足，告警一次）时
 * 返回 null（加密能力未启用）。
 */
function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = env[SECRET_KEY_ENV];
  if (!secret || secret.length < WEAK_SECRET_LENGTH) return null;
  if (secret.length < MIN_SECRET_LENGTH) {
    if (weakSecretWarned !== secret) {
      weakSecretWarned = secret;
      logger.warn(`${SECRET_KEY_ENV} 强度不足（建议 openssl rand -hex 32），网页端配置已禁用`);
    }
    return null;
  }
  if (cachedKey && cachedSecret === secret) return cachedKey;
  const key = scryptSync(secret, KDF_SALT, KEY_LENGTH);
  cachedSecret = secret;
  cachedKey = key;
  return key;
}

/** 加密能力是否已启用（主密钥可派生），供设置页判断 configurable */
export function isEncryptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadMasterKey(env) !== null;
}

/**
 * 加密明文密钥，返回 `v1:<ivB64>:<tagB64>:<dataB64>` 密文。
 * @throws SecretEncryptionDisabledError 主密钥未启用
 */
export function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = loadMasterKey(env);
  if (!key) {
    throw new SecretEncryptionDisabledError(
      `未设置 ${SECRET_KEY_ENV} 或长度不足，无法加密保存密钥；请在服务端环境变量中设置后重启`,
    );
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PAYLOAD_PREFIX,
    iv.toString('base64'),
    tag.toString('base64'),
    data.toString('base64'),
  ].join(':');
}

/**
 * 解密 `v1:<ivB64>:<tagB64>:<dataB64>` 密文，返回明文密钥。
 * 密文被篡改、格式不合法或主密钥不匹配时一律抛 SecretEncryptionError（消息不含明文）。
 * @throws SecretEncryptionDisabledError 主密钥未启用
 * @throws SecretEncryptionError 密文格式不合法 / 篡改 / 主密钥不匹配
 */
export function decryptSecret(payload: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = loadMasterKey(env);
  if (!key) {
    throw new SecretEncryptionDisabledError(
      `未设置 ${SECRET_KEY_ENV} 或长度不足，无法解密已保存的密钥；请在服务端环境变量中设置后重启`,
    );
  }
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PAYLOAD_PREFIX) {
    throw new SecretEncryptionError('密文格式不合法');
  }
  const [, ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart ?? '', 'base64');
  const tag = Buffer.from(tagPart ?? '', 'base64');
  const data = Buffer.from(dataPart ?? '', 'base64');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH || data.length === 0) {
    throw new SecretEncryptionError('密文格式不合法');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // GCM 认证失败：密文被篡改或主密钥不匹配。吞掉底层细节，避免泄漏任何材料。
    throw new SecretEncryptionError('密文校验失败：密文已损坏或主密钥不匹配');
  }
}
