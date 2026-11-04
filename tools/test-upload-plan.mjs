// 用假 client 跑一遍上传计划（不联网），验证清单/索引/README 的组装
import { planUpload, executeUpload, localSessionFile } from '../lib/sync.mjs';
import { listSessionsForCwd } from '../lib/localsessions.mjs';
import { existsSync } from 'node:fs';

const cwd = 'E:\\ruanjianxiazai\\deepseek\\work';
const all = listSessionsForCwd(cwd);
const target = all.find((s) => s.title && s.bytes > 20000) ?? all[0];
if (!target) { console.error('no session'); process.exit(1); }
console.log('目标会话:', target.id, target.title, target.bytes + 'B');
console.log('本地路径存在:', existsSync(localSessionFile(cwd, target.id)));

const commits = [];
const stub = {
  async listFiles() { return { empty: true, map: new Map(), commitSha: null, treeSha: null }; },
  async readFile() { return null; },
  async commitBatch({ files, message }) { commits.push({ files, message }); return { commitSha: 'deadbeef', files: files.length, firstCommit: true }; },
};

const plan = await planUpload({
  client: stub, cwd, ids: [target.id, 'session-does-not-exist'],
  deviceId: 'dev-1', deviceName: 'DESKTOP-A', projectTitle: 'work',
});

console.log('项目名:', plan.project);
console.log('摘要:', JSON.stringify(plan.summary));
console.log('条目:');
for (const i of plan.items) console.log(`  ${i.action.padEnd(8)} ${i.title ?? '(no title)'} ${i.bytes ?? ''} ${i.reason ?? ''}`);
console.log('将提交的文件:');
for (const f of plan.files) console.log(`  ${f.path}  ${f.content.length}B`);

const manifestFile = plan.files.find((f) => f.path === 'manifest.json');
const readmeFile = plan.files.find((f) => f.path === 'README.md');
const ok = manifestFile && readmeFile && plan.summary.upload === 1 && plan.summary.blocked === 1;
console.log('\nmanifest 片段:', manifestFile ? manifestFile.content.toString('utf8').slice(0, 200).replace(/\n/g, ' ') : '缺失');
console.log('README 片段:', readmeFile ? readmeFile.content.split('\n').slice(0, 6).join(' | ') : '缺失');

const res = await executeUpload({ client: stub, plan, deviceName: 'DESKTOP-A' });
console.log('提交信息:', commits[0]?.message);
console.log('提交结果:', JSON.stringify(res));

console.log(ok ? '\nSELFTEST OK' : '\nSELFTEST FAIL');
process.exit(ok ? 0 : 1);
