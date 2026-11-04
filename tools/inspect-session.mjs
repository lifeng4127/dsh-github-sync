#!/usr/bin/env node
// 只读探查：zstd 多帧遍历 + 会话头/事件统计 + 附件引用探测
// 用法：
//   node inspect-session.mjs --workspace --E-ruanjianxiazai-deepseek-work--       列出候选
//   node inspect-session.mjs --file <path>                                         检查单个
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const SESSIONS_ROOT = 'C:\\Users\\14507\\.dsh\\sessions';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function walkFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (!buf.subarray(off, off + 4).equals(MAGIC)) {
      throw new Error(`bad magic at offset ${off} (file len ${buf.length})`);
    }
    const fhd = buf[off + 4];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const didFlag = fhd & 3;
    let p = off + 5;
    if (!single) p += 1;
    p += [0, 1, 2, 4][didFlag];
    const fcsLen = fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    p += fcsLen;
    let last = 0;
    while (!last) {
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
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

function decodeFrame(buf, f) {
  return zstdDecompressSync(buf.subarray(f.offset, f.offset + f.length));
}

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function listSessions(wsKey) {
  const dir = join(SESSIONS_ROOT, wsKey);
  const out = [];
  for (const id of readdirSync(dir)) {
    const d = join(dir, id);
    let st;
    try { st = statSync(d); } catch { continue; }
    if (!st.isDirectory()) continue;
    const file = join(d, 'session.v4.jsonl.zstd');
    let fs2;
    try { fs2 = statSync(file); } catch { continue; }
    out.push({ id, file, bytes: fs2.size, mtime: fs2.mtime });
  }
  return sortBy(out, 'mtime', -1);
}

function sortBy(arr, key, dir) {
  return arr.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * dir);
}

function inspect(file) {
  const buf = readFileSync(file);
  const frames = walkFrames(buf);
  const firstText = decodeFrame(buf, frames[0]).toString('utf8');
  const allText = frames.map((f) => decodeFrame(buf, f).toString('utf8')).join('');
  const lines = allText.split('\n').filter(Boolean);
  let header = null;
  try { header = JSON.parse(lines[0]); } catch { header = { parseError: lines[0]?.slice(0, 200) }; }

  const counts = new Map();
  let badLines = 0;
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      counts.set(o.type ?? '(no type)', (counts.get(o.type ?? '(no type)') ?? 0) + 1);
    } catch { badLines++; }
  }

  const id = header?.id;
  const idRefs = id ? allText.split(id).length - 1 : 0;
  const attachLines = lines.filter((l) => l.includes('attach') || l.includes('media/'));

  return {
    file, bytes: buf.length, frames: frames.length,
    frame1ContentBytes: decodeFrame(buf, frames[0]).length,
    frame1IsJustHeader: firstText.endsWith('\n') && firstText.split('\n').filter(Boolean).length === 1,
    header, headerCwd: header?.cwd, headerId: id, headerVersion: header?.version,
    totalLines: lines.length, badLines, eventTypes: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    idRefs, attachLineCount: attachLines.length, attachSamples: attachLines.slice(0, 3).map((l) => l.slice(0, 400)),
  };
}

const wsKey = getArg('--workspace');
const fileArg = getArg('--file');

if (fileArg) {
  const r = inspect(fileArg);
  console.log(JSON.stringify({ ...r, attachSamples: r.attachSamples }, null, 2));
} else if (wsKey) {
  const list = listSessions(wsKey);
  console.log(`workspace ${wsKey}: ${list.length} sessions`);
  for (const s of list.slice(0, 20)) {
    console.log(`${s.id}  ${String(s.bytes).padStart(8)}B  ${s.mtime.toISOString()}`);
  }
} else {
  console.log('need --workspace <key> or --file <path>');
}
