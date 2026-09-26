# 导出到 OneNote

连接后，LinkDock 每存档一篇文章，就在你的 OneNote 默认笔记本的 **LinkDock** 分区中创建一个页面：标题、原文链接、作者（公众号名称）和整理后的正文。图片由 OneNote 在创建页面时从原网站下载保存（与 LinkDock 自身的存档不同，原文章删除后 OneNote 中的图片仍在）。

此功能是可选的：不设置下面的 `MS_CLIENT_ID` / `MS_CLIENT_SECRET` 时完全关闭，网页上也不显示。

## 工作方式

- **授权**：OneNote 接口自 2025-03-31 起只接受以用户身份（委托授权）调用。你在网页上点“连接 OneNote”并登录自己的 Microsoft 账户，Worker 保存刷新令牌，之后在后台自动续期。只申请 `Notes.Create` 权限：可以创建页面和分区，**不能读取、修改或删除**你已有的笔记。
- **导出范围**：连接之后存档的文章，包括提交时的后台存档、旧链接首次打开时的存档，以及“重新获取”生成的存档。每个链接最多导出一次：重复提交或重新获取已导出的文章不会生成新页面。连接之前已存档的文章不会导出。
- **时机与重试**：存档完成后立即导出。失败时每 30 分钟由定时任务重试一次，最多 5 次。网页底部显示已导出和失败的数量。
- **删除**：在 LinkDock 删除链接不会删除 OneNote 页面（权限上也做不到）。断开连接只删除 LinkDock 保存的令牌，已导出的页面保留。
- **分区**：页面放在默认笔记本的顶级分区中，分区不存在时自动创建。如果你改了分区名，之后的页面会放入新建的 LinkDock 分区。可以用 `ONENOTE_SECTION` 改名（不能包含 `? * \ / : < > | & # " % ~`）。

## 设置步骤

以下假设 LinkDock 已部署在 `https://linkdock.<你的子域>.workers.dev`（见 README）。

### 1. 注册 Microsoft 应用

1. 用你的 Microsoft 账户登录 [Microsoft Entra 管理中心](https://entra.microsoft.com) → **应用注册** → **新注册**（或在 Azure 门户中搜索“应用注册”）。注册应用本身免费。
2. 填写：
   - 名称：`LinkDock`
   - 支持的帐户类型：**仅个人 Microsoft 帐户**（Microsoft 365 个人版 / 家庭版、outlook.com 账户）。如果要连接的是工作或学校账户，改选“任何组织目录中的帐户”，并在第 3 步设置 `MS_TENANT=organizations`。
   - 重定向 URI：平台选 **Web**（不要选“单页应用程序 (SPA)”，SPA 的刷新令牌 24 小时就会过期），地址填 `https://linkdock.<你的子域>.workers.dev/onenote/callback`
3. 注册后在“概述”页复制 **应用程序(客户端) ID**。
4. **证书和密码** → **新客户端密码** → 选择有效期（最长 24 个月）→ 复制 **值**（不是“密码 ID”，离开页面后无法再次查看）。
5. （可选）**API 权限** → 添加 Microsoft Graph 的委托权限 `Notes.Create`。不添加也可以，登录时会请求。

### 2. 设置密钥并部署

```sh
npx wrangler secret put MS_CLIENT_ID       # 第 3 步复制的客户端 ID
npx wrangler secret put MS_CLIENT_SECRET   # 第 4 步复制的密码“值”
# 可选：
# npx wrangler secret put MS_TENANT        # 默认 consumers（个人账户）；工作或学校账户用 organizations
# npx wrangler secret put ONENOTE_SECTION  # 默认 LinkDock

npm run deploy   # 应用数据库迁移 0003_onenote.sql，并启用每 30 分钟一次的定时任务
```

### 3. 连接

登录 LinkDock 网页，点页面底部的“连接 OneNote”，登录 Microsoft 账户并同意授权，回到 LinkDock 后显示“已连接 OneNote”。之后保存一篇文章，稍等几秒即可在 OneNote 的 LinkDock 分区看到。

## 维护

- **客户端密码过期**：网页底部会显示“OneNote 导出已暂停”。在应用注册中新建密码，`npx wrangler secret put MS_CLIENT_SECRET`，然后点“重新连接”。暂停期间存档的文章会在重新连接后由定时任务补上导出（每次最多 10 篇）。
- **刷新令牌失效**（例如在 Microsoft 账户中撤销了授权、修改了密码）：同样显示已暂停，点“重新连接”即可。长期没有新文章时，定时任务每周自动续期一次，不会因闲置失效。
- **撤销授权**：先在 LinkDock 点“断开”，再在 [account.live.com/consent/Manage](https://account.live.com/consent/Manage) 中删除 LinkDock。
- **排查失败**：`npx wrangler tail` 查看日志；每篇文章最近一次失败的原因保存在 D1 `onenote_exports.last_error`。

## 本地开发

在应用注册中再添加一个 Web 重定向 URI `http://localhost:8787/onenote/callback`，把两个值写入 `.dev.vars`（见 `.dev.vars.example`），然后 `npm run dev` 并通过 `http://localhost:8787` 访问（不要用 127.0.0.1，否则与重定向 URI 不匹配）。

## 已知限制

- 单个分区的页面数量有上限，达到后创建页面返回 507。届时在 OneNote 中把 LinkDock 分区改名（例如“LinkDock 2026”），之后的页面会自动放入新建的 LinkDock 分区。
- 正文中的视频、音频等不会导出（存档中本来就没有）；个别复杂排版可能被 OneNote 简化。
- 某些网站的图片需要特定来源才能访问，OneNote 下载失败时该图片会缺失。
