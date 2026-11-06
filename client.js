// dsh-github-sync · 客户端半边（浏览器模块，无 node:fs）
// 手写 JS，不经打包：平台按 __ModuleLoader__ 工厂格式直接加载。
//
// 文件结构（从上到下）：
//   1. 常量与文案（ZH/EN）、图标
//   2. 通用小部件：Button / MiniBtn / Dot / fmtBytes / fmtAgo / rateText
//   3. Panel：全部状态与副作用（refresh / 轮询 / 预览 / 提交 / 删除 / 强制覆盖 / 诊断）
//   4. Panel 的渲染树：顶栏 → 状态行 → 横幅 → 弹层（设备/诊断/历史/设置/向导/预览）→ 双栏 → 底栏
//   5. 插件注册：sidebar.panellist + main 槽位
//
// 约定：状态里凡是"切屏后仍希望保留"的，一律用 usePersisted 落 localStorage；
//       传输本身跑在宿主，切屏后靠 /transfers 重新接上。
window.__ModuleLoader__.load({
  id: 'dsh-github-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-github-sync';
    const PANEL_ID = 'dsh-github-sync';
    const VERSION = '0.5.1';
    const PREFIX = '/dsh-github-sync';

    const ZH = {
      nav: 'GitHub 同步', title: 'GitHub 同步', subtitle: '私有仓 · 跨设备接力',
      remote: '远端仓库', local: '本地会话', device: '设备', repo: '仓库', branch: '分支',
      connected: '已连接', disconnected: '未配置', refresh: '刷新', settings: '设置',
      preview: '预览', upload: '上传选中', download: '下载选中', folder: '文件夹',
      emptyRemote: '远端浏览将在下一步接入', emptyLocal: '这个工作区没有会话',
      noRepo: '先在设置里填仓库地址与 token', save: '保存', test: '测试连接',
      token: '访问令牌', tokenHint: '只授权这一个仓：Contents 读写 + Metadata 只读',
      loading: '加载中…', saveOk: '已保存', testOk: '连接正常', testFail: '连接失败',
      sessions: '个会话', nextStep: '上传/下载在下一版接入',
    };
    const EN = {
      nav: 'GitHub Sync', title: 'GitHub Sync', subtitle: 'private repo · cross-device',
      remote: 'Remote repo', local: 'Local sessions', device: 'Device', repo: 'Repo', branch: 'Branch',
      connected: 'Connected', disconnected: 'Not configured', refresh: 'Refresh', settings: 'Settings',
      preview: 'Preview', upload: 'Upload selected', download: 'Download selected', folder: 'Folder',
      emptyRemote: 'Remote browsing lands in the next step', emptyLocal: 'No sessions in this workspace',
      noRepo: 'Set repo and token in settings first', save: 'Save', test: 'Test connection',
      token: 'Access token', tokenHint: 'Scope it to this repo only: Contents RW + Metadata R',
      loading: 'Loading…', saveOk: 'Saved', testOk: 'Connected', testFail: 'Connection failed',
      sessions: 'sessions', nextStep: 'Upload/download arrives in the next build',
    };

    const api = (p) => new URL(String(p).replace(/^\/+/, ''), document.baseURI).pathname;
    const getJson = async (p) => (await fetch(api(p), { cache: 'no-store' })).json();
    const postJson = async (p, body) => {
      const res = await fetch(api(p), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      });
      return res.json();
    };

    const C = {
      border: 'rgba(127,127,127,0.25)',
      dim: 'rgba(127,127,127,0.9)',
      pill: 'rgba(127,127,127,0.12)',
    };

    const PHASE_LABEL = {
      starting: '准备中', scan: '读取会话', fetch: '拉取远端', ref: '读取远端', seed: '初始化空仓',
      blob: '上传文件', tree: '建目录树', commit: '写提交', write: '写入本地', done: '完成',
    };
    const STATE_ICON = { pending: '○', current: '↻', done: '✓', skipped: '⊘', failed: '✕' };
    const STATE_TEXT = { pending: '等待', current: '传输中', done: '完成', skipped: '已取消', failed: '失败' };

    // 同步状态徽标：一眼看出哪条没传、哪边更新
    const SYNC_BADGE = {
      synced: { text: '已同步', color: '#22c55e' },
      'local-ahead': { text: '本地更新', color: '#3b82f6' },
      'remote-ahead': { text: '远端更新', color: '#f59e0b' },
      'not-uploaded': { text: '未上传', color: 'rgba(127,127,127,0.85)' },
      changed: { text: '有变化', color: '#a855f7' },
      diverged: { text: '分叉', color: '#ef4444' },
    };

    function MiniBtn({ children, onClick, disabled, title }) {
      return h('button', {
        onClick, disabled, title,
        style: {
          fontSize: 11, padding: '2px 7px', borderRadius: 5, cursor: disabled ? 'not-allowed' : 'pointer',
          border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit',
          opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        },
      }, children);
    }

    // 明细里只显示"对话"；附件、manifest、README 都不作为可取消项出现
    const isSessionRow = (f) => {
      const p = String((f && f.path) || '');
      if (!p) return false;
      if (p.includes('/attachments/')) return false;
      if (p.startsWith('附件 ')) return false;
      if (p === 'manifest.json' || p.endsWith('/manifest.json')) return false;
      if (p === 'README.md' || p.endsWith('/README.md')) return false;
      return true;
    };
    const friendlyName = (p) => String(p)
      .replace(/^.*\/sessions\//, '')
      .replace(/\.jsonl\.zstd$/, '')
      .replace(/^session-/, '');

    // 中性图标：云 + 上下箭头（不涉及任何厂商商标）
    function SyncIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M7.2 11.2C5.2 11.2 3.8 9.8 3.8 8.1C3.8 6.4 5.1 5.1 6.7 5C7.4 3.3 9.1 2.2 11 2.2C13.2 2.2 15 3.6 15.6 5.5C17.4 5.8 18.7 7.3 18.7 9.1C18.7 10.3 17.9 11.2 16.9 11.2Z' }),
        h('path', { d: 'M8 20V14.6' }),
        h('path', { d: 'M5.9 16.7 8 14.6 10.1 16.7' }),
        h('path', { d: 'M16 14.6V20.2' }),
        h('path', { d: 'M13.9 18.1 16 20.2 18.1 18.1' }),
      );
    }

    function Button({ children, onClick, disabled, primary, title }) {
      return h('button', {
        onClick, disabled, title,
        style: {
          padding: '5px 10px', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
          border: `1px solid ${C.border}`, background: primary ? 'rgba(99,102,241,0.18)' : 'transparent',
          color: 'inherit', font: 'inherit', fontSize: 12, opacity: disabled ? 0.5 : 1,
        },
      }, children);
    }

    function Dot({ on }) {
      return h('span', {
        style: { display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6,
          background: on ? '#22c55e' : 'rgba(127,127,127,0.6)' },
      });
    }

    /** 传输速率与粗略剩余时间（按已传字节 / 已用时间估算） */
    function rateText(p) {
      if (!p || !p.startedAt || !p.bytesDone) return '';
      const secs = Math.max(1, (Date.now() - p.startedAt) / 1000);
      const bps = p.bytesDone / secs;
      if (!Number.isFinite(bps) || bps <= 0) return '';
      const left = p.bytesTotal > p.bytesDone ? Math.round((p.bytesTotal - p.bytesDone) / bps) : 0;
      return `${fmtBytes(bps)}/s${left ? ` · 剩 ~${left}s` : ''}`;
    }

    /** 人类可读的字节数：分 KB/MB/GB 三档，保留一位小数 */
    function fmtBytes(n) {
      if (!Number.isFinite(n)) return '?';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(2) + ' MB';
    }

    function fmtAgo(ms) {
      if (!ms) return '';
      const diff = Date.now() - ms;
      const m = Math.round(diff / 60000);
      if (m < 1) return '刚刚';
      if (m < 60) return m + ' 分钟前';
      const hrs = Math.round(m / 60);
      if (hrs < 48) return hrs + ' 小时前';
      return Math.round(hrs / 24) + ' 天前';
    }

    // 面板卸载（切走标签页）后状态会丢，所以把关键 UI 状态落到 localStorage
    const PERSIST = 'dsh-github-sync:';
    function usePersisted(key, initial) {
      const [value, setValue] = React.useState(() => {
        try {
          const raw = window.localStorage.getItem(PERSIST + key);
          return raw === null ? initial : JSON.parse(raw);
        } catch { return initial; }
      });
      React.useEffect(() => {
        try { window.localStorage.setItem(PERSIST + key, JSON.stringify(value)); } catch { /* 忽略 */ }
      }, [key, value]);
      return [value, setValue];
    }

    function Panel({ t }) {
      const tt = (k) => { try { const v = t && t(k); return v || ZH[k] || k; } catch { return ZH[k] || k; } };
      const [status, setStatus] = React.useState(null);
      const [sessions, setSessions] = React.useState([]);
      const [workspaces, setWorkspaces] = React.useState([]);
      const [loading, setLoading] = React.useState(true);
      const [cwd, setCwd] = usePersisted('cwd', '');
      const [err, setErr] = React.useState(null);
      const [settingsOpen, setSettingsOpen] = usePersisted('settingsOpen', false);
      const [selected, setSelected] = usePersisted('selected', {});
      const [form, setForm] = React.useState({ repo: '', branch: 'main', deviceName: '', token: '', enableFiles: false, skipPreview: false });
      const [note, setNote] = React.useState(null);
      const [remote, setRemote] = React.useState({ projects: {}, sessions: [], files: [] });
      const [selectedRemote, setSelectedRemote] = usePersisted('selectedRemote', {});
      const [selectedFiles, setSelectedFiles] = usePersisted('selectedFiles', {});
      const [preview, setPreview] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [browser, setBrowser] = usePersisted('browser', null);
      const [showSubagents, setShowSubagents] = usePersisted('showSubagents', false);
      const [expanded, setExpanded] = React.useState(false);
      // 新增：搜索、只看未同步、设备/历史面板、首次配置向导
      const [search, setSearch] = usePersisted('search', '');
      const [onlyUnsynced, setOnlyUnsynced] = usePersisted('onlyUnsynced', false);
      const [devices, setDevices] = React.useState([]);
      const [historyRows, setHistoryRows] = React.useState([]);
      const [diagText, setDiagText] = React.useState('');
      const [remoteStale, setRemoteStale] = React.useState(false);
      const [popover, setPopover] = usePersisted('popover', null); // 'devices' | 'history' | 'wizard'
      const [wizardStep, setWizardStep] = React.useState(0);
      const [progress, setProgress] = React.useState(null);
      const [transferId, setTransferId] = React.useState(null);
      const pollRef = React.useRef(null);
      const ownsTransfer = React.useRef(false);
      const cwdRef = React.useRef(cwd);
      React.useEffect(() => { cwdRef.current = cwd; }, [cwd]);

      const applyProgress = (p) => setProgress({
        total: p.total || 0, done: p.done || 0, phase: p.phase,
        currentPath: p.currentPath, kind: p.kind || 'upload', cancelled: p.cancelled,
        files: p.files || [],
        bytesDone: p.bytesDone || 0, bytesTotal: p.bytesTotal || 0,
        startedAt: p.startedAt || null, cancelling: Boolean(p.cancelled),
      });

      const skipFile = async (filePathOrGroup) => {
        if (!transferId) return;
        try {
          const body = filePathOrGroup && filePathOrGroup.groupKey
            ? { transferId, groupKey: filePathOrGroup.groupKey }
            : { transferId, filePath: filePathOrGroup };
          const r = await postJson(`${PREFIX}/skip`, body);
          if (!r.ok) setNote(r.error || '跳过失败');
        } catch (e) {
          setNote(String(e && e.message ? e.message : e));
        }
      };

      const newTid = () => (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(16).slice(2);

      // 遮罩是否打开也落盘：只有"带着打开的遮罩离开"才在回来时恢复
      const openPreview = (x) => {
        setPreview(x);
        try {
          window.localStorage.setItem(PERSIST + 'previewOpen', 'true');
          // 连内容一起缓存：切走面板或刷新页面回来时能立刻恢复，不必等宿主响应
          window.localStorage.setItem(PERSIST + 'previewCache', JSON.stringify(x));
        } catch { /* 忽略 */ }
      };
      const closePreview = () => {
        setPreview(null);
        try {
          window.localStorage.setItem(PERSIST + 'previewOpen', 'false');
          window.localStorage.removeItem(PERSIST + 'previewCache');
        } catch { /* 忽略 */ }
      };

      const startPolling = (tid) => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            const p = await getJson(`${PREFIX}/progress?id=${encodeURIComponent(tid)}`);
            if (!p.ok) return;
            applyProgress(p);
            if (p.finished) {
              stopPolling();
              const label = p.kind === 'download' ? '下载' : '上传';
              const msg = p.error
                ? `${label}失败：${p.error}`
                : `${label}完成${p.commitSha ? ' · ' + String(p.commitSha).slice(0, 7) : ''}`;
              setProgress(null);
              setTransferId(null);
              // 不是本次组件发起的（切屏后回来重新接上的）→ 由这里收尾
              if (!ownsTransfer.current) { setNote(msg); refresh(); }
            }
          } catch { /* 轮询失败忽略 */ }
        }, 500);
      };
      const stopPolling = () => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      };
      React.useEffect(() => () => stopPolling(), []);

      // 切走面板会让组件卸载，但宿主那边的传输还在跑——回来时重新接上它；没确认的预览也恢复
      React.useEffect(() => {
        (async () => {
          try {
            const r = await getJson(`${PREFIX}/transfers`);
            const active = (r.transfers || []).find((t) => !t.finished);
            if (active) {
              ownsTransfer.current = false;
              setTransferId(active.id);
              applyProgress(active);
              startPolling(active.id);
            }
          } catch { /* 忽略 */ }
          try {
            const wantsPreview = (() => {
              try { return window.localStorage.getItem(PERSIST + 'previewOpen') === 'true'; } catch { return false; }
            })();
            if (wantsPreview) {
              // 1) 先用本地缓存的预览秒开（用户看到的框立刻回来）
              let restored = false;
              try {
                const cached = JSON.parse(window.localStorage.getItem(PERSIST + 'previewCache') || 'null');
                if (cached && cached.kind && cached.data) { setPreview(cached); restored = true; }
              } catch { /* 缓存坏了就跳过 */ }
              // 2) 再向宿主要一份最新的（宿主可能已刷新过 previewId）
              try {
                const l = await getJson(`${PREFIX}/preview/last`);
                if (l.ok && l.previewId) setPreview({ kind: l.kind || l.direction || 'upload', data: l });
                else if (!restored) {
                  try { window.localStorage.setItem(PERSIST + 'previewOpen', 'false'); } catch { /* 忽略 */ }
                }
              } catch { /* 宿主没有可恢复的预览，保留本地缓存那一份 */ }
            }
          } catch { /* 没有可恢复的预览 */ }
        })();
      }, []);

      const refresh = React.useCallback(async () => {
        setLoading(true); setErr(null);
        try {
          const st = await getJson(`${PREFIX}/status`);
          if (!st.ok) throw new Error(st.error || 'status failed');
          setStatus(st);
          setForm((f) => ({ ...f, repo: st.repo || f.repo, branch: st.branch || 'main', deviceName: st.device?.name || '', enableFiles: Boolean(st.enableFiles), skipPreview: Boolean(st.skipPreview) }));
          const target = cwdRef.current || st.defaultCwd || st.cwd;
          setCwd(target);
          const [ss, wss] = await Promise.all([
            getJson(`${PREFIX}/sessions?cwd=${encodeURIComponent(target)}`),
            getJson(`${PREFIX}/workspaces`),
          ]);
          setSessions(ss.sessions || []);
          setWorkspaces(wss.workspaces || []);
          try { const d = await getJson(`${PREFIX}/devices`); setDevices(d.devices || []); } catch { /* 忽略 */ }
          try { const h = await getJson(`${PREFIX}/history?limit=40`); setHistoryRows(h.history || []); } catch { /* 忽略 */ }
          // 选中项跟着数据走：已消失的会话自动从勾选里剔除
          setSelected((prev) => {
            const ids = new Set((ss.sessions || []).map((x) => x.id));
            const next = {};
            for (const [k, v] of Object.entries(prev || {})) if (v && ids.has(k)) next[k] = true;
            return next;
          });
          await loadRemote();
          // 远端索引刚刷新过，再取一次本地会话：让"已同步/未上传"徽标立刻反映刚才的上传结果
          try {
            const ss2 = await getJson(`${PREFIX}/sessions?cwd=${encodeURIComponent(target)}`);
            setSessions(ss2.sessions || []);
          } catch { /* 忽略 */ }
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => { refresh(); }, [refresh]);

      const loadSessions = async (next) => {
        setCwd(next); setLoading(true); setErr(null);
        try {
          const ss = await getJson(`${PREFIX}/sessions?cwd=${encodeURIComponent(next)}`);
          setSessions(ss.sessions || []);
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setLoading(false);
        }
      };

      const loadRemote = async () => {
        try {
          // 网络抖动时重试一次；仍失败就保留上一次的结果并明确告知，绝不把列表清空
          const fetchRemote = () => getJson(`${PREFIX}/remote`)
            .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
          let r = await fetchRemote();
          if (!r.ok) {
            await new Promise((res) => setTimeout(res, 1200));
            r = await fetchRemote();
          }
          if (r.ok) {
            setRemote({ projects: r.projects || {}, sessions: r.sessions || [], files: r.files || [], attachments: r.attachmentCount || 0 });
            setRemoteStale(false);
          } else {
            // 保持旧数据，只标"上次结果"
            setRemoteStale(true);
            setNote('远端读取失败：' + (r.error || '网络异常') + '（左侧显示的是上次结果，可点刷新重试）');
          }
          if (r.ok) {
            const ids = new Set((r.sessions || []).map((x) => x.id));
            const fids = new Set((r.files || []).map((x) => x.path));
            setSelectedRemote((prev) => {
              const next = {};
              for (const [k, v] of Object.entries(prev || {})) if (v && ids.has(k)) next[k] = true;
              return next;
            });
            setSelectedFiles((prev) => {
              const next = {};
              for (const [k, v] of Object.entries(prev || {})) if (v && fids.has(k)) next[k] = true;
              return next;
            });
          }
        } catch { /* 远端暂时不可用它 */ }
      };

      const pickedLocal = () => Object.keys(selected).filter((k) => selected[k]);
      const pickedRemote = () => Object.keys(selectedRemote).filter((k) => selectedRemote[k]);

      const selectAllVisible = () => {
        const next = { ...selected };
        for (const s of visibleSessions) next[s.id] = true;
        setSelected(next);
      };
      const selectUnsynced = () => {
        const next = {};
        for (const s of sessions) {
          if (showSubagents || !isNoise(s)) { if (s.sync !== 'synced') next[s.id] = true; }
        }
        setSelected(next);
      };
      const clearSelection = () => setSelected({});

      const previewUpload = async (explicitIds) => {
        // 注意：直接把它当 onClick 用时，React 会把事件对象塞进来，所以必须判断是不是数组
        const ids = Array.isArray(explicitIds) ? explicitIds : pickedLocal();
        if (!ids.length) { setNote('先勾选要上传的会话'); return; }
        setBusy(true); setNote(null);
        const tid = newTid();
        ownsTransfer.current = true;
        setTransferId(tid);
        setProgress({ total: ids.length, done: 0, phase: 'scan', kind: 'preview' });
        startPolling(tid);
        try {
          const r = await postJson(`${PREFIX}/preview`, { ids, cwd, transferId: tid });
          if (!r.ok) { setNote(r.error || '预览失败'); return; }
          const pv = { kind: 'upload', data: r };
          if (status?.skipPreview) { await runConfirm(pv); return; }
          openPreview(pv);
        } catch (e) {
          setNote(String(e && e.message ? e.message : e));
        } finally {
          stopPolling(); setProgress(null); setTransferId(null); setBusy(false); ownsTransfer.current = false;
        }
      };

      const previewFiles = async () => {
        const paths = Object.keys(selectedFiles).filter((k) => selectedFiles[k]);
        if (!paths.length) { setNote('先在左边勾选文件'); return; }
        setBusy(true); setNote(null);
        try {
          const r = await postJson(`${PREFIX}/files/preview`, { paths, targetCwd: cwd });
          if (!r.ok) { setNote(r.error || '预览失败'); return; }
          openPreview({ kind: 'files', data: r });
        } catch (e) {
          setNote(String(e && e.message ? e.message : e));
        } finally { setBusy(false); }
      };

      const previewDownload = async (explicitIds, forceIds) => {
        const ids = Array.isArray(explicitIds) ? explicitIds : pickedRemote();
        const force = Array.isArray(forceIds) ? forceIds : [];
        if (!ids.length) { setNote('先在左边勾选远端会话'); return; }
        setBusy(true); setNote(null);
        const tid = newTid();
        ownsTransfer.current = true;
        setTransferId(tid);
        setProgress({ total: ids.length, done: 0, phase: 'fetch', kind: 'preview' });
        startPolling(tid);
        try {
          const r = await postJson(`${PREFIX}/download/preview`, { ids, targetCwd: cwd, transferId: tid, force });
          if (!r.ok) { setNote(r.error || '预览失败'); return; }
          openPreview({ kind: 'download', data: r });
        } catch (e) {
          setNote(String(e && e.message ? e.message : e));
        } finally {
          stopPolling(); setProgress(null); setTransferId(null); setBusy(false); ownsTransfer.current = false;
        }
      };

      // ---------- 删除（本地/远端互不影响，附件随会话回收）----------
      const [confirmDel, setConfirmDel] = React.useState(null); // {scope:'local'|'remote', id}
      const doDelete = async (scope, id) => {
        setBusy(true); setNote(null);
        try {
          const r = scope === 'local'
            ? await postJson(`${PREFIX}/delete-local`, { id, cwd })
            : await postJson(`${PREFIX}/delete-remote`, { ids: [id] });
          if (r.ok) {
            setNote(scope === 'local'
              ? `已从本机删除（顺带回收 ${r.freedAttachments ?? 0} 个本地附件），仓库未受影响`
              : `已从仓库删除（含 ${r.attachmentsDeleted ?? 0} 个附件），本机未受影响`);
            if (scope === 'local') setSelected((v) => ({ ...v, [id]: false }));
            else setSelectedRemote((v) => ({ ...v, [id]: false }));
          } else {
            setNote(r.error || '删除失败');
          }
        } catch (e) {
          setNote(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
          try { await refresh(); } catch { /* 忽略 */ }
        }
      };
      const requestDelete = (scope, id) => {
        if (confirmDel && confirmDel.scope === scope && confirmDel.id === id) {
          setConfirmDel(null);
          doDelete(scope, id);
          return;
        }
        setConfirmDel({ scope, id });
        window.setTimeout(() => {
          setConfirmDel((c) => (c && c.scope === scope && c.id === id ? null : c));
        }, 4000);
      };

      // ---------- 冲突"选一边" ----------
      const forceUpload = async (id) => {
        const ids = (preview?.data?.items || []).map((i) => i.id).filter(Boolean);
        closePreview();
        await previewUpload(ids.length ? ids : [id], [id]);
      };
      const forceDownload = async (id) => {
        const ids = (preview?.data?.items || []).map((i) => i.id).filter(Boolean);
        closePreview();
        await previewDownload(ids.length ? ids : [id], [id]);
      };

      const runConfirm = async (pv) => {
        if (!pv) return;
        setBusy(true);
        ownsTransfer.current = true;
        const tid = newTid();
        setTransferId(tid);
        setProgress({ total: 0, done: 0, phase: 'starting', currentPath: null });
        startPolling(tid);
        try {
          const url = pv.kind === 'upload' ? `${PREFIX}/commit`
            : pv.kind === 'folder' ? `${PREFIX}/folder/commit`
              : pv.kind === 'files' ? `${PREFIX}/files/commit`
                : `${PREFIX}/download`;
          const r = await postJson(url, { previewId: pv.data.previewId, transferId: tid });
          if (pv.kind === 'upload') {
            setNote(r.ok ? `已提交 ${r.uploaded ?? 0} 个会话 · ${String(r.commitSha || '').slice(0, 7)}` : (r.error || '提交失败'));
            setSelected({});
          } else if (pv.kind === 'folder') {
            setNote(r.ok ? `已上传 ${r.uploaded ?? 0} 个文件 · ${String(r.commitSha || '').slice(0, 7)}` : (r.error || '上传失败'));
          } else if (pv.kind === 'files') {
            setNote(r.ok ? `已落盘 ${(r.applied || []).length} 个文件` : (r.error || '下载失败'));
            setSelectedFiles({});
          } else {
            const failed = (r.applied || []).filter((a) => a.action === 'attach-failed');
            const hint = failed.find((a) => a.hint)?.hint;
            setNote(r.ok
              ? (failed.length ? `已落盘，但 ${failed.length} 条没能挂载 · ${hint || ''}` : `已落盘 ${(r.applied || []).length} 个会话`)
              : (r.error || '下载失败'));
            setSelectedRemote({});
          }
          closePreview();
        } catch (e) {
          setNote(String(e && e.message ? e.message : e));
        } finally {
          stopPolling();
          setProgress(null);
          setTransferId(null);
          setBusy(false);
          ownsTransfer.current = false;
          // 传输结束（成功或取消）都刷新一次，避免界面停在旧状态
          try { await refresh(); } catch { /* 忽略 */ }
        }
      };

      const confirm = () => runConfirm(preview);

      const downloadOne = async (id) => {
        closePreview();
        setBusy(true);
        try {
          const r = await postJson(`${PREFIX}/download/preview`, { ids: [id], targetCwd: cwd });
          if (!r.ok) { setNote(r.error || '下载失败'); return; }
          await runConfirm({ kind: 'download', data: r });
        } catch (e) {
          setNote(String(e && e.message ? e.message : e));
        } finally { setBusy(false); }
      };

      const cancelRun = async () => {
        if (!transferId) return;
        try {
          const r = await postJson(`${PREFIX}/cancel`, { transferId });
          if (r.ok) {
            setNote('正在取消…');
            setProgress((p) => (p ? { ...p, cancelling: true } : p));
          } else {
            setNote(r.error || '取消失败');
          }
        } catch (e) {
          setNote(String(e && e.message ? e.message : e));
        }
      };

      const save = async () => {
        const r = await postJson(`${PREFIX}/config`, form);
        setNote(r.ok ? tt('saveOk') : (r.error || 'save failed'));
        await refresh();
      };
      const test = async () => {
        // 先保存（含 token），再测——避免"填了没保存就点测试"的坑
        const saved = await postJson(`${PREFIX}/config`, form);
        if (!saved.ok) { setNote(`${tt('testFail')} · ${saved.error || ''}`); return; }
        const r = await postJson(`${PREFIX}/test`, { token: form.token || '' });
        setNote(r.ok ? `${tt('testOk')} · ${r.fullName}` : `${tt('testFail')} · ${r.error || ''}`);
        await refresh();
      };

      const connected = Boolean(status && status.repo && status.hasToken);
      // 噪音会话：①子代理/委派（id 无 session- 前缀或 origin=subagent）②空壳（无标题且 <1KB）
      const isEmptyStub = (s) => !s.title && Number(s.bytes || 0) < 1024;
      const isSubagent = (s) => s.origin === 'subagent' || !String(s.id || '').startsWith('session-');
      const isNoise = (s) => isSubagent(s) || isEmptyStub(s);
      const q = search.trim().toLowerCase();
      const visibleSessions = sessions
        .filter((s) => showSubagents || !isNoise(s))
        .filter((s) => !onlyUnsynced || (s.sync && s.sync !== 'synced'))
        .filter((s) => !q || String(s.title || s.id).toLowerCase().includes(q));
      const visibleRemote = showSubagents ? remote.sessions : remote.sessions.filter((s) => !isNoise(s));
      const hiddenSessions = sessions.length - visibleSessions.length;
      const hiddenRemote = remote.sessions.length - visibleRemote.length;
      const localCount = visibleSessions.length;
      const unsyncedCount = sessions.filter((s) => (!showSubagents && isNoise(s) ? false : (s.sync !== 'synced'))).length;

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '14px 16px', gap: 12, position: 'relative' } },

        // 顶栏
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h(SyncIcon, { size: 18 }),
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, tt('title')),
          h('span', { style: { fontSize: 11, padding: '1px 6px', borderRadius: 999, background: C.pill, color: C.dim } }, 'v' + VERSION),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 12, color: C.dim } }, h(Dot, { on: connected }), connected ? tt('connected') : tt('disconnected')),
          h(Button, { onClick: refresh, disabled: loading }, tt('refresh')),
          h(Button, { onClick: () => setPopover(popover === 'devices' ? null : 'devices') }, `设备${devices.length ? ` ${devices.length}` : ''}`),
          h(Button, { onClick: () => setPopover(popover === 'history' ? null : 'history') }, '历史'),
          h(Button, {
            onClick: async () => {
              if (popover === 'diag') { setPopover(null); return; }
              try {
                const d = await getJson(`${PREFIX}/diagnostics`);
                setDiagText(d.ok ? d.text : (d.error || '诊断失败'));
              } catch (e) {
                setDiagText('诊断失败：' + String(e && e.message ? e.message : e));
              }
              setPopover('diag');
            },
          }, '诊断'),
          h(Button, { onClick: () => setSettingsOpen((v) => !v) }, '⚙ ' + tt('settings')),
        ),

        // 没配置好时给一条明确的路，而不是让人对着空列表发呆
        !connected ? h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '8px 12px',
            border: `1px solid ${C.border}`, borderRadius: 8, background: C.pill,
          },
        },
          h('span', { style: { flex: 1 } }, status?.tokenMalformed
            ? '访问令牌已损坏（保存的内容不是有效令牌，多半是把报错文本写进去了）：请在设置里重新粘贴一次令牌。'
            : '还没连上仓库：需要「私有仓库 + 访问令牌」两样东西，大约 3 分钟。'),
          h(Button, {
            onClick: () => {
              if (status?.tokenMalformed) { setSettingsOpen(true); return; }
              setWizardStep(0); setPopover('wizard');
            },
            primary: true,
          }, status?.tokenMalformed ? '去设置令牌' : '开始配置'),
        ) : null,

        // 设备 / 历史弹层
        popover === 'devices' ? h('div', {
          style: {
            position: 'absolute', top: 56, right: 16, width: 360, maxHeight: '60%', overflow: 'auto',
            background: 'Canvas', border: `1px solid ${C.border}`, borderRadius: 10, padding: 12,
            boxShadow: '0 12px 30px rgba(0,0,0,0.25)', zIndex: 25, fontSize: 12,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 8 } },
            h('div', { style: { fontWeight: 600 } }, '设备'),
            h('span', { style: { flex: 1 } }),
            h(MiniBtn, { onClick: () => setPopover(null) }, '关闭'),
          ),
          devices.length === 0
            ? h('div', { style: { color: C.dim } }, '还没有远端设备信息，点一次「刷新」读取远端索引。')
            : h('div', null, devices.map((d) => h('div', {
              key: d.id,
              style: { display: 'flex', gap: 8, padding: '5px 0', borderBottom: `1px solid ${C.border}` },
            },
              h('span', { style: { flex: 1 } }, d.name + (d.isThisDevice ? '（本机）' : '')),
              h('span', { style: { color: C.dim } }, fmtAgo(d.lastSeen ? Date.parse(d.lastSeen) : null)),
            ))),
          status?.remote?.at ? h('div', { style: { color: C.dim, marginTop: 8, fontSize: 11 } },
            `索引读取于 ${fmtAgo(Date.parse(status.remote.at))} · commit ${String(status.remote.commit || '').slice(0, 7) || '-'}`) : null,
        ) : null,

        popover === 'diag' ? h('div', {
          style: {
            position: 'absolute', top: 56, right: 16, width: 560, maxHeight: '70%', overflow: 'auto',
            background: 'Canvas', border: `1px solid ${C.border}`, borderRadius: 10, padding: 12,
            boxShadow: '0 12px 30px rgba(0,0,0,0.25)', zIndex: 25, fontSize: 12,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 8, gap: 6 } },
            h('div', { style: { fontWeight: 600, flex: 1 } }, '诊断'),
            h(MiniBtn, {
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(diagText);
                  setNote('诊断信息已复制到剪贴板');
                } catch {
                  setNote('复制失败，可以手动选中下面的文本');
                }
              },
            }, '复制'),
            h(MiniBtn, { onClick: () => setPopover(null) }, '关闭'),
          ),
          h('pre', {
            style: {
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, fontSize: 11,
              maxHeight: 420, overflow: 'auto', color: C.dim,
            },
          }, diagText || '（正在读取…）'),
        ) : null,

        popover === 'history' ? h('div', {
          style: {
            position: 'absolute', top: 56, right: 16, width: 420, maxHeight: '60%', overflow: 'auto',
            background: 'Canvas', border: `1px solid ${C.border}`, borderRadius: 10, padding: 12,
            boxShadow: '0 12px 30px rgba(0,0,0,0.25)', zIndex: 25, fontSize: 12,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 8 } },
            h('div', { style: { fontWeight: 600 } }, '传输历史'),
            h('span', { style: { flex: 1 } }),
            h(MiniBtn, { onClick: () => setPopover(null) }, '关闭'),
          ),
          historyRows.length === 0 ? h('div', { style: { color: C.dim } }, '还没有记录') : h('div', null,
            historyRows.map((r, i) => h('div', {
              key: i, style: { display: 'flex', gap: 8, padding: '5px 0', borderBottom: `1px solid ${C.border}` },
            },
              h('span', { style: { flexShrink: 0, color: r.kind === 'upload' ? '#3b82f6' : '#22c55e' } },
                r.kind === 'upload' ? '↑ 上传' : '↓ 下载'),
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                `${r.files ?? 0} 个文件` + (r.commit ? ` · ${String(r.commit).slice(0, 7)}` : '') + (r.failed ? ` · ${r.failed} 条挂载失败` : '')),
              h('span', { style: { color: C.dim, flexShrink: 0 } }, fmtAgo(Date.parse(r.at))),
            )),
          ),
        ) : null,

        // 状态行
        h('div', { style: { fontSize: 12, color: C.dim, display: 'flex', gap: 14, flexWrap: 'wrap' } },
          h('span', null, tt('device') + ': ' + (status?.device?.name || '-')),
          h('span', null, tt('repo') + ': ' + (status?.repo || '-')),
          h('span', null, tt('branch') + ': ' + (status?.branch || 'main')),
          h('span', null, '工作区: ' + (status?.defaultCwd || '-')),
        ),

        // 进行中的传输：与预览遮罩无关，切屏回来也能重新接上
        progress ? h('div', null,
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
              padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 8 },
          },
            h('span', {
              style: { whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' },
              title: '展开 / 收起文件明细',
              onClick: () => setExpanded((v) => !v),
            }, `${expanded ? '▾' : '▸'} ${progress.kind === 'download' ? '正在下载' : progress.kind === 'preview' ? '正在读取' : '正在上传'} ${progress.done}/${progress.total}`),
            h('div', { style: { flex: 1, height: 6, background: C.pill, borderRadius: 3, overflow: 'hidden', minWidth: 80 } },
              h('div', {
                style: {
                  height: '100%',
                  width: `${progress.total ? Math.max(2, Math.round((progress.done / progress.total) * 100)) : 5}%`,
                  background: '#6366f1', transition: 'width .25s ease',
                },
              })),
            h('span', { style: { color: C.dim, whiteSpace: 'nowrap' } },
              (PHASE_LABEL[progress.phase] || progress.phase || '')
                + (progress.currentPath ? ' · ' + String(progress.currentPath).split(/[\\/]/).pop() : '')),
            progress.bytesTotal ? h('span', { style: { color: C.dim, whiteSpace: 'nowrap' } },
              `${fmtBytes(progress.bytesDone)} / ${fmtBytes(progress.bytesTotal)}`) : null,
            h('span', { style: { color: C.dim, whiteSpace: 'nowrap' } }, rateText(progress)),
            h(Button, { onClick: cancelRun, disabled: progress.cancelling }, progress.cancelling ? '正在取消…' : '取消'),
          ),
          expanded ? h('div', {
            style: { marginTop: 6, maxHeight: 220, overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 },
          },
            (() => {
              const rows = (progress.files || []).filter(isSessionRow);
              if (!rows.length) return h('div', { style: { padding: 10, color: C.dim } }, '这次传输没有可取消的会话');
              return rows.map((f, i) => h('div', {
                key: f.path + ':' + i,
                style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 10px', borderBottom: `1px solid ${C.border}` },
              },
                h('span', {
                  style: {
                    width: 16, textAlign: 'center', flexShrink: 0,
                    color: f.state === 'skipped' ? '#f59e0b' : f.state === 'done' ? '#22c55e' : C.dim,
                  },
                }, STATE_ICON[f.state] || '·'),
                h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  (progress.labels && progress.labels[f.path]) || friendlyName(f.path)),
                h('span', { style: { color: C.dim, flexShrink: 0 } }, fmtBytes(f.bytes)),
                f.state === 'pending'
                  ? h(Button, { onClick: () => skipFile(f.path) }, '取消')
                  : h('span', { style: { color: C.dim, width: 52, textAlign: 'right', flexShrink: 0 } }, STATE_TEXT[f.state] || ''),
              ));
            })(),
          ) : null,
        ) : null,

        err ? h('div', { style: { fontSize: 12, color: '#ef4444' } }, err) : null,
        note ? h('div', { style: { fontSize: 12, color: C.dim } }, note) : null,

        // 双栏
        h('div', { style: { display: 'flex', gap: 12, flex: 1, minHeight: 0 } },
          h('div', { style: { flex: 1, minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 8, display: 'flex', flexDirection: 'column', minHeight: 0 } },
            h('div', { style: { padding: '8px 12px', fontSize: 12, fontWeight: 600, borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', null, tt('remote')),
              h('span', { style: { color: C.dim, fontWeight: 400 } },
                `${visibleRemote.length} 会话${hiddenRemote ? `（藏 ${hiddenRemote}）` : ''}${status?.enableFiles ? ` · ${(remote.files || []).length} 文件 · ${remote.attachments || 0} 附件` : ''}`),
              remoteStale ? h('span', { style: { color: '#f59e0b', fontWeight: 400, fontSize: 11 } }, '· 上次结果（读取失败）') : null,
            ),
            h('div', { style: { overflow: 'auto', flex: 1, minHeight: 0 } },
              !connected ? h('div', { style: { padding: 12, fontSize: 12, color: C.dim } }, tt('noRepo'))
                : (visibleRemote.length + (remote.files || []).length) === 0
                  ? h('div', { style: { padding: 12, fontSize: 12, color: C.dim } }, tt('emptyRemote'))
                  : h('div', null, [
                    ...visibleRemote.map((s) => h('label', {
                      key: 's:' + s.id,
                      style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 12, cursor: 'pointer' },
                    },
                      h('input', {
                        type: 'checkbox', checked: Boolean(selectedRemote[s.id]),
                        onChange: (e) => setSelectedRemote((v) => ({ ...v, [s.id]: e.target.checked })),
                      }),
                      h('span', { style: { color: C.dim, flexShrink: 0, minWidth: 52 } }, s.project || '-'),
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        '💬 ' + (s.title || s.id)),
                      h('span', { style: { color: C.dim, flexShrink: 0 } }, fmtBytes(s.bytes)),
                      h('button', {
                        title: '从仓库删除（不影响本机会话）',
                        onClick: (e) => { e.preventDefault(); e.stopPropagation(); requestDelete('remote', s.id); },
                        style: {
                          flexShrink: 0, fontSize: 11, padding: '1px 5px', borderRadius: 5, cursor: 'pointer',
                          border: '1px solid rgba(127,127,127,0.3)', background: 'transparent',
                          color: confirmDel && confirmDel.scope === 'remote' && confirmDel.id === s.id ? '#ef4444' : C.dim,
                        },
                      }, confirmDel && confirmDel.scope === 'remote' && confirmDel.id === s.id ? '确认删?' : '🗑'),
                    )),
                    ...(status?.enableFiles ? (remote.files || []) : []).map((f) => h('label', {
                      key: 'f:' + f.path,
                      title: f.path,
                      style: { display: 'flex', gap: 8, alignItems: 'center', padding: '5px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.dim, cursor: 'pointer' },
                    },
                      h('input', {
                        type: 'checkbox', checked: Boolean(selectedFiles[f.path]),
                        onChange: (e) => setSelectedFiles((v) => ({ ...v, [f.path]: e.target.checked })),
                      }),
                      h('span', { style: { flexShrink: 0, minWidth: 52 } }, f.project || '-'),
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        '📄 ' + (f.rel || f.path)),
                      h('span', { style: { flexShrink: 0 } }, fmtBytes(f.size)),
                    )),
                  ]),
            ),
          ),
          h('div', { style: { flex: 1, minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 8, display: 'flex', flexDirection: 'column', minHeight: 0 } },
            h('div', { style: { padding: '8px 12px', fontSize: 12, fontWeight: 600, borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', null, tt('local')),
              h('span', { style: { color: C.dim, fontWeight: 400 } },
                `${localCount} ${tt('sessions')}${hiddenSessions ? ` · 隐藏 ${hiddenSessions}（子代理/空会话）` : ''}`),
              h('span', { style: { flex: 1 } }),
              h('select', {
                value: cwd,
                onChange: (e) => loadSessions(e.target.value),
                style: { fontSize: 11, padding: '2px 4px', borderRadius: 5, border: `1px solid ${C.border}`, background: 'transparent', color: 'inherit', maxWidth: 190 },
              }, workspaces.map((w) => h('option', { key: w.id, value: w.path }, `${w.title} · ${w.sessionCount}`))),
            ),
            // 搜索 + 过滤 + 批量
            h('div', { style: { display: 'flex', gap: 6, padding: '6px 10px', borderBottom: `1px solid ${C.border}`, alignItems: 'center' } },
              h('input', {
                placeholder: '搜索会话…',
                value: search,
                onChange: (e) => setSearch(e.target.value),
                style: {
                  flex: 1, minWidth: 0, fontSize: 11, padding: '3px 7px', borderRadius: 5,
                  border: `1px solid ${C.border}`, background: 'transparent', color: 'inherit',
                },
              }),
              h('label', { style: { fontSize: 11, color: C.dim, display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', whiteSpace: 'nowrap' } },
                h('input', { type: 'checkbox', checked: onlyUnsynced, onChange: (e) => setOnlyUnsynced(e.target.checked) }),
                '只看未同步'),
              h(MiniBtn, { onClick: selectAllVisible }, '全选'),
              h(MiniBtn, { onClick: selectUnsynced }, '选未同步'),
              h(MiniBtn, { onClick: clearSelection }, '清空'),
            ),
            h('div', { style: { overflow: 'auto', flex: 1, minHeight: 0 } },
              loading ? h('div', { style: { padding: 12, fontSize: 12, color: C.dim } }, tt('loading'))
                : localCount === 0 ? h('div', { style: { padding: 12, fontSize: 12, color: C.dim } }, tt('emptyLocal'))
                  : visibleSessions.map((s) => h('label', {
                    key: s.id,
                    style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 12, cursor: 'pointer' },
                  },
                    h('input', {
                      type: 'checkbox', checked: Boolean(selected[s.id]),
                      onChange: (e) => setSelected((v) => ({ ...v, [s.id]: e.target.checked })),
                    }),
                    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      s.title || s.id),
                    s.active ? h('span', { style: { color: '#f59e0b', flexShrink: 0, fontSize: 11 } }, '活跃') : null,
                    (() => {
                      const b = SYNC_BADGE[s.sync] || SYNC_BADGE['not-uploaded'];
                      return h('span', { style: { color: b.color, flexShrink: 0, fontSize: 11, width: 56, textAlign: 'right' } }, b.text);
                    })(),
                    h('span', { style: { color: C.dim, flexShrink: 0, width: 62, textAlign: 'right' } }, fmtBytes(s.bytes)),
                    h('span', { style: { color: C.dim, flexShrink: 0, width: 58, textAlign: 'right' } }, fmtAgo(s.mtimeMs)),
                    h('button', {
                      title: '从本机删除（不影响 GitHub 仓库）',
                      onClick: (e) => { e.preventDefault(); e.stopPropagation(); requestDelete('local', s.id); },
                      style: {
                        flexShrink: 0, fontSize: 11, padding: '1px 5px', borderRadius: 5, cursor: 'pointer',
                        border: '1px solid rgba(127,127,127,0.3)', background: 'transparent',
                        color: confirmDel && confirmDel.scope === 'local' && confirmDel.id === s.id ? '#ef4444' : C.dim,
                      },
                    }, confirmDel && confirmDel.scope === 'local' && confirmDel.id === s.id ? '确认删?' : '🗑'),
                  )),
            ),
          ),
        ),

        // 底部动作条
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', borderTop: `1px solid ${C.border}`, paddingTop: 10 } },
          h('span', { style: { fontSize: 12, color: C.dim } },
            busy ? '处理中…' : `已选：本地 ${pickedLocal().length} · 远端会话 ${pickedRemote().length} · 远端文件 ${Object.keys(selectedFiles).filter((k) => selectedFiles[k]).length}`),
          h('span', { style: { flex: 1 } }),
          h('label', { style: { fontSize: 12, color: C.dim, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', marginRight: 4 } },
            h('input', {
              type: 'checkbox', checked: showSubagents,
              onChange: (e) => setShowSubagents(e.target.checked),
            }),
            `含子代理/空会话${hiddenSessions + hiddenRemote ? `（藏 ${hiddenSessions + hiddenRemote}）` : ''}`,
          ),
          h(Button, {
            disabled: busy || Boolean(progress) || !connected || unsyncedCount === 0,
            onClick: () => {
              const ids = sessions
                .filter((s) => (showSubagents || !isNoise(s)) && s.sync !== 'synced')
                .map((s) => s.id);
              if (!ids.length) { setNote('没有未同步的会话'); return; }
              setSelected(Object.fromEntries(ids.map((id) => [id, true])));
              previewUpload(ids);
            },
          }, `同步此工作区${unsyncedCount ? `（${unsyncedCount}）` : ''}`),
          h(Button, { onClick: () => previewUpload(), disabled: busy || Boolean(progress) || !connected }, '预览上传'),
          h(Button, { onClick: previewDownload, disabled: busy || Boolean(progress) || !connected }, '下载会话'),
          ...(status?.enableFiles ? [
            h(Button, {
              disabled: busy,
              onClick: async () => {
                setBrowser({ path: cwd, dirs: [], files: [], loading: true });
                try {
                  const r = await getJson(`${PREFIX}/folder/list?path=${encodeURIComponent(cwd)}`);
                  setBrowser({ path: cwd, dirs: r.dirs || [], files: r.files || [], loading: false, error: r.ok ? null : r.error });
                } catch (e) {
                  setBrowser({ path: cwd, dirs: [], files: [], loading: false, error: String(e && e.message ? e.message : e) });
                }
              },
            }, '文件夹…'),
            h(Button, { onClick: previewFiles, disabled: busy || Boolean(progress) || !connected }, '下载文件'),
          ] : []),
        ),

        // 文件夹浏览器
        browser ? h('div', {
          style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 31 },
        },
          h('div', {
            style: { width: 640, maxHeight: '80%', display: 'flex', flexDirection: 'column', background: 'Canvas',
              border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 },
          },
            h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, '选择要上传的文件夹'),
            h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 8, wordBreak: 'break-all' } }, browser.path),
            browser.error ? h('div', { style: { fontSize: 12, color: '#ef4444', marginBottom: 8 } }, browser.error) : null,
            h('div', { style: { marginBottom: 8 } },
              h(Button, {
                onClick: async () => {
                  const parent = browser.path.replace(/[\\/][^\\/]+$/, '');
                  if (!parent || parent === browser.path) return;
                  try {
                    const r = await getJson(`${PREFIX}/folder/list?path=${encodeURIComponent(parent)}`);
                    setBrowser({ path: parent, dirs: r.dirs || [], files: r.files || [], loading: false });
                  } catch { /* 忽略 */ }
                },
              }, '↑ 上一级'),
            ),
            h('div', { style: { overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 340 } },
              browser.loading
                ? h('div', { style: { padding: 10, fontSize: 12, color: C.dim } }, '加载中…')
                : h('div', null, [
                  ...(browser.dirs || []).map((d) => h('div', {
                    key: d.path,
                    style: { padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${C.border}` },
                    onClick: async () => {
                      try {
                        const r = await getJson(`${PREFIX}/folder/list?path=${encodeURIComponent(d.path)}`);
                        setBrowser({ path: d.path, dirs: r.dirs || [], files: r.files || [], loading: false });
                      } catch { /* 忽略 */ }
                    },
                  }, '📁 ' + d.name)),
                  ...(browser.files || []).slice(0, 80).map((f) => h('div', {
                    key: f.path, style: { padding: '4px 10px', fontSize: 11, color: C.dim },
                  }, '· ' + f.name)),
                ]),
            ),
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 } },
              h(Button, { onClick: () => setBrowser(null) }, '取消'),
              h(Button, {
                primary: true,
                disabled: busy,
                onClick: async () => {
                  setBusy(true);
                  try {
                    const r = await postJson(`${PREFIX}/folder/preview`, { path: browser.path, cwd });
                    if (!r.ok) { setNote(r.error || '预览失败'); return; }
                    setBrowser(null);
                    openPreview({ kind: 'folder', data: r });
                  } catch (e) {
                    setNote(String(e && e.message ? e.message : e));
                  } finally { setBusy(false); }
                },
              }, '上传这个文件夹'),
            ),
          ),
        ) : null,

        // 预览遮罩
        preview ? h('div', {
          style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 30 },
        },
          h('div', {
            style: { width: 620, maxHeight: '82%', overflow: 'auto', background: 'Canvas',
              border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, boxShadow: '0 20px 50px rgba(0,0,0,0.3)' },
          },
            h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } },
              preview.kind === 'upload' ? '上传预览'
                : preview.kind === 'folder' ? '文件夹上传预览'
                  : preview.kind === 'files' ? '文件下载预览' : '会话下载预览'),
            h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 10 } },
              Object.entries(preview.data.summary || {}).map(([k, v]) => `${k}=${v}`).join('　')),
            (preview.data.items || []).map((i) => h('div', {
              key: i.id,
              style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '5px 0', borderBottom: `1px solid ${C.border}` },
            },
              h('span', {
                style: { flexShrink: 0, width: 58, fontWeight: 600,
                  color: i.action === 'upload' || i.action === 'write' ? '#22c55e'
                    : i.action === 'blocked' ? '#ef4444'
                      : i.action === 'fork' ? '#f59e0b' : C.dim },
              }, i.action),
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                i.title || i.id),
              i.active ? h('span', { style: { color: '#f59e0b', flexShrink: 0, fontSize: 11 } }, '活跃·快照') : null,
              h('span', { style: { color: C.dim, flexShrink: 0, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                i.reason || ''),
              (i.action === 'blocked' && /远端更新|请先下载/.test(String(i.reason || '')))
                ? h(MiniBtn, { onClick: () => downloadOne(i.id) }, '先下载')
                : null,
              i.action === 'blocked'
                ? h(MiniBtn, {
                  onClick: () => (preview.kind === 'download' ? forceDownload(i.id) : forceUpload(i.id)),
                }, preview.kind === 'download' ? '用远端覆盖本地' : '用本地覆盖远端')
                : null,
            )),
            (preview.data.items || []).filter((i) => (i.attachments && i.attachments.length) || i.attachmentCount || (i.attachmentWarnings && i.attachmentWarnings.length)).map((i) => h('div', {
              key: 'att:' + i.id,
              style: { fontSize: 11, color: C.dim, padding: '2px 0 8px 8px', borderBottom: `1px solid ${C.border}` },
            },
              (i.attachmentCount ? `附件 ${i.attachmentCount} 个` : ''),
              (i.attachments && i.attachments.length
                ? `附件：${i.attachments.map((a) => a.action + (a.bytes ? '(' + fmtBytes(a.bytes) + ')' : '')).join('、')}`
                : ''),
              ...(i.attachmentWarnings || []).map((w, idx) => h('div', { key: idx, style: { color: '#f59e0b' } }, '⚠ ' + w)),
            )),
            progress ? h('div', { style: { marginTop: 12 } },
              h('div', { style: { height: 6, background: C.pill, borderRadius: 3, overflow: 'hidden' } },
                h('div', {
                  style: {
                    height: '100%',
                    width: `${progress.total ? Math.max(2, Math.round((progress.done / progress.total) * 100)) : 4}%`,
                    background: '#6366f1', transition: 'width .25s ease',
                  },
                })),
              h('div', { style: { fontSize: 11, color: C.dim, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('span', null, `${progress.done}/${progress.total} 文件`),
                progress.bytesTotal ? h('span', null, `${fmtBytes(progress.bytesDone)} / ${fmtBytes(progress.bytesTotal)}`) : null,
                rateText(progress) ? h('span', null, rateText(progress)) : null,
                h('span', null, '· ' + (PHASE_LABEL[progress.phase] || progress.phase)),
                progress.currentPath ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  '· ' + String(progress.currentPath).split('/').pop()) : null,
              ),
            ) : null,
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 } },
              busy
                ? h(Button, { onClick: cancelRun }, '取消传输')
                : h(Button, { onClick: () => closePreview() }, '关闭'),
              h(Button, { onClick: confirm, disabled: busy, primary: true },
                preview.kind === 'download' ? '确认下载' : '确认上传'),
            ),
          ),
        ) : null,

        // 首次配置向导
        popover === 'wizard' ? h('div', {
          style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 40 },
        },
          h('div', {
            style: { width: 620, maxHeight: '85%', overflow: 'auto', background: 'Canvas',
              border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 12 } },
              h('div', { style: { fontSize: 15, fontWeight: 600 } },
                ['第 1 步 · 建一个空私有仓', '第 2 步 · 建访问令牌', '第 3 步 · 填进来并测试'][wizardStep]),
              h('span', { style: { flex: 1 } }),
              h(MiniBtn, { onClick: () => setPopover(null) }, '稍后再说'),
            ),
            wizardStep === 0 ? h('div', { style: { fontSize: 12, lineHeight: 1.9 } },
              h('div', null, '1. 打开 GitHub 新建仓库页面。'),
              h('div', null, '2. 名字随意，勾 Private。'),
              h('div', { style: { color: '#f59e0b' } }, '3. 不要勾 README、不要勾 .gitignore —— 空仓库最省事。'),
              h('div', { style: { marginTop: 10 } },
                h('a', { href: 'https://github.com/new', target: '_blank', rel: 'noreferrer', style: { color: '#3b82f6' } }, '打开 github.com/new')),
            ) : null,
            wizardStep === 1 ? h('div', { style: { fontSize: 12, lineHeight: 1.9 } },
              h('div', null, '1. 打开 Fine-grained tokens 页面。'),
              h('div', null, '2. Repository access 选 Only select repositories，只勾刚才那个仓库。'),
              h('div', null, '3. Permissions：Contents 设为 Read and write；Metadata 自动是 Read-only。'),
              h('div', null, '4. 生成后立刻复制那串 github_pat_…（只显示一次）。'),
              h('div', { style: { marginTop: 10 } },
                h('a', { href: 'https://github.com/settings/tokens?type=beta', target: '_blank', rel: 'noreferrer', style: { color: '#3b82f6' } }, '打开 tokens 页面')),
            ) : null,
            wizardStep === 2 ? h('div', { style: { fontSize: 12 } },
              [['repo', '仓库（owner/repo 或完整链接）', 'owner/repo'], ['token', '访问令牌', 'github_pat_…']]
                .map(([key, label, ph]) => h('div', { key, style: { marginBottom: 10 } },
                  h('div', { style: { color: C.dim, marginBottom: 4 } }, label),
                  h('input', {
                    type: key === 'token' ? 'password' : 'text',
                    value: form[key] ?? '', placeholder: ph,
                    onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })),
                    style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12,
                      borderRadius: 6, border: `1px solid ${C.border}`, background: 'transparent', color: 'inherit' },
                  }),
                )),
              h('div', { style: { color: C.dim, fontSize: 11 } }, '令牌只存在本机，面板永远不显示明文。'),
            ) : null,
            note && popover === 'wizard' ? h('div', { style: { fontSize: 12, marginTop: 10, color: C.dim } }, note) : null,
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 } },
              wizardStep > 0 ? h(Button, { onClick: () => setWizardStep((s) => s - 1) }, '上一步') : null,
              wizardStep < 2
                ? h(Button, { onClick: () => setWizardStep((s) => s + 1), primary: true }, '下一步')
                : h(Button, { onClick: async () => { await test(); }, primary: true }, '测试连接'),
              wizardStep === 2 ? h(Button, { onClick: () => setPopover(null) }, '完成') : null,
            ),
          ),
        ) : null,

        // 设置抽屉
        settingsOpen ? h('div', {
          style: { position: 'absolute', top: 8, right: 8, width: 340, background: 'Canvas', border: `1px solid ${C.border}`,
            borderRadius: 10, padding: 14, boxShadow: '0 10px 30px rgba(0,0,0,0.25)', zIndex: 20 },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 10 } },
            h('div', { style: { fontWeight: 600, fontSize: 13 } }, tt('settings')),
            h('span', { style: { flex: 1 } }),
            h(Button, { onClick: () => setSettingsOpen(false) }, '✕'),
          ),
          [
            ['repo', tt('repo'), 'owner/repo'],
            ['branch', tt('branch'), 'main'],
            ['deviceName', tt('device'), 'DESKTOP-XXX'],
            ['token', tt('token'), 'github_pat_…'],
          ].map(([key, label, ph]) => h('div', { key, style: { marginBottom: 10 } },
            h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 4 } }, label),
            h('input', {
              type: key === 'token' ? 'password' : 'text',
              value: form[key] ?? '', placeholder: ph,
              onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })),
              style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12,
                borderRadius: 6, border: `1px solid ${C.border}`, background: 'transparent', color: 'inherit' },
            }),
          )),
          h('label', { style: { fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: Boolean(form.enableFiles),
              onChange: (e) => setForm((f) => ({ ...f, enableFiles: e.target.checked })),
            }),
            '启用文件夹 / 文件同步（默认关闭）'),
          h('label', { style: { fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: Boolean(form.skipPreview),
              onChange: (e) => setForm((f) => ({ ...f, skipPreview: e.target.checked })),
            }),
            '上传时跳过预览（高级：勾选后点上传直接提交，不再弹清单）'),
          h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 10 } },
            tt('tokenHint') + ' · 当前：' + (status?.hasToken ? '已配置 ✅' : '未配置')),
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(Button, { onClick: save }, tt('save')),
            h(Button, { onClick: test, primary: true }, tt('test')),
          ),
        ) : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try { ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), NS + ': dictionaries'); } catch { /* locale 可选 */ }
        let t;
        try { t = ctx.locale.bind(NS); } catch { t = (k) => k; }

        const offPanel = ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }),
        }, Panel));

        const offRow = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => (t ? t('nav') : 'GitHub 同步'), locale: NS,
        }, (owner) => h(SyncIcon, { size: (owner && owner.size) || 16 })));

        return () => {
          try { if (typeof offRow === 'function') offRow(); } catch { /* ignore */ }
          try { if (typeof offPanel === 'function') offPanel(); } catch { /* ignore */ }
        };
      },
    };
  },
});
