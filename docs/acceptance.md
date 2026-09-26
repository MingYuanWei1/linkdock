# 验收记录

## 自动化测试（2026-09-26）

| 套件 | 运行环境 | 结果 |
| --- | --- | --- |
| `npm test` 接口测试 | Workers 运行时（vitest-pool-workers）、独立测试 D1、可控外部测试网页 | 67 项通过 |
| `npm run test:e2e` 端到端测试 | 本地 `wrangler dev` + Chrome，两个独立浏览器会话 | 11 项通过 |
| `npm run typecheck` | TypeScript | 通过 |

为确认测试能发现问题，曾临时破坏去重约束、内网地址校验和“失败不覆盖有效预览”规则，相应测试均失败（共 8 项），恢复代码后全部通过。

## 线上冒烟测试（2026-09-26，https://linkdock.mingyuanw.workers.dev）

在设置密钥之前：接口返回 `503 服务尚未完成配置`（缺少密钥时拒绝服务）。

设置密钥之后：

| 检查 | 结果 |
| --- | --- |
| 匿名读取列表 | 401 |
| 上传密钥读取列表 | 403 |
| 错误的上传密钥提交 | 401 `上传密钥无效，请检查快捷指令配置` |
| 错误密码登录 | 401 |
| 正确密码登录后读取 | 200 |
| 页面响应头 | 包含 CSP、HSTS、`X-Frame-Options: DENY` |

### 微信公众号文章实际抓取结果

从 Cloudflare 边缘节点抓取，样本来自搜索引擎收录的公开文章链接：

| 链接 | 预览结果 |
| --- | --- |
| `https://mp.weixin.qq.com/s/gSbICIchAuzKdDfVX1EIwA` | 成功：`官宣！10月20日，第十九届武汉光博会蓄势待发`，图标 `res.wx.qq.com/…/NTI4MWU5.ico` |
| `https://mp.weixin.qq.com/s/lkadgp9kvEuyjecIT7LUGw` | 成功：`不想关注公众号，却又想看他的所有内容？`，同上图标 |
| `https://mp.weixin.qq.com/s?__biz=MzI4OTg2MzUwOQ%3D%3D&idx=1&mid=2247484004&scene=21&sn=8a7e…` | 失败，仅显示原链接。该地址即使用普通浏览器请求也只返回约 2 KB 的空壳页面，没有标题元数据（可能为 2018 年的旧文章或已不可访问） |
| `https://example.com/`（对照） | 成功：`Example Domain` |

去重：同一长链文章分别以 `__biz=…%3D%3D&idx=1&mid=…&scene=21` 与 `__biz=…==&mid=…&idx=1&…&chksm=…&scene=126#rd` 提交，第二次返回“已保存（已移到顶部）”，只保留一个条目。

冒烟测试结束后已删除全部测试条目。

## 尚未验证（需要真机）

- 真实 iOS 系统分享菜单调用快捷指令、快捷指令初次配置、通知显示。
- 从微信 App 经“在默认浏览器中打开”后再分享的完整路径。
- iPhone Safari 上的实际页面效果（自动化测试使用 Chrome 模拟 iPhone 13 视口）。

自动化 HTTP 测试通过不等于真实 iOS 分享路径已验证。
