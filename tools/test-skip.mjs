// 验证"可展开明细 + 单文件跳过"：造 8 个文件 → 提交中途跳过第 3 个 → 结果应只提交 7 个
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:56497';
const DIR = 'E:\\ruanjianxiazai\\deepseek\\work\\_skiptest';
const url = (p) => `${BASE}/dsh-github-sync${p}`;
const post = async (p, b) => (await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })).json();
const get = async (p) => (await fetch(url(p))).json();

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
for (let i = 0; i < 8; i++) writeFileSync(join(DIR, `s${i}.bin`), Buffer.alloc(200 * 1024, i));
console.log('已造 8 个文件 × 200KB');

const prev = await post('/folder/preview', { path: DIR, cwd: 'E:\\ruanjianxiazai\\deepseek\\work' });
if (!prev.ok) { console.error('预览失败', prev); process.exit(1); }
console.log(`预览：${prev.summary.upload} 个文件`);

const tid = 'skip-' + Date.now();
const target = prev.items.filter((i) => i.action === 'upload')[2]?.title;
console.log('准备跳过的文件:', target);

const poller = setInterval(async () => {
  try {
    const p = await get(`/progress?id=${tid}`);
    if (p.ok && Array.isArray(p.files)) {
      const s = p.files.map((f) => `${f.path}:${f.state[0]}`).join(' ');
      console.log(`  ${p.done}/${p.total} ${p.phase} | ${s}`);
    }
  } catch { /* 忽略 */ }
}, 600);

const commitPromise = post('/folder/commit', { previewId: prev.previewId, transferId: tid });

setTimeout(async () => {
  const r = await post('/skip', { transferId: tid, filePath: `work/files/${target}` });
  console.log('跳过请求:', JSON.stringify(r));
}, 900);

const done = await commitPromise;
clearInterval(poller);
console.log('提交结果:', JSON.stringify(done));
rmSync(DIR, { recursive: true, force: true });
console.log(`期望提交 7 个，实际 ${done.files} 个 → ${done.files === 7 ? '✅' : '❌'}`);
