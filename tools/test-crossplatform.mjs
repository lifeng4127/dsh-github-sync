// 跨平台：会话目录名与当前平台算法不一致时，能否按会话头里的 cwd 找回来
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = join(tmpdir(), 'dsh-xplat-' + Date.now());
process.env.DSH_HOME = HOME;

const { projectDir, resetProjectDirCache } = await import('../lib/sessiondir.mjs');
const { listSessionsForCwd } = await import('../lib/localsessions.mjs');
const { projectKey } = await import('../lib/projectkey.mjs');
const { rewriteSession } = await import('../lib/sessionlog.mjs');

let pass = 0; let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};

// 用一条真实会话做样本，把头帧 cwd 改成"另一台机器的工作区"
const REAL = process.env.SYNC_SAMPLE || 'C:\\Users\\14507\\.dsh\\sessions\\--E-ruanjianxiazai-deepseek-work--';
const sampleBuf = readFileSync(join(REAL, 'session-06f8ae05-3a38-43e8-9dd6-7e09d7bc1990', 'session.v4.jsonl.zstd'));
const cwdA = 'E:\\ruanjianxiazai\\deepseek\\work';
const macCwd = '/Users/lifeng/projects/work';
const rewritten = rewriteSession(sampleBuf, { newCwd: macCwd }).buffer;

// 场景 1：目录名就是本平台的算法 → 直接命中
const normalDir = join(HOME, 'sessions', projectKey(macCwd), 'session-06f8ae05-3a38-43e8-9dd6-7e09d7bc1990');
mkdirSync(normalDir, { recursive: true });
writeFileSync(join(normalDir, 'session.v4.jsonl.zstd'), rewritten);
resetProjectDirCache();
ok('键一致时直接命中', projectDir(macCwd) === join(HOME, 'sessions', projectKey(macCwd)));
ok('能列出会话', listSessionsForCwd(macCwd).length === 1);

// 场景 2：目录名是"另一个平台的算法"（模拟键算法差异）→ 应回退按头帧 cwd 找到
rmSync(join(HOME, 'sessions'), { recursive: true, force: true });
const weirdKey = '--Users-lifeng-projects-work--LEGACY';
const weirdDir = join(HOME, 'sessions', weirdKey, 'session-06f8ae05-3a38-43e8-9dd6-7e09d7bc1990');
mkdirSync(weirdDir, { recursive: true });
writeFileSync(join(weirdDir, 'session.v4.jsonl.zstd'), rewritten);
resetProjectDirCache();
const found = projectDir(macCwd);
ok('键不一致时回退匹配成功', found === join(HOME, 'sessions', weirdKey), found.split('sessions')[1]);
ok('回退后也能列出会话', listSessionsForCwd(macCwd).length === 1);

// 场景 3：完全不存在 → 返回按当前算法算出的路径（用于新建）
rmSync(join(HOME, 'sessions'), { recursive: true, force: true });
resetProjectDirCache();
const brandNew = projectDir('E:\\brand\\new\\place');
ok('新工作区返回新路径', brandNew === join(HOME, 'sessions', projectKey('E:\\brand\\new\\place')));
ok('新工作区列表为空', listSessionsForCwd('E:\\brand\\new\\place').length === 0);

rmSync(HOME, { recursive: true, force: true });
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
