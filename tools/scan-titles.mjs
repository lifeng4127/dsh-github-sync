#!/usr/bin/env node
// 扫描某工作区全部会话：id / createdAt / 标题 / 大小 / mtime
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const SESSIONS_ROOT = 'C:\\Users\\14507\\.dsh\\sessions';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function walkFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (!buf.subarray(off, off + 4).equals(MAGIC)) break;
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
      else break;
    }
    if (checksum) p += 4;
    frames.push({ offset: off, length: p - off });
    off = p;
  }
  return frames;
}

const key = process.argv[2];
const dir = join(SESSIONS_ROOT, key);
const out = [];
for (const id of readdirSync(dir)) {
  const file = join(dir, id, 'session.v4.jsonl.zstd');
  let st;
  try { st = statSync(file); } catch { continue; }
  const buf = readFileSync(file);
  const frames = walkFrames(buf);
  let title = '(none)';
  for (const f of frames) {
    const t = zstdDecompressSync(buf.subarray(f.offset, f.offset + f.length)).toString('utf8');
    if (!t.includes('"session/title"')) continue;
    for (const line of t.split('\n')) {
      if (!line.includes('"session/title"')) continue;
      try { const o = JSON.parse(line); if (o.type === 'session/title') title = o?.data?.title ?? o?.data?.text ?? title; } catch {}
    }
  }
  const header = JSON.parse(zstdDecompressSync(buf.subarray(frames[0].offset, frames[0].offset + frames[0].length)).toString('utf8').split('\n')[0]);
  out.push({ id, title, createdAt: header.createdAt, cwd: header.cwd, bytes: st.size, mtime: st.mtime.toISOString() });
}
out.sort((a, b) => b.mtime.localeCompare(a.mtime));
for (const r of out) {
  console.log(`${new Date(r.createdAt).toISOString().slice(0, 16)}  ${String(r.bytes).padStart(8)}  ${r.id}  ${r.title}`);
}
console.log(`total: ${out.length}`);
