// 边界值：大小阈值两侧、空文件、超长名、emoji、目录深度
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { scanFolder } = await import('../lib/folders.mjs');

let pass = 0; let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};

const ROOT = join(tmpdir(), 'dsh-bound-' + Date.now());
const put = (rel, size = 8) => {
  const abs = join(ROOT, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, Buffer.alloc(size, 0x62));
  return abs;
};
mkdirSync(ROOT, { recursive: true });

const LIMIT = 10 * 1024 * 1024;

console.log('[1] 10MB 阈值两侧');
put('exact-10mb.bin', LIMIT);          // 正好等于上限 → 允许
put('over-10mb.bin', LIMIT + 1);       // 超 1 字节 → 拒绝
const s1 = scanFolder(ROOT);
const allowed = s1.files.map((f) => f.rel);
const blocked = s1.blocked.map((b) => b.rel);
ok('正好 10MB 允许', allowed.includes('exact-10mb.bin'));
ok('超 1 字节被拒', blocked.includes('over-10mb.bin') && !allowed.includes('over-10mb.bin'));
ok('拒绝原因写清 10MB', /10MB/.test(s1.blocked.find((b) => b.rel === 'over-10mb.bin')?.reason || ''));

console.log('\n[2] 空文件与极小文件');
put('zero.bin', 0);
put('one.bin', 1);
const s2 = scanFolder(ROOT);
const rel2 = s2.files.map((f) => f.rel);
ok('0 字节文件允许', rel2.includes('zero.bin'));
ok('1 字节文件允许', rel2.includes('one.bin'));

console.log('\n[3] 特殊文件名');
const longName = 'L'.repeat(180) + '.txt';   // 200 字符左右
put(longName, 10);
put('emoji-🚀-file.txt', 10);
put('a b c.txt', 10);
put('.hidden-config', 10);
const s3 = scanFolder(ROOT);
const rel3 = s3.files.map((f) => f.rel);
ok('长文件名允许', rel3.includes(longName));
ok('emoji 文件名允许', rel3.some((r) => r.includes('🚀')));
ok('空格文件名允许', rel3.includes('a b c.txt'));
ok('隐藏文件允许（非密钥类）', rel3.includes('.hidden-config'));
ok('中文名不再被转义或丢弃', (() => { put('目录 中文/文件.txt', 5); return scanFolder(ROOT).files.some((f) => f.rel.includes('目录 中文/文件.txt')); })());

console.log('\n[4] 目录深度');
const deep = Array.from({ length: 6 }, (_, i) => 'd' + (i + 1)).join('/');
put(deep + '/deep.txt', 10);
const s4 = scanFolder(ROOT, { limits: { maxDepth: 3 } });
ok('超过深度上限被拦', s4.blocked.some((b) => /过深/.test(b.reason)), JSON.stringify(s4.blocked.filter((b) => /过深/.test(b.reason)).map((b) => b.rel)));
const s5 = scanFolder(ROOT, { limits: { maxDepth: 20 } });
ok('深度放宽后可扫到', s5.files.some((f) => f.rel.endsWith('deep.txt')));

console.log('\n[5] 总量与文件数上限的边界');
const s6 = scanFolder(ROOT, { limits: { maxFiles: s5.files.length } });
ok('文件数恰好等于上限时全收', s6.files.length === s5.files.length, `${s6.files.length}/${s5.files.length}`);
const s7 = scanFolder(ROOT, { limits: { maxFiles: s5.files.length - 1 } });
ok('少一个就有一个被拦', s7.files.length === s5.files.length - 1 && s7.blocked.some((b) => /上限/.test(b.reason)));

console.log('\n[6] 汇总数据自洽');
const total = s5.files.reduce((a, f) => a + f.bytes, 0);
ok('totalBytes 等于文件大小之和', s5.totalBytes === total, `${s5.totalBytes} vs ${total}`);
ok('每个文件都有绝对路径', s5.files.every((f) => f.abs && statSync(f.abs).isFile()));

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
