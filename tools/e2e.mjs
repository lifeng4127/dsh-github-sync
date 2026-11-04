// 端到端验收：对着正在运行的插件跑真实链路。
//   node tools/e2e.mjs          只读检查（不写仓库）
//   node tools/e2e.mjs --write  允许上传/删除（会真的改 GitHub 仓库）
import { existsSync } from 'node:fs';

const BASE = process.env.SYNC_BASE || 'http://127.0.0.1:62798';
const API = `${BASE}/dsh-github-sync`;
const CWD = process.env.SYNC_CWD || 'E:\\ruanjianxiazai\\deepseek\\work';
const WRITE = process.argv.includes('--write');

const post = async (p, b) => (await fetch(API + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}),
})).json();
const get = async (p) => (await fetch(API + p)).json();

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};
const section = (t) => console.log(`\n[${t}]`);

section('基础');
const st = await get('/status');
ok('status 可读', st.ok === true, `v${st.version}`);
ok('仓库已配置', Boolean(st.repo), st.repo || '(空)');
ok('令牌格式有效', st.hasToken === true || st.tokenMalformed === false, st.tokenMalformed ? '令牌损坏' : '正常');

section('远端读取');
// 网络抖动时 /remote 可能失败，重试一次再判定
let remote = await get('/remote');
if (!remote.ok) { await new Promise((r) => setTimeout(r, 1500)); remote = await get('/remote'); }
ok('远端可读', remote.ok === true, `${remote.sessions?.length ?? 0} 会话${remote.ok ? '' : ' · ' + (remote.error || '失败')}`);
const sessions = (await get('/sessions?cwd=' + encodeURIComponent(CWD))).sessions || [];
ok('本地列表可读', sessions.length > 0, `${sessions.length} 条`);
ok('同步状态有值', sessions.every((s) => typeof s.sync === 'string'));

section('诊断');
const diag = await get('/diagnostics');
ok('诊断可导出', diag.ok === true && diag.text.includes('诊断报告'));

section('预览');
const candidates = sessions.filter((s) => s.sync === 'not-uploaded' || s.sync === 'local-ahead');
const sample = candidates[0] || sessions[0];
const prev = await post('/preview', { ids: [sample.id], cwd: CWD });
ok('预览成功', prev.ok === true, prev.ok ? `upload=${prev.summary?.upload} skip=${prev.summary?.skip} blocked=${prev.summary?.blocked}` : prev.error);

section('下载预览（不落盘）');
const dl = await post('/download/preview', { ids: [remote.sessions?.[0]?.id].filter(Boolean), targetCwd: CWD });
ok('下载预览成功', dl.ok === true, dl.ok ? `items=${dl.items?.length}` : dl.error);

if (WRITE) {
  section('上传（真的提交）');
  const t0 = Date.now();
  const c = await post('/commit', { previewId: prev.previewId, transferId: 'e2e-' + Date.now() });
  ok('提交成功', c.ok === true, c.ok ? `commit=${String(c.commitSha).slice(0, 7)} ${((Date.now() - t0) / 1000).toFixed(1)}s` : c.error);

  section('上传后徽标自动变已同步');
  await get('/remote');
  const after = (await get('/sessions?cwd=' + encodeURIComponent(CWD))).sessions || [];
  const row = after.find((s) => s.id === sample.id);
  ok('状态变为 synced', row?.sync === 'synced', row?.sync);

  section('重复上传应为 skip');
  const prev2 = await post('/preview', { ids: [sample.id], cwd: CWD });
  ok('第二次全部 skip', prev2.ok === true && (prev2.summary?.upload ?? 0) === 0, `upload=${prev2.summary?.upload}`);

  section('取消能中断');
  // 必须挑一条真的会传、而且足够大的会话，否则提交会在取消到达前就跑完
  const big = [...sessions].filter((s) => s.sync !== 'synced').sort((a, b) => b.bytes - a.bytes)[0];
  if (!big) {
    ok('取消（跳过：没有待传会话）', true, 'skipped');
  } else {
    const pd = await post('/preview', { ids: [big.id], cwd: CWD });
    if ((pd.summary?.files ?? 0) === 0) {
      ok('取消（跳过：没有可传文件）', true, 'skipped');
    } else {
      const tid = 'e2e-cancel-' + Date.now();
      const running = post('/commit', { previewId: pd.previewId, transferId: tid });
      await new Promise((r) => setTimeout(r, 400));
      await post('/cancel', { transferId: tid });
      const cr = await running;
      ok('取消返回已取消', cr.ok === false && /取消/.test(String(cr.error || '')),
        `${String(cr.error || 'ok')} · ${(big.bytes / 1048576).toFixed(1)}MB`);
    }
  }

  section('删除远端不影响本地');
  const beforeCount = (await get('/remote')).sessions.length;
  const del = await post('/delete-remote', { ids: [sample.id] });
  ok('远端删除成功', del.ok === true, JSON.stringify({ deleted: del.deleted, att: del.attachmentsDeleted }));
  const afterRemote = (await get('/remote')).sessions.length;
  ok('远端条数减少', afterRemote === beforeCount - (del.deleted || 0), `${beforeCount} → ${afterRemote}`);
  const localStill = ((await get('/sessions?cwd=' + encodeURIComponent(CWD))).sessions || []).find((s) => s.id === sample.id);
  ok('本地仍在', Boolean(localStill), localStill?.sync);
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
if (!WRITE) console.log('（只读模式；加 --write 才会真的上传/删除）');
process.exit(fail ? 1 : 0);
