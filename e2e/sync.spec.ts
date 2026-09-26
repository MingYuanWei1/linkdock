import { expect, test } from "@playwright/test";
import {
  APP_PASSWORD,
  clearAllLinks,
  completePreview,
  itemFor,
  linkItems,
  newSignedInPage,
  submitFromPage,
  submitWithShortcut,
  uniqueUrl,
} from "./utils";

test.beforeEach(async () => {
  await clearAllLinks();
});

test("未登录只能看到登录页；错误密码有提示；登录后浏览器记住会话", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  await expect(page.locator("#app-view")).toBeHidden();

  await page.getByPlaceholder("访问密码").fill("wrong password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("alert")).toHaveText("密码错误");

  await page.getByPlaceholder("访问密码").fill(APP_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("还没有保存的链接", { exact: false })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "登录" })).toBeHidden();
  await expect(page.getByText("还没有保存的链接", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
});

test("发送设备网页提交后，接收设备无需刷新即可看到唯一条目；刷新后仍然存在", async ({ browser }) => {
  const sender = await newSignedInPage(browser);
  const receiver = await newSignedInPage(browser);
  const url = uniqueUrl("web");

  await submitFromPage(sender, url);
  await expect(sender.locator("#submit-message")).toHaveText("已保存");
  await expect(sender.getByPlaceholder("粘贴链接，例如 https://mp.weixin.qq.com/s/…")).toHaveValue("");

  await expect(itemFor(receiver, url)).toHaveCount(1);
  // 预览失败的条目只显示原链接，并且可以打开。
  const anchor = itemFor(receiver, url).locator("a.title");
  await expect(anchor).toHaveText(url);
  await expect(anchor).toHaveAttribute("href", url);
  await expect(anchor).toHaveAttribute("target", "_blank");

  await receiver.reload();
  await expect(itemFor(receiver, url)).toHaveCount(1);
});

test("快捷指令（上传密钥）提交后出现在接收设备；重复提交不产生重复条目并移到顶部", async ({ browser }) => {
  const receiver = await newSignedInPage(browser);
  const first = uniqueUrl("first");
  const second = uniqueUrl("second");

  const saved = await submitWithShortcut(first);
  expect(saved.status).toBe(201);
  expect(saved.body.message).toContain("已保存");
  await submitWithShortcut(second);
  await expect(linkItems(receiver).first()).toContainText(second);

  const again = await submitWithShortcut(first);
  expect(again.status).toBe(200);
  expect(again.body.message).toContain("已移到顶部");
  await expect(linkItems(receiver).first()).toContainText(first);
  await expect(itemFor(receiver, first)).toHaveCount(1);
  await expect(linkItems(receiver)).toHaveCount(2);

  const rejected = await submitWithShortcut(first, "not-the-upload-key-at-all-0000");
  expect(rejected.status).toBe(401);
  expect(rejected.body.message).toContain("上传密钥无效");
});

test("预览补全会同步到已打开的页面；标题中的标记按文本显示；图标加载失败不影响标题", async ({ browser }) => {
  const receiver = await newSignedInPage(browser);
  const url = uniqueUrl("preview");
  await submitWithShortcut(url);
  await expect(itemFor(receiver, url)).toHaveCount(1);

  const title = `<img src=x onerror="window.__xss=1">标题 <b>加粗</b>`;
  completePreview(url, title, "https://icon-host.invalid/broken.png");

  const item = itemFor(receiver, title);
  await expect(item).toHaveCount(1);
  await expect(item.locator("a.title")).toHaveText(title);
  await expect(item.locator("a.title")).toHaveAttribute("href", url);
  await expect(item.locator(".domain")).toHaveText(new URL(url).hostname);
  await expect(item.locator("time")).toContainText("保存于");
  // 图标无法加载时显示首字母占位，标题与链接不受影响。
  await expect(item.locator(".icon.letter")).toHaveText("E");
  expect(await receiver.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(item.locator("b")).toHaveCount(0);
});

test("在一台设备删除后，其他打开的设备同步移除", async ({ browser }) => {
  const a = await newSignedInPage(browser);
  const b = await newSignedInPage(browser);
  const keep = uniqueUrl("keep");
  const drop = uniqueUrl("drop");
  await submitWithShortcut(keep);
  await submitWithShortcut(drop);
  await expect(linkItems(a)).toHaveCount(2);
  await expect(linkItems(b)).toHaveCount(2);

  a.once("dialog", (dialog) => dialog.accept());
  await itemFor(a, drop).getByRole("button", { name: /删除/ }).click();
  await expect(itemFor(a, drop)).toHaveCount(0);
  await expect(itemFor(b, drop)).toHaveCount(0);
  await expect(itemFor(b, keep)).toHaveCount(1);
});

test("取消删除确认时条目保留", async ({ browser }) => {
  const page = await newSignedInPage(browser);
  const url = uniqueUrl("cancel");
  await submitWithShortcut(url);
  await expect(itemFor(page, url)).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.dismiss());
  await itemFor(page, url).getByRole("button", { name: /删除/ }).click();
  await page.waitForTimeout(500);
  await expect(itemFor(page, url)).toHaveCount(1);
});

test("按标题和网址搜索；无结果与空列表提示不同", async ({ browser }) => {
  const page = await newSignedInPage(browser);
  await expect(page.getByText("还没有保存的链接", { exact: false })).toBeVisible();

  const alpha = uniqueUrl("alpha");
  const beta = uniqueUrl("beta");
  await submitWithShortcut(alpha);
  await submitWithShortcut(beta);
  completePreview(beta, "关于水豚的长文", null);
  await expect(linkItems(page)).toHaveCount(2);

  const search = page.getByPlaceholder("搜索标题或网址");
  await search.fill("e2e-alpha");
  await expect(linkItems(page)).toHaveCount(1);
  await expect(linkItems(page).first()).toContainText(alpha);

  await search.fill("水豚");
  await expect(linkItems(page)).toHaveCount(1);
  await expect(linkItems(page).first()).toContainText("关于水豚的长文");

  await search.fill("完全不存在的词");
  await expect(page.getByText("没有找到与“完全不存在的词”匹配的链接")).toBeVisible();
  await expect(linkItems(page)).toHaveCount(0);

  await search.fill("");
  await expect(linkItems(page)).toHaveCount(2);
});

test("无效输入被拒绝并提示，列表不变", async ({ browser }) => {
  const page = await newSignedInPage(browser);
  await submitFromPage(page, "javascript:alert(1)");
  await expect(page.locator("#submit-message")).toHaveText("未保存：只支持 http 或 https 网页链接");
  await submitFromPage(page, "就是一段文字");
  await expect(page.locator("#submit-message")).toContainText("未保存");
  await expect(page.getByText("还没有保存的链接", { exact: false })).toBeVisible();
});

test("网络中断时显示错误状态，恢复后自动重新同步", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.getByPlaceholder("访问密码").fill(APP_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator("#sync")).toHaveText("已同步");

  await context.setOffline(true);
  // 离线时提交会明确提示未保存。
  await submitFromPage(page, uniqueUrl("offline"));
  await expect(page.locator("#submit-message")).toHaveText("未保存：网络连接失败");
  await expect(page.locator("#list-error")).toContainText("网络连接失败");

  const url = uniqueUrl("recovered");
  await submitWithShortcut(url);
  await context.setOffline(false);
  await expect(page.locator("#list-error")).toBeHidden();
  await expect(itemFor(page, url)).toHaveCount(1);
  await expect(page.locator("#sync")).toHaveText("已同步");
});

test("点击链接在站内阅读视图中打开；返回按钮、浏览器返回和刷新都行为正确", async ({ browser }) => {
  const page = await newSignedInPage(browser);
  const url = uniqueUrl("reader");
  await submitWithShortcut(url);
  await expect(itemFor(page, url)).toHaveCount(1);

  const viewer = page.locator("#viewer");
  const frame = page.frameLocator("#viewer iframe");

  await itemFor(page, url).locator("a.title").click();
  await expect(viewer).toBeVisible();
  await expect(page).toHaveURL(/#read\//);
  await expect(page.getByRole("button", { name: "‹ 返回" })).toBeVisible();
  await expect(page.locator("#viewer-open")).toHaveAttribute("href", url);
  // .invalid 域名无法访问：阅读页显示说明和打开原网页。
  await expect(frame.getByRole("heading", { name: "无法在此显示这篇文章" })).toBeVisible();
  await expect(frame.getByRole("link", { name: "打开原网页" })).toHaveAttribute("href", url);
  await expect(page.locator("#viewer-loading")).toBeHidden();
  await expect(page.locator("#viewer iframe")).toHaveCount(1);

  // 返回按钮回到列表，地址恢复。
  await page.getByRole("button", { name: "‹ 返回" }).click();
  await expect(viewer).toBeHidden();
  await expect(page).not.toHaveURL(/#read\//);
  await expect(itemFor(page, url)).toBeVisible();

  // 浏览器返回（iPhone 返回手势）同样关闭阅读视图。
  await itemFor(page, url).locator("a.title").click();
  await expect(viewer).toBeVisible();
  await page.goBack();
  await expect(viewer).toBeHidden();
  await expect(page.locator("#viewer iframe")).toHaveCount(0);
  // 多次打开后，返回仍然直接回到列表（不会在 iframe 历史中后退）。
  for (let i = 0; i < 2; i++) {
    await itemFor(page, url).locator("a.title").click();
    await expect(frame.getByRole("heading", { name: "无法在此显示这篇文章" })).toBeVisible();
    await page.getByRole("button", { name: "‹ 返回" }).click();
    await expect(viewer).toBeHidden();
  }
  await itemFor(page, url).locator("a.title").click();
  await expect(viewer).toBeVisible();
  await page.goBack();
  await expect(viewer).toBeHidden();

  // 前进会重新打开；在阅读视图中刷新后仍停留在该文章。
  await page.goForward();
  await expect(viewer).toBeVisible();
  await page.reload();
  await expect(viewer).toBeVisible();
  await expect(page.locator("#viewer-open")).toHaveAttribute("href", url);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
});

test("阅读视图需要登录：退出后无法直接访问阅读页", async ({ browser }) => {
  const page = await newSignedInPage(browser);
  const url = uniqueUrl("reader-auth");
  const { body } = await submitWithShortcut(url);
  const anonymous = await browser.newContext();
  const res = await anonymous.request.get(`/read/${body.link.id}`);
  expect(res.status()).toBe(401);
  await anonymous.close();
  await page.close();
});
