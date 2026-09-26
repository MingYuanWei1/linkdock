# LinkDock（链接坞）

个人跨设备链接收集工具。在 iPhone 上通过系统分享菜单（或在任意设备的网页里粘贴）保存链接，在另一台设备打开网页即可查看、搜索、打开和删除。运行在 Cloudflare Workers + D1 上，不需要自己的服务器。

- 单用户、单私有列表；网页使用统一密码登录，浏览器记住会话（180 天，常用设备自动续期）。
- iOS 快捷指令使用独立的**上传密钥**，只能提交链接，不能读取或删除。
- 链接先保存，再在后台获取标题和网站图标；预览失败时只显示原链接。
- 重复提交保留同一条目并移到顶部；微信公众号文章按稳定文章标识去重。
- 页面打开期间每 5 秒自动同步（切回页面或网络恢复时立即同步）。
- 中文界面，适配手机与桌面，支持浅色与深色模式。

规格见 [SPEC.md](SPEC.md)，领域术语见 [CONTEXT.md](CONTEXT.md)。

## 使用

1. 打开站点（例如 `https://linkdock.<你的子域>.workers.dev`），输入访问密码登录。
2. 发送链接：
   - 网页：在顶部输入框粘贴链接，点“保存”。
   - iPhone / iPad：在 Safari 等 App 中点“分享”→ 选择“存到链接坞”快捷指令。配置方法见 [docs/ios-shortcut.md](docs/ios-shortcut.md)。
3. 接收设备打开同一网址即可看到新链接；点标题在新标签页打开，点“删除”移除。
4. 搜索框同时匹配标题和网址。

> 微信 App 内置的“…”菜单不是 iOS 系统分享菜单。在微信里打开公众号文章后，先选“复制链接”再粘贴到网页，或选“在默认浏览器中打开”，再从 Safari 的分享菜单调用快捷指令。

## 部署

需要 Node.js 20+ 和一个 Cloudflare 账户（免费计划即可）。

```sh
npm install
npx wrangler login

# 1. 创建 D1 数据库，把输出的 database_id 填入 wrangler.jsonc
npx wrangler d1 create linkdock --location apac

# 2. 建表
npm run db:migrate:remote

# 3. 部署 Worker（此时尚未设置密钥，接口会返回“服务尚未完成配置”）
npx wrangler deploy

# 4. 设置三个密钥（按提示输入，不会写入仓库）
npx wrangler secret put APP_PASSWORD     # 网页登录密码，至少 8 个字符
npx wrangler secret put UPLOAD_KEY       # 快捷指令上传密钥，至少 24 个字符，不能与密码相同
npx wrangler secret put SESSION_SECRET   # 会话签名密钥，至少 24 个随机字符
```

生成随机密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

之后更新代码只需 `npm run deploy`（先应用数据库迁移，再部署）。链接保存在 D1 中，重新部署或重启不会丢失。

### 更换密码或密钥

- 更换 `APP_PASSWORD` 或 `SESSION_SECRET`：所有设备需要重新登录。
- 更换 `UPLOAD_KEY`：需要同时更新 iOS 快捷指令里的密钥，旧密钥立即失效。

### 免费额度

默认使用 `workers.dev` 子域与免费计划。每个打开的页面约每 5 秒请求一次（页面在后台时暂停）；未变化时返回 304，只读取一行数据。个人使用远低于免费额度。不会自动开通付费方案。

## 本地开发

```sh
cp .dev.vars.example .dev.vars    # 填入本地开发用的密码与密钥
npm run db:migrate:local
npm run dev                       # http://localhost:8787
```

## 测试

```sh
npm test            # 接口测试：在 Workers 运行时中运行，使用独立的测试 D1 与可控的外部测试网页
npm run typecheck
npm run test:e2e    # 端到端测试：启动本地 wrangler dev，用两个浏览器会话模拟发送与接收设备
```

端到端测试默认使用本机安装的 Google Chrome（`PLAYWRIGHT_CHANNEL` 可改为其他 Playwright 浏览器通道）。

测试覆盖：权限边界（匿名、错误密码、上传密钥只能提交、跨站请求）、提交与去重（包括并发提交、微信文章身份）、预览（成功、超时、错误、重定向、内网地址、超大页面、标记转义、预览前删除）、搜索、删除同步、网络中断恢复、手机布局以及重启后数据仍在。自动化测试不能代替真机验证 iOS 分享菜单，见 [docs/acceptance.md](docs/acceptance.md)。

## HTTP 接口

所有接口返回 JSON；错误体为 `{ "error": "代码", "message": "可直接展示的中文说明" }`。

| 操作 | 请求 | 权限 | 结果 |
| --- | --- | --- | --- |
| 登录 | `POST /api/session` `{ "password": "…" }` | 无 | `204` 并设置会话 Cookie；`401` 密码错误；`429` 尝试过多（15 分钟内 10 次） |
| 查询登录状态 | `GET /api/session` | 会话 | `200`；`401` |
| 退出 | `DELETE /api/session` | 无 | `204` 并清除 Cookie |
| 读取 / 搜索 | `GET /api/links?q=词&limit=100` | 会话 | `200 { version, links, hasMore }`；支持 `If-None-Match` 返回 `304` |
| 提交 | `POST /api/links` `{ "url": "https://…" }` | 会话或 `Authorization: Bearer <上传密钥>` | `201` 新建；`200` 已存在并移到顶部；`400` 链接无效；`401` 密钥无效 |
| 删除 | `DELETE /api/links/<id>` | 会话 | `204`；`404` |

使用上传密钥访问读取或删除接口返回 `403`。上传密钥只能放在 `Authorization` 请求头中，不接受 URL 参数。提交成功的响应只会在条目已写入 D1 之后返回。

## 实现要点

- `src/index.ts`：路由、鉴权检查、错误处理、安全响应头（CSP 等）。
- `src/auth.ts`：密码与密钥的定长比较、HMAC 签名的无状态会话 Cookie（`__Host-`、`HttpOnly`、`Secure`、`SameSite=Strict`）、同源校验、登录限速。
- `src/url.ts`：链接校验与去重身份。通用链接只去掉 `utm_*` 跟踪参数和空片段；微信文章按 `/s/<标识>` 或 `__biz + mid + idx + sn` 归并，短链与长链之间不归并。
- `src/preview.ts`：8 秒总时限、1 MiB 读取上限、手动跟随最多 5 次重定向且每一跳只允许公网地址；不携带 Cookie 或凭证；标题按纯文本保存。
- `src/links.ts`：D1 读写。去重身份有唯一约束，并发提交也只产生一个条目；预览结果只更新仍存在的条目，删除后迟到的预览不会重新创建条目；失败结果不会覆盖有效预览。
- `public/`：无构建步骤的静态网页（原生 JavaScript），所有外部内容通过 `textContent` 渲染。
