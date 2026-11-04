// 路径守卫的运行时验证：恶意 id / sha 必须被拦在落盘之前
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = join(tmpdir(), 'dsh-guard-' + Date.now());
process.env.DSH_HOME = HOME;
mkdirSync(join(HOME, 'sessions'), { recursive: true });

const { isSafeSegment, isHex64, isInsideRoot, assertInsideRoot, assertSessionId, assertSha256 } = await import('../lib/guard.mjs');
const { localSessionFile, planDownload } = await import('../lib/sync.mjs');
const { attachmentObjectPath } = await import('../lib/attachments.mjs');

let pass = 0; let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('[1] 标识符校验');
ok('正常 id 通过', isSafeSegment('session-abc_123.x'));
ok('拒绝 ..', !isSafeSegment('..'));
ok('拒绝带斜杠', !isSafeSegment('a/b'));
ok('拒绝带反斜杠', !isSafeSegment('a\\b'));
ok('拒绝空串', !isSafeSegment(''));
ok('拒绝超长', !isSafeSegment('a'.repeat(200)));
ok('64 位十六进制通过', isHex64('a'.repeat(64)));
ok('拒绝短 sha', !isHex64('abc'));
ok('拒绝非十六进制', !isHex64('z'.repeat(64)));

console.log('\n[2] 拼路径时必须炸');
ok('localSessionFile 拒绝 ../..', throws(() => localSessionFile('E:\\work', '../../evil')));
ok('localSessionFile 拒绝绝对路径', throws(() => localSessionFile('E:\\work', 'C:\\Windows\\x')));
ok('attachmentObjectPath 拒绝穿越', throws(() => attachmentObjectPath('../../evil')));
ok('attachmentObjectPath 拒绝非 hex', throws(() => attachmentObjectPath('hello')));
ok('assertSessionId 抛错', throws(() => assertSessionId('..')));
ok('assertSha256 抛错', throws(() => assertSha256('../x')));

console.log('\n[3] 目录边界');
const root = join(HOME, 'sessions');
ok('内部路径通过', isInsideRoot(root, join(root, 'a', 'b')));
ok('外部路径拒绝', !isInsideRoot(root, join(HOME, 'other')));
ok('前缀伪装拒绝', !isInsideRoot(root, root + '-evil'));
ok('越界写入抛错', throws(() => assertInsideRoot(root, join(HOME, 'other', 'x'))));

console.log('\n[4] 远端索引投毒：planDownload 必须拦下');
const manifest = {
  schema: 1,
  sessions: {
    '../../evil': { id: '../../evil', path: 'work/sessions/x.jsonl.zstd', title: 'evil', attachments: [] },
    'session-good': { id: 'session-good', path: 'work/sessions/good.jsonl.zstd', title: 'good', attachments: ['../../../'.padEnd(64, 'a')] },
  },
  attachments: {}, workspaces: {}, devices: {},
};
const stub = {
  async listFiles() {
    return {
      empty: false, commitSha: 'c', treeSha: 't',
      map: new Map([['manifest.json', { sha: 'm', size: 1 }], ['work/sessions/x.jsonl.zstd', { sha: 's', size: 1 }]]),
    };
  },
  async readFile(p) {
    if (p === 'manifest.json') return Buffer.from(JSON.stringify(manifest), 'utf8');
    return null; // 远端文件读不到 → 走到"文件读取失败"，不会继续落盘
  },
};
const plan = await planDownload({ client: stub, ids: ['../../evil', 'session-good'], targetCwd: 'E:\\work' });
ok('恶意 id 被 blocked', plan.items[0].action === 'blocked', plan.items[0].reason);
ok('恶意 id 的理由是"不合法"', /不合法/.test(String(plan.items[0].reason || '')));
ok('正常 id 未被误伤', plan.items[1].action === 'blocked' && /读取失败/.test(String(plan.items[1].reason || '')),
  plan.items[1].reason);

rmSync(HOME, { recursive: true, force: true });
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
