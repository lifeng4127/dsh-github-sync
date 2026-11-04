// 离线验证「冲突选一边」与「活跃会话标记」（不联网、不写仓库）
import { readFileSync } from 'node:fs';
import { planDownload, planUpload, localSessionFile } from '../lib/sync.mjs';
import { listSessionsForCwd } from '../lib/localsessions.mjs';
import { rewriteSession } from '../lib/sessionlog.mjs';
import { walkFrames } from '../lib/zstdframe.mjs';

const cwd = 'E:\\ruanjianxiazai\\deepseek\\work';
const all = listSessionsForCwd(cwd);
const target = all.find((s) => s.title && s.bytes > 20000) ?? all[0];
const localBuf = readFileSync(localSessionFile(cwd, target.id));
const sessionPathInRepo = `work/sessions/${target.id}.jsonl.zstd`;

let pass = 0; let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' · ' + extra : ''}`);
};

const manifest = {
  version: 1,
  sessions: {
    [target.id]: {
      id: target.id, path: sessionPathInRepo, project: 'work', title: target.title,
      attachments: [], sha256: 'x', bodyBytes: localBuf.length, bytes: localBuf.length,
    },
  },
  attachments: {}, workspaces: {}, devices: {},
};

const stubWith = (remoteBuf) => ({
  async listFiles() {
    return {
      empty: false, commitSha: 'c0ffee', treeSha: 't',
      map: new Map([['manifest.json', { sha: 'm', size: 1 }], [sessionPathInRepo, { sha: 's', size: 1 }]]),
    };
  },
  async readFile(p) { return p === 'manifest.json' ? Buffer.from(JSON.stringify(manifest), 'utf8') : remoteBuf; },
});

// 远端 = 本地换个 cwd（头帧不同、body 相同）——对比时只看 body
const moved = rewriteSession(localBuf, { newCwd: 'D:\\another-machine' }).buffer;

// A. 远端多一帧 → 上传侧应 blocked，强制后应 upload
const frames = walkFrames(localBuf);
const remoteAhead = moved; // 头帧不同不影响比较
const aheadBuf = Buffer.concat([remoteAhead, Buffer.from([0x28, 0xb5, 0x2f, 0xfd])]);
// 手工拼一帧不合法，改用"截掉本地最后一帧"得到远端落后、本地领先的反向场景

console.log('\n[A] 上传：本地落后（远端更新）→ blocked，强制后 upload');
const baseForUpload = await planUpload({
  client: stubWith(moved), cwd, ids: [target.id],
  deviceId: 'dev-1', deviceName: 'DESKTOP-A', projectTitle: 'work',
});
// moved 与本地 body 相同 → 应 skip（证明对比只看 body）
ok('头帧不同不算差异（skip）', baseForUpload.items[0].action === 'skip', baseForUpload.items[0].action);

// 真正的分歧：把远端 body 的最后一个字节翻转
const diverged = Buffer.from(moved);
diverged[diverged.length - 1] ^= 0xff;
const blockedPlan = await planUpload({
  client: stubWith(diverged), cwd, ids: [target.id],
  deviceId: 'dev-1', deviceName: 'DESKTOP-A', projectTitle: 'work',
});
ok('分叉时被 blocked', blockedPlan.items[0].action === 'blocked', blockedPlan.items[0].reason);

const forcedPlan = await planUpload({
  client: stubWith(diverged), cwd, ids: [target.id], force: new Set([target.id]),
  deviceId: 'dev-1', deviceName: 'DESKTOP-A', projectTitle: 'work',
});
ok('强制后改为 upload', forcedPlan.items[0].action === 'upload', forcedPlan.items[0].reason);
ok('强制原因写明覆盖远端', /强制覆盖远端/.test(forcedPlan.items[0].reason || ''));

console.log('\n[B] 下载：本地领先 → 默认 skip，强制后 write');
const movedFrames = walkFrames(moved); // 偏移量必须取自已重写后的缓冲区
const cutAt = movedFrames[movedFrames.length - 1].offset; // 去掉最后一帧，得到"远端落后"
const remoteBehind = Buffer.from(moved.subarray(0, cutAt));
const dl = await planDownload({
  client: stubWith(remoteBehind), ids: [target.id], targetCwd: cwd,
});
ok('默认保留本地（skip）', dl.items[0].action === 'skip', `${dl.items[0].action} ${dl.items[0].reason}`);
const dlForce = await planDownload({
  client: stubWith(remoteBehind), ids: [target.id], targetCwd: cwd, force: new Set([target.id]),
});
ok('强制后改为 write', dlForce.items[0].action === 'write', dlForce.items[0].reason);
ok('强制原因写明覆盖本地', /强制用远端覆盖本地/.test(dlForce.items[0].reason || ''));

console.log('\n[C] 活跃会话标记');
const anyActive = blockedPlan.items[0].active === true || baseForUpload.items[0].active === true;
ok('最近 5 分钟写入的会话标 active', anyActive, String(blockedPlan.items[0].active));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
