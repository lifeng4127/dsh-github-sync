// 空仓库首传验收：切到新仓 → 连接测试 → 首传（Contents API 打种子）→ 切回原仓
const API = process.env.SYNC_BASE ? `${process.env.SYNC_BASE}/dsh-github-sync` : 'http://127.0.0.1:64202/dsh-github-sync';
const CWD = 'E:\\ruanjianxiazai\\deepseek\\work';
const NEW_REPO = 'https://github.com/mount9527/deepseek-harness-work1.git';

const post = async (p, b) => (await fetch(API + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}),
})).json();
const get = async (p) => (await fetch(API + p)).json();

const orig = (await get('/status')).repo;
console.log('原仓库:', orig);
console.log('测试仓:', NEW_REPO, '\n');

try {
  const c = await post('/config', { repo: NEW_REPO });
  console.log('① 切换仓库:', c.ok ? 'ok' : JSON.stringify(c));

  const t = await post('/test', {});
  console.log('② 测试连接:', t.ok ? `ok · ${t.fullName} · private=${t.private}` : `失败 · ${t.error}`);
  if (!t.ok) {
    console.log('\n→ 大概率是 PAT 没授权这个新仓库（fine-grained token 是按仓库授权的）');
    throw new Error('skip');
  }

  // 挑一条小的未上传会话来首传
  const ss = (await get('/sessions?cwd=' + encodeURIComponent(CWD))).sessions || [];
  const target = ss.filter((s) => s.title && s.id.startsWith('session-') && s.sync !== 'synced')
    .sort((a, b) => a.bytes - b.bytes)[0];
  if (!target) { console.log('没有可传会话'); throw new Error('skip'); }
  console.log(`③ 首传目标: ${(target.title || target.id).slice(0, 30)} · ${(target.bytes / 1048576).toFixed(2)}MB`);

  const prev = await post('/preview', { ids: [target.id], cwd: CWD });
  console.log('   预览:', prev.ok ? `files=${prev.summary.files} upload=${prev.summary.upload}` : prev.error);
  const commit = await post('/commit', { previewId: prev.previewId, transferId: 'newrepo-' + Date.now() });
  console.log('   提交:', JSON.stringify({
    ok: commit.ok, firstCommit: commit.firstCommit, files: commit.files,
    commit: String(commit.commitSha || '').slice(0, 7), error: commit.error,
  }));

  const rv = await get('/remote');
  console.log('④ 新仓内容:', `${rv.sessions?.length ?? 0} 会话 · ${rv.attachmentCount ?? 0} 附件 · commit ${String(rv.commit || '').slice(0, 7)}`);
  console.log('   项目:', Object.keys(rv.projects || {}).join(', ') || '(空)');
} catch (e) {
  if (e.message !== 'skip') console.log('异常:', e.message);
} finally {
  const back = await post('/config', { repo: orig });
  const t2 = await post('/test', {});
  console.log(`\n⑤ 已切回原仓库: ${back.ok ? 'ok' : JSON.stringify(back)} · 连接测试: ${t2.ok ? '正常' : t2.error}`);
}
