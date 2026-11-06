# 发布状态与步骤（GitHub + 插件市场）

> 这份文件记录"已经做到哪一步、还差什么、下一步跑什么"。发布完成后可以删掉。

## 一、已经就绪的

| 项 | 状态 |
|---|---|
| 本地 git 仓库 | `main` 分支，3 个提交，工作区干净 |
| 与远程的关系 | 已合并远程 `Initial commit`，**推送是快进**（不会覆盖你的历史） |
| 仓库级 git 配置 | TLS 走 OpenSSL 后端、代理 `127.0.0.1:7892`、`credential.helper=manager` |
| 市场提交文件 | [`submit/mount9527__dsh-github-sync.yml`](submit/mount9527__dsh-github-sync.yml)（格式已对照官方样例） |
| 包与文档 | 26 个文件 / 72 KB，含 README、README.en、TUTORIAL、RELEASE_NOTES、LICENSE、PUBLISHING |

## 二、阻塞 1：推送需要你的 GitHub 身份

我没有你的账号凭据，**这一步必须你执行**。仓库已经配好 `credential.helper=manager`，所以最简单：

```powershell
cd E:\ruanjianxiazai\deepseek\work\dsh-github-sync
git push -u origin main
```

会弹出 GitHub 登录窗口（浏览器授权一次即可）。之后：

```
remote: ...
To https://github.com/mount9527/dsh-github-sync.git
   6178f06..5cb8cde  main -> main
```

### 如果不想弹浏览器（用令牌）

1. 到 <https://github.com/settings/tokens?type=beta> 建一个令牌，**Repository access 勾 `dsh-github-sync`**（现有的令牌只授权了两个 work 仓，且 fine-grained 令牌**不能改**，只能新建）
2. 执行（令牌只在本次命令里出现，不要写进 config）：

```powershell
git push https://mount9527:<你的令牌>@github.com/mount9527/dsh-github-sync.git main:main
```

## 三、阻塞 2：插件市场要求"仓库满 1 天"

市场（dshmarket）的插件列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
上架方式是**去那个仓库提 PR**，不是往某个后台传包。

它的硬性条件（来自官方 CONTRIBUTING）：

| 条件 | 我们 |
|---|---|
| `package.json` 里声明 `dsh.bundle` | ✅ 已有 |
| 仓库满 **1 天** | ⏳ 仓库创建于 `2026-11-04T12:49:01Z`，需等到 **2026-11-05 12:49 UTC** 之后 |
| 仓库带 `dsh-plugin` topic | ❌ 待加（见下） |

### 明天要做的三步

1. **给仓库加 topic**：仓库页右侧 ⚙ → Topics 填 `dsh-plugin` → 保存
2. **Fork** [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
3. **新增文件** `data/plugins/mount9527__dsh-github-sync.yml`，内容就是 `submit/` 下那份，然后提 PR

PR 标题建议：`Add mount9527/dsh-github-sync`

合并后站点与市场会自动收录（官方说通常一天内生效）。

## 四、可选：发到 npm

市场里有大量 `npm: null` 的条目（只挂 GitHub 也能上架），但**一键安装的体验取决于 npm**：

```powershell
npm login
npm publish --access public
```

发完后若需要大陆镜像，再跑：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7892'; $env:NODE_USE_ENV_PROXY='1'
node tools/publish-cn.mjs --wait
```

## 五、推送完成后

跟我说一声，我可以帮你验证：

- 远程文件是否与本地一致（匿名读取）
- README/LICENSE 渲染是否正常
- 仓库大小、分支、默认分支
