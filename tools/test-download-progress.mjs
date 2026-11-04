// 验证下载侧也有进度：藏一个附件对象 → 下载预览 → 带 transferId 执行并轮询
import { existsSync, renameSync, rmSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:56497';
const SID = 'session-06f8ae05-3a38-43e8-9dd6-7e09d7bc1990';
const CWD = 'E:\\ruanjianxiazai\\deepseek\\work';
const SHA = '74f9219de1b3fe56d700918cdcaf7a6b0bc562bcde6b139a3bbd353a6a738215';
const OBJ = `C:\\Users\\14507\\.dsh\\attachments\\v1\\objects\\74\\${SHA}`;

const url = (p) => `${BASE}/dsh-github-sync${p}`;
const post = async (p, b) => (await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })).json();
const get = async (p) => (await fetch(url(p))).json();

// 藏起来（模拟 B 机没有它）
if (existsSync(OBJ)) renameSync(OBJ, OBJ + '.bak');
console.log('附件对象已藏起:', !existsSync(OBJ));

const prev = await post('/download/preview', { ids: [SID], targetCwd: CWD });
if (!prev.ok) { console.error('预览失败', prev); process.exit(1); }
const atts = (prev.items?.[0]?.attachments || []).length;
console.log(`预览：会话动作=${prev.items?.[0]?.action} 附件项=${atts}`);

const tid = 'dl-' + Date.now();
const poller = setInterval(async () => {
  try {
    const p = await get(`/progress?id=${tid}`);
    if (p.ok) console.log(`  进度 ${p.done}/${p.total} · ${p.phase}${p.currentPath ? ' · ' + String(p.currentPath).split('\\').pop() : ''}`);
  } catch { /* 忽略 */ }
}, 250);

const done = await post('/download', { previewId: prev.previewId, transferId: tid });
clearInterval(poller);
console.log('结果:', JSON.stringify(done));

const back = existsSync(OBJ);
console.log('附件已还原:', back, back ? `${(await import('node:fs')).statSync(OBJ).size} 字节` : '');
if (back) { try { rmSync(OBJ + '.bak'); } catch { /* 忽略 */ } }
