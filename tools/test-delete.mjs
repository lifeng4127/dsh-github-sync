// 删除语义验收：本地删除不影响仓库；仓库删除不影响本地；附件随会话回收
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectKey } from '../lib/projectkey.mjs';

const BASE = process.env.SYNC_BASE || 'http://127.0.0.1:62798';
const API = `${BASE}/dsh-github-sync`;
const DSH_HOME = process.env.DSH_HOME || 'C:\\Users\\14507\\.dsh';
const CWD = 'E:\\ruanjianxiazai\\deepseek\\work';

const post = async (p, b) => (await fetch(API + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}),
})).json();
const get = async (p) => (await fetch(API + p)).json();
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);

// ---------- 1. 本地删除：不应影响仓库 ----------
console.log('\n[1] 本地删除独立于仓库');
const scratchCwd = join(CWD, '_del-test');
const fakeId = 'session-del-test-0001';
const dir = join(DSH_HOME, 'sessions', projectKey(scratchCwd), fakeId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
const remoteBefore = await get('/remote');
const r1 = await post('/delete-local', { id: fakeId, cwd: scratchCwd });
ok('接口成功', r1.ok === true, JSON.stringify({ freedAttachments: r1.freedAttachments }));
ok('目录已删除', !existsSync(dir));
const remoteAfter = await get('/remote');
ok('仓库会话数未变', remoteBefore.sessions.length === remoteAfter.sessions.length,
  `${remoteBefore.sessions.length} → ${remoteAfter.sessions.length}`);
rmSync(scratchCwd, { recursive: true, force: true });

// ---------- 2. 远端删除：不应影响本地 ----------
console.log('\n[2] 仓库删除独立于本地');
const sessions = (await get('/sessions?cwd=' + encodeURIComponent(CWD))).sessions;
const victim = sessions.find((s) => s.sync === 'not-uploaded' || s.sync === 'synced');
const prev = await post('/preview', { ids: [victim.id], cwd: CWD });
if (!prev.ok) {
  console.log('  预览失败:', prev.error);
} else {
  const c = await post('/commit', { previewId: prev.previewId, transferId: 'del-test-' + Date.now() });
  ok('先上传一条做样本', c.ok === true, String(c.commitSha || '').slice(0, 7));
  const before = await get('/remote');
  const localFile = sessions.find((s) => s.id === victim.id);
  const d = await post('/delete-remote', { ids: [victim.id] });
  ok('远端删除成功', d.ok === true, JSON.stringify({ deleted: d.deleted, attachmentsDeleted: d.attachmentsDeleted }));
  const after = await get('/remote');
  ok('远端会话数减一', after.sessions.length === before.sessions.length - d.deleted,
    `${before.sessions.length} → ${after.sessions.length}`);
  const still = (await get('/sessions?cwd=' + encodeURIComponent(CWD))).sessions.find((s) => s.id === victim.id);
  ok('本地仍在（且变成未上传）', Boolean(still) && still.sync === 'not-uploaded', still?.sync);
  console.log('  本地文件大小未变:', localFile?.bytes === still?.bytes);
}

console.log('\n[3] 附件回收计数来自远端索引');
const fin = await get('/remote');
ok('附件数仍可读', typeof fin.attachmentCount === 'number', String(fin.attachmentCount));
