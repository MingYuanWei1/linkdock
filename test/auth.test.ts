import { describe, expect, it } from "vitest";
import {
  call,
  cookieFrom,
  deleteRequest,
  list,
  listRequest,
  login,
  ORIGIN,
  submitWithKey,
  submitWithSession,
  UPLOAD_KEY,
} from "./helpers";

const ARTICLE = "https://site.example/no-icon";

describe("匿名访问", () => {
  it("不能读取、搜索、提交或删除", async () => {
    const owner = await login();
    const saved = (await (await submitWithSession(owner, ARTICLE)).json()) as { link: { id: string } };

    const anonymousList = await call("/api/links");
    expect(anonymousList.status).toBe(401);
    expect(await anonymousList.text()).not.toContain("site.example");

    expect((await call("/api/links?q=site")).status).toBe(401);

    const anonymousSubmit = await call("/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ url: "https://site.example/article" }),
    });
    expect(anonymousSubmit.status).toBe(401);

    const anonymousDelete = await call(`/api/links/${saved.link.id}`, {
      method: "DELETE",
      headers: { Origin: ORIGIN },
    });
    expect(anonymousDelete.status).toBe(401);

    expect((await list(owner)).links.map((l) => l.url)).toEqual([ARTICLE]);
  });

  it("伪造或篡改的会话 Cookie 无效", async () => {
    const cookie = await login();
    const [name, value] = cookie.split("=");
    const tampered = `${name}=${value.replace(/^v1\.\d+/, "v1.99999999999999")}`;
    expect((await listRequest(tampered)).status).toBe(401);
    expect((await listRequest(`${name}=v1.9999999999999.AAAA`)).status).toBe(401);
    expect((await listRequest(`${name}=garbage`)).status).toBe(401);
  });

  it("静态网页本身不包含私有数据或密钥", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("LinkDock");
    expect(html).not.toContain(UPLOAD_KEY);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });
});

describe("网页登录", () => {
  it("错误密码被拒绝且不设置会话", async () => {
    const res = await call("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ password: "wrong password" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(((await res.json()) as { message: string }).message).toBe("密码错误");
  });

  it("上传密钥不能用作网页密码", async () => {
    const res = await call("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ password: UPLOAD_KEY }),
    });
    expect(res.status).toBe(401);
  });

  it("正确密码建立安全会话 Cookie，会话可完成全部操作", async () => {
    const res = await call("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ password: "correct horse battery" }),
    });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^__Host-linkdock_session=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toMatch(/Max-Age=\d{6,}/);

    const cookie = cookieFrom(res);
    expect((await call("/api/session", { headers: { Cookie: cookie } })).status).toBe(200);

    const submitted = await submitWithSession(cookie, ARTICLE);
    expect(submitted.status).toBe(201);
    const { link } = (await submitted.json()) as { link: { id: string } };
    expect((await list(cookie)).links).toHaveLength(1);
    expect((await list(cookie, "no-icon")).links).toHaveLength(1);
    expect((await deleteRequest(cookie, link.id)).status).toBe(204);
    expect((await list(cookie)).links).toHaveLength(0);
  });

  it("退出登录清除 Cookie", async () => {
    const cookie = await login();
    const res = await call("/api/session", {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
  });

  it("连续输错密码后暂时锁定，正确密码也不能绕过", async () => {
    const attempt = (password: string) =>
      call("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9" },
        body: JSON.stringify({ password }),
      });
    for (let i = 0; i < 10; i++) expect((await attempt("nope nope")).status).toBe(401);
    expect((await attempt("nope nope")).status).toBe(429);
    expect((await attempt("correct horse battery")).status).toBe(429);
  });
});

describe("上传密钥", () => {
  it("可以提交链接，并返回可展示的保存结果", async () => {
    const res = await submitWithKey(ARTICLE);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean; message: string };
    expect(body.created).toBe(true);
    expect(body.message).toContain("已保存");

    const owner = await login();
    expect((await list(owner)).links.map((l) => l.url)).toEqual([ARTICLE]);
  });

  it("不能读取、搜索或删除", async () => {
    const res = await submitWithKey(ARTICLE);
    const { link } = (await res.json()) as { link: { id: string } };
    const auth = { Authorization: `Bearer ${UPLOAD_KEY}` };

    const read = await call("/api/links", { headers: auth });
    expect(read.status).toBe(403);
    expect(await read.text()).not.toContain("site.example");
    expect((await call("/api/links?q=site", { headers: auth })).status).toBe(403);
    expect((await call(`/api/links/${link.id}`, { method: "DELETE", headers: auth })).status).toBe(403);
    expect((await call("/api/session", { headers: auth })).status).toBe(401);

    const owner = await login();
    expect((await list(owner)).links).toHaveLength(1);
  });

  it("无效或失效的上传密钥给出明确错误且不保存", async () => {
    const res = await submitWithKey(ARTICLE, "upload-key-that-was-rotated-away");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toContain("上传密钥无效");

    // 即使同时带着有效会话，错误的上传密钥也不会被放行。
    const owner = await login();
    const mixed = await call("/api/links", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong",
        Cookie: owner,
        Origin: ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: ARTICLE }),
    });
    expect(mixed.status).toBe(401);
    expect((await list(owner)).links).toHaveLength(0);
  });

  it("不接受 URL 查询参数中的密钥", async () => {
    const res = await call(`/api/links?key=${UPLOAD_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: ARTICLE }),
    });
    expect(res.status).toBe(401);
  });
});

describe("跨站请求", () => {
  it("携带会话 Cookie 的跨站写请求被拒绝", async () => {
    const cookie = await login();
    const res = await call("/api/links", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: ARTICLE }),
    });
    expect(res.status).toBe(403);

    const form = await call("/api/links", {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: `url=${encodeURIComponent(ARTICLE)}`,
    });
    expect(form.status).toBe(415);
    expect((await list(cookie)).links).toHaveLength(0);
  });
});

describe("快捷指令文件", () => {
  it("可公开下载，是已签名的快捷指令，且不包含任何密钥", async () => {
    const res = await call("/shortcut/LinkDock.shortcut");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("LinkDock.shortcut");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("AEA1");
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw).not.toContain(UPLOAD_KEY);
  });
});
