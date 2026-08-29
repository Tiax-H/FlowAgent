import { afterEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';

import {
  decryptSecret,
  encryptSecret,
  isEncryptionEnabled,
  SECRET_KEY_ENV,
  SecretEncryptionDisabledError,
  SecretEncryptionError,
} from '../src/llm/provider-crypto';

const SECRET_A = 'master-secret-alpha-0123456789abcdef';
const SECRET_B = 'master-secret-bravo-0123456789fedcba';
const PLAIN_KEY = 'sk-plain-test-key-9527';

function envWith(secret: string): NodeJS.ProcessEnv {
  return { [SECRET_KEY_ENV]: secret };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provider-crypto 加密往返', () => {
  it('encryptSecret/decryptSecret 往返还原明文（含中文与特殊字符）', () => {
    const payload = encryptSecret(PLAIN_KEY, envWith(SECRET_A));
    expect(decryptSecret(payload, envWith(SECRET_A))).toBe(PLAIN_KEY);

    const unicode = '密钥-with-中文-和-符号！@#';
    expect(decryptSecret(encryptSecret(unicode, envWith(SECRET_A)), envWith(SECRET_A))).toBe(
      unicode,
    );
  });

  it('密文格式为 v1:<ivB64>:<tagB64>:<dataB64>，iv 12 字节 / tag 16 字节，随机 iv 使两次密文不同', () => {
    const first = encryptSecret(PLAIN_KEY, envWith(SECRET_A));
    const second = encryptSecret(PLAIN_KEY, envWith(SECRET_A));
    expect(first).not.toBe(second);

    const parts = first.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1] ?? '', 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[2] ?? '', 'base64')).toHaveLength(16);
    expect((parts[3] ?? '').length).toBeGreaterThan(0);
    // 密文不含明文
    expect(first).not.toContain(PLAIN_KEY);
  });
});

describe('provider-crypto 篡改与错钥检测', () => {
  it('密文 data 部分被篡改 → 解密抛 SecretEncryptionError，不还原明文', () => {
    const payload = encryptSecret(PLAIN_KEY, envWith(SECRET_A));
    const parts = payload.split(':');
    const dataPart = parts[3] ?? '';
    const tampered = [parts[0], parts[1], parts[2], `X${dataPart.slice(1)}`].join(':');
    expect(() => decryptSecret(tampered, envWith(SECRET_A))).toThrow(SecretEncryptionError);
  });

  it('认证标签被篡改 → 解密抛 SecretEncryptionError', () => {
    const payload = encryptSecret(PLAIN_KEY, envWith(SECRET_A));
    const parts = payload.split(':');
    const tagPart = parts[2] ?? '';
    const tampered = [parts[0], parts[1], `X${tagPart.slice(1)}`, parts[3]].join(':');
    expect(() => decryptSecret(tampered, envWith(SECRET_A))).toThrow(SecretEncryptionError);
  });

  it('主密钥不匹配（换了 FLOWAGENT_SECRET_KEY）→ 解密抛 SecretEncryptionError', () => {
    const payload = encryptSecret(PLAIN_KEY, envWith(SECRET_A));
    expect(() => decryptSecret(payload, envWith(SECRET_B))).toThrow(SecretEncryptionError);
  });

  it('格式不合法（段数不足/前缀错误）→ 抛 SecretEncryptionError', () => {
    expect(() => decryptSecret('not-a-payload', envWith(SECRET_A))).toThrow(SecretEncryptionError);
    expect(() => decryptSecret('v2:a:b:c', envWith(SECRET_A))).toThrow(SecretEncryptionError);
    expect(() => decryptSecret('v1:only:three', envWith(SECRET_A))).toThrow(SecretEncryptionError);
  });

  it('异常消息为中文且绝不包含明文密钥与主密钥', () => {
    const payload = encryptSecret(PLAIN_KEY, envWith(SECRET_A));
    const attempts: Array<() => void> = [
      () => decryptSecret(payload, envWith(SECRET_B)),
      () => decryptSecret('garbage', envWith(SECRET_A)),
      () => encryptSecret(PLAIN_KEY, {}),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        expect.unreachable('应当抛出 SecretEncryptionError');
      } catch (error) {
        expect(error).toBeInstanceOf(SecretEncryptionError);
        expect((error as Error).message).not.toContain(PLAIN_KEY);
        expect((error as Error).message).not.toContain(SECRET_A);
        expect((error as Error).message).not.toContain(SECRET_B);
      }
    }
  });
});

describe('provider-crypto 加密能力开关', () => {
  it('未设置 FLOWAGENT_SECRET_KEY → 加密能力未启用，encrypt/decrypt 抛 Disabled', () => {
    expect(isEncryptionEnabled({})).toBe(false);
    expect(() => encryptSecret(PLAIN_KEY, {})).toThrow(SecretEncryptionDisabledError);
    expect(() => decryptSecret('v1:a:b:c', {})).toThrow(SecretEncryptionDisabledError);
  });

  it('FLOWAGENT_SECRET_KEY 过短（<8 字符，视为未设置）→ 未启用且不告警', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(isEncryptionEnabled(envWith('short'))).toBe(false);
    expect(() => encryptSecret(PLAIN_KEY, envWith('short'))).toThrow(SecretEncryptionDisabledError);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('FLOWAGENT_SECRET_KEY 8-31 字符 → 视为强度不足：未启用，同一密钥只告警一次', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const weak = 'a'.repeat(31);
    expect(isEncryptionEnabled(envWith(weak))).toBe(false);
    expect(() => encryptSecret(PLAIN_KEY, envWith(weak))).toThrow(SecretEncryptionDisabledError);
    // 同一密钥重复检查不重复告警；消息为中文、含环境变量名与修复建议，不含密钥本身
    expect(isEncryptionEnabled(envWith(weak))).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0]);
    expect(message).toContain(SECRET_KEY_ENV);
    expect(message).toContain('强度不足');
    expect(message).toContain('openssl rand -hex 32');
    expect(message).not.toContain(weak);
    warnSpy.mockRestore();
  });

  it('FLOWAGENT_SECRET_KEY 达到 32 字符 → 加密能力启用', () => {
    const threshold = '1'.repeat(32);
    expect(isEncryptionEnabled(envWith(threshold))).toBe(true);
    const payload = encryptSecret(PLAIN_KEY, envWith(threshold));
    expect(decryptSecret(payload, envWith(threshold))).toBe(PLAIN_KEY);
  });

  it('主密钥变更后（进程复用派生缓存）新密钥仍正确派生，旧密文解不开', () => {
    const payloadA = encryptSecret(PLAIN_KEY, envWith(SECRET_A));
    const payloadB = encryptSecret(PLAIN_KEY, envWith(SECRET_B));
    expect(decryptSecret(payloadB, envWith(SECRET_B))).toBe(PLAIN_KEY);
    expect(() => decryptSecret(payloadA, envWith(SECRET_B))).toThrow(SecretEncryptionError);
    expect(() => decryptSecret(payloadB, envWith(SECRET_A))).toThrow(SecretEncryptionError);
  });
});
