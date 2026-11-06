# 发布清单

面向插件市场的发布前检查。照着走一遍即可。

## 1. 元数据

仓库地址已填好（`mount9527/dsh-github-sync`）：

```json
"repository": { "type": "git", "url": "git+https://github.com/mount9527/dsh-github-sync.git" },
"homepage": "https://github.com/mount9527/dsh-github-sync#readme",
"bugs": { "url": "https://github.com/mount9527/dsh-github-sync/issues" }
```

已就位：`name` / `version` / `description` / `license` / `author` / `repository` /
`homepage` / `bugs` / `keywords` / `engines` / `files` / `exports` / `dsh`。

`private` 已从 `true` 去掉；发到 npm 公共源必须如此。

## 2. engines.dsh 必须带预发布标记

当前运行时是 `0.2.1-rc.5`（预发布版）。按语义化版本，`>=0.2.1` **不包含** `0.2.1-rc.5`，
写错会导致插件**装不上**：

```
incompatible-version: dsh-github-sync 0.5.0
requirements {"engines.dsh": ">=0.2.1"}  runtimeVersion "0.2.1-rc.5"
```

实测可用写法：`"dsh": ">=0.2.1-rc.5"`。发布前务必确认这一项能过 DSH 的版本校验
（最直接的验证：在插件管理器里关掉再启用一次，报 `incompatible-version` 就是没过）。

## 3. 打包与检查

```bash
pnpm pack            # 生成 dsh-github-sync-0.5.0.tgz
tar -tzf dsh-github-sync-0.5.0.tgz   # 确认只包含 files 里列的东西
```

`files` 应当只含：`index.js`、`client.js`、`cordis.patch.yml`、`icon.svg`、
`locale/*.json`、`lib/*.mjs`、`README.md`、`README.en.md`、`CHANGELOG.md`、
`LICENSE`、`PUBLISHING.md`。

**不会**打进包里的：`tools/`（开发脚本）、`node_modules`。

## 4. 单平台自检（Windows 与 macOS 各跑一遍，互不依赖）

插件是纯 JavaScript，没有原生模块，两个系统跑同一份代码。
**唯一需要人确认的是路径相关行为**，所以下面的清单每台机器**独立**完成，不需要另一台配合。

准备：一台机器 + DSH（版本 ≥ `0.2.1-rc.5`）+ 一个**空的私有测试仓**（别用真仓库）。

### 4.1 通用自检（12 步，Windows 与 macOS 完全相同）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 安装插件 → 启用 → 左栏点「GitHub 同步」 | 面板打开；图标是「云 + 上下箭头」 |
| 2 | 看面板右上角 | 显示 `v0.5.0` |
| 3 | 填仓库地址 + PAT → 点「测试连接」 | 显示「连接正常」，不报 404/401 |
| 4 | 看本地会话列 | **非空**，每条右侧有徽标（已同步/未上传/本地更新） |
| 5 | 勾一条 →「预览上传」→「确认上传」 | 进度条出现 `x/y 文件 · KB/KB · KB/s` |
| 6 | 看提交结果提示 | `已提交 N 个会话 · <7 位 commit>` |
| 7 | 等 2 秒看该行徽标 | 变「已同步」；远端列出现该会话 + `manifest.json` + `README.md` |
| 8 | 新建一个空目录，在 DSH 里加为工作区并切过去 | 本地列显示「这个工作区没有会话」 |
| 9 | 在远端列勾同一会话 →「下载会话」→ 确认 | 提示已落盘并挂载；切回该工作区能看到它 |
| 10 | 本地该行 🗑 点两次 | 提示已删除；**远端仍在**（删本地不动仓库） |
| 11 | 远端该行 🗑 点两次 | 提示已从仓库删除；**本地仍在**，徽标变「未上传」 |
| 12 | 点「诊断」→ 复制 | 「可写范围」只有 3 个 `.dsh` 路径，且带「文件同步关闭」字样（未开启时） |

### 4.2 平台差异点（只有这两行不同）

| 检查点 | Windows | macOS |
|---|---|---|
| 会话目录在哪 | `%USERPROFILE%\.dsh\sessions\` | `~/.dsh/sessions/` |
| 目录名长什么样 | `--E-ruanjianxiazai-deepseek-work--`（盘符被折成 `-`） | `--Users-<你>-...--`（斜杠被折成 `-`） |

**第 4 步是这轮检查的重点**：如果列表为空，说明该平台的目录名算法与插件不同、
且 `lib/sessiondir.mjs` 的回退也没命中。这时请把 `sessions` 下的目录名发出来，按真实格式修 `projectkey`。

### 4.3 出问题时看哪里

| 现象 | 大概率原因 |
|---|---|
| 面板列出 0 条会话（明明有） | 目录名算法不匹配且回退未命中 → 附上目录名报 bug |
| 下载后侧栏没有 | 宿主对会话 header 有内存缓存；重启 DSH 再试 |
| 上传报 `incompatible-version` | `engines.dsh` 写法不对（见第 2 节） |
| 两端都改了同一条 | 预览里会标 `blocked`，用「用本地覆盖远端 / 用远端覆盖本地」明确选一边 |

---

## 4b. 两端互通（可选：只有用到跨设备接力时才需要两台机器）

| # | 操作 | 期望 |
|---|---|---|
| 1 | A 机上传一条会话 | 成功 |
| 2 | B 机点「刷新」 | 远端列出现该会话 |
| 3 | B 机「下载会话」→ 确认 | 落盘并挂载，打开能继续对话 |
| 4 | B 机在该会话里再发一句话 | 徽标变「本地更新」 |
| 5 | B 机上传 → 回到 A 机刷新 | A 机徽标变「**远端更新**」；下载后能看到 B 机追加的那句话 |
| 6 | 两端看「设备」弹层 | 两台设备名都在，各自标「(本机)」 |
| 7 | 两端看「历史」弹层 | 都能看到对方的提交记录 |

> 第 5 步是整条链路的胜负手：同时验证了 `cwd` 重映射、body 比对、以及索引合并。



## 5. 安全边界（发布说明里应原文写清）

插件**只**做这些文件操作：

| 位置 | 用途 |
|---|---|
| `$DSH_HOME/github-sync/` | 自己的状态、历史、诊断 |
| `$DSH_HOME/sessions/` | 下载/删除会话（用户点按钮才动作） |
| `$DSH_HOME/attachments/v1/objects/` | 还原/回收附件 |
| 当前工作区（默认关闭） | 文件夹/文件同步，需在设置里显式打开 |

插件**不会**：启动子进程、执行外部命令、读写注册表、改 hosts、改系统环境变量、
安装全局代理、访问 GitHub 以外的域名。

这些不变量由 `tools/audit-safety.mjs` 静态检查，发布前跑一次：

```bash
node tools/audit-safety.mjs   # 期望 19 项全过
```

## 6. 测试套件
```bash
node tools/selftest.mjs           # 编解码/重映射/清单（离线）
node tools/test-upload-plan.mjs   # 上传计划组装（离线）
node tools/test-force.mjs         # 冲突强制覆盖（离线）
node tools/test-multidevice.mjs   # 多设备合并与非快进重试（离线）
node tools/test-crossplatform.mjs # 会话目录回退解析（离线）
node tools/test-guards.mjs        # 路径守卫：恶意 id/sha 必须被拦（离线）
node tools/test-filesync.mjs      # 文件夹/文件同步：密钥阻断、限制、路径消毒（离线）
node tools/test-boundaries.mjs    # 边界值：10MB 两侧、空文件、超长/emoji/中文名（离线）
node tools/audit-safety.mjs       # 安全不变量（离线）
node tools/e2e.mjs                # 端到端只读（需要 DSH 在跑）
```

`tools/e2e.mjs --write` 会真的上传/删除，只在专用测试仓上跑。
插件端口每次重启都会变，跑之前用 `SYNC_BASE=http://127.0.0.1:<端口>` 指定。

## 7. 版本与变更记录

发布前确认三处版本号一致：`package.json`、`index.js` 的 `VERSION`、`client.js` 的 `VERSION`；
CHANGELOG 有对应条目。

## 8. 最近一次自检记录

| 步骤 | 结果 |
|---|---|
| 1 元数据 | repository / homepage / bugs 已填 `mount9527/dsh-github-sync` |
| 2 engines.dsh | `>=0.2.1-rc.5`；安装 0.5.0 无 `incompatible-version`，重启后 `/status` 返回 0.5.0 |
| 3 打包 | `pnpm pack` 产出 64.6 KB / 24 文件，**不含 `tools/`** |
| 4 单平台自检 | Windows 侧自动化部分由 `e2e --write` 覆盖（16/16）；UI 的 12 步待人工确认；**macOS 未验证** |
| 5 安全审计 | 19/19 |
| 6 测试套件 | selftest 24 · force 8 · multidevice 9 · crossplatform 6 · guards 22 · filesync 25 · boundaries 16 · e2e 9 → 全过 |
| 7 版本一致 | package.json / index.js / client.js 均 0.5.0，CHANGELOG 有 0.5.0 条目 |
| 附加 | 空提交不记历史（16→16 条验证）；100 天历史清理（注入 2 条 200 天前记录，重启后 18→16） |
| 附加 | **空仓库首传已验证**：新仓 `deepseek-harness-work1`（零提交）连接 OK → 首传 18 文件 → 提交历史显示"根提交无父 + 正常提交"，即 Contents API 种子路径生效 |

## 9. 中国大陆镜像（npmmirror）

### 先纠正一个常见误解

**npmmirror（原淘宝 npm 镜像）是 npm 的只读镜像，不能直接往它上面发布。**

它只做一件事：把 `registry.npmjs.org` 上已有的包**复制**过来。
所以顺序永远是：**先发布到 npm → 镜像自动（或手动触发）同步 → 大陆用户从镜像装**。

已验证：`registry.npmmirror.com/react` 返回 200，`registry.npmmirror.com/dsh-github-sync` 返回 404
（因为包还没发到 npm，镜像里自然就没有）。

### 发布后的同步步骤

1. **先发 npm**：`npm publish --access public`
2. **一条命令搞定剩下的事**：

   ```bash
   node tools/publish-cn.mjs --wait
   ```

   它会：检查 npm 上有没有这个版本 → 检查镜像 → 触发同步（`PUT /-/package/<name>/syncs`）→ 轮询直到镜像就绪。
   网络慢时先设代理：

   ```powershell
   $env:HTTPS_PROXY='http://127.0.0.1:7892'; $env:NODE_USE_ENV_PROXY='1'
   ```
3. **手动兜底**：打开 <https://npmmirror.com/package/dsh-github-sync>，
   页面上有「同步」按钮；如果页面还没收录，用它的同步接口按包名触发一次
4. **验证镜像可用**：

   ```bash
   npm view dsh-github-sync version --registry=https://registry.npmmirror.com
   ```

   返回版本号（如 `0.5.0`）就说明镜像已就绪。

### 给大陆用户的安装说明（写进 README 或发布说明）

```bash
# 临时用镜像源安装
npm install dsh-github-sync --registry=https://registry.npmmirror.com

# 或长期把源切成镜像（影响所有包）
npm config set registry https://registry.npmmirror.com
```

### 如果镜像迟迟不同步

- npmmirror 对**新发布**的包有抓取延迟，属正常；
- 也可以在包里加一个 `README` 徽章/说明，引导用户临时用官方源；
- 备选分发方式：把 `pnpm pack` 产出的 tgz 挂到 **GitHub Release**（大陆访问慢，只作兜底）。

### 注意

- 镜像只镜像**公开**包。私有包（`private: true`）不会也不应该出现在镜像里。
- 镜像上的版本可能**滞后**几分钟，发版后立刻验证可能还是旧版本，属正常。
