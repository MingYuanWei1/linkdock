# LinkDock（链接坞）：个人跨设备链接收集工具

状态：规格草稿，产品范围已确认；测试边界待确认。目标 issue tracker 未配置，尚未发布。发布时应用 ready-for-agent 标签。

## Problem Statement

用户希望将 iOS 设备上的公开文章链接发送到另一台设备，尤其是微信公众号文章。现有传输方式依赖 AirDrop 或微信，不能满足通过独立网页跨设备保存、查找和打开链接的需求。

用户需要一个只有本人可访问的私有列表，长期保存链接，通过简短的链接预览识别文章，并且不需要另购或持续维护服务器。

## Solution

自行构建 LinkDock（链接坞），采用 Cloudflare Workers + D1 部署到公网。中文网页适配手机与电脑；用户使用统一密码登录，多个设备共享同一私有列表。

发送设备既可以在网页粘贴链接，也可以从 iOS 系统分享菜单调用快捷指令。快捷指令首次配置站点地址和独立上传密钥，后续分享即可提交。接收设备打开网页查看列表，页面打开期间自动更新。

链接先持久化，再尝试获取标题和网站图标。预览失败只显示原链接，不影响保存和打开。链接长期保存，支持搜索和手动删除；重复提交保留同一条目并移到顶部。

## User Stories

1. As an owner, I want a publicly reachable website, so that I can use my private list across different networks.
2. As an owner, I want to use LinkDock without AirDrop or WeChat transfer, so that sending links is independent of those services.
3. As an owner, I want one private list across my devices, so that all saved links are available in one place.
4. As an owner, I want to sign in with one password, so that I do not need a multi-user registration workflow.
5. As an owner, I want my browser to remember my signed-in session, so that I do not enter the password on every visit.
6. As an owner, I want unauthenticated visitors to be unable to read or modify my private list, so that my saved articles remain private.
7. As a sending-device user, I want to paste a link into the webpage, so that I can save it without installing an app.
8. As an iOS sending-device user, I want to submit a link through the system share sheet, so that I can save the article I am viewing.
9. As an iOS sending-device user, I want to configure the shortcut once, so that later submissions require minimal interaction.
10. As an owner, I want the shortcut to use a separate upload key, so that it does not need my website password.
11. As an owner, I want the upload key to permit submissions only, so that it cannot read or delete my saved links.
12. As a sending-device user, I want a successful submission to mean the link was stored, so that I can trust the confirmation.
13. As a sending-device user, I want clear failure feedback, so that I know when a link has not been saved.
14. As a sending-device user, I want invalid link input to be rejected, so that unusable entries do not enter my list.
15. As a sending-device user, I want public WeChat article links to be accepted, so that I can collect the articles I commonly read.
16. As a sending-device user, I want saving to finish without waiting for a preview, so that metadata fetching does not slow down submission.
17. As a receiving-device user, I want to see saved links as a list, so that I can scan them quickly.
18. As a receiving-device user, I want titles and website icons when available, so that I can recognize articles.
19. As a receiving-device user, I want available previews to show the domain and save time, so that I can identify the source and recency.
20. As a receiving-device user, I want the original link to remain visible when preview retrieval fails, so that the saved entry remains useful.
21. As a receiving-device user, I want to open the saved article from the list, so that I can continue reading on another device.
22. As a receiving-device user, I want the open page to update automatically, so that new submissions appear without manual reloads.
23. As a receiving-device user, I want the most recently submitted links first, so that I can find what I just sent.
24. As a sending-device user, I want a repeat submission to move the existing article to the top, so that I can resend it without creating clutter.
25. As an owner, I want links to remain until I delete them, so that I can return to older articles.
26. As a receiving-device user, I want to search titles and URLs, so that I can find previously saved links.
27. As an owner, I want to delete individual links, so that I can remove entries I no longer need.
28. As an owner, I want deletion to be reflected on my other open devices, so that the list remains consistent.
29. As an owner, I want a usable Chinese interface on mobile and desktop, so that any of my devices can send and receive links.
30. As an owner, I want empty lists, empty search results, and loading or network failures to be distinguishable, so that I understand the current state.
31. As an owner, I want my links to survive application updates and restarts, so that deployment does not erase my collection.
32. As an owner, I want deployment and shortcut setup instructions, so that I can configure and use my own instance.
33. As an owner, I want the application to use managed hosting and storage, so that I do not need an additional server.

## Implementation Decisions

- 已确认采用自行开发的精简应用；现有项目仅作为产品与交互参考。未选择复制或 fork 某个项目。
- 使用一个 Cloudflare Worker 托管静态网页和 HTTP 接口；D1 保存链接。通过 Cloudflare MCP 发布到用户账户，优先使用免费额度，不自动开通付费方案。
- 单用户、单私有列表。职责包括会话验证、链接提交与管理、链接预览获取、网页展示及 iOS 快捷指令集成；这些职责不要求拆成独立服务。
- 网页密码与上传密钥分离。登录会话允许查看、搜索、提交、删除；上传密钥只允许提交。服务端对每个受保护操作执行权限验证，不能仅隐藏网页内容。
- 密码、密钥不进入公开前端资源、源码仓库或 URL 查询参数；会话使用安全 Cookie。具体密码派生、会话有效期及密钥配置细节在实现时确定，不新增账户系统。
- HTTP 合约按操作定义：建立会话、读取或搜索列表、提交链接、删除指定条目。写入失败不得返回保存成功，未授权请求不得泄漏私有列表。具体路由名与状态码由实现统一定义。
- 条目至少持久化原链接、去重身份、可选标题与图标、首次保存时间和最近提交时间。列表按最近提交时间倒序，重复提交更新最近提交时间，不覆盖已有的有效预览为失败状态。
- 重复提交需通过持久化约束保持唯一性，避免同时提交产生两条记录。相同链接必须去重；微信文章在能验证稳定文章身份时归并，不盲目删除全部查询参数或合并无法确认相同的链接。
- 仅接受 HTTP/HTTPS 网页链接。主要验收对象为无需登录的微信公众号文章；不声称所有微信链接形式都能被预览或识别为同一篇文章。
- 保存成功与预览成功分离：先写入条目再尝试获取元数据。已删除条目的迟到预览结果不得重新创建条目。
- 元数据请求有时限与响应大小上限，校验目标及跳转；不向目标网站发送登录 Cookie 或上传密钥。文章标题按文本显示。
- 预览获取失败时仅显示原链接，保留打开和删除操作；不自动生成摘要，不改成默认域名卡片，不增加手动标题编辑功能。成功预览的图标加载失败不应影响标题或链接使用。
- 页面打开期间自动拉取变化，恢复网络或回到页面时重新同步。验收需观察到新提交、预览补全及删除传播；具体轮询间隔属于实现配置，不承诺瞬时同步。
- iOS 快捷指令仅接收系统分享菜单的链接输入，不默认读取剪贴板。使用上传密钥通过 HTTPS 提交并显示保存结果。无有效输入、网络失败及密钥失效均提供可理解反馈。
- 中文界面支持手机与桌面；提供链接输入、搜索、列表与删除操作，以及加载、空列表、无搜索结果、错误状态。

## Testing Decisions

- 以下测试边界为提案，等待用户确认。当前项目只有需求文档，没有现成代码、测试框架或可沿用的测试先例。
- 以整个已运行应用的外部边界为主要测试入口：两个独立浏览器会话模拟发送设备和接收设备；快捷指令提交由相同的公开 HTTP 接口驱动。内部模块、数据库助手和函数调用顺序不作为验收目标。
- 测试使用与部署运行环境相符的 Workers 运行时和独立测试 D1。网页预览依赖使用可控的外部 HTTP 测试页面，提供成功、超时、错误、跳转等结果；保留真实鉴权、持久化和页面同步流程。
- 核心场景：发送设备提交后收到成功反馈，接收设备无需重载即可看到唯一条目；刷新和重新启动应用后条目仍然存在。
- 权限场景：匿名请求和错误密码不能访问列表；有效上传密钥可提交，但不能读取、搜索或删除；有效网页登录会话可完成全部授权操作。
- 重复提交场景：同一链接再次或并发提交，仅保留一个条目并移到顶部；不同文章不能误合并；微信稳定身份规则使用有证据的 URL 样本验证。
- 预览场景：正常标题与图标显示；慢响应不阻塞保存；失败只显示原链接；元数据中的标记不能执行为网页脚本；预览完成前删除条目后，不得重新出现。
- 列表场景：标题与 URL 搜索、无结果、删除、跨设备同步、网络失败后恢复，以及手机和桌面布局的关键操作。
- 实机验收另行覆盖真实 iOS 分享菜单、快捷指令初次配置及公开微信文章提交；记录实际抓取结果。自动化 HTTP 测试通过不等于真实 iOS 分享路径已验证。
- 好的测试断言用户能观察到的结果与权限边界，能够发现丢失链接、重复记录、未授权读取或同步失败；避免复制实现逻辑或为每个内部函数建立测试。

## Out of Scope

- 多用户注册、团队共享、公开列表、邮箱登录、SSO。
- AirDrop、微信消息传输、剪贴板自动上传、原生 iOS App。
- 标签、文件夹、已读状态、手动修改标题、AI 摘要、全文检索。
- 全文归档、网页截图、PDF 生成、离线阅读、附件上传、公众号订阅抓取。
- 需要登录的网页内容抓取、绕过访问验证、保证所有微信文章预览成功。
- 页面关闭后的系统推送、定时自动删除、自动付费扩容。
- 用 Pages 部署、购买新服务器、迁移现有书签库。

## Further Notes

- 项目名称为 LinkDock（链接坞），正式目录为 ~/Desktop/project/linkdock/。
- 交付包括源码、线上地址、使用说明、快捷指令安装或配置材料。是否能提供直接安装的签名快捷指令需在开发时验证，不能把配置文档称为已测试的可安装产物。
- 微信 App 自身的内部分享菜单不等同于 iOS 系统分享菜单；实机验收需记录可实际触发快捷指令的入口。
- 本规格没有现成原型代码或 ADR 可引用；自行开发与 Workers + D1 的选择来自已确认的对话。
- 尚无关联 Git 仓库、项目 issue tracker 或已验证的标签配置。按 to-spec 要求先运行 /setup-matt-pocock-skills 配置，再发布本规格并应用 ready-for-agent；本地草稿不等同于已创建 issue。
