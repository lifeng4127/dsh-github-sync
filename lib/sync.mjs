// 上传/下载的编排层：只做"计划"和"字节处理"，不碰 DSH 服务（注册与写盘由 index.js 收尾）。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { sessionsRoot } from './paths.mjs';
import { projectKey } from './projectkey.mjs';
import { projectDir } from './sessiondir.mjs';
import { SESSION_FILE, bodySha256, compareSessions, readHeader, rewriteSession, sessionBody, sha256, validateSession } from './sessionlog.mjs';
import { readCachedTitle, readTitleFast } from './localsessions.mjs';
import { attachmentObjectPath, collectAttachmentRefs, extFor, readAttachment } from './attachments.mjs';
import { assertSessionId, isHex64, isSafeSegment } from './guard.mjs';
import {
  MANIFEST_PATH, README_PATH, allocateProjectName, createManifest, parseManifest,
  registerWorkspace, renderReadme, serializeManifest, sessionPath, touch, upsertSession,
} from './manifest.mjs';

export function localSessionFile(cwd, id) {
  return join(projectDir(cwd), assertSessionId(id), SESSION_FILE);
}

/** 单个附件的大小上限（GitHub blob 接口在几 MB 以上就很吃时间） */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export { MAX_ATTACHMENT_BYTES };

/** 读远端索引（空仓库也返回可用结构） */
export async function readRemote(client) {
  const listing = await client.listFiles();
  if (listing.empty) {
    return { empty: true, map: listing.map, manifest: createManifest(), commitSha: null };
  }
  const raw = await client.readFile(MANIFEST_PATH, listing.map);
  return {
    empty: false,
    map: listing.map,
    manifest: raw ? parseManifest(raw.toString('utf8')) : createManifest(),
    commitSha: listing.commitSha,
  };
}

/**
 * 生成上传计划（纯函数 + 只读远端）。
 * 每个被选中的会话给出一个 action：upload / skip / blocked（附原因）。
 */
export async function planUpload({ client, cwd, ids, deviceId, deviceName, projectTitle, force = new Set(), now = new Date(), onProgress, shouldCancel }) {
  const remote = await readRemote(client);
  const manifest = remote.manifest;

  const existing = Object.entries(manifest.workspaces)
    .find(([, ws]) => String(ws.originalCwd ?? '').toLowerCase() === String(cwd).toLowerCase());
  const project = existing ? existing[0] : allocateProjectName(manifest, cwd, projectTitle || 'project');

  const items = [];
  const files = [];
  let manifestDirty = false;

  for (const id of ids) {
    if (shouldCancel?.()) throw new Error('已取消');
    onProgress?.({ phase: 'scan', index: items.length, path: id });
    let file;
    try { file = localSessionFile(cwd, id); }
    catch (err) { items.push({ id, action: 'blocked', reason: err.message }); continue; }
    if (!existsSync(file)) { items.push({ id, action: 'blocked', reason: '本地文件不存在' }); continue; }

    const buf = readFileSync(file);
    let active = false;
    try { active = Date.now() - statSync(file).mtimeMs < 5 * 60 * 1000; } catch { /* 拿不到 mtime 就当不活跃 */ }
    let header;
    try { header = readHeader(buf); } catch (err) {
      items.push({ id, action: 'blocked', reason: '会话文件无法解析：' + err.message });
      continue;
    }
    const title = readCachedTitle(id) ?? readTitleFast(buf);
    // 用 body 哈希而不是整份文件哈希：头帧里的 cwd 跨机必然不同
    const body = sessionBody(buf);
    const sha = sha256(body);
    const prev = manifest.sessions[id];

    let action = 'upload';
    let reason = '';
    if (prev && prev.sha256 === sha) {
      action = 'skip';
      reason = '远端已有相同版本';
    } else if (prev && prev.bodyBytes && prev.bodyBytes < body.length
      && sha256(body.subarray(0, prev.bodyBytes)) === prev.sha256) {
      // 远端那份是本地那份的前缀 → 本地只是多追加了，零网络即可判定
      action = 'upload';
      reason = '本地多追加了内容';
    } else if (prev) {
      const remoteBuf = await client.readFile(prev.path, remote.map).catch(() => null);
      if (!remoteBuf) {
        action = 'upload';
        reason = '远端索引里有、文件缺失，重新上传';
      } else {
        const cmp = compareSessions(buf, remoteBuf);
        if (cmp === 'equal') {
          action = 'skip';
          reason = '内容一致（顺手刷新远端哈希）';
          upsertSession(manifest, { ...prev, sha256: sha, bodyBytes: body.length });
          manifestDirty = true;
        }
        else if (cmp === 'local-ahead') { action = 'upload'; reason = '本地多追加了内容'; }
        else if (force.has(id)) {
          // 用户明确选了"用本地覆盖远端"：分叉/远端更新都直接推
          action = 'upload';
          reason = cmp === 'remote-ahead' ? '强制覆盖远端（远端更新过）' : '强制覆盖远端（两端分叉）';
        }
        else if (cmp === 'remote-ahead') { action = 'blocked'; reason = '远端更新，请先下载'; }
        else { action = 'blocked'; reason = '两端分叉，需先下载再决定'; }
      }
    }

    const path = prev?.path || sessionPath(project, id);
    let attachmentCount = 0;
    const attachmentWarnings = [];
    const shaList = [];
    let groupBytes = buf.length;

    // 会话要传，或者虽然内容没变但附件还没传过（补传）——两种情况都走这段
    if (action === 'upload' || action === 'skip') {
      for (const ref of collectAttachmentRefs(buf)) {
        shaList.push(ref.sha);
        if (manifest.attachments[ref.sha]) continue;
        const label = ref.name || ref.sha.slice(0, 8);
        const data = readAttachment(ref.sha);
        if (!data) { attachmentWarnings.push(`附件在本机缺失，跳过：${label}`); continue; }
        if (data.length > MAX_ATTACHMENT_BYTES) {
          attachmentWarnings.push(`附件超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB，跳过：${label}`);
          continue;
        }
        const attPath = `${project}/attachments/${ref.sha}.${extFor(ref.mediaType, ref.name)}`;
        files.push({ path: attPath, content: data });
        groupBytes += data.length;
        manifest.attachments[ref.sha] = {
          path: attPath, mediaType: ref.mediaType, name: ref.name, bytes: data.length,
        };
        attachmentCount += 1;
        manifestDirty = true;
      }

      if (action === 'upload') {
        files.push({ path, content: buf });
        upsertSession(manifest, {
          id, path, project,
          originalCwd: header.cwd,
          title: title ?? null,
          createdAt: header.createdAt ?? null,
          updatedAt: now.getTime(),
          bytes: buf.length,
          frames: undefined,
          sha256: sha,
          bodyBytes: body.length,
          attachments: shaList,
          uploadedBy: deviceId,
          uploadedAt: now.toISOString(),
        });
      } else if (attachmentCount > 0) {
        // 内容没变但补了附件：只补登记，不重传会话
        upsertSession(manifest, { ...(manifest.sessions[id] || {}), attachments: shaList });
        manifestDirty = true;
      }
    }

    items.push({
      id, title, bytes: buf.length, path, action, reason, sha256: sha.slice(0, 12),
      attachmentCount, attachmentWarnings,
      attachmentBytes: groupBytes - buf.length,
      active,
    });
  }

  const uploads = items.filter((i) => i.action === 'upload');
  if (uploads.length || manifestDirty) {
    registerWorkspace(manifest, { name: project, originalCwd: cwd, title: projectTitle || project, deviceId, deviceName });
    touch(manifest);
    files.push({ path: MANIFEST_PATH, content: serializeManifest(manifest) });
    files.push({ path: README_PATH, content: renderReadme(manifest) });
  }

  return {
    ok: true,
    direction: 'upload',
    cwd,
    project,
    items,
    files,
    manifest,
    summary: {
      upload: uploads.length,
      skip: items.filter((i) => i.action === 'skip').length,
      blocked: items.filter((i) => i.action === 'blocked').length,
      bytes: uploads.reduce((a, b) => a + (b.bytes || 0), 0),
      files: files.length,
    },
  };
}

export async function executeUpload({ client, plan, deviceName, onProgress, shouldCancel, skipPaths, transformFile }) {
  const files = plan.files ?? [];
  if (!files.length) return { ok: true, nothing: true };
  const message = `sync(${deviceName}): 上传 ${plan.summary.upload} 个会话 · ${plan.project}`;
  const res = await client.commitBatch({ files, message, onProgress, shouldCancel, skipPaths, transformFile });
  return { ok: true, ...res, project: plan.project, uploaded: plan.summary.upload };
}

/**
 * 生成下载计划：取远端字节 → 改 cwd 到目标工作区 → 与本地比较决定动作。
 * action: write / skip / blocked / fork（分叉时本地保留、远端另存）
 */
export async function planDownload({ client, ids, targetCwd, registeredElsewhere = {}, force = new Set(), onProgress, shouldCancel }) {
  const remote = await readRemote(client);
  if (remote.empty) return { ok: false, error: '远端仓库还没有内容' };

  const items = [];
  for (const id of ids) {
    if (shouldCancel?.()) throw new Error('已取消');
    onProgress?.({ phase: 'fetch', index: items.length, path: id });
    const otherPath = registeredElsewhere[id];
    if (otherPath && String(otherPath).toLowerCase() !== String(targetCwd).toLowerCase()) {
      items.push({ id, action: 'blocked', reason: `该会话已属于工作区 ${otherPath}，不能重复挂到别处` });
      continue;
    }

    const entry = remote.manifest.sessions[id];
    if (!entry) { items.push({ id, action: 'blocked', reason: '远端没有这个会话' }); continue; }
    if (!isSafeSegment(id)) { items.push({ id, action: 'blocked', reason: '会话 id 不合法，拒绝落盘' }); continue; }

    const remoteBuf = await client.readFile(entry.path, remote.map).catch(() => null);
    if (!remoteBuf) { items.push({ id, action: 'blocked', reason: '远端文件读取失败' }); continue; }

    const check = validateSession(remoteBuf);
    if (!check.ok) { items.push({ id, title: entry.title, action: 'blocked', reason: `远端会话校验失败（坏行 ${check.badLines}）` }); continue; }

    let rewritten;
    try {
      rewritten = rewriteSession(remoteBuf, { newCwd: targetCwd }).buffer;
    } catch (err) {
      items.push({ id, title: entry.title, action: 'blocked', reason: '重映射失败：' + err.message });
      continue;
    }

    const localFile = localSessionFile(targetCwd, id);
    let action = 'write';
    let reason = '';
    if (existsSync(localFile)) {
      const localBuf = readFileSync(localFile);
      const cmp = compareSessions(localBuf, rewritten);
      if (cmp === 'equal') { action = 'skip'; reason = '本地已有相同版本'; }
      else if (cmp === 'local-ahead') {
        action = force.has(id) ? 'write' : 'skip';
        reason = force.has(id) ? '强制用远端覆盖本地（本地更新过）' : '本地更新，保留本地';
      }
      else if (cmp === 'remote-ahead') { action = 'write'; reason = '远端更新，覆盖本地'; }
      else {
        action = force.has(id) ? 'write' : 'fork';
        reason = force.has(id) ? '强制用远端覆盖本地（两端分叉）' : '两端分叉：本地保留，远端另存副本';
      }
    }

    // 附件：manifest 登记的 ∪ 会话本身引用到的（后者让"上传时还没有附件功能"的旧会话也能补）
    // manifest 来自远端仓库，可能被篡改，非十六进制的一律忽略
    const wanted = new Set();
    for (const sha of entry.attachments ?? []) if (isHex64(sha)) wanted.add(sha);
    for (const ref of collectAttachmentRefs(remoteBuf)) wanted.add(ref.sha);

    const project = entry.project || String(entry.path || '').split('/')[0];
    const atts = [];
    for (const sha of wanted) {
      if (existsSync(attachmentObjectPath(sha))) continue;
      let attPath = remote.manifest.attachments?.[sha]?.path;
      if (!attPath) {
        // 旧 manifest 没登记：按约定在远端树里找 <项目>/attachments/<sha>.*
        const prefix = `${project}/attachments/${sha}.`;
        attPath = [...remote.map.keys()].find((k) => k.startsWith(prefix)) || null;
      }
      if (!attPath) {
        atts.push({ sha, action: 'blocked', reason: '远端没有这个附件' });
        continue;
      }
      const data = await client.readFile(attPath, remote.map).catch(() => null);
      if (data) atts.push({ sha, action: 'write', bytes: data.length, data });
      else atts.push({ sha, action: 'blocked', reason: '远端附件读取失败' });
    }

    items.push({
      id, title: entry.title, action, reason,
      bytes: rewritten.length,
      attachments: atts,
      data: rewritten, // Buffer，只在宿主内存里；返回给浏览器前会被剥掉
    });
  }
  return { ok: true, direction: 'download', targetCwd, items, summary: summarize(items) };
}

function summarize(items) {
  return {
    write: items.filter((i) => i.action === 'write').length,
    skip: items.filter((i) => i.action === 'skip').length,
    fork: items.filter((i) => i.action === 'fork').length,
    blocked: items.filter((i) => i.action === 'blocked').length,
    bytes: items.reduce((a, b) => a + (b.bytes || 0), 0),
  };
}

// ---------- 文件夹文件：从远端下载回工作区 ----------

/** 远端相对路径消毒：拒绝绝对路径、盘符、..、空段、控制字符 */
export function safeRelPath(rel) {
  if (!rel || typeof rel !== 'string' || rel.includes('\0')) return null;
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  const segs = norm.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segs.join('/');
}

/** 落点必须仍在工作区内（防 `..` 与符号链接式逃逸的兜底） */
function insideRoot(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

export async function planFileDownload({ client, paths, targetCwd, now = new Date() }) {
  const remote = await readRemote(client);
  if (remote.empty) return { ok: false, error: '远端仓库还没有内容' };
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const items = [];

  for (const p of paths) {
    const meta = remote.map.get(p);
    if (!meta) { items.push({ id: p, action: 'blocked', reason: '远端没有这个文件' }); continue; }
    const at = p.indexOf('/files/');
    if (at < 0) { items.push({ id: p, action: 'blocked', reason: '不是文件夹上传的文件' }); continue; }

    const rel = safeRelPath(p.slice(at + '/files/'.length));
    if (!rel) { items.push({ id: p, action: 'blocked', reason: '路径不安全（绝对路径/..），拒绝写入' }); continue; }

    const target = join(targetCwd, rel);
    if (!insideRoot(targetCwd, target)) { items.push({ id: p, action: 'blocked', reason: '落点越出工作区' }); continue; }

    const buf = await client.readFile(p, remote.map).catch(() => null);
    if (!buf) { items.push({ id: p, rel, action: 'blocked', reason: '远端文件读取失败' }); continue; }

    let action = 'write';
    let reason = '';
    let outPath = target;
    if (existsSync(target)) {
      const current = readFileSync(target);
      if (current.equals(buf)) { action = 'skip'; reason = '内容一致'; }
      else {
        action = 'copy';
        const ext = extname(target);
        const base = basename(target, ext);
        outPath = join(dirname(target), `${base}.remote-${stamp}${ext}`);
        reason = '本地同名但内容不同，另存副本';
      }
    }

    items.push({ id: p, rel, action, reason, target: outPath, bytes: buf.length, data: buf });
  }

  return {
    ok: true,
    direction: 'files',
    targetCwd,
    items,
    summary: {
      write: items.filter((i) => i.action === 'write').length,
      copy: items.filter((i) => i.action === 'copy').length,
      skip: items.filter((i) => i.action === 'skip').length,
      blocked: items.filter((i) => i.action === 'blocked').length,
      bytes: items.reduce((a, b) => a + (b.bytes || 0), 0),
    },
  };
}
