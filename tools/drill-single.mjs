// 单机模拟"B 机"：把一条已上传的会话从 work 解绑 + 删掉本地文件，
// 再当作"从远端下载到另一台机器的默认工作区"，完整走一遍下载链路。
//
//   node drill-single.mjs                     执行演练
//   node drill-single.mjs --undo              回滚（解绑副本、恢复原文件、重新挂回 work）
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readHeader, validateSession } from '../lib/sessionlog.mjs';
import { sessionsRoot } from '../lib/paths.mjs';
import { projectKey } from '../lib/projectkey.mjs';
import { SESSION_FILE } from '../lib/sessionlog.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('--base', 'http://127.0.0.1:54721');
const SID = arg('--session', 'session-0cbccc63-e363-458b-b727-0344de0deb6a');
const FROM_CWD = 'E:\\ruanjianxiazai\\deepseek\\work';
const TO_CWD = 'C:\\Users\\14507\\Documents\\deepseek-harness\\default-workspace';
const BACKUP_DIR = join('E:\\ruanjianxiazai\\deepseek\\work', '_drill_backup');

const srcDir = join(sessionsRoot(), projectKey(FROM_CWD), SID);
const dstDir = join(sessionsRoot(), projectKey(TO_CWD), SID);
const backupFile = join(BACKUP_DIR, `${SID}.jsonl.zstd`);

async function post(path, body) {
  const res = await fetch(`${BASE}/dsh-github-sync${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

const undo = process.argv.includes('--undo');

if (undo) {
  console.log('— 回滚 —');
  const d1 = await post('/detach', { sessionId: SID, workspace: TO_CWD });
  console.log('  从默认工作区解绑:', JSON.stringify(d1));
  if (existsSync(dstDir)) {
    const header = (() => { try { return readHeader(readFileSync(join(dstDir, SESSION_FILE))); } catch { return null; } })();
    if (header?.id === SID) { rmSync(dstDir, { recursive: true, force: true }); console.log('  删除副本:', dstDir); }
    else console.log('  跳过删除（不是目标会话）:', dstDir);
  }
  if (existsSync(backupFile)) {
    mkdirSync(srcDir, { recursive: true });
    copyFileSync(backupFile, join(srcDir, SESSION_FILE));
    console.log('  恢复原文件:', join(srcDir, SESSION_FILE));
    const a = await post('/attach', { sessionId: SID, workspace: FROM_CWD });
    console.log('  挂回 work:', JSON.stringify(a));
  } else {
    console.log('  没有备份文件，无法恢复');
  }
  process.exit(0);
}

console.log('— 单机演练开始 —');
console.log('会话:', SID);
console.log('源工作区:', FROM_CWD);
console.log('目标工作区（模拟 B 机）:', TO_CWD);

// 1) 备份
mkdirSync(BACKUP_DIR, { recursive: true });
copyFileSync(join(srcDir, SESSION_FILE), backupFile);
const before = statSync(join(srcDir, SESSION_FILE)).size;
console.log(`\n1) 已备份 ${before} 字节 → ${backupFile}`);

// 2) 解绑 + 删除本地（模拟"这台机器上没有这条会话"）
const det = await post('/detach', { sessionId: SID, workspace: FROM_CWD });
console.log('2) 从 work 解绑:', JSON.stringify(det));
rmSync(srcDir, { recursive: true, force: true });
console.log('   本地文件已删除:', !existsSync(srcDir));

// 3) 下载到"B 机"
const prev = await post('/download/preview', { ids: [SID], targetCwd: TO_CWD });
if (!prev.ok) { console.error('预览失败:', prev); process.exit(1); }
console.log('3) 下载预览:', JSON.stringify(prev.summary), '动作:', prev.items?.[0]?.action, prev.items?.[0]?.reason || '');
if (prev.items?.[0]?.action === 'blocked') { console.error('被拦下:', prev.items[0].reason); process.exit(1); }

const done = await post('/download', { previewId: prev.previewId });
if (done.ok) console.log('   执行:', JSON.stringify(done.applied));
else console.log('   执行返回错误（文件已写入，但挂载失败）:', done.error);

// 4) 验证落盘与 cwd 改写
const dstFile = join(dstDir, SESSION_FILE);
if (!existsSync(dstFile)) { console.error('❌ 文件没有落盘:', dstFile); process.exit(1); }
const buf = readFileSync(dstFile);
const header = readHeader(buf);
const val = validateSession(buf);
console.log('\n4) 校验');
console.log('   路径:', dstFile);
console.log('   大小:', buf.length, '（原', before, '）');
console.log('   header.cwd:', header.cwd, header.cwd === TO_CWD ? '✅ 已改写' : '❌ 未改写');
console.log('   结构:', val.ok ? `✅ ${val.frames} 帧、0 坏行` : `❌ 坏行 ${val.badLines}`);

console.log('\n— 请到界面里确认 —');
console.log('   1. 左侧「默认工作区」应出现这条会话');
console.log('   2. 点进去发一句"继续"，能正常回答');
console.log('   3. 看完后跑：node drill-single.mjs --undo  回滚');
