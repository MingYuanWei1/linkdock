# LinkDock 相似项目调研

调研日期：2026-09-26。依据 GitHub 仓库 README、官方文档和部署配置；没有部署候选项目，也没有验证微信公众号文章的实际抓取效果。功能未见于文档不等于一定不存在。

| 项目 | 已核实能力 | 与本项目的差异 |
| --- | --- | --- |
| [linkding](https://github.com/sissbruecker/linkding) | 简洁的自托管书签管理器，自动标题、描述、图标，REST API、PWA；官方与社区文档提供 iOS 分享方案 | Django 应用，官方以 Docker/服务器部署为主；不能原样按 Pages 项目部署。自动更新、微信去重与上传权限需要进一步核实 |
| [Linkwarden](https://github.com/linkwarden/linkwarden) | 完整书签管理、检索、网页归档；官方 iOS 分享快捷指令使用实例地址与访问令牌 | 官方 Compose 包含应用、PostgreSQL 与 Meilisearch；超出轻量链接列表所需，不能原样直接放入 Pages |
| [Cloudmark](https://github.com/wesleyel/cloudmark) | Workers + D1；跨设备紧凑列表、过滤排序、书签脚本、中文界面 | 知道集合 mark 即可读取；写令牌可增改删。不同于统一密码保护读取与只允许上传的密钥；文档未见现成 iOS 快捷指令，部署目标为 Workers |
| [CloudNav](https://github.com/janver/CloudNav) | Pages + KV，访问密码、多设备同步、书签管理 | 偏分类导航站与浏览器扩展；文档未见 iOS 分享快捷指令，仍需验证接收列表流程 |
| [SmartTools](https://github.com/yumumao/SmartTools) | Pages + KV，可视化管理、卡片与图标、管理员登录 | 默认数据读取端点公开，隐私采用另外的加密分类机制；偏导航/工具集，不符合私有列表的默认访问模型 |

## 关键来源

- [linkding iOS 指南](https://github.com/sissbruecker/linkding/blob/master/docs/src/content/docs/how-to.md)：内置示例在分享后打开网页表单，还需保存，不能视为纯后台一键上传。
- [linkding 社区方案](https://github.com/sissbruecker/linkding/blob/master/docs/src/content/docs/community.md)：列出 API 快捷指令和多个 iOS 客户端。
- [Linkwarden iOS 快捷指令](https://github.com/linkwarden/docs/blob/main/docs/getting-started/apple-shortcut.md)：官方分享入口和实例地址、访问令牌配置。
- [Linkwarden Compose](https://github.com/linkwarden/linkwarden/blob/main/docker-compose.yml)：部署依赖。

## 判断

如果可以接受服务器或 Docker，优先试用 linkding，有机会直接满足核心需求并避免自建维护。

如果 Cloudflare Pages 是硬约束，当前查到的候选没有一个经文档确认即可原样满足全部约定。Cloudmark 可参考紧凑列表与收集流程；CloudNav 可参考 Pages 部署；实际 fork 前仍应核对源码、许可证和改造范围。实现一个小型 LinkDock 仍是可选方案，但本次调研不足以证明它一定比修改现有项目成本更低。

微信公众号预览成功率尚未验证；不把一般网页元数据支持视为微信兼容性的证明。
