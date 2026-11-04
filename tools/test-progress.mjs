// 进度 / 取消的端到端验证：造一批文件 → 预览 → 提交（并发轮询进度）→ 中途取消
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:56497';
const DIR = 'E:\\ruanjianxiazai\\deepseek\\work\\_progresstest';
const url = (p) => `${BASE}/dsh-github-sync${p}`;
const post = async (p, body) => (await fetch(url(p), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
})).json();
const get = async (p) => (await fetch(url(p))).json();

// 1) 造 30 个 100KB 文件
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
for (let i = 0; i < 30; i++) {
  writeFileSync(join(DIR, `f${String(i).padStart(2, '0')}.bin`), Buffer.alloc(100 * 1024, i));
}
console.log('已造 30 个文件 × 100KB');

// 2) 预览
const prev = await post('/folder/preview', { path: DIR, cwd: 'E:\\ruanjianxiazai\\deepseek\\work' });
if (!prev.ok) { console.error('预览失败:', prev); process.exit(1); }
console.log(`预览：${prev.summary.upload} 个文件，${Math.round(prev.summary.bytes / 1024)}KB`);

// 3) 提交 + 并发轮询
const tid = 'test-' + Date.now();
let stopped = false;
const poller = setInterval(async () => {
  if (stopped) return;
  try {
    const p = await get(`/progress?id=${tid}`);
    if (p.ok) console.log(`  进度 ${p.done}/${p.total} · ${p.phase}${p.currentPath ? ' · ' + p.currentPath.split('/').pop() : ''}`);
  } catch { /* 忽略 */ }
}, 400);

const CANCEL_AFTER_MS = Number(process.argv[3] || 1200);
const commitPromise = post('/folder/commit', { previewId: prev.previewId, transferId: tid });

// 到点取消（0 = 不取消，跑完整流程）
if (CANCEL_AFTER_MS > 0) {
  setTimeout(async () => {
    const c = await post('/cancel', { transferId: tid });
    console.log('取消请求:', JSON.stringify(c));
  }, CANCEL_AFTER_MS);
}

const done = await commitPromise;
stopped = true;
clearInterval(poller);
console.log('提交结果:', JSON.stringify(done));

// 5) 收尾
rmSync(DIR, { recursive: true, force: true });
console.log(`清理测试目录: ${!existsSync(DIR)}`);
