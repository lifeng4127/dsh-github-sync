// 发布到 npm 之后，触发并等待中国大陆镜像（npmmirror）同步。
// 用法：node tools/publish-cn.mjs [--wait] [--timeout=600]
// 前提：包已经 npm publish 成功（镜像只镜像 npm 上已有的包）。
//
// 网络较慢或需要走代理时：
//   PowerShell: $env:HTTPS_PROXY='http://127.0.0.1:7892'; $env:NODE_USE_ENV_PROXY='1'
//   bash:       export HTTPS_PROXY=http://127.0.0.1:7892 NODE_USE_ENV_PROXY=1
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = pkg.name;
const VERSION = pkg.version;

const args = process.argv.slice(2);
const WAIT = args.includes('--wait');
const timeoutArg = args.find((a) => a.startsWith('--timeout='));
const TIMEOUT_S = timeoutArg ? Number(timeoutArg.split('=')[1]) : 600;

const NPM = 'https://registry.npmjs.org';
const CN = 'https://registry.npmmirror.com';

const jget = async (url, tries = 3) => {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      return { status: r.status, body: r.status === 200 ? await r.json().catch(() => null) : null };
    } catch (e) {
      lastErr = e;                       // 代理不稳时偶发 ECONNRESET，重试即可
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return { status: 0, error: lastErr?.cause?.code || lastErr?.message || 'network' };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`包名: ${NAME}`);
console.log(`版本: ${VERSION}\n`);

console.log('[1] 检查 npm 官方源');
const npmRes = await jget(`${NPM}/${encodeURIComponent(NAME)}`);
if (npmRes.status === 404) {
  console.log('  ✗ npm 上还没有这个包');
  console.log('  → 先执行: npm publish --access public');
  console.log('  → 镜像只复制 npm 上已有的包，必须先发布');
  process.exit(1);
}
if (npmRes.status !== 200) {
  console.log(`  ✗ 查询失败（HTTP ${npmRes.status}${npmRes.error ? ' · ' + npmRes.error : ''}）`);
  console.log('  → 如果本机需要代理，先设置 HTTPS_PROXY 与 NODE_USE_ENV_PROXY=1');
  process.exit(1);
}
const npmVersions = Object.keys(npmRes.body?.versions ?? {});
console.log(`  ✓ npm 上有 ${npmVersions.length} 个版本，latest=${npmRes.body?.['dist-tags']?.latest}`);
if (!npmVersions.includes(VERSION)) {
  console.log(`  ✗ npm 上没有 ${VERSION}（当前 package.json 的版本还没发布？）`);
  process.exit(1);
}

console.log('\n[2] 检查大陆镜像');
const checkCn = async () => {
  const r = await jget(`${CN}/${encodeURIComponent(NAME)}`);
  if (r.status !== 200) return { ok: false, status: r.status };
  return { ok: true, has: Object.keys(r.body?.versions ?? {}).includes(VERSION), latest: r.body?.['dist-tags']?.latest };
};
let cn = await checkCn();
if (cn.ok && cn.has) {
  console.log(`  ✓ 镜像已有 ${VERSION}`);
  console.log(`\n大陆用户可以安装：npm install ${NAME} --registry=${CN}`);
  process.exit(0);
}
console.log(cn.ok ? `  镜像有该包但缺 ${VERSION}（latest=${cn.latest}）` : '  镜像里还没有这个包');

console.log('\n[3] 触发镜像同步');
try {
  const r = await fetch(`${CN}/-/package/${encodeURIComponent(NAME)}/syncs`, { method: 'PUT' });
  const body = await r.text();
  console.log(`  PUT /-/package/${NAME}/syncs → HTTP ${r.status} ${body.slice(0, 120)}`);
  if (r.status !== 200 && r.status !== 201 && r.status !== 202) {
    console.log('  → 接口返回异常，可以到 https://npmmirror.com/package/' + NAME + ' 手动点「同步」');
  }
} catch (e) {
  console.log('  触发失败:', e.message);
  console.log('  → 到 https://npmmirror.com/package/' + NAME + ' 手动点「同步」');
}

if (!WAIT) {
  console.log('\n已触发。镜像通常几分钟内完成；用 --wait 可以自动等待并验证。');
  process.exit(0);
}

console.log(`\n[4] 等待同步（最多 ${TIMEOUT_S} 秒）`);
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
  await sleep(10000);
  cn = await checkCn();
  const secs = Math.round((Date.now() - t0) / 1000);
  if (cn.ok && cn.has) {
    console.log(`  ✓ ${secs}s 后镜像已就绪`);
    console.log(`\n大陆用户可以安装：npm install ${NAME} --registry=${CN}`);
    process.exit(0);
  }
  console.log(`  …${secs}s 仍在同步（latest=${cn.latest ?? '-'}）`);
}
console.log('\n✗ 超时。可以稍后再跑一次本脚本，或到 npmmirror 页面手动点同步。');
process.exit(1);
