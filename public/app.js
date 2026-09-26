// LinkDock 网页端：登录、提交、搜索、删除，以及页面打开期间的自动同步。

const POLL_INTERVAL_MS = 5000;
const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 250;

const $ = (id) => document.getElementById(id);

const els = {
  boot: $("boot"),
  loginView: $("login-view"),
  loginForm: $("login-form"),
  password: $("password"),
  loginMessage: $("login-message"),
  appView: $("app-view"),
  logout: $("logout"),
  submitForm: $("submit-form"),
  url: $("url"),
  submitMessage: $("submit-message"),
  search: $("search"),
  sync: $("sync"),
  listError: $("list-error"),
  listErrorText: $("list-error-text"),
  retry: $("retry"),
  listState: $("list-state"),
  list: $("links"),
  more: $("more"),
  viewer: $("viewer"),
  viewerBack: $("viewer-back"),
  viewerTitle: $("viewer-title"),
  viewerOpen: $("viewer-open"),
  viewerRefresh: $("viewer-refresh"),
  viewerLoading: $("viewer-loading"),
  viewerBody: $("viewer-body"),
  oneNote: $("onenote"),
  oneNoteText: $("onenote-text"),
  oneNoteConnect: $("onenote-connect"),
  oneNoteDisconnect: $("onenote-disconnect"),
};

const state = {
  signedIn: false,
  query: "",
  limit: PAGE_SIZE,
  etag: null,
  links: [],
  hasMore: false,
  loaded: false,
  loading: false,
  error: null,
  requestSeq: 0,
  timer: null,
};

// ---------- 网络 ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  } catch {
    throw new ApiError(0, "网络连接失败");
  }
  if (res.ok || res.status === 304) return res;
  let message = `请求失败（${res.status}）`;
  try {
    const body = await res.json();
    if (body && typeof body.message === "string") message = body.message;
  } catch {
    // 非 JSON 错误体
  }
  throw new ApiError(res.status, message);
}

function jsonRequest(method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------- 视图切换 ----------

function showLogin(message = "") {
  state.signedIn = false;
  stopPolling();
  closeViewer();
  els.boot.hidden = true;
  els.appView.hidden = true;
  els.logout.hidden = true;
  els.loginView.hidden = false;
  els.loginMessage.textContent = message;
  els.password.value = "";
  els.password.focus();
}

function showApp() {
  state.signedIn = true;
  els.boot.hidden = true;
  els.loginView.hidden = true;
  els.appView.hidden = false;
  els.logout.hidden = false;
  resetList();
  refresh();
  restoreViewerFromUrl();
  loadOneNote();
}

function resetList() {
  state.etag = null;
  state.links = [];
  state.hasMore = false;
  state.loaded = false;
  state.error = null;
  state.limit = PAGE_SIZE;
  els.list.replaceChildren();
  render();
}

async function boot() {
  try {
    await api("/api/session");
    showApp();
  } catch (err) {
    if (err.status === 401) return showLogin();
    els.boot.textContent = `无法连接 LinkDock：${err.message}`;
    els.boot.classList.add("error");
    setTimeout(boot, POLL_INTERVAL_MS);
  }
}

// ---------- 登录与退出 ----------

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = els.password.value;
  if (!password) {
    els.loginMessage.textContent = "请输入密码";
    return;
  }
  const button = els.loginForm.querySelector("button");
  button.disabled = true;
  els.loginMessage.textContent = "";
  try {
    await api("/api/session", jsonRequest("POST", { password }));
    els.password.value = "";
    showApp();
  } catch (err) {
    els.loginMessage.textContent = err.message;
    els.password.select();
  } finally {
    button.disabled = false;
  }
});

els.logout.addEventListener("click", async () => {
  try {
    await api("/api/session", { method: "DELETE" });
  } catch {
    // 即使请求失败也回到登录页；Cookie 会在下一次成功请求时处理。
  }
  showLogin();
});

// ---------- 提交 ----------

els.submitForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = els.url.value.trim();
  if (!url) {
    setSubmitMessage("请先粘贴链接", "error");
    els.url.focus();
    return;
  }
  const button = els.submitForm.querySelector("button");
  button.disabled = true;
  setSubmitMessage("正在保存…", "");
  try {
    const res = await api("/api/links", jsonRequest("POST", { url }));
    const body = await res.json();
    setSubmitMessage(body.created ? "已保存" : "已保存，已移到列表顶部", "success");
    els.url.value = "";
    refresh();
  } catch (err) {
    if (err.status === 401) return showLogin("登录已过期，请重新登录");
    setSubmitMessage(`未保存：${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
});

function setSubmitMessage(text, kind) {
  els.submitMessage.textContent = text;
  els.submitMessage.className = `message ${kind}`;
}

// ---------- 搜索 ----------

let searchTimer = null;
els.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const query = els.search.value.trim();
    if (query === state.query) return;
    state.query = query;
    resetList();
    refresh();
  }, SEARCH_DEBOUNCE_MS);
});

els.more.addEventListener("click", () => {
  state.limit += PAGE_SIZE;
  state.etag = null;
  refresh();
});

els.retry.addEventListener("click", () => refresh());

// ---------- 同步 ----------

function stopPolling() {
  clearTimeout(state.timer);
  state.timer = null;
}

function schedulePoll() {
  stopPolling();
  if (!state.signedIn || document.hidden) return;
  state.timer = setTimeout(refresh, POLL_INTERVAL_MS);
}

async function refresh() {
  if (!state.signedIn) return;
  stopPolling();
  const seq = ++state.requestSeq;
  const params = new URLSearchParams({ limit: String(state.limit) });
  if (state.query) params.set("q", state.query);
  const headers = state.etag ? { "If-None-Match": state.etag } : {};

  state.loading = true;
  render();
  try {
    const res = await api(`/api/links?${params}`, { headers });
    if (seq !== state.requestSeq) return; // 已有更新的请求
    if (res.status === 200) {
      const body = await res.json();
      if (seq !== state.requestSeq) return;
      state.links = body.links;
      state.hasMore = body.hasMore;
      state.etag = res.headers.get("ETag");
      fillViewerDetails();
    }
    state.loaded = true;
    state.error = null;
  } catch (err) {
    if (seq !== state.requestSeq) return;
    if (err.status === 401) return showLogin("登录已过期，请重新登录");
    state.error = err.status === 0 ? "网络连接失败，恢复后会自动重试" : `无法加载列表：${err.message}`;
  } finally {
    if (seq === state.requestSeq) {
      state.loading = false;
      render();
      schedulePoll();
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (!state.signedIn) return;
  if (document.hidden) stopPolling();
  else refresh();
});
window.addEventListener("online", () => state.signedIn && refresh());
window.addEventListener("focus", () => state.signedIn && !state.loading && refresh());

// ---------- 删除 ----------

async function remove(link, button) {
  const label = link.title || link.url;
  if (!window.confirm(`删除这条链接？\n\n${label}`)) return;
  button.disabled = true;
  try {
    await api(`/api/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
  } catch (err) {
    if (err.status === 401) return showLogin("登录已过期，请重新登录");
    if (err.status !== 404) {
      button.disabled = false;
      window.alert(`删除失败：${err.message}`);
      return;
    }
  }
  state.links = state.links.filter((l) => l.id !== link.id);
  render();
  refresh();
}

// ---------- OneNote 导出 ----------

// 连接 OneNote 后从 Microsoft 跳回时，地址带有 ?onenote=结果；显示一次后从地址中去掉。
const ONENOTE_RESULTS = {
  connected: "已连接 OneNote",
  denied: "已取消连接 OneNote",
  failed: "连接 OneNote 失败，请重试",
  unavailable: "OneNote 导出尚未配置",
};
const oneNoteResult = new URLSearchParams(location.search).get("onenote");
if (oneNoteResult) history.replaceState(history.state, "", location.pathname + location.hash);

async function loadOneNote() {
  let status;
  try {
    status = await (await api("/api/onenote")).json();
  } catch {
    return; // 不影响列表使用
  }
  els.oneNote.hidden = !status.available;
  if (!status.available) return;
  let text;
  if (!status.connected) {
    text = "可以把存档的文章自动导出到 OneNote。";
  } else if (status.error) {
    text = `OneNote 导出已暂停：${status.error}`;
  } else {
    text = `已连接 OneNote，新存档的文章会自动导出（已导出 ${status.exported} 篇`;
    text += status.failed ? `，${status.failed} 篇失败）。` : "）。";
  }
  // 只显示与当前状态一致的结果（例如之后已在其他设备断开时不再显示“已连接”）。
  const ok = status.connected && !status.error;
  const result = ONENOTE_RESULTS[oneNoteResult];
  const fits = oneNoteResult === "connected" ? ok : !ok;
  els.oneNoteText.textContent = result && fits ? `${result}。${text}` : text;
  els.oneNoteConnect.hidden = status.connected && !status.error;
  els.oneNoteConnect.textContent = status.connected ? "重新连接" : "连接 OneNote";
  els.oneNoteDisconnect.hidden = !status.connected;
}

els.oneNoteDisconnect.addEventListener("click", async () => {
  if (!window.confirm("断开 OneNote？之后存档的文章不再导出，已导出的页面保留在 OneNote 中。")) return;
  els.oneNoteDisconnect.disabled = true;
  try {
    await api("/api/onenote", { method: "DELETE" });
  } catch (err) {
    if (err.status === 401) return showLogin("登录已过期，请重新登录");
    window.alert(`断开失败：${err.message}`);
  } finally {
    els.oneNoteDisconnect.disabled = false;
  }
  loadOneNote();
});

// ---------- 复制链接 ----------

async function copyLink(link, button) {
  const ok = await writeClipboard(link.url);
  flashButton(button, ok ? "已复制" : "复制失败");
  if (!ok) window.prompt("无法自动复制，请手动复制链接：", link.url);
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒绝等情况，改用下面的旧方法
  }
  // 旧版浏览器：选中隐藏文本框中的内容后执行复制。
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.className = "clipboard-helper";
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function flashButton(button, text) {
  const original = button.dataset.label ?? button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  button.classList.add("flash");
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("flash");
    }, 1500),
  );
}

// ---------- 阅读视图 ----------

// 打开时写入一条历史记录，iPhone 的返回手势与浏览器返回按钮都会回到列表。
let viewerReturnFocus = null;

function openViewer(link, { push = true } = {}) {
  if (push) history.pushState({ reader: link.id }, "", `#read/${link.id}`);
  viewerReturnFocus = document.activeElement;
  els.viewerTitle.textContent = link.title || link.url || "";
  if (link.url && isWebUrl(link.url)) {
    els.viewerOpen.href = link.url;
    els.viewerOpen.hidden = false;
  } else {
    els.viewerOpen.removeAttribute("href");
    els.viewerOpen.hidden = true;
  }
  loadArticle(link.id, false);
  els.viewer.hidden = false;
  document.body.classList.add("viewing");
  els.viewerBack.focus();
}

// 每次新建 iframe：新 iframe 的首次加载不会产生历史记录，返回操作始终回到列表，
// 而不是在 iframe 的历史中后退。
function loadArticle(id, refresh) {
  els.viewerBody.querySelector("iframe")?.remove();
  els.viewerLoading.textContent = refresh ? "正在从原网页重新获取…" : "正在加载文章…";
  els.viewerLoading.hidden = false;
  els.viewerRefresh.disabled = true;
  const frame = document.createElement("iframe");
  frame.title = "文章阅读视图";
  // 阅读页不含脚本；sandbox 不授予脚本与同源权限，只允许在新标签页打开链接。
  frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  frame.referrerPolicy = "no-referrer";
  frame.addEventListener("load", () => {
    els.viewerLoading.hidden = true;
    els.viewerRefresh.disabled = false;
  });
  frame.src = `/read/${encodeURIComponent(id)}${refresh ? "?refresh=1" : ""}`;
  frame.dataset.id = id;
  els.viewerBody.append(frame);
}

els.viewerRefresh.addEventListener("click", () => {
  const frame = els.viewerBody.querySelector("iframe");
  if (frame && frame.dataset.id) loadArticle(frame.dataset.id, true);
});

function closeViewer() {
  if (els.viewer.hidden) return;
  els.viewer.hidden = true;
  document.body.classList.remove("viewing");
  els.viewerBody.querySelector("iframe")?.remove();
  if (viewerReturnFocus && document.contains(viewerReturnFocus)) viewerReturnFocus.focus();
  viewerReturnFocus = null;
}

// 从地址恢复的阅读视图在列表加载后补全标题与原网页链接。
function fillViewerDetails() {
  const id = history.state && history.state.reader;
  if (!id || els.viewer.hidden) return;
  const link = state.links.find((l) => l.id === id);
  if (!link) return;
  if (!els.viewerTitle.textContent) els.viewerTitle.textContent = link.title || link.url;
  if (els.viewerOpen.hidden && isWebUrl(link.url)) {
    els.viewerOpen.href = link.url;
    els.viewerOpen.hidden = false;
  }
}

function goBack() {
  if (history.state && history.state.reader) history.back();
  else closeViewer();
}

els.viewerBack.addEventListener("click", goBack);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.viewer.hidden) goBack();
});

window.addEventListener("popstate", (event) => {
  const id = event.state && event.state.reader;
  if (!id) return closeViewer();
  const link = state.links.find((l) => l.id === id) ?? { id, title: "", url: "" };
  openViewer(link, { push: false });
});

// 在阅读视图中刷新页面时，重新打开同一篇文章。
function restoreViewerFromUrl() {
  const match = /^#read\/([A-Za-z0-9-]{1,64})$/.exec(location.hash);
  if (!match) return;
  history.replaceState({ reader: match[1] }, "", location.hash);
  const link = state.links.find((l) => l.id === match[1]) ?? { id: match[1], title: "", url: "" };
  openViewer(link, { push: false });
}

// ---------- 渲染 ----------

function render() {
  const { loaded, error, links, query, hasMore, loading } = state;

  els.listError.hidden = !error;
  els.listErrorText.textContent = error ?? "";

  if (!loaded) {
    els.listState.textContent = error ? "" : "正在加载链接…";
  } else if (links.length === 0) {
    els.listState.textContent = query
      ? `没有找到与“${query}”匹配的链接`
      : "还没有保存的链接。在上方粘贴链接，或通过 iOS 分享菜单中的快捷指令发送。";
  } else {
    els.listState.textContent = "";
  }
  els.listState.hidden = !els.listState.textContent;

  if (error) {
    els.sync.textContent = navigator.onLine ? "同步失败" : "离线";
    els.sync.className = "sync error";
  } else if (loading) {
    els.sync.textContent = "正在同步…";
    els.sync.className = "sync";
  } else if (loaded) {
    els.sync.textContent = "已同步";
    els.sync.className = "sync ok";
  }

  renderLinks(links);
  els.more.hidden = !hasMore;
}

const itemCache = new Map(); // id -> { el, signature }

function renderLinks(links) {
  const seen = new Set();
  const nodes = links.map((link) => {
    seen.add(link.id);
    const signature = JSON.stringify([link.url, link.title, link.iconUrl, link.previewStatus, link.lastSubmittedAt]);
    let cached = itemCache.get(link.id);
    if (!cached || cached.signature !== signature) {
      cached = { el: buildItem(link), signature };
      itemCache.set(link.id, cached);
    } else {
      updateTime(cached.el, link);
    }
    return cached.el;
  });
  for (const id of itemCache.keys()) if (!seen.has(id)) itemCache.delete(id);

  // 仅在顺序或内容变化时替换节点，避免打断正在进行的操作。
  const current = [...els.list.children];
  if (current.length !== nodes.length || current.some((el, i) => el !== nodes[i])) {
    els.list.replaceChildren(...nodes);
  }
}

function buildItem(link) {
  const li = document.createElement("li");
  li.className = "link";
  li.dataset.id = link.id;
  li.dataset.status = link.previewStatus;

  const hasPreview = link.previewStatus === "ok" && link.title;
  const safeUrl = isWebUrl(link.url) ? link.url : null;

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.setAttribute("aria-hidden", "true");
  if (hasPreview) {
    const fallback = domainOf(link.url).charAt(0).toUpperCase() || "·";
    if (link.iconUrl && isWebUrl(link.iconUrl)) {
      const img = document.createElement("img");
      img.alt = "";
      img.width = 20;
      img.height = 20;
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        icon.textContent = fallback;
        icon.classList.add("letter");
      });
      img.src = link.iconUrl;
      icon.append(img);
    } else {
      icon.textContent = fallback;
      icon.classList.add("letter");
    }
  } else {
    icon.classList.add("blank");
  }

  const body = document.createElement("div");
  body.className = "body";

  const anchor = document.createElement(safeUrl ? "a" : "span");
  anchor.className = hasPreview ? "title" : "title raw-url";
  if (safeUrl) {
    // 普通点击在站内阅读视图中打开；带修饰键的点击或长按仍可在新标签页打开原网页。
    anchor.href = safeUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openViewer(link);
    });
  }
  anchor.textContent = hasPreview ? link.title : link.url;
  body.append(anchor);

  const meta = document.createElement("div");
  meta.className = "meta";
  if (hasPreview) {
    const domain = document.createElement("span");
    domain.className = "domain";
    domain.textContent = domainOf(link.url);
    meta.append(domain);
  }
  const time = document.createElement("time");
  time.className = "time";
  meta.append(time);
  if (link.previewStatus === "pending") {
    const pending = document.createElement("span");
    pending.className = "pending";
    pending.textContent = "正在获取预览…";
    meta.append(pending);
  }
  body.append(meta);

  const label = hasPreview ? link.title : link.url;
  const actions = document.createElement("div");
  actions.className = "item-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy ghost";
  copy.textContent = "复制链接";
  copy.setAttribute("aria-label", `复制链接 ${label}`);
  copy.addEventListener("click", () => copyLink(link, copy));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete ghost";
  del.textContent = "删除";
  del.setAttribute("aria-label", `删除 ${label}`);
  del.addEventListener("click", () => remove(link, del));
  actions.append(copy, del);

  li.append(icon, body, actions);
  updateTime(li, link);
  return li;
}

function updateTime(li, link) {
  const time = li.querySelector("time");
  const date = new Date(link.lastSubmittedAt);
  time.dateTime = date.toISOString();
  time.textContent = `保存于 ${formatTime(date)}`;
  time.title = date.toLocaleString("zh-CN");
}

function isWebUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function domainOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const pad = (n) => String(n).padStart(2, "0");

function formatTime(date, now = new Date()) {
  const diff = now - date;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date >= startOfToday) return `今天 ${hm}`;
  if (date >= new Date(startOfToday - 86_400_000)) return `昨天 ${hm}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

// 相对时间每分钟更新一次。
setInterval(() => {
  for (const link of state.links) {
    const cached = itemCache.get(link.id);
    if (cached) updateTime(cached.el, link);
  }
}, 60_000);

boot();
