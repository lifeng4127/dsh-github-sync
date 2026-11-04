#!/usr/bin/env node
// 阶段 0 验证：把真实会话的 header.cwd 改写到一个已存在的工作区，并按 projectKey 落到正确目录、
// 同时把会话注册进 workspace.json，验证"跨机重映射后能看见 + 能续聊"这条主线是否成立。
//
// 用法：
//   node verify-remap.mjs --dry-run          只算不写，打印计划
//   node verify-remap.mjs                    执行（写新会话目录 + 备份并登记 workspace.json）
//   node verify-remap.mjs --check            检查当前状态
//   node verify-remap.mjs --rollback         撤销（删新会话目录 + 摘掉登记项）
import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync,
  readdirSync, rmSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const SESSIONS_ROOT = 'C:\\Users\\14507\\.dsh\\sessions';
const WORKSPACE_JSON = 'C:\\Users\\14507\\.dsh\\storages\\workspace.json';
const JOURNAL = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'verify-remap.journal.json');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const DEFAULT_SRC = join(SESSIONS_ROOT, '--E-ruanjianxiazai-deepseek-work--',
  'session-0cbccc63-e363-458b-b727-0344de0deb6a', 'session.v4.jsonl.zstd');
const DEFAULT_TARGET_CWD = 'C:\\Users\\14507\\Documents\\deepseek-harness\\default-workspace';

// ---------- zstd 多帧 ----------
function walkFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (!buf.subarray(off, off + 4).equals(MAGIC)) throw new Error(`bad magic at ${off}`);
    const fhd = buf[off + 4];
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, didFlag = fhd & 3;
    let p = off + 5;
    if (!single) p += 1;
    p += [0, 1, 2, 4][didFlag];
    p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    let last = 0;
    while (!last) {
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      last = h & 1;
      const type = (h >> 1) & 3, size = h >>> 3;
      p += 3;
      if (type === 0) p += size;
      else if (type === 1) p += 1;
      else if (type === 2) p += size;
      else throw new Error(`reserved block type at ${p}`);
      if (p > buf.length) throw new Error(`frame overruns buffer at ${off}`);
    }
    if (checksum) p += 4;
    frames.push({ offset: off, length: p - off });
    off = p;
  }
  return frames;
}

const decode = (buf, f) => zstdDecompressSync(buf.subarray(f.offset, f.offset + f.length));
const decodeAll = (buf) => walkFrames(buf).map((f) => decode(buf, f).toString('utf8'));

// ---------- projectKey ----------
function projectKey(cwd) {
  let s = cwd.replace(/[/\\:]+/g, '-');
  s = s.replace(/[^A-Za-z0-9._-]/g, (ch) => '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
  const key = '--' + s + '--';
  return key.length > 251 ? key.slice(0, 251) : key;
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// ---------- 改写 ----------
function rewriteSession(buf, { oldId, newId, newCwd, titleSuffix }) {
  const frames = walkFrames(buf);
  const texts = frames.map((f) => decode(buf, f).toString('utf8'));
  if (newId && oldId && newId !== oldId) {
    for (let i = 0; i < texts.length; i++) texts[i] = texts[i].split(oldId).join(newId);
  }
  {
    const t = texts[0];
    const nl = t.indexOf('\n');
    const line = nl === -1 ? t : t.slice(0, nl);
    const rest = nl === -1 ? '' : t.slice(nl);
    const h = JSON.parse(line);
    h.cwd = newCwd;
    if (newId) h.id = newId;
    texts[0] = JSON.stringify(h) + rest;
  }
  if (titleSuffix) {
    outer: for (let i = texts.length - 1; i >= 0; i--) {
      if (!texts[i].includes('"type":"session/title"')) continue;
      const lines = texts[i].split('\n');
      for (let j = lines.length - 1; j >= 0; j--) {
        if (!lines[j].includes('"type":"session/title"')) continue;
        try {
          const o = JSON.parse(lines[j]);
          if (typeof o?.data?.title === 'string') {
            o.data.title = o.data.title + titleSuffix;
            lines[j] = JSON.stringify(o);
            texts[i] = lines.join('\n');
            break outer;
          }
        } catch { /* 跳过解析不了的行 */ }
      }
    }
  }
  return Buffer.concat(texts.map((t) => zstdCompressSync(Buffer.from(t, 'utf8'))));
}

function verifyBuffer(buf, { expectId, expectCwd }) {
  const frames = walkFrames(buf);
  const header = JSON.parse(decode(buf, frames[0]).toString('utf8').split('\n')[0]);
  const lines = frames.map((f) => decode(buf, f).toString('utf8')).join('').split('\n').filter(Boolean);
  let bad = 0;
  for (const l of lines) { try { JSON.parse(l); } catch { bad++; } }
  return {
    frames: frames.length, lines: lines.length, badLines: bad, header,
    ok: header.id === expectId && header.cwd === expectCwd && bad === 0,
  };
}

// ---------- 注册 ----------
function loadJson() { return JSON.parse(readFileSync(WORKSPACE_JSON, 'utf8')); }
function saveJson(j) { writeFileSync(WORKSPACE_JSON, JSON.stringify(j, null, 2), 'utf8'); }

function findWorkspace(j, cwd) {
  return Object.entries(j.tables.workspaces).find(([, w]) => norm(w.path) === norm(cwd));
}

// ---------- 主流程 ----------
const src = val('--src', DEFAULT_SRC);
const targetCwd = val('--target', DEFAULT_TARGET_CWD);
const newId = val('--id', 'session-' + randomUUID());
const titleSuffix = val('--title-suffix', '');

if (has('--check')) {
  if (!existsSync(JOURNAL)) { console.log('no journal: nothing to check'); process.exit(0); }
  const jr = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  const fileOk = existsSync(jr.targetFile);
  const ws = loadJson();
  const entry = findWorkspace(ws, jr.targetCwd);
  const registered = !!entry && entry[1].sessionIds.includes(jr.newId);
  console.log(JSON.stringify({ ...jr, fileExists: fileOk, registered }, null, 2));
  process.exit(0);
}

if (has('--register-only')) {
  // 重启后若发现登记被宿主覆盖，用这个补登记，再重启一次即可
  if (!existsSync(JOURNAL)) { console.error('no journal'); process.exit(1); }
  const jr = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  if (!existsSync(jr.targetFile)) { console.error('target file missing:', jr.targetFile); process.exit(1); }
  const ws = loadJson();
  const hit0 = findWorkspace(ws, jr.targetCwd);
  if (hit0 && hit0[1].sessionIds.includes(jr.newId)) { console.log('already registered:', jr.newId); process.exit(0); }
  const bak = `${WORKSPACE_JSON}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(WORKSPACE_JSON, bak);
  if (hit0) {
    hit0[1].sessionIds.push(jr.newId);
    hit0[1].updatedAt = new Date().toISOString();
  } else {
    const wid = randomUUID();
    ws.tables.workspaces[wid] = {
      path: jr.targetCwd, title: basename(jr.targetCwd), sessionIds: [jr.newId],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    ws.global.workspaceIds.push(wid);
  }
  saveJson(ws);
  console.log('re-registered', jr.newId, 'backup', bak);
  process.exit(0);
}

if (has('--rollback')) {
  if (!existsSync(JOURNAL)) { console.log('no journal'); process.exit(1); }
  const jr = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  const dir = dirname(jr.targetFile);
  if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); console.log('removed', dir); }
  const ws = loadJson();
  const hit = findWorkspace(ws, jr.targetCwd);
  if (hit) {
    const [, w] = hit;
    const before = w.sessionIds.length;
    w.sessionIds = w.sessionIds.filter((x) => x !== jr.newId);
    if (w.sessionIds.length !== before) { saveJson(ws); console.log('unregistered', jr.newId); }
  }
  rmSync(JOURNAL, { force: true });
  console.log('rollback done; workspace.json backup kept at', jr.backup);
  process.exit(0);
}

// 前置检查
if (!existsSync(src)) { console.error('source missing:', src); process.exit(1); }
if (!existsSync(targetCwd)) { console.error('target cwd does not exist:', targetCwd); process.exit(1); }
const tst = statSync(targetCwd);
if (!tst.isDirectory()) { console.error('target cwd is not a directory'); process.exit(1); }

const buf = readFileSync(src);
const frames = walkFrames(buf);
const header = JSON.parse(decode(buf, frames[0]).toString('utf8').split('\n')[0]);
if (header.version !== 4) { console.error('unsupported version', header.version); process.exit(1); }

const key = projectKey(targetCwd);
const targetDir = join(SESSIONS_ROOT, key, newId);
const targetFile = join(targetDir, 'session.v4.jsonl.zstd');

const rewritten = rewriteSession(buf, { oldId: header.id, newId, newCwd: targetCwd, titleSuffix });
const check = verifyBuffer(rewritten, { expectId: newId, expectCwd: targetCwd });

const allText = decodeAll(buf).join('');
const titleEvent = allText.split('\n').filter((l) => l.includes('"session/title"')).pop();
let title = '(未找到标题)';
try { const o = JSON.parse(titleEvent); title = o?.data?.title ?? o?.data?.text ?? JSON.stringify(o?.data).slice(0, 80); } catch {}
if (titleSuffix && typeof title === 'string') title = title + titleSuffix;

const plan = {
  source: src,
  sourceHeader: { id: header.id, cwd: header.cwd, version: header.version, createdAt: header.createdAt },
  newId, title,
  targetCwd, projectKey: key,
  targetFile,
  bytes: { before: buf.length, after: rewritten.length },
  frames: { before: frames.length, after: check.frames },
  selfCheck: { ok: check.ok, lines: check.lines, badLines: check.badLines, frames: check.frames },
};

if (has('--dry-run')) { console.log(JSON.stringify(plan, null, 2)); process.exit(check.ok ? 0 : 1); }

if (!check.ok) { console.error('self-check failed, aborting', check); process.exit(1); }
if (existsSync(targetDir)) { console.error('target dir already exists:', targetDir); process.exit(1); }

// 1) 写会话
mkdirSync(targetDir, { recursive: true });
writeFileSync(targetFile, rewritten);

// 2) 备份 + 注册（追加式，不动别的条目）
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${WORKSPACE_JSON}.bak-${ts}`;
copyFileSync(WORKSPACE_JSON, backup);

const ws = loadJson();
const hit = findWorkspace(ws, targetCwd);
let workspaceId;
if (hit) {
  workspaceId = hit[0];
  if (!hit[1].sessionIds.includes(newId)) hit[1].sessionIds.push(newId);
  hit[1].updatedAt = new Date().toISOString();
} else {
  workspaceId = randomUUID();
  ws.tables.workspaces[workspaceId] = {
    path: targetCwd, title: basename(targetCwd), sessionIds: [newId],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  ws.global.workspaceIds.push(workspaceId);
}
saveJson(ws);

writeFileSync(JOURNAL, JSON.stringify({
  createdAt: new Date().toISOString(), source: src, newId, title,
  targetCwd, workspaceId, targetFile, backup,
}, null, 2), 'utf8');

console.log(JSON.stringify({
  ...plan,
  written: targetFile,
  registeredIn: workspaceId,
  backup,
  next: [
    '1) 完全退出并重启 DSH（不是刷新页面）',
    '2) 打开左侧工作区 "default-workspace"，找标题为「' + title + '」的会话',
    '3) 点进去，发一句"继续"，看是否会话能正常续聊',
    '4) 若没出现：先跑 --check 看登记是否还在，再跑 --rollback 重来',
  ],
}, null, 2));
