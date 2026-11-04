// 只验证"取消能真正中断"：挑最大的待传会话，传 400ms 后取消
const BASE = process.env.SYNC_BASE || 'http://127.0.0.1:62798';
const API = `${BASE}/dsh-github-sync`;
const CWD = process.env.SYNC_CWD || 'E:\\ruanjianxiazai\\deepseek\\work';
const post = async (p, b) => (await fetch(API + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}),
})).json();
const get = async (p) => (await fetch(API + p)).json();

const sessions = (await get('/sessions?cwd=' + encodeURIComponent(CWD))).sessions || [];
const big = sessions.filter((s) => s.sync !== 'synced').sort((a, b) => b.bytes - a.bytes)[0];
if (!big) { console.log('没有待传会话，跳过'); process.exit(0); }
console.log(`目标: ${(big.title || big.id).slice(0, 40)} · ${(big.bytes / 1048576).toFixed(2)}MB · ${big.sync}`);

const pd = await post('/preview', { ids: [big.id], cwd: CWD });
console.log(`预览: files=${pd.summary?.files} bytes=${pd.summary?.bytes}`);
if (!pd.summary?.files) { console.log('没有可传文件，跳过'); process.exit(0); }

const tid = 'cancel-check-' + Date.now();
const t0 = Date.now();
const running = post('/commit', { previewId: pd.previewId, transferId: tid });
await new Promise((r) => setTimeout(r, 400));
const c0 = Date.now();
await post('/cancel', { transferId: tid });
const cr = await running;
const took = ((Date.now() - t0) / 1000).toFixed(1);
const react = ((Date.now() - c0) / 1000).toFixed(1);
console.log(`结果: ${JSON.stringify({ ok: cr.ok, error: cr.error })} · 总耗时 ${took}s · 取消后 ${react}s 结束`);
console.log(cr.ok === false && /取消/.test(String(cr.error || '')) ? 'PASS 取消生效' : 'FAIL 取消未生效');
