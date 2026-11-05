# 配置教程：私有仓库 + 访问令牌

第一次用这个插件，需要做三件事：**建一个私有仓**、**建一个令牌**、**填进插件**。
全程约 5 分钟，不需要命令行。

> ⚠️ 先记住一条：**令牌等于你的 GitHub 密码**。它存在本机 `$DSH_HOME/.credentials.yaml` 里，
> 面板永远不会回显。不要把它贴到聊天、截图、issue 或任何公开的地方。

---

## 一、为什么必须是**私有仓**

插件会把你的**完整对话记录**（包括你让它读过的代码、贴过的报错、走过的弯路）同步上去。
公开仓意味着这些内容对全世界可见，甚至会被搜索引擎收录。

所以插件**硬性拒绝公开仓**：测试连接时如果发现 `private !== true`，会直接报错并拒绝使用。

---

## 二、第一步：建一个空的私有仓

1. 打开 <https://github.com/new>
2. **Repository name**：随便起，例如 `dsh-sync`（插件会用它做项目名前缀）
3. **Visibility**：选 **Private** ← 必须
4. **Initialize this repository with** 里面的三项（README / .gitignore / license）**全部不要勾**
   - 勾了也能用，但空仓能顺带验证"零提交仓库"的初始化路径，更省事
5. 点 **Create repository**

建完你会看到一个空仓页面，网址形如 `https://github.com/<你的用户名>/dsh-sync`。

---

## 三、第二步：建访问令牌（fine-grained）

1. 打开 <https://github.com/settings/tokens?type=beta>
2. 点右上 **Generate new token**
3. **Token name**：`dsh-github-sync`（自己认得出就行）
4. **Expiration**：按需，建议 90 天或 1 年，过期前记得换
5. **Resource owner**：选你自己
6. **Repository access** → 选 **Only select repositories**
   - 在下拉里勾上**刚才建的那个仓库**
   - 如果打算同时用两个仓（比如一个真仓 + 一个测试仓），**两个都勾上**
7. **Permissions** → 展开 **Repository permissions**，找到 **Contents**
   - 设为 **Read and write**
   - 下面的 **Metadata** 会自动变成 **Read-only**（必须，不用动）
8. 拉到底点 **Generate token**
9. **立刻复制**那串 `github_pat_xxxxxxxx…`

> 📌 **只显示一次**。关掉页面就再也看不到了，只能重新生成。
>
> 📌 **令牌创建后不能改权限**。选错仓库只能重建一个新的——这是 GitHub 的设计，不是插件问题。

### 如果坚持用 classic 令牌（不推荐）

`Settings → Developer settings → Tokens (classic) → Generate new token (classic)`，
勾选 **`repo`** 一个范围即可。缺点：它对你**所有**仓库生效，权限过大。

---

## 四、第三步：填进插件

1. 打开 DSH，左侧栏点「**GitHub 同步**」
2. 点右上 **⚙ 设置**
3. **仓库**：填下面任意一种写法，插件都认
   - `你的用户名/仓库名`，例如 `lifeng4127/dsh-sync`
   - `https://github.com/lifeng4127/dsh-sync.git`
   - `https://github.com/lifeng4127/dsh-sync`
4. **分支**：默认 `main`，不用改
5. **访问令牌**：粘贴刚才那串 `github_pat_…`
6. 点 **保存**，再点 **测试连接**
7. 看到「**连接正常**」就配好了

第一次连接后，面板顶部会显示绿色圆点 + 「已连接」，本地会话列表里每条会话右边会出现同步徽标。

---

## 五、在第二台机器上接着用

**同一台设备不需要重建令牌，同一个仓库可以在多台机器上同时使用。**

在新机器上：

1. 装好插件
2. 重复上面「第三步」，**仓库地址填同一个**
3. **令牌**：可以**复用同一个**，也可以给新机器单独建一个（推荐，便于单独吊销）
4. 点「刷新」→ 左侧远端列出现已经传上去的会话
5. 勾一条 →「下载会话」→ 确认 → 它会被挂到当前工作区，可以直接继续对话

> 两台机器的会话会**自动合并**，不会互相覆盖：提交前插件会重读远端索引做并集。
> 同一会话两端都改过时，预览里会标 `blocked`，用「用本地覆盖远端 / 用远端覆盖本地」明确选一边。

---

## 六、常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `404 Not Found` | ① 仓库名写错 ② 令牌没授权这个仓库 ③ 仓库不存在 | 回第二步，确认令牌的 **Repository access** 勾了这个仓 |
| `401 Unauthorized` | 令牌过期、被吊销，或复制时漏了字符 | 重新生成并粘贴 |
| `403` / `Resource not accessible` | 令牌缺 **Contents: Read and write** | 重建令牌，勾上该权限 |
| 「这个仓库是公开的，按安全红线拒绝使用」 | 仓库是 Public | 仓库 Settings → 最下方 Change visibility → 改回 Private |
| 「访问令牌已损坏」 | 存进去的不是令牌（常见于把报错文本误存进去） | 重新粘贴一次令牌 |
| 「空仓库初始化失败」 | 极少数情况下 Contents API 建种子失败 | 在网页上给仓库建一个 README 提交，再重试 |
| 面板列出 0 条会话 | 该工作区确实没有会话，或目录解析异常 | 换个工作区看看；仍为空就点「诊断」→ 复制，把 **`平台`**、**`会话目录(应有)`**、**`sessions 根下 N 个目录`** 三行发出来 |
| **macOS 上列表为空** | 该平台的会话目录名算法与插件不一致（Windows 上不会遇到） | 同上，把诊断里那三行发出来即可定位；插件有回退匹配，多数情况会自动恢复 |

### 证书错误（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）

**现象**：连接测试或上传时报 `网络失败：fetch failed（UNABLE_TO_VERIFY_LEAF_SIGNATURE）`，
或者 `SELF_SIGNED_CERT_IN_CHAIN` / `unable to get local issuer certificate`。

**原因**：你电脑上有软件在**解密 HTTPS**，它用自己的根证书替换了 GitHub 的真证书。

中国大陆最常见的是：

| 软件 | 典型特征 |
|---|---|
| SteamTools（Watt Toolkit / 瓦特工具箱） | 证书签发者 `CN=SteamTools Certificate, O=BeyondDimension` |
| Fiddler / Charles | 抓包工具，默认开启 HTTPS 解密 |
| 部分安全软件的「网页防护 / HTTPS 扫描」 | 名称里带安全、卫士、管家等 |

浏览器能用是因为系统信任了它的根证书，但 DSH 用的 Node 只信任内置的 CA 列表，所以会拒绝。

**三种解法，从简到繁：**

**① 加进绕过列表（推荐）**

打开那个软件的设置，找到「不使用代理的地址 / 跳过域名 / 绕过列表」，加上：

```
api.github.com
github.com
*.githubusercontent.com
```

**② 关掉它的 HTTPS 解密**

SteamTools：关掉「GitHub 加速」或「网络加速」；
抓包工具：关闭 HTTPS 解密 / 停止捕获；
安全软件：关闭「HTTPS 扫描 / 网页防护」。

**③ 让它信任你的环境（导出根证书）**

适合你确实需要那个软件（比如它是你唯一的翻墙/加速手段）：

```powershell
# 1. 找到它的根证书并导出成 PEM
$cert = Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root |
  Where-Object { $_.Subject -match 'SteamTools' } | Select-Object -First 1
$pem = "-----BEGIN CERTIFICATE-----`n" +
  [Convert]::ToBase64String($cert.RawData, [Base64FormattingOptions]::InsertLineBreaks) +
  "`n-----END CERTIFICATE-----`n"
Set-Content -Path "$env:USERPROFILE\.dsh\proxy-ca.pem" -Value $pem -Encoding ascii

# 2. 让 Node（也就是 DSH）信任它
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', "$env:USERPROFILE\.dsh\proxy-ca.pem", 'User')
```

然后**完全退出 DSH 再打开**（环境变量只在新进程生效）。

> ⚠️ 这等于让那张证书的持有者能解密 Node 的 HTTPS 流量。它本来就已经在解密你浏览器的流量了，
> 所以是"延续既有信任"；卸载那个软件时记得撤掉：
> `[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $null, 'User')`

**怎么确认好了**：再点一次「测试连接」，看到「连接正常」即可。

---

## 七、令牌的轮换与撤销

**定期轮换**（建议每 90 天，或怀疑泄露时立刻做）：

1. 按第二步建一个新令牌（同一个仓库、同样的 Contents 权限）
2. 插件 ⚙ 设置里粘贴新令牌 → 保存 → 测试连接
3. 确认可用后，到 <https://github.com/settings/tokens> 把**旧令牌删掉**

**令牌泄露了怎么办**：先删令牌（立刻失效），再建新的。GitHub 会记录令牌的最近使用时间，可用于判断是否被滥用。

---

## 八、这台机器上到底写了什么

插件只写这三个目录（外加你手动开启的文件同步时才碰工作区）：

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/github-sync/` | 插件自己的状态、历史、诊断 |
| `$DSH_HOME/sessions/` | 你下载或删除的会话 |
| `$DSH_HOME/attachments/v1/objects/` | 你下载或回收的附件 |

令牌存在 `$DSH_HOME/.credentials.yaml`，由 DSH 平台管理，插件只读不写。

它**不碰**注册表、hosts、系统环境变量、全局代理，也不访问 GitHub 以外的域名。
