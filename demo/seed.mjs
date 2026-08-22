#!/usr/bin/env node
/**
 * demo 工作流导入脚本：读取 demo/workflows/*.json，按名称幂等导入到 FlowAgent server。
 * 用法：先启动 server（pnpm dev），再 pnpm seed:demos；可用 FLOWAGENT_URL 覆盖地址。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = (process.env.FLOWAGENT_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const WORKFLOWS_DIR = fileURLToPath(new URL('./workflows/', import.meta.url));

async function api(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(`${path} HTTP ${response.status}: ${body?.message ?? ''}`);
  }
  return response.status === 204 ? null : response.json();
}

async function main() {
  const files = (await readdir(WORKFLOWS_DIR)).filter((file) => file.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`未找到 demo 工作流: ${WORKFLOWS_DIR}`);

  const existing = await api('/api/workflows');
  const existingNames = new Set(existing.map((workflow) => workflow.name));

  let created = 0;
  let skipped = 0;
  for (const file of files) {
    const definition = JSON.parse(await readFile(join(WORKFLOWS_DIR, file), 'utf-8'));
    if (typeof definition.name !== 'string' || definition.name.length === 0) {
      throw new Error(`${file} 缺少 name`);
    }
    if (existingNames.has(definition.name)) {
      console.log(`跳过（已存在）: ${definition.name}`);
      skipped += 1;
      continue;
    }
    await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: definition.name,
        description: definition.description ?? null,
        definition,
      }),
    });
    console.log(`已导入: ${definition.name}`);
    created += 1;
  }
  console.log(`完成：导入 ${created} 个，跳过 ${skipped} 个（FlowAgent: ${BASE_URL}）`);
}

main().catch((error) => {
  console.error('seed 失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
