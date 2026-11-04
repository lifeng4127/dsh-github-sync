// 查目标仓库的提交历史，判断"空仓打种子"是否真的发生过（令牌只在本进程内使用，不输出）
import { readFileSync } from 'node:fs';

const CRED = 'C:\\Users\\14507\\.dsh\\.credentials.yaml';
const REPO = process.env.CHECK_REPO || 'lifeng4127/deepseek-harness-work1';

let token = null;
try {
  const raw = readFileSync(CRED, 'utf8');
  const m = raw.match(/^\s*GITHUB_TOKEN:\s*["']?([A-Za-z0-9_\-]+)["']?\s*$/m);
  token = m ? m[1] : null;
} catch (e) {
  console.log('读凭据失败:', e.message);
}
if (!token) { console.log('没拿到令牌（可能存的是引用而非明文），改用静态信息'); process.exit(0); }
console.log('令牌已读取（长度 ' + token.length + '），不打印内容\n');

const get = async (p) => {
  const r = await fetch('https://api.github.com' + p, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-github-sync-check',
    },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const list = await get(`/repos/${REPO}/commits?per_page=10`);
if (list.status !== 200) { console.log('查询失败:', list.status, JSON.stringify(list.body).slice(0, 200)); process.exit(1); }

console.log(`仓库 ${REPO} 共 ${list.body.length} 条提交（最多列 10 条）：`);
for (const c of list.body) {
  const parents = (c.parents || []).length;
  console.log(`  ${c.sha.slice(0, 7)}  父提交=${parents}  ${String(c.commit.message).split('\n')[0].slice(0, 60)}`);
}

const oldest = list.body[list.body.length - 1];
const msgs = list.body.map((c) => String(c.commit.message).split('\n')[0]);
const hasInitial = msgs.some((m) => /^initial commit/i.test(m));
const hasSync = msgs.some((m) => /^sync\(/i.test(m));
const rootCommit = list.body.find((c) => (c.parents || []).length === 0);

console.log('\n判定：');
console.log('  存在 "Initial commit" :', hasInitial, '（有 → 仓库创建时自带文件，没走种子路径）');
console.log('  存在 "sync(...)" 提交 :', hasSync);
console.log('  根提交                :', rootCommit ? rootCommit.sha.slice(0, 7) + ' · ' + String(rootCommit.commit.message).split('\n')[0].slice(0, 50) : '(未在前 10 条里)');
if (!hasInitial && hasSync) {
  console.log('  → 仓库是空的，首传走了 Contents API 打种子 ✅');
} else if (hasInitial) {
  console.log('  → 仓库创建时已有提交，种子路径未被验证 ❌');
}
