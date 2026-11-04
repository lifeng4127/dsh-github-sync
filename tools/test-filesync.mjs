// 文件夹/文件同步的离线验收：密钥阻断、排除规则、大小与数量限制、路径消毒
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { scanFolder, isHardBlocked, isExcluded } = await import('../lib/folders.mjs');
const { planFileDownload } = await import('../lib/sync.mjs');
const { MAX_ATTACHMENT_BYTES } = await import('../lib/sync.mjs');

let pass = 0; let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};

const ROOT = join(tmpdir(), 'dsh-filesync-' + Date.now());
const put = (rel, size = 8) => {
  const abs = join(ROOT, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, Buffer.alloc(size, 0x61));
  return abs;
};
mkdirSync(ROOT, { recursive: true });

console.log('[1] 密钥类文件硬阻断（与排除规则无关，一律拦）');
for (const name of ['.env', '.env.local', 'server.key', 'cert.pem', 'id_rsa', '.npmrc', '.netrc']) {
  ok(`${name} 被硬阻断`, isHardBlocked(name));
}
ok('普通 .envrc 不误伤', !isHardBlocked('.envrc'));

console.log('\n[2] 扫描：正常文件 / 排除 / 阻断');
put('src/a.js', 100);
put('src/b.txt', 200);
put('src/.env', 30);                 // 硬阻断
put('node_modules/x/index.js', 50);  // 默认排除
put('debug.log', 20);                // 默认排除
put('中文 目录/报告 文件.md', 60);    // 中文+空格应正常
put('empty.bin', 0);                 // 空文件应正常

const scan = scanFolder(ROOT, { patterns: ['node_modules', '*.log'] });
const rels = scan.files.map((f) => f.rel);
ok('正常文件在列表里', rels.includes('src/a.js') && rels.includes('src/b.txt'));
ok('密钥文件不在可上传列表', !rels.some((r) => r.endsWith('.env')));
ok('密钥文件出现在 blocked 且给原因',
  scan.blocked.some((b) => b.rel.endsWith('.env') && /密钥/.test(b.reason)));
ok('node_modules 被排除（不进 files 也不进 blocked）',
  !rels.some((r) => r.includes('node_modules')) && !scan.blocked.some((b) => b.rel.includes('node_modules')));
ok('*.log 被排除', !rels.some((r) => r.endsWith('.log')));
ok('中文与空格路径正常', rels.some((r) => r.includes('中文 目录') && r.includes('报告 文件.md')));
ok('空文件正常通过', rels.includes('empty.bin'));
ok('rel 用正斜杠', rels.every((r) => !r.includes('\\')));

console.log('\n[3] 大小与数量限制');
put('big.bin', 11 * 1024 * 1024);    // 超过默认 10MB
const scan2 = scanFolder(ROOT, { patterns: ['node_modules', '*.log'] });
ok('超 10MB 被拦并说明原因',
  scan2.blocked.some((b) => b.rel === 'big.bin' && /10MB/.test(b.reason)));
const scan3 = scanFolder(ROOT, { patterns: [], limits: { maxFiles: 2 } });
ok('单批文件数上限生效', scan3.files.length <= 2 && scan3.blocked.some((b) => /上限/.test(b.reason)),
  `${scan3.files.length} 个`);
const scan4 = scanFolder(ROOT, { patterns: [], limits: { maxTotalBytes: 300 } });
ok('单批总量上限生效', scan4.blocked.some((b) => /总量/.test(b.reason)));

console.log('\n[4] 文件下载：路径消毒');
const longName = 'work/files/' + 'x'.repeat(200) + '.txt';
const remoteFiles = {
  'work/files/ok.txt': 'ok',
  'work/files/中文 报告.md': 'cn',
  'work/files/../../evil.txt': 'evil',
  'work/files/C:/windows.txt': 'abs',
  [longName]: 'long',
};
const stub = {
  async listFiles() {
    const map = new Map([['manifest.json', { sha: 'm', size: 10 }]]);
    for (const [p, c] of Object.entries(remoteFiles)) map.set(p, { sha: 's', size: c.length });
    return { empty: false, commitSha: 'c', treeSha: 't', map };
  },
  async readFile(p) {
    if (p === 'manifest.json') return Buffer.from(JSON.stringify({ schema: 1, sessions: {}, attachments: {}, workspaces: {}, devices: {} }), 'utf8');
    return Buffer.from(remoteFiles[p] ?? '', 'utf8');
  },
};
const plan = await planFileDownload({ client: stub, paths: Object.keys(remoteFiles), targetCwd: ROOT });
const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
ok('正常文件可写', byId['work/files/ok.txt']?.action === 'write');
ok('中文文件名可写', byId['work/files/中文 报告.md']?.action === 'write');
ok('.. 穿越被拒', byId['work/files/../../evil.txt']?.action === 'blocked',
  byId['work/files/../../evil.txt']?.reason);
ok('带盘符的绝对路径被拒', byId['work/files/C:/windows.txt']?.action === 'blocked');
ok('落点都在工作区内',
  plan.items.filter((i) => i.action === 'write').every((i) => i.target && !i.target.includes('..')));

console.log('\n[5] 附件上限常量');
ok('附件上限是 25MB', MAX_ATTACHMENT_BYTES === 25 * 1024 * 1024, String(MAX_ATTACHMENT_BYTES));

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
