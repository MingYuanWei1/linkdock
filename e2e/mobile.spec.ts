import { expect, test } from "@playwright/test";
import { clearAllLinks, completePreview, itemFor, signIn, submitFromPage, uniqueUrl } from "./utils";

test.beforeEach(async () => {
  await clearAllLinks();
});

test("手机布局：登录、提交、查看、删除都可用，且没有横向滚动", async ({ page }) => {
  await signIn(page);
  const url = uniqueUrl("mobile") + "&" + "long-parameter=".repeat(12);
  await submitFromPage(page, url);
  await expect(page.locator("#submit-message")).toHaveText("已保存");
  await expect(itemFor(page, url)).toHaveCount(1);

  completePreview(url, "一个非常非常长的中文文章标题，用来检查手机上的换行与截断是否正常显示，不会撑破页面布局", null);
  const item = page.locator("#links > li").first();
  await expect(item.locator("a.title")).toContainText("一个非常非常长的中文文章标题");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // 在阅读视图中打开并返回。
  await item.locator("a.title").click();
  const back = page.getByRole("button", { name: "‹ 返回" });
  await expect(back).toBeVisible();
  const backBox = await back.boundingBox();
  expect(backBox!.y).toBeGreaterThanOrEqual(0);
  expect(backBox!.height).toBeGreaterThanOrEqual(40);
  await back.click();
  await expect(page.locator("#viewer")).toBeHidden();

  const del = item.getByRole("button", { name: /删除/ });
  const copy = item.getByRole("button", { name: /复制链接/ });
  const box = await del.boundingBox();
  const copyBox = await copy.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(copyBox!.x + copyBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // 手机上复制在上、删除在下，标题保留足够宽度。
  expect(copyBox!.y).toBeLessThan(box!.y);
  const titleBox = await item.locator("a.title").boundingBox();
  expect(titleBox!.width).toBeGreaterThan(page.viewportSize()!.width * 0.5);

  page.once("dialog", (dialog) => dialog.accept());
  await del.click();
  await expect(page.locator("#links > li")).toHaveCount(0);
  await expect(page.getByText("还没有保存的链接", { exact: false })).toBeVisible();
});
