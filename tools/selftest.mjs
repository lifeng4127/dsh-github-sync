// 内核自测：不联网，只用真实会话文件与构造数据。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectKey, encodeSegment, decodeSegment } from '../lib/projectkey.mjs';
import { readHeader, readTitle, validateSession, rewriteSession, compareSessions, sha256 } from '../lib/sessionlog.mjs';
import { walkFrames, encodeOne as encodeFrame } from '../lib/zstdframe.mjs';
import { parseRepo } from '../lib/github.mjs';
import { createManifest, registerWorkspace, upsertSession, sessionPath, serializeManifest, parseManifest, renderReadme } from '../lib/manifest.mjs';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`); }
}
function ok(name, cond) { cond ? (pass++, console.log(`  ok   ${name}`)) : (fail++, console.log(`  FAIL ${name}`)); }

const SRC = join('C:\\Users\\14507\\.dsh\\sessions', '--E-ruanjianxiazai-deepseek-work--',
  'session-0cbccc63-e363-458b-b727-0344de0deb6a', 'session.v4.jsonl.zstd');

console.log('projectKey');
eq('work', projectKey('E:\\ruanjianxiazai\\deepseek\\work'), '--E-ruanjianxiazai-deepseek-work--');
eq('default-workspace', projectKey('C:\\Users\\14507\\Documents\\deepseek-harness\\default-workspace'),
  '--C-Users-14507-Documents-deepseek-harness-default-workspace--');
eq('segment roundtrip', decodeSegment(encodeSegment('a b/中文')), 'a b/中文');

console.log('session read');
const buf = readFileSync(SRC);
const header = readHeader(buf);
eq('version', header.version, 4);
eq('cwd', header.cwd, 'E:\\ruanjianxiazai\\deepseek\\work');
ok('title', readTitle(buf) === '物流运营岗位职责与要求');
const val = validateSession(buf);
ok('validate ok', val.ok);
// 帧数不写死：这条会话会随着聊天继续增长，跟文件实际帧数比即可
const FRAMES = walkFrames(buf).length;
eq('frames', val.frames, FRAMES);
eq('sha256 length', sha256(buf).length, 64);

console.log('compareSessions（只比 body）');
const moved = rewriteSession(buf, { newCwd: 'D:\\somewhere\\else' }).buffer;
const grown = Buffer.concat([buf, encodeFrame('[{"type":"noop"}]\n')]);
eq('equal 同文件', compareSessions(buf, buf), 'equal');
eq('equal 仅头帧不同', compareSessions(moved, buf), 'equal');
eq('local-ahead 本地多一帧', compareSessions(grown, buf), 'local-ahead');
eq('remote-ahead 远端多一帧', compareSessions(buf, grown), 'remote-ahead');
const corrupted = Buffer.from(buf);
corrupted[corrupted.length - 1] ^= 0xff;
eq('diverged', compareSessions(corrupted, buf), 'diverged');

console.log('rewriteSession');
const rw = rewriteSession(buf, { newCwd: 'D:\\somewhere\\else' });
eq('cwd changed', rw.header.cwd, 'D:\\somewhere\\else');
eq('id kept', rw.header.id, header.id);
eq('frames kept', walkFrames(rw.buffer).length, FRAMES);
ok('rewritten validates', validateSession(rw.buffer).ok);

console.log('parseRepo');
eq('short', parseRepo('lifeng/dsh-sync'), { owner: 'lifeng', repo: 'dsh-sync' });
eq('https', parseRepo('https://github.com/lifeng/dsh-sync.git'), { owner: 'lifeng', repo: 'dsh-sync' });
let threw = false;
try { parseRepo('not a repo'); } catch { threw = true; }
ok('rejects garbage', threw);

console.log('manifest');
const m = createManifest();
const name = registerWorkspace(m, { name: 'work', originalCwd: header.cwd, title: 'work', deviceId: 'dev-1', deviceName: 'DESKTOP-A' });
upsertSession(m, {
  id: header.id, path: sessionPath(name ?? 'work', header.id), project: 'work', originalCwd: header.cwd,
  title: readTitle(buf), createdAt: header.createdAt, updatedAt: Date.now(), bytes: buf.length,
  frames: FRAMES, sha256: sha256(buf), uploadedBy: 'dev-1', uploadedAt: new Date().toISOString(),
});
const text = serializeManifest(m);
const reparsed = parseManifest(text);
eq('roundtrip sessions', Object.keys(reparsed.sessions).length, 1);
const readme = renderReadme(reparsed);
ok('readme has title', readme.includes('DSH 跨设备同步仓库'));
ok('readme links session', readme.includes('物流运营岗位职责与要求'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
