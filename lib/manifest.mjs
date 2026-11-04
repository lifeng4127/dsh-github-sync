// 远端索引 manifest.json：它让"项目/会话/路径"在跨机时保持稳定，并驱动自动生成的 README。

export const MANIFEST_PATH = 'manifest.json';
export const README_PATH = 'README.md';
export const SCHEMA = 1;

export function createManifest() {
  return {
    schema: SCHEMA,
    updatedAt: new Date().toISOString(),
    devices: {},
    workspaces: {},
    sessions: {},
    attachments: {},
  };
}

export function parseManifest(text) {
  let m;
  try { m = JSON.parse(String(text)); } catch { return createManifest(); }
  if (!m || typeof m !== 'object') return createManifest();
  m.schema ??= SCHEMA;
  m.devices ??= {};
  m.workspaces ??= {};
  m.sessions ??= {};
  m.attachments ??= {};
  return m;
}

/**
 * 多设备安全：把"刚刚重新读到的远端索引"和"我们计划里的索引"合并。
 *
 * 场景：A 机预览后、提交前，B 机推了新会话。A 若直接提交自己的 manifest，
 * 就会把 B 的条目覆盖掉（blob 还在，但索引里消失了）。合并规则是"并集 +
 * 我们这份优先"，这样两边的东西都留得住。
 */
export function mergeRemoteManifest(fresh, ours) {
  const out = {
    schema: fresh?.schema ?? ours?.schema ?? SCHEMA,
    devices: { ...(fresh?.devices ?? {}) },
    workspaces: { ...(fresh?.workspaces ?? {}), ...(ours?.workspaces ?? {}) },
    sessions: { ...(fresh?.sessions ?? {}), ...(ours?.sessions ?? {}) },
    attachments: { ...(fresh?.attachments ?? {}), ...(ours?.attachments ?? {}) },
  };
  for (const [id, d] of Object.entries(ours?.devices ?? {})) {
    const prev = out.devices[id];
    if (!prev) { out.devices[id] = d; continue; }
    const newer = String(d?.lastSeen ?? '') > String(prev?.lastSeen ?? '') ? d.lastSeen : prev.lastSeen;
    out.devices[id] = { ...prev, ...d, lastSeen: newer };
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

export function serializeManifest(m) {  return JSON.stringify(m, null, 2) + '\n';
}

/** 项目名安全化：Windows 非法字符换掉，去首尾点与空白 */
export function safeProjectName(title) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return (cleaned || 'project').slice(0, 60);
}

/** 同一项目名被不同工作区占用时加后缀（依据 manifest 记录） */
export function allocateProjectName(manifest, cwd, preferred) {
  const base = safeProjectName(preferred);
  const used = new Map();
  for (const [name, ws] of Object.entries(manifest.workspaces)) {
    used.set(name, ws.originalCwd);
  }
  const sameCwd = Object.entries(manifest.workspaces).find(([, ws]) => ws.originalCwd === cwd);
  if (sameCwd) return sameCwd[0];
  if (!used.has(base) || used.get(base) === cwd) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate) || used.get(candidate) === cwd) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function registerWorkspace(manifest, { name, originalCwd, title, deviceId, deviceName }) {
  manifest.workspaces[name] ??= {
    title: title ?? name,
    originalCwd,
    fromDevice: deviceId ?? null,
    createdAt: new Date().toISOString(),
  };
  if (deviceId) {
    manifest.devices[deviceId] ??= { name: deviceName ?? deviceId, lastSeen: new Date().toISOString() };
    manifest.devices[deviceId].lastSeen = new Date().toISOString();
  }
  return manifest.workspaces[name];
}

export function sessionPath(project, sessionId) {
  return `${project}/sessions/${sessionId}.jsonl.zstd`;
}

export function upsertSession(manifest, entry) {
  const prev = manifest.sessions[entry.id];
  manifest.sessions[entry.id] = { ...prev, ...entry };
  return manifest.sessions[entry.id];
}

export function removeSession(manifest, id) {
  delete manifest.sessions[id];
}

export function touch(manifest) {
  manifest.updatedAt = new Date().toISOString();
  return manifest;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(iso) {
  if (!iso) return '?';
  try {
    const d = new Date(iso);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return String(iso); }
}

/** 生成仓库首页：设备 × 项目 × 会话 */
export function renderReadme(manifest) {
  const lines = [];
  lines.push('# DSH 跨设备同步仓库');
  lines.push('');
  lines.push('> 由 `dsh-github-sync` 自动生成，请勿手改。每次上传都会重写本文件。');
  lines.push('');
  lines.push(`- 最近更新：${fmtTime(manifest.updatedAt)}`);
  const sessionCount = Object.keys(manifest.sessions).length;
  const projectNames = Object.keys(manifest.workspaces);
  lines.push(`- 项目数：${projectNames.length}　会话数：${sessionCount}　设备数：${Object.keys(manifest.devices).length}`);
  lines.push('');

  if (Object.keys(manifest.devices).length) {
    lines.push('## 设备');
    lines.push('');
    lines.push('| 设备 | 最近活动 |');
    lines.push('| --- | --- |');
    for (const [id, d] of Object.entries(manifest.devices)) {
      lines.push(`| ${d.name ?? id} | ${fmtTime(d.lastSeen)} |`);
    }
    lines.push('');
  }

  for (const name of projectNames.sort()) {
    const ws = manifest.workspaces[name];
    const sessions = Object.values(manifest.sessions)
      .filter((s) => s.project === name)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    lines.push(`## ${name}`);
    lines.push('');
    lines.push(`- 原始路径：\`${ws.originalCwd}\``);
    lines.push(`- 会话数：${sessions.length}`);
    lines.push('');
    if (sessions.length) {
      lines.push('| 会话 | 创建于 | 大小 | 帧 | 上传设备 |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const s of sessions) {
        const title = (s.title ?? s.id).replace(/\|/g, '\\|');
        lines.push(`| [${title}](${s.path}) | ${fmtTime(new Date(s.createdAt ?? 0).toISOString())} | ${fmtBytes(s.bytes)} | ${s.frames ?? '?'} | ${manifest.devices[s.uploadedBy]?.name ?? s.uploadedBy ?? '?'} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
