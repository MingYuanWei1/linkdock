import { exports } from "cloudflare:workers";
import { vi } from "vitest";
import { TEST_SECRETS } from "./secrets";

export const ORIGIN = "https://linkdock.test";
export const { APP_PASSWORD, UPLOAD_KEY } = TEST_SECRETS;

export interface LinkView {
  id: string;
  url: string;
  title: string | null;
  iconUrl: string | null;
  previewStatus: "pending" | "ok" | "failed";
  firstSavedAt: number;
  lastSubmittedAt: number;
}

export interface ListBody {
  version: number;
  links: LinkView[];
  hasMore: boolean;
}

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(ORIGIN + path, init));
}

// 模拟浏览器页面发出的同源请求。
function pageHeaders(cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

export async function login(password = APP_PASSWORD): Promise<string> {
  const res = await call("/api/session", {
    method: "POST",
    headers: pageHeaders(undefined, { "Content-Type": "application/json" }),
    body: JSON.stringify({ password }),
  });
  if (res.status !== 204) throw new Error(`登录失败：${res.status}`);
  return cookieFrom(res);
}

export function cookieFrom(res: Response): string {
  const header = res.headers.get("Set-Cookie");
  if (!header) throw new Error("响应没有 Set-Cookie");
  return header.split(";")[0];
}

export function submitWithSession(cookie: string, url: unknown): Promise<Response> {
  return call("/api/links", {
    method: "POST",
    headers: pageHeaders(cookie, { "Content-Type": "application/json" }),
    body: JSON.stringify({ url }),
  });
}

// 模拟 iOS 快捷指令：只带上传密钥，没有 Cookie、Origin 等浏览器请求头。
export function submitWithKey(url: unknown, key = UPLOAD_KEY): Promise<Response> {
  return call("/api/links", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function listRequest(cookie: string, query = "", init: RequestInit = {}): Promise<Response> {
  const qs = query ? `?q=${encodeURIComponent(query)}` : "";
  return call(`/api/links${qs}`, { ...init, headers: { ...pageHeaders(cookie), ...(init.headers ?? {}) } });
}

export async function list(cookie: string, query = ""): Promise<ListBody> {
  const res = await listRequest(cookie, query);
  if (res.status !== 200) throw new Error(`读取列表失败：${res.status}`);
  return res.json();
}

export function deleteRequest(cookie: string, id: string): Promise<Response> {
  return call(`/api/links/${id}`, { method: "DELETE", headers: pageHeaders(cookie) });
}

export async function waitForPreview(cookie: string, id: string): Promise<LinkView> {
  return vi.waitFor(
    async () => {
      const { links } = await list(cookie);
      const link = links.find((l) => l.id === id);
      if (!link) throw new Error("条目不存在");
      if (link.previewStatus === "pending") throw new Error("预览尚未完成");
      return link;
    },
    { timeout: 8_000, interval: 50 },
  );
}

export async function outboundRequests(): Promise<
  { url: string; method: string; headers: Record<string, string> }[]
> {
  return (await fetch("https://fixture.control/requests")).json();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
