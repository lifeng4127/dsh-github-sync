// 发布前静态安全审计：确保插件不会碰系统层面的东西。
// 用法：node tools/audit-safety.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
};

const shipped = ['index.js', 'client.js', ...walk(join(ROOT, 'lib')).map((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/'))];
const sources = shipped.map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), 'utf8') }));

console.log('[1] 不许执行的系统级能力');
const forbidden = [
  ['child_process', /from\s+['"]node:child_process['"]/, '启动子进程'],
  ['exec/spawn', /\b(execSync|execFileSync|spawnSync)\s*\(/, '执行外部命令'],
  ['winreg/注册表', /(winreg|HKEY_|reg\.exe|regedit)/i, '读写注册表'],
  ['hosts 文件', /drivers[\\/]+etc[\\/]+hosts/i, '改 hosts'],
  ['系统目录写入', /(['"`])(C:\\\\Windows|\/etc\/|\/usr\/|\/System\/)/i, '写系统目录'],
  ['环境变量写入', /process\.env\.[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/, '改进程环境变量'],
  ['全局代理设置', /(setGlobalDispatcher|setEnvironmentVariable|SetEnvironmentVariable)/, '改全局网络设置'],
];
for (const [name, re, why] of forbidden) {
  const hit = sources.find((s) => re.test(s.text));
  ok(`无${why}（${name}）`, !hit, hit ? `出现在 ${hit.rel}` : '');
}

console.log('\n[2] 依赖面');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const deps = Object.keys(pkg[field] ?? {});
  ok(`${field} 为空（无第三方包）`, deps.length === 0, deps.join(', '));
}
ok('没有 install 钩子脚本', !Object.keys(pkg.scripts ?? {}).some((k) => /^(pre|post)?install$/.test(k)), JSON.stringify(pkg.scripts ?? {}));

console.log('\n[3] 写入点必须经过守卫');
const writes = [];
for (const s of sources) {
  s.text.split('\n').forEach((line, i) => {
    if (/\b(writeFileSync|rmSync|unlinkSync|renameSync|mkdirSync)\s*\(/.test(line)) {
      writes.push({ rel: s.rel, line: i + 1, text: line.trim() });
    }
  });
}
ok('写入点只出现在宿主入口与附件模块',
  writes.every((w) => ['index.js', 'lib/attachments.mjs'].includes(w.rel)),
  [...new Set(writes.map((w) => w.rel))].join(', '));
const hasGuard = (rel) => readFileSync(join(ROOT, rel), 'utf8').includes('guard.mjs');
ok('index.js 使用路径守卫', hasGuard('index.js'));
ok('attachments.mjs 使用路径守卫', hasGuard('lib/attachments.mjs'));
ok('sync.mjs 使用路径守卫', hasGuard('lib/sync.mjs'));
ok('守卫导出越界检查', readFileSync(join(ROOT, 'lib/guard.mjs'), 'utf8').includes('assertInsideRoot'));

console.log('\n[4] 网络出口');
const hosts = new Set();
for (const s of sources) {
  for (const m of s.text.matchAll(/https?:\/\/([^/'"`\s)]+)/g)) hosts.add(m[1]);
  for (const m of s.text.matchAll(/(?:href|src)\s*[:=]\s*['"]https?:\/\/([^/'"`\s]+)/g)) hosts.add(m[1]);
}
const allowed = ['api.github.com', 'github.com', 'www.github.com'];
// 'dsh' 是宿主解析相对请求路径用的假基址（new URL(req.url, 'http://dsh')），不是真实出网
const external = [...hosts].filter((h) => h !== 'dsh');
ok('只访问 GitHub 域', external.every((h) => allowed.some((a) => h === a || h.endsWith('.' + a))),
  external.filter((h) => !allowed.some((a) => h === a || h.endsWith('.' + a))).join(', ') || '全部合规');

console.log('\n[5] 数据目录边界');
const pathsSrc = readFileSync(join(ROOT, 'lib/paths.mjs'), 'utf8');
ok('所有数据目录都在 $DSH_HOME 下', (pathsSrc.match(/join\(dshHome\(\)/g) ?? []).length >= 4,
  String((pathsSrc.match(/join\(dshHome\(\)/g) ?? []).length) + ' 处');
ok('dshHome 支持 DSH_HOME 覆盖', /DSH_HOME/.test(pathsSrc));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
