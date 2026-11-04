// 多设备同仓：设备登记累积、索引合并不丢别人条目、非快进自动重试
import { mergeRemoteManifest, createManifest } from '../lib/manifest.mjs';
import { GitHubClient } from '../lib/github.mjs';

let pass = 0; let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};

console.log('[1] 索引合并：两台设备的条目都要在');
const fresh = createManifest();
fresh.sessions['session-aaa'] = { id: 'session-aaa', path: 'work/sessions/session-aaa.jsonl.zstd', title: 'A 机的会话' };
fresh.devices['dev-A'] = { name: 'MACBOOK', lastSeen: '2026-11-04T10:00:00.000Z' };
fresh.attachments['a'.repeat(64)] = { path: `work/attachments/${'a'.repeat(64)}.png` };

const ours = createManifest();
ours.sessions['session-bbb'] = { id: 'session-bbb', path: 'work/sessions/session-bbb.jsonl.zstd', title: 'B 机的会话' };
ours.devices['dev-B'] = { name: 'DESKTOP-PC', lastSeen: '2026-11-04T11:00:00.000Z' };
ours.attachments['b'.repeat(64)] = { path: `work/attachments/${'b'.repeat(64)}.png` };

const merged = mergeRemoteManifest(fresh, ours);
ok('A 的会话保留', Boolean(merged.sessions['session-aaa']));
ok('B 的会话也在', Boolean(merged.sessions['session-bbb']));
ok('两台设备都登记', Object.keys(merged.devices).length === 2, Object.keys(merged.devices).join(','));
ok('附件并集', Object.keys(merged.attachments).length === 2);

console.log('\n[2] 同一会话两边都有 → 以"我们这份"为准，但设备时间取较新');
const fresh2 = createManifest();
fresh2.sessions['session-x'] = { id: 'session-x', title: '旧标题', sha256: 'old' };
fresh2.devices['dev-A'] = { name: 'MACBOOK', lastSeen: '2026-11-04T12:00:00.000Z' };
const ours2 = createManifest();
ours2.sessions['session-x'] = { id: 'session-x', title: '新标题', sha256: 'new' };
ours2.devices['dev-A'] = { name: 'MACBOOK', lastSeen: '2026-11-04T09:00:00.000Z' };
const merged2 = mergeRemoteManifest(fresh2, ours2);
ok('内容以我们为准', merged2.sessions['session-x'].sha256 === 'new');
ok('设备 lastSeen 取较新', merged2.devices['dev-A'].lastSeen === '2026-11-04T12:00:00.000Z');

console.log('\n[3] 非快进（别的设备先推了）→ 自动重读 ref 并重试');
const calls = [];
let commitTries = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const p = u.pathname;
  const method = init.method ?? 'GET';
  calls.push(`${method} ${p}`);
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  if (method === 'GET' && p.includes('/git/ref/heads/')) {
    return json({ object: { sha: 'c0ffee' + (calls.filter((c) => c.includes('/git/ref/')).length) } });
  }
  if (method === 'GET' && p.includes('/git/commits/')) return json({ tree: { sha: 'tree0' } });
  if (method === 'POST' && p.endsWith('/git/blobs')) return json({ sha: 'blob1' });
  if (method === 'POST' && p.endsWith('/git/trees')) return json({ sha: 'tree1' });
  if (method === 'POST' && p.endsWith('/git/commits')) {
    commitTries += 1;
    if (commitTries === 1) return json({ message: 'Update is not a fast forward' }, 422);
    return json({ sha: 'newcommit' });
  }
  if (method === 'PATCH' && p.includes('/git/refs/heads/')) return json({ ok: true });
  return json({ message: 'unexpected ' + method + ' ' + p }, 404);
};
try {
  const client = new GitHubClient({ token: 't', repo: 'u/r', branch: 'main' });
  const res = await client.commitBatch({ files: [{ path: 'a.txt', content: 'x' }], message: 'm' });
  ok('重试后提交成功', Boolean(res && res.commitSha), String(res?.commitSha));
  ok('确实尝试了两次提交', commitTries === 2, String(commitTries));
  ok('每次都重新读了 ref', calls.filter((c) => c.startsWith('GET ') && c.includes('/git/ref/heads/')).length >= 2);
} catch (e) {
  ok('重试后提交成功', false, e.message);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
