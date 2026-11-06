// dsh-github-sync · 宿主半边
// 只依赖 Node 内置。配置存在自己的状态文件里（$DSH_HOME/github-sync/state.json），
// 不声明 Config——本地安装是符号链接，解析不到 asar 内的 @deepseek-ai/* 包。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listSessionsForCwd } from './lib/localsessions.mjs';
import { dshHome, sessionsRoot } from './lib/paths.mjs';
import { GitHubClient, parseRepo } from './lib/github.mjs';
import { executeUpload, localSessionFile, planDownload, planFileDownload, planUpload, readRemote } from './lib/sync.mjs';
import { listDir, scanFolder } from './lib/folders.mjs';
import { attachmentObjectPath, collectAttachmentRefs, restoreAttachment } from './lib/attachments.mjs';
import { MANIFEST_PATH, README_PATH, mergeRemoteManifest, renderReadme, safeProjectName, serializeManifest, touch } from './lib/manifest.mjs';
import { assertInsideRoot, isInsideRoot } from './lib/guard.mjs';
import { projectDir } from './lib/sessiondir.mjs';

export const name = 'dsh-github-sync';

export const inject = ['webServer', 'credentials', 'workspaceRegistry', 'tools'];

const VERSION = '0.5.1';
const PREFIX = '/dsh-github-sync';
const DATA_DIR = join(dshHome(), 'github-sync');
const STATE_FILE = join(DATA_DIR, 'state.json');
const HISTORY_FILE = join(DATA_DIR, 'history.jsonl');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.idea', '.vscode', '__pycache__', '*.bak', '*.log',
  '*.tmp', '.env', '.env.*', '*.key', '*.pem', '_session-dump.jsonl', 'asar-dsh-files.txt',
];

function defaultState() {
  return {
    deviceId: randomUUID(),
    deviceName: hostname(),
    repo: '',
    branch: 'main',
    // 文件夹/文件同步默认关闭：公开发布时只同步对话，需要的人自己打开
    enableFiles: false,
    // 预览后直接执行（高级偏好，默认仍走两段式）
    skipPreview: false,
    excludes: DEFAULT_EXCLUDES.slice(),
    lastSync: {},
    // 最近一次读到的远端索引（用于算"同步状态"、设备列表，避免每次列表都联网）
    remoteCache: null,
    updatedAt: new Date().toISOString(),
  };
}

function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { ...defaultState(), ...raw, excludes: Array.isArray(raw.excludes) ? raw.excludes : DEFAULT_EXCLUDES.slice() };
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 历史文件保留天数：超过 100 天的记录自动清掉。
 * 清理不是每次写都做（避免频繁读写），而是每天最多一次。
 */
const HISTORY_KEEP_DAYS = 100;
const HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastHistoryPrune = 0;

/** 删掉超过保留期的历史行；坏行保留（宁可留着也别误删） */
function pruneHistory(force = false) {
  const now = Date.now();
  if (!force && now - lastHistoryPrune < HISTORY_PRUNE_INTERVAL_MS) return 0;
  lastHistoryPrune = now;
  let text;
  try { text = readFileSync(HISTORY_FILE, 'utf8'); } catch { return 0; }
  const cutoff = now - HISTORY_KEEP_DAYS * 86400000;
  const kept = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let at = NaN;
    try { at = Date.parse(JSON.parse(line).at); } catch { /* 坏行：保留 */ }
    if (Number.isFinite(at) && at < cutoff) { dropped += 1; continue; }
    kept.push(line);
  }
  if (!dropped) return 0;
  try {
    writeFileSync(HISTORY_FILE, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  } catch { return 0; }
  return dropped;
}

/** 审计留痕：每次提交/下载追加一行，出问题时能回看"什么时候传了什么" */
function logHistory(entry) {
  // 没实际动作的记录（例如"无事可做"的提交）不写，避免历史里全是噪声
  if (entry && entry.kind === 'upload' && !entry.files && !entry.commit) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    pruneHistory();
    writeFileSync(HISTORY_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', {
      flag: 'a', encoding: 'utf8',
    });
  } catch { /* 历史写失败不影响主流程 */ }
}

/** 预演计划暂存（内存，10 分钟过期）；执行时必须带回来 */
const pending = new Map();
const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** 传输进度（内存）：transferId → 进度对象，供面板轮询与取消 */
const transfers = new Map();

function beginTransfer(id, total, bytesTotal, kind = 'upload', files = [], sessionFiles = {}, labels = {}) {
  const fileEntries = files.map((f) => ({
    path: f.path,
    bytes: typeof f.bytes === 'number' ? f.bytes : Buffer.byteLength(f.content ?? ''),
    state: 'pending',
  }));
  transfers.set(id, {
    id, kind, total, bytesTotal, done: 0, bytesDone: 0,
    phase: 'pending', currentPath: null,
    files: fileEntries,
    // 会话文件路径 → 它名下的附件文件路径；取消一个会话时按这张表连带取消
    sessionFiles,
    // 会话文件路径 → 显示名（标题），列表里不显示裸文件名
    labels,
    skipped: [],
    // 取消时要能真正打断进行中的请求，而不只是等它传完
    controller: new AbortController(),
    startedAt: Date.now(), cancelled: false, finished: false, error: null, commitSha: null,
  });
  return transfers.get(id);
}

function updateTransfer(id, p) {
  const t = transfers.get(id);
  if (!t) return;
  // done 用"已完成个数"推进（blob 是并发的，不能用下标当计数）
  if (typeof p.done === 'number') t.done = p.done;
  else if (typeof p.index === 'number' && p.phase !== 'blob' && p.phase !== 'blob-done') t.done = p.index;
  if (p.phase) t.phase = p.phase;
  if (p.path) t.currentPath = p.path;
  if (typeof p.bytes === 'number') t.bytesDone += p.bytes;

  const mark = (i, state) => { const f = t.files[i]; if (f) f.state = state; };
  if (p.phase === 'blob' && typeof p.index === 'number') {
    mark(p.index, 'current');
  } else if (p.phase === 'blob-done' && typeof p.index === 'number') {
    mark(p.index, 'done');
  } else if (p.phase === 'write' && typeof p.index === 'number') {
    for (let i = 0; i < p.index; i++) if (t.files[i]?.state === 'current') t.files[i].state = 'done';
    mark(p.index, 'current');
  } else if (p.phase === 'skip' && typeof p.index === 'number') {
    mark(p.index, 'skipped');
  } else if (p.phase === 'done') {
    for (const f of t.files) if (f.state !== 'skipped') f.state = 'done';
    t.done = t.total;
  }
}

// 一小时前的进度记录清掉，避免内存里越积越多
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, t] of transfers) if (t.startedAt < cutoff) transfers.delete(id);
}, 10 * 60 * 1000).unref?.();

function putPlan(kind, plan) {
  const now = Date.now();
  for (const [id, entry] of pending) if (now - entry.at > PREVIEW_TTL_MS) pending.delete(id);
  const previewId = randomUUID();
  pending.set(previewId, { kind, plan, at: now });
  lastPreview = { kind, id: previewId, plan, at: now };
  return previewId;
}

/** 最近一次预览：面板切走再回来时用它把预览遮罩恢复出来 */
let lastPreview = null;

/** 剥掉不能/不该发给浏览器的字段（Buffer 与整份 manifest） */
function publicPlan(plan) {
  return {
    ...plan,
    manifest: undefined,
    files: (plan.files ?? []).map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content) })),
    items: (plan.items ?? []).map(({ data, ...rest }) => ({
      ...rest,
      attachments: Array.isArray(rest.attachments)
        ? rest.attachments.map(({ data: _d, ...a }) => a)
        : rest.attachments,
    })),
  };
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export function apply(ctx, config = {}) {
  const tokenRef = config.tokenRef || 'GITHUB_TOKEN';
  let state = readState();
  if (config.repo) state.repo = config.repo;
  if (config.branch) state.branch = config.branch;
  // 启动时清一次过期历史（超过保留期的记录），之后每天最多再清一次
  try { pruneHistory(true); } catch { /* 清不掉也不影响使用 */ }
  /**
   * 令牌必须是可打印 ASCII（github_pat_… / ghp_…）。
   * 凭据里一旦混入中文（例如把报错文本写进了 ref），拼请求头时会抛
   * "Cannot convert argument to a ByteString"，报错完全看不出根因，
   * 所以这里提前拦下，交给界面提示"重新粘贴令牌"。
   */
  const sanitizeToken = (value) => {
    if (typeof value !== 'string') return null;
    const t = value.trim();
    if (t.length < 20) return null;
    if (!/^[\x21-\x7E]+$/.test(t)) return null;
    return t;
  };

  let tokenMalformed = false;
  const resolveToken = async () => {
    try {
      const resolved = await ctx.credentials.resolve(tokenRef);
      const raw = resolved?.value ?? null;
      const clean = sanitizeToken(raw);
      tokenMalformed = raw !== null && raw !== undefined && clean === null;
      return clean;
    } catch {
      return null;
    }
  };

  const clientFor = (repo, token, signal) => new GitHubClient({ token, repo, branch: state.branch, signal });

  // 宿主进程的 cwd 是 profile 目录，不是工作区；默认工作区从注册表里按最近活动取。
  const defaultWorkspacePath = () => {
    try {
      const list = ctx.workspaceRegistry.list();
      if (!list.length) return process.cwd();
      const time = (w) => new Date(w.updatedAt ?? 0).getTime() || 0;
      return [...list].sort((a, b) => time(b) - time(a))[0].path;
    } catch {
      return process.cwd();
    }
  };

  /** 取工作区实体；不存在就建一个（下载到新目录时用） */
  const ensureWorkspace = async (cwd) => {
    const existing = await ctx.workspaceRegistry.resolveByPath(cwd);
    if (existing) return existing;
    return ctx.workspaceRegistry.create(cwd, basename(cwd));
  };

  /** 文件同步默认关闭：未启用时直接拒绝，避免"我没开它却动了我的工作区" */
  const filesOff = (res) => {
    if (state.enableFiles) return false;
    sendJson(res, 403, { ok: false, error: '文件同步未启用：在设置里打开「启用文件夹/文件同步」' });
    return true;
  };

  /** sessionId → 它已归属的工作区路径（用于阻止把同一会话挂到第二个项目） */
  const registeredPaths = () => {
    const map = {};
    try {
      for (const ws of ctx.workspaceRegistry.list()) {
        for (const id of ws.sessionIds) map[id] = ws.path;
      }
    } catch { /* 注册表暂时不可用时放行，后续 attach 会再校验 */ }
    return map;
  };

  /**
   * 会话文件路径 → 它名下附件在本批里的路径。
   * 目的是"取消一个会话时，连带取消它引用的附件"，而不是让用户一格格勾附件。
   */
  const buildSessionFiles = (plan) => {
    const map = {};
    const files = plan.files ?? [];
    for (const s of Object.values(plan.manifest?.sessions ?? {})) {
      if (!s?.path) continue;
      map[s.path] = (s.attachments ?? []).flatMap((sha) => files
        .filter((f) => String(f.path).includes(`/attachments/${sha}.`))
        .map((f) => f.path));
    }
    return map;
  };

  /**
   * 本地附件回收：删掉没有任何本地会话再引用的附件对象。
   * 扫描全部会话（不只当前工作区），避免误删别的工作区正在用的附件。
   */
  const gcLocalAttachments = () => {
    const keep = new Set();
    let scanned = 0;
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (e.name !== 'session.v4.jsonl.zstd') continue;
        try {
          const buf = readFileSync(p);
          for (const ref of collectAttachmentRefs(buf)) keep.add(ref.sha);
          scanned += 1;
        } catch { /* 坏文件跳过 */ }
      }
    };
    walk(sessionsRoot());
    const root = join(dshHome(), 'attachments', 'v1', 'objects');
    let freed = 0;
    try {
      for (const bucket of readdirSync(root)) {
        const bdir = join(root, bucket);
        let names;
        try { names = readdirSync(bdir); } catch { continue; }
        for (const name of names) {
          if (!/^[0-9a-f]{64}$/i.test(name)) continue;
          if (keep.has(name)) continue;
          try { rmSync(join(bdir, name), { force: true }); freed += 1; } catch { /* 被占用就跳过 */ }
        }
      }
    } catch { /* 没有附件目录 */ }
    return { freed, scanned, kept: keep.size };
  };

  /**
   * 诊断用：当前工作区"应该"落在哪个会话目录，以及 sessions 根下实际有哪些目录。
   * macOS 上如果键算法与插件不同，用户把这几行发过来就能定位——不用再让对方描述。
   */
  const sessionDirsReport = () => {
    const cwd = defaultWorkspacePath();
    const expected = projectDir(cwd);
    const out = [`会话目录(应有): ${expected}`];
    try {
      const names = readdirSync(sessionsRoot(), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const hit = names.includes(basename(expected));
      out.push(`会话目录命中: ${hit ? '是' : '否（若列表为空，请把下面这行发出来）'}`);
      out.push(`sessions 根下 ${names.length} 个目录: ${names.slice(0, 12).join(' | ')}${names.length > 12 ? ' | …' : ''}`);
    } catch (err) {
      out.push(`sessions 根不可读: ${err.message}`);
    }
    return out;
  };

  /** 跳过文件时，把 manifest 里对应的会话/附件引用一并摘掉，避免留下悬空引用 */  const manifestTransform = (tid) => (path, content) => {
    if (path !== 'manifest.json') return content;
    const skipped = transfers.get(tid)?.skipped ?? [];
    if (!skipped.length) return content;
    let m;
    try { m = JSON.parse(content.toString('utf8')); } catch { return content; }
    const skippedSet = new Set(skipped);
    const skippedShas = new Set();
    for (const p of skipped) {
      const mm = String(p).match(/attachments\/([0-9a-f]{64})\./i);
      if (mm) skippedShas.add(mm[1]);
    }
    if (skippedShas.size) {
      for (const sha of skippedShas) { if (m.attachments) delete m.attachments[sha]; }
      for (const s of Object.values(m.sessions ?? {})) {
        if (Array.isArray(s.attachments)) s.attachments = s.attachments.filter((x) => !skippedShas.has(x));
      }
    }
    for (const [id, s] of Object.entries(m.sessions ?? {})) {
      if (s && skippedSet.has(s.path)) delete m.sessions[id];
    }
    return Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf8');
  };

  /** 执行下载计划：写文件 + 挂到工作区（分叉时另存副本、不挂载） */
  const applyDownloadPlan = async (plan, { onProgress, shouldCancel } = {}) => {
    const applied = [];
    let index = 0;
    for (const item of plan.items) {
      // 附件先补：即使会话本身 skip，缺的附件也要落回来
      for (const att of item.attachments ?? []) {
        if (att.action !== 'write' || !att.data) continue;
        if (shouldCancel?.()) throw new Error('已取消');
        onProgress?.({ phase: 'write', index, path: att.sha.slice(0, 12), bytes: att.bytes || 0 });
        const r = restoreAttachment(att.sha, att.data);
        if (r.written) applied.push({ id: att.sha, action: 'attachment', file: r.target });
        index += 1;
      }
      if (item.action !== 'write' && item.action !== 'fork') continue;
      if (shouldCancel?.()) throw new Error('已取消');
      onProgress?.({ phase: 'write', index, path: item.id, bytes: item.bytes || 0 });
      index += 1;
      const dir = dirname(localSessionFile(plan.targetCwd, item.id));
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const file = item.action === 'fork'
        ? join(dir, `${item.id}.remote-fork-${stamp}-${state.deviceName}.jsonl.zstd`)
        : localSessionFile(plan.targetCwd, item.id);
      assertInsideRoot(sessionsRoot(), file, '会话文件');
      writeFileSync(file, item.data);
      if (item.action === 'write') {
        const ws = await ensureWorkspace(plan.targetCwd);
        try {
          await ws.attachSession(item.id);
        } catch (err) {
          // 同机"删了再下"时，宿主内存里还记着旧 cwd，会拒绝挂载——给出可执行的提示
          const msg = String(err?.message ?? err);
          applied.push({
            id: item.id, action: 'attach-failed', file, error: msg,
            hint: /cwd resolves to/i.test(msg) ? '本机已有同 id 的旧记录：重启 DSH 后再下一次即可挂载' : null,
          });
          continue;
        }
      }
      applied.push({ id: item.id, action: item.action, file });
    }
    return applied;
  };

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh');
    const path = url.pathname;
    try {
      if (path === `${PREFIX}/status`) {
        const token = await resolveToken();
        const rc = state.remoteCache;
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          device: { id: state.deviceId, name: state.deviceName },
          repo: state.repo,
          branch: state.branch,
          hasToken: Boolean(token),
          tokenMalformed,
          enableFiles: Boolean(state.enableFiles),
          skipPreview: Boolean(state.skipPreview),
          cwd: process.cwd(),
          defaultCwd: defaultWorkspacePath(),
          dshHome: dshHome(),
          excludes: state.excludes,
          remote: rc ? {
            at: rc.at,
            commit: rc.commitSha ?? null,
            sessionCount: Object.keys(rc.sessions ?? {}).length,
            deviceCount: Object.keys(rc.devices ?? {}).length,
          } : null,
        });
      }

      if (path === `${PREFIX}/sessions`) {
        const cwd = url.searchParams.get('cwd') || defaultWorkspacePath();
        const rc = state.remoteCache;
        const remoteSessions = rc?.sessions ?? {};
        const rows = listSessionsForCwd(cwd).map((r) => {
          const entry = remoteSessions[r.id];
          let sync = 'not-uploaded';
          let remoteBytes = null;
          if (entry) {
            remoteBytes = entry.bytes ?? null;
            if (entry.sha256 && r.bodySha256 && entry.sha256 === r.bodySha256) sync = 'synced';
            else if (entry.bodyBytes && r.bodyBytes && entry.bodyBytes < r.bodyBytes) sync = 'local-ahead';
            else if (entry.bodyBytes && r.bodyBytes && entry.bodyBytes > r.bodyBytes) sync = 'remote-ahead';
            else sync = 'changed';
          }
          return {
            id: r.id, title: r.title, bytes: r.bytes, mtimeMs: r.mtimeMs,
            sha256: r.sha256, bodySha256: r.bodySha256,
            createdAt: r.header?.createdAt ?? null,
            origin: r.header?.origin ?? null, error: r.error,
            sync, remoteBytes,
            active: Date.now() - r.mtimeMs < 5 * 60 * 1000,
          };
        });
        return sendJson(res, 200, {
          ok: true,
          cwd,
          remoteAt: rc?.at ?? null,
          sessions: rows,
        });
      }

      if (path === `${PREFIX}/devices`) {
        const rc = state.remoteCache;
        const devices = Object.entries(rc?.devices ?? {}).map(([id, d]) => ({
          id, name: d.name ?? id, lastSeen: d.lastSeen ?? null,
          isThisDevice: id === state.deviceId,
        }));
        return sendJson(res, 200, { ok: true, devices, cachedAt: rc?.at ?? null });
      }

      if (path === `${PREFIX}/diagnostics`) {
        const token = await resolveToken();
        const rc = state.remoteCache;
        const readHistory = (n) => {
          const rows = [];
          try {
            const text = readFileSync(HISTORY_FILE, 'utf8');
            for (const line of text.split('\n')) {
              if (!line.trim()) continue;
              try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
            }
          } catch { /* 没有历史 */ }
          return rows.slice(-n).reverse();
        };
        const lines = [
          `# dsh-github-sync 诊断报告`,
          `生成时间: ${new Date().toISOString()}`,
          `版本: ${VERSION}`,
          `设备: ${state.deviceName} (${state.deviceId})`,
          `仓库: ${state.repo || '(未配置)'}  分支: ${state.branch}`,
          `令牌: ${token ? '已配置（格式有效）' : tokenMalformed ? '已配置但内容损坏' : '未配置'}`,
          `文件同步: ${state.enableFiles}  跳过预览: ${state.skipPreview}`,
          `工作区: ${defaultWorkspacePath()}`,
          `数据目录: ${DATA_DIR}`,
          `远端索引: ${rc ? `${rc.at} commit=${String(rc.commitSha || '').slice(0, 7)} 会话=${Object.keys(rc.sessions ?? {}).length}` : '(尚未读取)'}`,
          `进行中的传输: ${[...transfers.values()].filter((t) => !t.finished).length}`,
          `平台: ${process.platform} (${process.arch})`,
          ...sessionDirsReport(),
          `可写范围: ${DATA_DIR} · ${sessionsRoot()} · ${join(dshHome(), 'attachments', 'v1', 'objects')}`
            + (state.enableFiles ? ` · 工作区 ${defaultWorkspacePath()}（文件同步已开启）` : '（文件同步关闭，不碰工作区）'),
          '不会: 启动子进程 / 读写注册表 / 改 hosts / 改环境变量 / 装全局代理',
          '',
          '## 最近传输',
          ...[...transfers.values()]
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 8)
            .map((t) => `- ${new Date(t.startedAt).toISOString()} ${t.kind} ${t.done}/${t.total} `
              + `${t.finished ? '结束' : '进行中'}${t.error ? ` 错误=${t.error}` : ''}${t.commitSha ? ` commit=${String(t.commitSha).slice(0, 7)}` : ''}`),
          '',
          '## 最近历史',
          ...readHistory(10).map((h) => `- ${h.at} ${h.kind} ${JSON.stringify({ files: h.files, sessions: (h.sessions || []).length, commit: h.commit, freed: h.freedAttachments, attachmentsDeleted: h.attachmentsDeleted })}`),
        ];
        return sendJson(res, 200, { ok: true, text: lines.join('\n') });
      }

      if (path === `${PREFIX}/history`) {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
        const rows = [];
        try {
          const text = readFileSync(HISTORY_FILE, 'utf8');
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
          }
        } catch { /* 还没有历史 */ }
        return sendJson(res, 200, { ok: true, history: rows.slice(-limit).reverse() });
      }

      if (path === `${PREFIX}/workspaces`) {
        const list = ctx.workspaceRegistry.list().map((ws) => ({
          id: ws.id, path: ws.path, title: ws.title,
          sessionCount: ws.sessionIds.length,
          updatedAt: ws.updatedAt ?? null,
        }));
        return sendJson(res, 200, { ok: true, workspaces: list });
      }

      if (path === `${PREFIX}/config` && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.repo === 'string') {
          const repo = body.repo.trim();
          if (repo) parseRepo(repo); // 语法校验，失败直接抛给前端
          state.repo = repo;
        }
        if (typeof body.branch === 'string' && body.branch.trim()) state.branch = body.branch.trim();
        if (typeof body.deviceName === 'string' && body.deviceName.trim()) state.deviceName = body.deviceName.trim();
        if (Array.isArray(body.excludes)) state.excludes = body.excludes.map(String);
        if (typeof body.enableFiles === 'boolean') state.enableFiles = body.enableFiles;
        if (typeof body.skipPreview === 'boolean') state.skipPreview = body.skipPreview;
        if (typeof body.token === 'string' && body.token.trim()) {
          try {
            await ctx.credentials.set(tokenRef, body.token.trim());
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: '保存 token 失败：' + String(err?.message ?? err) });
          }
        }
        if (body.clearToken === true) {
          try { await ctx.credentials.unset(tokenRef); } catch { /* 忽略 */ }
        }
        writeState(state);
        const token = await resolveToken();
        return sendJson(res, 200, { ok: true, repo: state.repo, branch: state.branch, hasToken: Boolean(token) });
      }

      if (path === `${PREFIX}/test` && req.method === 'POST') {
        const body = await readBody(req);
        const supplied = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
        const token = supplied || (await resolveToken());
        if (!token) return sendJson(res, 400, { ok: false, error: '还没有 token' });
        if (!state.repo) return sendJson(res, 400, { ok: false, error: '还没有仓库地址' });
        try {
          const info = await clientFor(state.repo, token).repoInfo();
          if (info.private !== true) {
            return sendJson(res, 200, { ok: false, error: '这个仓库是公开的，按安全红线拒绝使用', fullName: info.full_name });
          }
          return sendJson(res, 200, {
            ok: true, fullName: info.full_name, private: true,
            defaultBranch: info.default_branch, permissions: info.permissions ?? null,
          });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: String(err?.message ?? err) });
        }
      }

      // ---------- 上传：预览 → 执行 ----------
      if (path === `${PREFIX}/preview` && req.method === 'POST') {
        const token = await resolveToken();
        if (!token) return sendJson(res, 400, { ok: false, error: '还没有 token' });
        if (!state.repo) return sendJson(res, 400, { ok: false, error: '还没有仓库地址' });
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const cwd = body.cwd || defaultWorkspacePath();
        if (!ids.length) return sendJson(res, 400, { ok: false, error: '没有选中任何会话' });
        const tid = typeof body.transferId === 'string' && body.transferId ? body.transferId : randomUUID();
        beginTransfer(tid, ids.length, 0, 'preview');
        try {
          const plan = await planUpload({
            client: clientFor(state.repo, token), cwd, ids,
            deviceId: state.deviceId, deviceName: state.deviceName,
            projectTitle: basename(cwd),
            force: new Set(Array.isArray(body.force) ? body.force.map(String) : []),
            onProgress: (p) => updateTransfer(tid, p),
            shouldCancel: () => Boolean(transfers.get(tid)?.cancelled),
          });
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.phase = 'done'; t.done = t.total; }
          return sendJson(res, 200, { ...publicPlan(plan), previewId: putPlan('upload', plan), transferId: tid });
        } catch (err) {
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.error = String(err?.message ?? err); }
          return sendJson(res, 200, { ok: false, error: String(err?.message ?? err), transferId: tid });
        }
      }

      if (path === `${PREFIX}/commit` && req.method === 'POST') {
        const body = await readBody(req);
        const entry = pending.get(body.previewId);
        if (!entry || entry.kind !== 'upload') return sendJson(res, 400, { ok: false, error: '预演已过期，请重新预览' });
        pending.delete(body.previewId);
        lastPreview = null;
        const token = await resolveToken();
        if (!token) return sendJson(res, 400, { ok: false, error: '还没有 token' });
        const tid = typeof body.transferId === 'string' && body.transferId ? body.transferId : randomUUID();
        const plan = entry.plan;
        const labels = {};
        for (const item of plan.items ?? []) {
          if (item.action === 'upload' && item.path) labels[item.path] = item.title || item.id;
        }
        // 先建传输记录：后面的远端合并可能要几秒，期间用户点「取消」必须能落到这条记录上
        beginTransfer(tid, plan.files.length, plan.summary.bytes, 'upload', plan.files, buildSessionFiles(plan), labels);
        const signal = transfers.get(tid)?.controller?.signal;
        // 多设备安全：预览可能是一两分钟前做的，期间别的设备推过东西。
        // 提交前重读一次远端索引并合并，避免"后写覆盖"把别人的条目从索引里抹掉。
        try {
          const fresh = await readRemote(clientFor(state.repo, token, signal));
          if (transfers.get(tid)?.cancelled) throw new Error('已取消');
          if (fresh && !fresh.empty) {
            plan.manifest = mergeRemoteManifest(fresh.manifest, plan.manifest);
            plan.files = (plan.files ?? []).map((f) => {
              if (f.path === MANIFEST_PATH) return { ...f, content: serializeManifest(plan.manifest) };
              if (f.path === README_PATH) return { ...f, content: renderReadme(plan.manifest) };
              return f;
            });
          }
        } catch (err) {
          if (/已取消/.test(String(err?.message ?? err))) {
            const t0 = transfers.get(tid);
            if (t0) { t0.finished = true; t0.error = '已取消'; }
            return sendJson(res, 200, { ok: false, error: '已取消', transferId: tid });
          }
          /* 读不到远端就沿用预览时的索引 */
        }
        try {
          const result = await executeUpload({
            client: clientFor(state.repo, token, transfers.get(tid)?.controller?.signal), plan, deviceName: state.deviceName,
            onProgress: (p) => updateTransfer(tid, p),
            shouldCancel: () => Boolean(transfers.get(tid)?.cancelled),
            skipPaths: () => new Set(transfers.get(tid)?.skipped ?? []),
            transformFile: manifestTransform(tid),
          });
          for (const item of plan.items) {
            if (item.action === 'upload') state.lastSync[item.id] = { sha256: item.sha256, at: new Date().toISOString() };
          }
          writeState(state);
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.commitSha = result.commitSha ?? null; t.phase = 'done'; t.done = t.total; }
          logHistory({
            kind: 'upload',
            project: result.project ?? plan.project,
            commit: result.commitSha ?? null,
            files: result.files ?? 0,
            sessions: plan.items.filter((i) => i.action === 'upload').map((i) => ({ id: i.id, title: i.title })),
            skippedFiles: (transfers.get(tid)?.skipped ?? []).length,
            device: state.deviceName,
          });
          return sendJson(res, 200, { ok: true, ...result, transferId: tid });
        } catch (err) {
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.error = String(err?.message ?? err); }
          return sendJson(res, 200, { ok: false, error: String(err?.message ?? err), transferId: tid });
        }
      }

      // ---------- 进度 / 取消 ----------
      if (path === `${PREFIX}/transfers`) {
        const list = [...transfers.values()]
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, 10)
          .map(({ controller, ...rest }) => rest);
        return sendJson(res, 200, { ok: true, transfers: list });
      }

      if (path === `${PREFIX}/progress`) {
        const id = url.searchParams.get('id');
        const t = id ? transfers.get(id) : null;
        if (!t) return sendJson(res, 404, { ok: false, error: '没有这个传输' });
        const { controller, ...safe } = t;
        return sendJson(res, 200, { ok: true, ...safe });
      }

      if (path === `${PREFIX}/skip` && req.method === 'POST') {
        const body = await readBody(req);
        const t = transfers.get(body.transferId);
        if (!t) return sendJson(res, 404, { ok: false, error: '没有这个传输' });
        if (t.finished) return sendJson(res, 400, { ok: false, error: '已经结束了' });

        const target = t.files.find((x) => x.path === body.filePath);
        if (!target) return sendJson(res, 404, { ok: false, error: '不在这次传输的文件里' });
        if (target.state === 'done' || target.state === 'current') {
          return sendJson(res, 400, { ok: false, error: '这个会话已经开始传了，取消无效' });
        }

        // 取消一个会话 = 它自己 + 它名下的全部附件（尚未开始传的）
        const related = [target.path, ...(t.sessionFiles?.[target.path] ?? [])];
        let marked = 0;
        for (const p of related) {
          const f = t.files.find((x) => x.path === p);
          if (!f) continue;
          if (f.state === 'done' || f.state === 'current') continue;
          f.state = 'skipped';
          if (!t.skipped.includes(f.path)) t.skipped.push(f.path);
          marked += 1;
        }
        return sendJson(res, 200, { ok: true, cancelledFiles: marked });
      }

      if (path === `${PREFIX}/cancel` && req.method === 'POST') {
        const body = await readBody(req);
        const t = transfers.get(body.transferId);
        if (!t) return sendJson(res, 404, { ok: false, error: '没有这个传输' });
        if (t.finished) return sendJson(res, 200, { ok: false, error: '已经结束了' });
        t.cancelled = true;
        try { t.controller?.abort(); } catch { /* 忽略 */ }
        return sendJson(res, 200, { ok: true, cancelled: true });
      }

      if (path === `${PREFIX}/remote`) {
        const token = await resolveToken();
        if (!token) return sendJson(res, 400, { ok: false, error: '还没有 token' });
        if (!state.repo) return sendJson(res, 400, { ok: false, error: '还没有仓库地址' });
        const remote = await readRemote(clientFor(state.repo, token));
        // 缓存远端索引：算同步状态、设备列表都要用，避免每次列会话都联网
        state.remoteCache = {
          at: new Date().toISOString(),
          commitSha: remote.commitSha ?? null,
          sessions: remote.manifest.sessions ?? {},
          devices: remote.manifest.devices ?? {},
        };
        writeState(state);
        return sendJson(res, 200, {
          ok: true,
          empty: remote.empty,
          commit: remote.commitSha,
          attachmentCount: Object.keys(remote.manifest.attachments ?? {}).length,
          projects: remote.manifest.workspaces,
          sessions: Object.values(remote.manifest.sessions).map((s) => ({
            id: s.id, title: s.title, project: s.project, path: s.path, bytes: s.bytes,
            sha256: s.sha256, originalCwd: s.originalCwd, createdAt: s.createdAt,
            uploadedBy: s.uploadedBy, uploadedAt: s.uploadedAt,
          })),
          files: [...remote.map.entries()]
            .filter(([p]) => p.includes('/files/'))
            .map(([p, v]) => {
              const at = p.indexOf('/files/');
              return {
                path: p,
                project: p.slice(0, at),
                rel: p.slice(at + '/files/'.length),
                size: v.size ?? 0,
              };
            }),
        });
      }

      // ---------- 下载：预览 → 执行 ----------
      // ---------- 删除：本地与远端互不影响 ----------
      // 删本地不动仓库；删仓库不动本地。附件跟着各自的会话一起回收。
      if (path === `${PREFIX}/delete-local` && req.method === 'POST') {
        const body = await readBody(req);
        const cwd = body.cwd || defaultWorkspacePath();
        const id = String(body.id || '');
        if (!/^[\w.:-]{1,128}$/.test(id)) return sendJson(res, 400, { ok: false, error: '会话 id 不合法' });
        const file = localSessionFile(cwd, id);
        const dir = dirname(file);
        const root = sessionsRoot();
        if (!existsSync(dir) || !isInsideRoot(root, dir)) {
          return sendJson(res, 404, { ok: false, error: '本地没有这个会话' });
        }
        try { const ws = await ctx.workspaceRegistry.resolveByPath(cwd); await ws?.detachSession?.(id); } catch { /* 未注册也无所谓 */ }
        rmSync(dir, { recursive: true, force: true });
        const gc = gcLocalAttachments();
        logHistory({ kind: 'delete-local', id, cwd, freedAttachments: gc.freed, device: state.deviceName });
        return sendJson(res, 200, { ok: true, id, freedAttachments: gc.freed, scanned: gc.scanned });
      }

      if (path === `${PREFIX}/delete-remote` && req.method === 'POST') {
        const token = await resolveToken();
        if (!token) return sendJson(res, 400, { ok: false, error: '还没有 token' });
        if (!state.repo) return sendJson(res, 400, { ok: false, error: '还没有仓库地址' });
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (!ids.length) return sendJson(res, 400, { ok: false, error: '没有选中任何会话' });
        const client = clientFor(state.repo, token);
        const remote = await readRemote(client);
        const manifest = remote.manifest;
        const deletions = [];
        const removed = [];
        for (const id of ids) {
          const entry = manifest.sessions?.[id];
          if (!entry?.path) continue;
          deletions.push(entry.path);
          removed.push(id);
          delete manifest.sessions[id];
        }
        if (!removed.length) return sendJson(res, 200, { ok: false, error: '远端没有这些会话' });
        // 附件回收：只删"没有任何剩余会话引用"的那些
        const stillUsed = new Set();
        for (const s of Object.values(manifest.sessions ?? {})) {
          for (const sha of s.attachments ?? []) stillUsed.add(sha);
        }
        let attDeleted = 0;
        for (const [sha, meta] of Object.entries(manifest.attachments ?? {})) {
          if (stillUsed.has(sha)) continue;
          if (meta?.path) deletions.push(meta.path);
          delete manifest.attachments[sha];
          attDeleted += 1;
        }
        touch(manifest);
        const res2 = await client.commitBatch({
          files: [
            { path: MANIFEST_PATH, content: serializeManifest(manifest) },
            { path: README_PATH, content: renderReadme(manifest) },
          ],
          deletions,
          message: `delete(${state.deviceName}): 移除 ${removed.length} 个会话${attDeleted ? ` + ${attDeleted} 个附件` : ''}`,
        });
        state.remoteCache = {
          at: new Date().toISOString(),
          commitSha: res2.commitSha ?? null,
          sessions: manifest.sessions ?? {},
          devices: manifest.devices ?? {},
        };
        writeState(state);
        logHistory({
          kind: 'delete-remote', sessions: removed, attachmentsDeleted: attDeleted,
          commit: res2.commitSha ?? null, device: state.deviceName,
        });
        return sendJson(res, 200, {
          ok: true, deleted: removed.length, attachmentsDeleted: attDeleted,
          commitSha: res2.commitSha ?? null, ids: removed,
        });
      }

      if (path === `${PREFIX}/download/preview` && req.method === 'POST') {
        const token = await resolveToken();
        if (!token) return sendJson(res, 400, { ok: false, error: '还没有 token' });
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const targetCwd = body.targetCwd || defaultWorkspacePath();
        if (!ids.length) return sendJson(res, 400, { ok: false, error: '没有选中任何会话' });
        if (!existsSync(targetCwd)) return sendJson(res, 400, { ok: false, error: '目标工作区不存在：' + targetCwd });
        const tid = typeof body.transferId === 'string' && body.transferId ? body.transferId : randomUUID();
        beginTransfer(tid, ids.length, 0, 'preview');
        try {
          const plan = await planDownload({
            client: clientFor(state.repo, token),
            ids,
            targetCwd,
            registeredElsewhere: registeredPaths(),
            force: new Set(Array.isArray(body.force) ? body.force.map(String) : []),
            onProgress: (p) => updateTransfer(tid, p),
            shouldCancel: () => Boolean(transfers.get(tid)?.cancelled),
          });
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.phase = 'done'; t.done = t.total; }
          if (!plan.ok) return sendJson(res, 400, plan);
          return sendJson(res, 200, { ...publicPlan(plan), previewId: putPlan('download', plan), transferId: tid });
        } catch (err) {
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.error = String(err?.message ?? err); }
          return sendJson(res, 200, { ok: false, error: String(err?.message ?? err), transferId: tid });
        }
      }

      if (path === `${PREFIX}/preview/last`) {
        if (!lastPreview) return sendJson(res, 404, { ok: false, error: '没有可恢复的预览' });
        if (Date.now() - lastPreview.at > PREVIEW_TTL_MS) {
          lastPreview = null;
          return sendJson(res, 404, { ok: false, error: '预览已过期' });
        }
        return sendJson(res, 200, { ...publicPlan(lastPreview.plan), previewId: lastPreview.id, kind: lastPreview.kind });
      }

      if (path === `${PREFIX}/download` && req.method === 'POST') {
        const body = await readBody(req);
        const entry = pending.get(body.previewId);
        if (!entry || entry.kind !== 'download') return sendJson(res, 400, { ok: false, error: '预演已过期，请重新预览' });
        pending.delete(body.previewId);
        lastPreview = null;
        const plan = entry.plan;
        const tid = typeof body.transferId === 'string' && body.transferId ? body.transferId : randomUUID();
        const writable = plan.items.filter((i) => i.action === 'write' || i.action === 'fork');
        const attCount = plan.items.reduce((a, i) => a + (i.attachments ?? []).filter((x) => x.action === 'write').length, 0);
        const fileList = [
          ...writable.map((i) => ({ path: i.title || i.id, bytes: i.bytes || 0 })),
          ...plan.items.flatMap((i) => (i.attachments ?? [])
            .filter((a) => a.action === 'write')
            .map((a) => ({ path: '附件 ' + String(a.sha).slice(0, 12), bytes: a.bytes || 0 }))),
        ];
        // 总字节数：下载也要能看到进度百分比和速率，不能只有"第几个"
        const totalBytes = writable.reduce((a, i) => a + (i.bytes || 0), 0)
          + plan.items.reduce((a, i) => a + (i.attachments ?? [])
            .filter((x) => x.action === 'write')
            .reduce((b, x) => b + (x.bytes || 0), 0), 0);
        beginTransfer(tid, writable.length + attCount, totalBytes, 'download', fileList);
        try {
          const applied = await applyDownloadPlan(plan, {
            onProgress: (p) => updateTransfer(tid, p),
            shouldCancel: () => Boolean(transfers.get(tid)?.cancelled),
          });
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.phase = 'done'; t.done = t.total; }
          logHistory({
            kind: 'download',
            targetCwd: plan.targetCwd,
            files: applied.length,
            sessions: plan.items.filter((i) => i.action === 'write').map((i) => ({ id: i.id, title: i.title })),
            failed: applied.filter((a) => a.action === 'attach-failed').length,
            device: state.deviceName,
          });
          return sendJson(res, 200, { ok: true, targetCwd: plan.targetCwd, applied, transferId: tid });
        } catch (err) {
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.error = String(err?.message ?? err); }
          return sendJson(res, 200, { ok: false, error: String(err?.message ?? err), transferId: tid });
        }
      }

      // ---------- 文件夹：浏览 → 预览 → 上传 ----------
      if (path === `${PREFIX}/folder/list`) {
        if (filesOff(res)) return;
        const target = url.searchParams.get('path') || defaultWorkspacePath();
        if (!existsSync(target)) return sendJson(res, 400, { ok: false, error: '目录不存在：' + target });
        try {
          const { dirs, files } = listDir(target);
          return sendJson(res, 200, { ok: true, path: target, dirs: dirs.slice(0, 300), files: files.slice(0, 300) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      }

      if (path === `${PREFIX}/folder/preview` && req.method === 'POST') {
        if (filesOff(res)) return;
        const body = await readBody(req);
        const root = body.path || defaultWorkspacePath();
        const cwd = body.cwd || defaultWorkspacePath();
        if (!existsSync(root)) return sendJson(res, 400, { ok: false, error: '目录不存在：' + root });
        const scanned = scanFolder(root, { patterns: state.excludes });
        if (!scanned.files.length) {
          return sendJson(res, 400, { ok: false, error: `没有可上传的文件（已排除 ${scanned.blocked.length} 项）` });
        }
        const project = safeProjectName(body.project || basename(cwd) || basename(root));
        const plan = {
          ok: true,
          direction: 'folder',
          root,
          project,
          items: [
            ...scanned.files.map((f) => ({ id: f.rel, title: f.rel, bytes: f.bytes, action: 'upload', reason: '' })),
            ...scanned.blocked.map((b) => ({ id: b.rel, title: b.rel, bytes: b.bytes, action: 'blocked', reason: b.reason })),
          ],
          files: scanned.files.map((f) => ({ path: `${project}/files/${f.rel}`, content: readFileSync(f.abs) })),
          summary: { upload: scanned.files.length, blocked: scanned.blocked.length, bytes: scanned.totalBytes, files: scanned.files.length },
        };
        return sendJson(res, 200, { ...publicPlan(plan), previewId: putPlan('folder', plan) });
      }

      if (path === `${PREFIX}/folder/commit` && req.method === 'POST') {
        if (filesOff(res)) return;
        const body = await readBody(req);
        const entry = pending.get(body.previewId);
        if (!entry || entry.kind !== 'folder') return sendJson(res, 400, { ok: false, error: '预演已过期，请重新预览' });
        pending.delete(body.previewId);
        lastPreview = null;
        const token = await resolveToken();
        if (!token) return sendJson(res, 400, { ok: false, error: '还没有 token' });
        const plan = entry.plan;
        const tid = typeof body.transferId === 'string' && body.transferId ? body.transferId : randomUUID();
        beginTransfer(tid, plan.files.length, plan.summary.bytes, 'upload', plan.files);
        const message = `sync(${state.deviceName}): 上传文件夹 · ${plan.project}（${plan.files.length} 个文件）`;
        try {
          const res2 = await clientFor(state.repo, token, transfers.get(tid)?.controller?.signal).commitBatch({
            files: plan.files, message,
            onProgress: (p) => updateTransfer(tid, p),
            shouldCancel: () => Boolean(transfers.get(tid)?.cancelled),
            skipPaths: () => new Set(transfers.get(tid)?.skipped ?? []),
          });
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.commitSha = res2.commitSha ?? null; t.phase = 'done'; t.done = t.total; }
          return sendJson(res, 200, { ok: true, ...res2, project: plan.project, uploaded: res2.files, transferId: tid });
        } catch (err) {
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.error = String(err?.message ?? err); }
          return sendJson(res, 200, { ok: false, error: String(err?.message ?? err), transferId: tid });
        }
      }

      // ---------- 文件：预览 → 下载回工作区 ----------
      if (path === `${PREFIX}/files/preview` && req.method === 'POST') {
        if (filesOff(res)) return;
        const token = await resolveToken();
        if (!token) return sendJson(res, 400, { ok: false, error: '还没有 token' });
        const body = await readBody(req);
        const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
        const targetCwd = body.targetCwd || defaultWorkspacePath();
        if (!paths.length) return sendJson(res, 400, { ok: false, error: '没有选中任何文件' });
        if (!existsSync(targetCwd)) return sendJson(res, 400, { ok: false, error: '目标工作区不存在：' + targetCwd });
        const plan = await planFileDownload({ client: clientFor(state.repo, token), paths, targetCwd });
        if (!plan.ok) return sendJson(res, 400, plan);
        return sendJson(res, 200, { ...publicPlan(plan), previewId: putPlan('files', plan) });
      }

      // ---------- 解绑 / 重新挂载（不删文件） ----------
      if (path === `${PREFIX}/detach` && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.sessionId;
        if (!id) return sendJson(res, 400, { ok: false, error: '需要 sessionId' });
        const ws = await ctx.workspaceRegistry.resolveByPath(body.workspace || defaultWorkspacePath());
        if (!ws) return sendJson(res, 404, { ok: false, error: '工作区不存在' });
        await ws.detachSession(id);
        return sendJson(res, 200, { ok: true, detached: id, workspace: ws.path });
      }

      if (path === `${PREFIX}/attach` && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.sessionId;
        if (!id) return sendJson(res, 400, { ok: false, error: '需要 sessionId' });
        const ws = await ensureWorkspace(body.workspace || defaultWorkspacePath());
        await ws.attachSession(id);
        return sendJson(res, 200, { ok: true, attached: id, workspace: ws.path });
      }

      if (path === `${PREFIX}/files/commit` && req.method === 'POST') {
        if (filesOff(res)) return;
        const body = await readBody(req);
        const entry = pending.get(body.previewId);
        if (!entry || entry.kind !== 'files') return sendJson(res, 400, { ok: false, error: '预演已过期，请重新预览' });
        pending.delete(body.previewId);
        lastPreview = null;
        const applied = [];
        const tid = typeof body.transferId === 'string' && body.transferId ? body.transferId : randomUUID();
        const writableFiles = entry.plan.items.filter((i) => i.action === 'write' || i.action === 'copy');
        const fileBytes = writableFiles.reduce((a, i) => a + (i.bytes || 0), 0);
        beginTransfer(tid, writableFiles.length, fileBytes, 'download',
          writableFiles.map((i) => ({ path: i.id, bytes: i.bytes || 0 })));
        try {
          let index = 0;
          for (const item of entry.plan.items) {
            if (item.action !== 'write' && item.action !== 'copy') continue;
            if (transfers.get(tid)?.cancelled) throw new Error('已取消');
            updateTransfer(tid, { phase: 'write', index, path: item.id, bytes: item.bytes || 0 });
            // 计划阶段已校验过，这里是写盘前的最后一道闸
            assertInsideRoot(entry.plan.targetCwd, item.target, '工作区文件');
            mkdirSync(dirname(item.target), { recursive: true });
            writeFileSync(item.target, item.data);
            applied.push({ id: item.id, action: item.action, target: item.target });
            index += 1;
          }
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.phase = 'done'; t.done = t.total; }
          return sendJson(res, 200, { ok: true, targetCwd: entry.plan.targetCwd, applied, transferId: tid });
        } catch (err) {
          const t = transfers.get(tid);
          if (t) { t.finished = true; t.error = String(err?.message ?? err); }
          return sendJson(res, 200, { ok: false, error: String(err?.message ?? err), transferId: tid });
        }
      }

      return sendJson(res, 404, { ok: false, error: `未知接口：${path}` });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'dsh-github-sync: routes',
  );

  // ---------- 给 agent 用的 3 个工具（写入必须两段式：preview → execute） ----------
  const toolOutput = (extra = {}) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' }, ...extra },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  });

  const toolDisposers = [];

  toolDisposers.push(ctx.tools.register({
    name: 'github_sync_status',
    description: 'GitHub 同步状态：仓库、设备、token 是否就绪，远端会话数与提交。只读。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: toolOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 20000,
    async execute() {
      const token = await resolveToken();
      const lines = [
        `设备：${state.deviceName}`,
        `仓库：${state.repo || '（未配置）'}`,
        `分支：${state.branch}`,
        `token：${token ? '已配置' : '未配置'}`,
      ];
      if (state.repo && token) {
        try {
          const remote = await readRemote(clientFor(state.repo, token));
          lines.push(`远端：${Object.keys(remote.manifest.sessions).length} 个会话 / ${Object.keys(remote.manifest.workspaces).length} 个项目`);
          lines.push(`当前工作区：${defaultWorkspacePath()}`);
        } catch (err) {
          lines.push(`远端读取失败：${err.message}`);
        }
      }
      return { text: lines.join('\n') };
    },
  }));

  toolDisposers.push(ctx.tools.register({
    name: 'github_sync_remote_list',
    description: '列出远端仓库里的会话（项目/标题/大小/id）。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { project: { type: 'string', description: '只看这个项目' } },
    },
    output: toolOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    async execute(args) {
      const token = await resolveToken();
      if (!token) return { text: '还没配置 token' };
      if (!state.repo) return { text: '还没配置仓库' };
      const remote = await readRemote(clientFor(state.repo, token));
      if (remote.empty) return { text: '远端仓库还是空的' };
      const rows = Object.values(remote.manifest.sessions)
        .filter((s) => !args.project || s.project === args.project)
        .map((s) => `- [${s.project}] ${s.title || '(无标题)'} · ${Math.round((s.bytes || 0) / 1024)}KB · ${s.id}`);
      return { text: rows.length ? rows.join('\n') : '没有匹配的会话' };
    },
  }));

  toolDisposers.push(ctx.tools.register({
    name: 'github_sync_transfer',
    description: '上传会话到远端 / 从远端下载会话。两段式：先 phase=preview 拿清单与 previewToken，再 phase=execute 带同一个 token 才真正执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['direction', 'phase'],
      properties: {
        direction: { type: 'string', enum: ['upload', 'download'] },
        phase: { type: 'string', enum: ['preview', 'execute'] },
        sessionIds: { type: 'array', items: { type: 'string' }, description: '要处理的会话 id' },
        targetWorkspace: { type: 'string', description: '下载目标工作区绝对路径；默认当前工作区' },
        previewToken: { type: 'string', description: 'execute 阶段必须带上' },
      },
    },
    output: toolOutput({ token: { type: 'string' } }),
    timeoutMs: 240000,
    async execute(args) {
      const token = await resolveToken();
      if (!token) return { text: '还没配置 token' };
      if (!state.repo) return { text: '还没配置仓库' };

      if (args.phase === 'preview') {
        const ids = Array.isArray(args.sessionIds) ? args.sessionIds : [];
        if (!ids.length) return { text: '需要 sessionIds（会话 id）' };

        if (args.direction === 'upload') {
          const cwd = defaultWorkspacePath();
          const plan = await planUpload({
            client: clientFor(state.repo, token), cwd, ids,
            deviceId: state.deviceId, deviceName: state.deviceName, projectTitle: basename(cwd),
          });
          const pid = putPlan('upload', plan);
          const lines = plan.items.map((i) => `- ${i.action} ${i.title || i.id}${i.reason ? ' · ' + i.reason : ''}`);
          return {
            text: [`上传预览（项目 ${plan.project}，${plan.summary.upload} 个可传 / ${plan.summary.blocked} 个被挡）`, ...lines,
              `确认：phase=execute, direction=upload, previewToken=${pid}`].join('\n'),
            token: pid,
          };
        }

        const targetCwd = args.targetWorkspace || defaultWorkspacePath();
        const plan = await planDownload({
          client: clientFor(state.repo, token), ids, targetCwd, registeredElsewhere: registeredPaths(),
        });
        if (!plan.ok) return { text: plan.error };
        const pid = putPlan('download', plan);
        const lines = plan.items.map((i) => `- ${i.action} ${i.title || i.id}${i.reason ? ' · ' + i.reason : ''}`);
        return {
          text: [`下载预览 → ${targetCwd}`, ...lines, `确认：phase=execute, direction=download, previewToken=${pid}`].join('\n'),
          token: pid,
        };
      }

      // execute
      if (!args.previewToken) return { text: 'execute 需要 previewToken' };
      const entry = pending.get(args.previewToken);
      if (!entry) return { text: '预览已过期，请重新 preview' };
      if (entry.kind !== args.direction) return { text: `token 属于 ${entry.kind}，与 direction=${args.direction} 不符` };
      pending.delete(args.previewToken);

      if (entry.kind === 'upload') {
        const r = await executeUpload({ client: clientFor(state.repo, token), plan: entry.plan, deviceName: state.deviceName });
        for (const item of entry.plan.items) {
          if (item.action === 'upload') state.lastSync[item.id] = { sha256: item.sha256, at: new Date().toISOString() };
        }
        writeState(state);
        return { text: `已提交 ${r.uploaded ?? 0} 个会话，commit ${String(r.commitSha || '').slice(0, 7)}` };
      }

      const applied = await applyDownloadPlan(entry.plan);
      return { text: `已落盘 ${applied.length} 个文件到 ${entry.plan.targetCwd}` };
    },
  }));

  return () => {
    for (const off of toolDisposers) { try { off(); } catch { /* 忽略 */ } }
  };
}
