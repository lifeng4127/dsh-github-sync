// 证书不受信的错误应被识别、不重试、并给出可执行的排查建议
import { GitHubClient, isTlsTrustError, TLS_TRUST_HINT } from '../lib/github.mjs';

let pass = 0; let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};

console.log('[1] 错误码识别');
for (const code of [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'unable to get local issuer certificate',
]) {
  ok(`识别 ${code}`, isTlsTrustError(code));
}
for (const notTls of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '', 'fetch failed']) {
  ok(`不误判 ${notTls || '(空)'}`, !isTlsTrustError(notTls));
}
ok('提示包含三种解法', /绕过列表/.test(TLS_TRUST_HINT) && /NODE_EXTRA_CA_CERTS/.test(TLS_TRUST_HINT),
  `${TLS_TRUST_HINT.length} 字符`);

console.log('\n[2] 端到端：证书错误应立刻抛出（不重试 3 次）并附带提示');
const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  const err = new TypeError('fetch failed');
  err.cause = { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' };
  throw err;
};
try {
  const client = new GitHubClient({ token: 't', repo: 'a/b', branch: 'main' });
  await client.getRef('main');
  ok('应当抛错', false);
} catch (e) {
  ok('抛出了错误', true);
  ok('只请求了 1 次（没有无意义重试）', calls === 1, `${calls} 次`);
  ok('错误里带证书提示', /NODE_EXTRA_CA_CERTS/.test(e.message));
  ok('错误里保留原始错误码', /UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(e.message));
  console.log('  实际信息:', e.message.slice(0, 120) + '…');
} finally {
  globalThis.fetch = realFetch;
}

console.log('\n[3] 普通网络错误仍然重试');
let calls2 = 0;
globalThis.fetch = async () => {
  calls2 += 1;
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNRESET' };
  throw err;
};
try {
  const client = new GitHubClient({ token: 't', repo: 'a/b', branch: 'main' });
  await client.getRef('main');
} catch { /* 预期失败 */ } finally {
  globalThis.fetch = realFetch;
}
ok('普通网络错误重试了 3 次', calls2 === 3, `${calls2} 次`);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
