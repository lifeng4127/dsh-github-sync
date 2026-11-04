// 只读探针：找出会话日志里"附件"是怎么被引用的
import { readFileSync } from 'node:fs';
import { decodeFrames } from '../lib/zstdframe.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: find-attachments.mjs <session file>'); process.exit(1); }
const buf = readFileSync(file);
const texts = decodeFrames(buf);

const hits = [];
function walk(value, path, depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    if (/^[0-9a-f]{64}$/i.test(value)) hits.push({ kind: 'sha-like', path, value });
    else if (value.includes('objects/')) hits.push({ kind: 'path', path, value: value.slice(0, 160) });
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1)); return; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (/attach|media/i.test(k)) hits.push({ kind: 'key', path: p, value: JSON.stringify(v).slice(0, 240) });
      walk(v, p, depth + 1);
    }
  }
}

let lineCount = 0;
for (const text of texts) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    lineCount++;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    walk(obj, obj.type ?? '?');
  }
}

console.log(`文件：${file}`);
console.log(`帧：${texts.length}  行：${lineCount}  命中：${hits.length}`);
const seen = new Set();
for (const h of hits) {
  const k = h.kind + '|' + h.path;
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(`[${h.kind}] ${h.path}\n    ${h.value}`);
  if (seen.size >= 25) break;
}
