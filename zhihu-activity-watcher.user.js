// ==UserScript==
// @name         Zhihu User Activity Watcher
// @namespace    https://github.com/plsy1/zhihu-user-activity-watcher
// @version      0.3.0
// @description  Export a visible Zhihu activity timeline with an LLM analysis prompt.
// @author       local
// @match        https://www.zhihu.com/people/*
// @updateURL    https://raw.githubusercontent.com/plsy1/zhihu-user-activity-watcher/main/zhihu-activity-watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/plsy1/zhihu-user-activity-watcher/main/zhihu-activity-watcher.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "zhihu-activity-watcher.items";
  const SETTINGS_KEY = "zhihu-activity-watcher.settings";
  const ACTIONS = [
    { re: /赞同|赞了|点赞/, type: "voteup", label: "点赞/赞同" },
    { re: /关注了问题/, type: "follow_question", label: "关注问题" },
    { re: /关注了专栏/, type: "follow_column", label: "关注专栏" },
    { re: /关注了收藏夹/, type: "follow_collection", label: "关注收藏夹" },
    { re: /关注了/, type: "follow", label: "关注" },
    { re: /收藏/, type: "collect", label: "收藏" },
    { re: /回答/, type: "answer", label: "回答" },
    { re: /发表了文章|发布了文章/, type: "article", label: "文章" },
    { re: /发布了想法/, type: "pin", label: "想法" },
    { re: /提问|提出了问题/, type: "question", label: "提问" },
  ];

  const state = {
    running: false,
    timer: null,
    idleRounds: 0,
    lastHeight: 0,
    apiRunning: false,
    apiAddedCount: 0,
    apiPageCount: 0,
    apiNextUrl: "",
    apiLastError: "",
    lastApiAt: "",
    items: loadItems(),
    settings: {
      intervalMs: 2800,
      maxIdleRounds: 8,
      ...loadJson(SETTINGS_KEY, {}),
    },
  };

  installNetworkHooks();

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function loadItems() {
    const items = loadJson(STORE_KEY, []);
    return Array.isArray(items) ? items : [];
  }

  function saveItems() {
    saveJson(STORE_KEY, state.items);
    updatePanel();
  }

  function textOf(root, selector) {
    const node = root.querySelector(selector);
    return node ? normalizeText(node.textContent) : "";
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function absoluteUrl(href) {
    if (!href) return "";
    if (href.startsWith("//")) return `https:${href}`;
    if (href.startsWith("/")) return `https://www.zhihu.com${href}`;
    try {
      return new URL(href, location.origin).href;
    } catch {
      return "";
    }
  }

  function currentProfileToken() {
    const match = location.pathname.match(/^\/people\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function likelyActivityContainers() {
    const selectors = [
      ".List-item",
      ".ActivityItem",
      ".ContentItem",
      "[data-za-detail-view-path-module='FeedItem']",
      "[class*='Activity'] [class*='Item']",
    ];
    const seen = new Set();
    const nodes = [];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof HTMLElement) || seen.has(node)) return;
        if (nodes.some((parent) => parent.contains(node))) return;
        const text = normalizeText(node.textContent);
        if (text.length < 20) return;
        seen.add(node);
        nodes.push(node);
      });
    }

    return nodes;
  }

  function itemKey(item) {
    if (item.targetUrl) return [item.actionType, item.targetUrl, item.timeText].join("|");
    if (item.url) return item.url;
    return [item.profileToken, item.actionType, item.targetTitle, item.timeText].join("|");
  }

  function addItems(items) {
    const before = state.items.length;
    const keys = new Set(state.items.map(itemKey));

    for (const item of items) {
      const key = itemKey(item);
      if (!key || keys.has(key)) continue;
      keys.add(key);
      state.items.push(item);
    }

    if (state.items.length !== before) {
      saveItems();
    } else {
      updatePanel();
    }

    return state.items.length - before;
  }

  function classifyAction(text) {
    const matched = ACTIONS.find((action) => action.re.test(text));
    return matched || { type: "activity", label: "动态" };
  }

  function targetTypeFromUrl(url) {
    if (/\/question\/\d+\/answer\/\d+/.test(url)) return "answer";
    if (/\/question\/\d+/.test(url)) return "question";
    if (/\/p\/\d+/.test(url)) return "article";
    if (/\/pin\//.test(url)) return "pin";
    if (/\/people\//.test(url)) return "person";
    if (/\/column\//.test(url)) return "column";
    if (/\/collection\//.test(url)) return "collection";
    return "";
  }

  function parseZhihuTime(text) {
    const cleaned = normalizeText(text)
      .replace(/^发布于\s*/, "")
      .replace(/^编辑于\s*/, "")
      .replace(/^更新于\s*/, "");
    if (!cleaned) return "";

    const now = new Date();
    const relative = cleaned.match(/(\d+)\s*(秒|分钟|小时|天)前/);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2];
      const date = new Date(now);
      if (unit === "秒") date.setSeconds(date.getSeconds() - amount);
      if (unit === "分钟") date.setMinutes(date.getMinutes() - amount);
      if (unit === "小时") date.setHours(date.getHours() - amount);
      if (unit === "天") date.setDate(date.getDate() - amount);
      return date.toISOString();
    }

    if (/刚刚/.test(cleaned)) return now.toISOString();
    if (/昨天/.test(cleaned)) {
      const time = cleaned.match(/(\d{1,2}):(\d{2})/);
      const date = new Date(now);
      date.setDate(date.getDate() - 1);
      if (time) {
        date.setHours(Number(time[1]), Number(time[2]), 0, 0);
      }
      return date.toISOString();
    }

    const full = cleaned.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (full) {
      return new Date(
        Number(full[1]),
        Number(full[2]) - 1,
        Number(full[3]),
        Number(full[4] || 0),
        Number(full[5] || 0),
        0,
        0,
      ).toISOString();
    }

    const monthDay = cleaned.match(/(\d{1,2})[-/月.](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (monthDay) {
      return new Date(
        now.getFullYear(),
        Number(monthDay[1]) - 1,
        Number(monthDay[2]),
        Number(monthDay[3] || 0),
        Number(monthDay[4] || 0),
        0,
        0,
      ).toISOString();
    }

    return "";
  }

  function extractTime(container, fullText) {
    const candidates = [
      textOf(container, "time"),
      textOf(container, ".ContentItem-time"),
      textOf(container, ".ActivityItem-meta"),
      textOf(container, ".ContentItem-status"),
      textOf(container, ".RichContent-meta"),
    ].filter(Boolean);

    const textCandidate = fullText.match(
      /(刚刚|\d+\s*(?:秒|分钟|小时|天)前|昨天\s*\d{0,2}:?\d{0,2}|\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?|\d{1,2}[-/月.]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?)/,
    );

    if (textCandidate) candidates.unshift(textCandidate[1]);
    return candidates.find(Boolean) || "";
  }

  function cleanTargetTitle(rawTitle, fullText, timeText) {
    let title = normalizeText(rawTitle) || normalizeText(fullText).slice(0, 120);

    if (timeText && title.includes(timeText)) {
      title = normalizeText(title.slice(title.indexOf(timeText) + timeText.length));
    }

    title = title
      .replace(/^(赞同了|赞了|点赞了)?(回答|文章|想法)\s*/, "")
      .replace(/^关注了(问题|专栏|收藏夹)?\s*/, "")
      .replace(/^收藏了?\s*/, "")
      .replace(/^回答了?(问题)?\s*/, "")
      .replace(/^发表了文章\s*/, "")
      .replace(/^发布了想法\s*/, "");

    const readMoreIndex = title.indexOf("阅读全文");
    if (readMoreIndex > 0) {
      title = title.slice(0, readMoreIndex);
    }

    return normalizeText(title).slice(0, 160);
  }

  function extractItem(container) {
    const fullText = normalizeText(container.textContent);
    const links = Array.from(container.querySelectorAll("a[href]"));
    const meaningfulLinks = links
      .map((node) => ({
        text: normalizeText(node.textContent),
        url: absoluteUrl(node.getAttribute("href")),
      }))
      .filter((link) => link.text.length >= 2 && link.url.includes("zhihu.com"));

    const targetLink =
      meaningfulLinks.find((link) => /\/question\/|\/answer\/|\/p\//.test(link.url)) ||
      meaningfulLinks.find((link) => !/\/people\//.test(link.url)) ||
      meaningfulLinks[0] ||
      { text: "", url: "" };

    const timeText = extractTime(container, fullText);
    const action = classifyAction(fullText.slice(0, 120));
    const targetTitle = cleanTargetTitle(targetLink.text, fullText, timeText);

    return {
      profileToken: currentProfileToken(),
      actionType: action.type,
      actionLabel: action.label,
      targetType: targetTypeFromUrl(targetLink.url),
      targetTitle,
      targetUrl: targetLink.url,
      timeText,
      timeIso: parseZhihuTime(timeText),
      summary: fullText.slice(0, 500),
      capturedAt: new Date().toISOString(),
      pageUrl: location.href,
      source: "dom",
    };
  }

  function collectVisibleItems() {
    return addItems(likelyActivityContainers().map(extractItem));
  }

  function installNetworkHooks() {
    if (window.__zhihuActivityWatcherHooksInstalled) return;
    window.__zhihuActivityWatcherHooksInstalled = true;
    hookFetch();
    hookXhr();
  }

  function hookFetch() {
    if (typeof window.fetch !== "function") return;
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const requestUrl = requestUrlOf(args[0]);
      const result = originalFetch.apply(this, args);

      if (isActivityApiUrl(requestUrl)) {
        result
          .then((response) => {
            if (!response || typeof response.clone !== "function") return;
            response
              .clone()
              .json()
              .then((json) => ingestActivityApiResponse(json, requestUrl))
              .catch(() => {});
          })
          .catch(() => {});
      }

      return result;
    };
  }

  function hookXhr() {
    if (typeof window.XMLHttpRequest !== "function") return;
    const originalOpen = window.XMLHttpRequest.prototype.open;
    const originalSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__zawUrl = requestUrlOf(url);
      return originalOpen.call(this, method, url, ...rest);
    };

    window.XMLHttpRequest.prototype.send = function (...args) {
      if (isActivityApiUrl(this.__zawUrl)) {
        this.addEventListener("loadend", () => {
          try {
            const json = this.responseType === "json" ? this.response : JSON.parse(this.responseText || "");
            ingestActivityApiResponse(json, this.__zawUrl);
          } catch {}
        });
      }
      return originalSend.apply(this, args);
    };
  }

  function requestUrlOf(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    return String(input);
  }

  function isActivityApiUrl(url) {
    return /\/api\/v3\/moments\/[^/?#]+\/activities\b/.test(url) || /\/api\/v4\/members\/[^/?#]+\/activities\b/.test(url);
  }

  function ingestActivityApiResponse(json, sourceUrl) {
    captureActivityApiPaging(json);
    const items = extractApiItems(json, sourceUrl);
    if (items.length === 0) return;

    const added = addItems(items);
    if (added > 0) {
      state.apiAddedCount += added;
      state.lastApiAt = formatLocalDateTime(new Date());
      updatePanel();
    }
  }

  function captureActivityApiPaging(json) {
    const next = nextActivityApiUrl(json);
    if (next) state.apiNextUrl = next;
  }

  function nextActivityApiUrl(json) {
    const next = json?.paging?.next;
    return typeof next === "string" && next ? absoluteUrl(next) : "";
  }

  function extractApiItems(json, sourceUrl) {
    const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return rows.map((row) => apiRowToItem(row, sourceUrl)).filter(Boolean);
  }

  function apiRowToItem(row, sourceUrl) {
    if (!row || typeof row !== "object") return null;

    const target = row.target || row.content || row.sourceContent || row.source_content || row.object || {};
    const nestedTarget = target.target || target.content || {};
    const actionText = pickText(row, ["action_text", "actionText", "verb", "verb_text", "verbText", "type"]);
    const title =
      pickText(target, ["title", "name", "question_title", "excerpt_title"]) ||
      pickText(nestedTarget, ["title", "name", "question_title", "excerpt_title"]) ||
      pickText(row, ["title", "question_title"]);
    const summary =
      pickText(target, ["excerpt", "summary", "content", "description"]) ||
      pickText(nestedTarget, ["excerpt", "summary", "content", "description"]) ||
      pickText(row, ["excerpt", "summary", "content", "description"]);
    const timeText = apiTimeText(row);
    const rawUrl =
      pickText(target, ["url", "link", "content_url"]) ||
      pickText(nestedTarget, ["url", "link", "content_url"]) ||
      apiUrlFromIds(target) ||
      apiUrlFromIds(nestedTarget);
    const targetUrl = absoluteUrl(rawUrl);
    const action = classifyAction(`${actionText} ${summary} ${title}`);
    const normalizedTitle = cleanTargetTitle(title, `${actionText} ${timeText} ${title} ${summary}`, timeText);

    if (!normalizedTitle && !targetUrl && !summary) return null;

    return {
      profileToken: profileTokenFromApiUrl(sourceUrl) || currentProfileToken(),
      actionType: action.type,
      actionLabel: action.label,
      targetType: targetTypeFromApiTarget(target, targetUrl),
      targetTitle: normalizedTitle || summary.slice(0, 80),
      targetUrl,
      timeText,
      timeIso: parseZhihuTime(timeText) || apiTimeIso(row),
      summary: normalizeText(`${actionText} ${timeText} ${normalizedTitle || title} ${summary}`).slice(0, 500),
      capturedAt: new Date().toISOString(),
      pageUrl: location.href,
      source: "api",
    };
  }

  function pickText(object, keys) {
    for (const key of keys) {
      const value = object?.[key];
      if (typeof value === "string" && normalizeText(value)) return normalizeText(stripHtml(value));
      if (typeof value === "number") return String(value);
    }
    return "";
  }

  function stripHtml(value) {
    return String(value).replace(/<[^>]*>/g, " ");
  }

  function apiTimeText(row) {
    const value =
      row.created_time ||
      row.createdTime ||
      row.created_at ||
      row.createdAt ||
      row.updated_time ||
      row.timestamp ||
      row.time;
    if (!value) return "";
    if (typeof value === "number") {
      const milliseconds = value > 1e12 ? value : value * 1000;
      return formatLocalDateTime(new Date(milliseconds));
    }
    return normalizeText(value);
  }

  function apiTimeIso(row) {
    const value =
      row.created_time ||
      row.createdTime ||
      row.created_at ||
      row.createdAt ||
      row.updated_time ||
      row.timestamp ||
      row.time;
    if (typeof value !== "number") return "";
    const milliseconds = value > 1e12 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }

  function apiUrlFromIds(target) {
    const type = target?.type || target?.schema;
    const id = target?.id || target?.token || target?.url_token || target?.urlToken;
    if (!type || !id) return "";
    if (type === "answer") {
      const questionId = target?.question?.id || target?.question_id || target?.questionId;
      return questionId ? `/question/${questionId}/answer/${id}` : `/answer/${id}`;
    }
    if (type === "question") return `/question/${id}`;
    if (type === "article") return `https://zhuanlan.zhihu.com/p/${id}`;
    if (type === "pin") return `/pin/${id}`;
    if (type === "people" || type === "member") return `/people/${id}`;
    return "";
  }

  function targetTypeFromApiTarget(target, url) {
    return target?.type || target?.schema || targetTypeFromUrl(url);
  }

  function profileTokenFromApiUrl(url) {
    const match = String(url).match(/\/api\/v[34]\/(?:moments|members)\/([^/?#]+)\/activities\b/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function tick() {
    if (!state.running) return;

    const added = collectVisibleItems();
    const height = document.documentElement.scrollHeight;
    const atBottom = window.scrollY + window.innerHeight >= height - 8;

    if (added === 0 && height === state.lastHeight && atBottom) {
      state.idleRounds += 1;
    } else {
      state.idleRounds = 0;
    }

    state.lastHeight = height;
    updatePanel();

    if (state.idleRounds >= state.settings.maxIdleRounds) {
      stop();
      return;
    }

    window.scrollBy({ top: Math.floor(window.innerHeight * 0.82), behavior: "smooth" });
    state.timer = window.setTimeout(tick, state.settings.intervalMs);
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.idleRounds = 0;
    state.lastHeight = 0;
    updatePanel();
    tick();
  }

  function stop() {
    state.running = false;
    state.apiRunning = false;
    if (state.timer) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    collectVisibleItems();
    updatePanel();
  }

  async function startApiCollect() {
    if (state.apiRunning) return;

    const token = currentProfileToken();
    if (!token) {
      updatePanel("未识别用户 token");
      return;
    }

    state.apiRunning = true;
    state.apiLastError = "";
    state.apiPageCount = 0;
    updatePanel("API直采中");

    let nextUrl = state.apiNextUrl || buildInitialActivityApiUrl(token);

    try {
      while (state.apiRunning && nextUrl) {
        const json = await fetchActivityApiPage(nextUrl);
        const rows = Array.isArray(json?.data) ? json.data : [];
        ingestActivityApiResponse(json, nextUrl);

        state.apiPageCount += 1;
        const followingUrl = nextActivityApiUrl(json);
        const isEnd = Boolean(json?.paging?.is_end || json?.paging?.isEnd) || rows.length === 0 || !followingUrl;

        updatePanel(`API页 ${state.apiPageCount}`);
        if (isEnd) break;

        nextUrl = followingUrl;
        state.apiNextUrl = followingUrl;
        await sleep(state.settings.intervalMs);
      }
    } catch (error) {
      state.apiLastError = error instanceof Error ? error.message : String(error);
      updatePanel(`API失败 ${state.apiLastError.slice(0, 40)}`);
    } finally {
      state.apiRunning = false;
      updatePanel(state.apiLastError ? `API失败 ${state.apiLastError.slice(0, 40)}` : "API直采结束");
    }
  }

  function buildInitialActivityApiUrl(token) {
    const url = new URL(`/api/v3/moments/${encodeURIComponent(token)}/activities`, location.origin);
    url.searchParams.set("offset", String(Date.now()));
    url.searchParams.set("page_num", "1");
    return url.href;
  }

  async function fetchActivityApiPage(url) {
    if (typeof window.fetch !== "function") return xhrActivityApiPage(url);

    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
      },
    });

    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const errorJson = await response.clone().json();
        const serverMessage = errorJson?.error?.message || errorJson?.message;
        if (serverMessage) message = `${message}: ${serverMessage}`;
      } catch {}
      throw new Error(message);
    }

    return response.json();
  }

  function xhrActivityApiPage(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader("accept", "application/json, text/plain, */*");
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`${xhr.status} ${xhr.statusText}: ${xhr.responseText.slice(0, 80)}`));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText || "{}"));
        } catch {
          reject(new Error("API 返回不是 JSON"));
        }
      };
      xhr.onerror = () => reject(new Error("API 请求失败"));
      xhr.ontimeout = () => reject(new Error("API 请求超时"));
      xhr.timeout = 30000;
      xhr.send();
    });
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, milliseconds)));
  }

  function clearItems() {
    if (!confirm("Clear captured activity items for this browser?")) return;
    state.items = [];
    state.apiAddedCount = 0;
    state.lastApiAt = "";
    saveItems();
  }

  function trimOldCards(maxCards = 60) {
    const cards = Array.from(document.querySelectorAll(".List-item"));
    const extra = cards.length - maxCards;
    if (extra <= 0) {
      updatePanel(`页面卡片 ${cards.length} 条，无需清理`);
      return;
    }

    for (const card of cards.slice(0, extra)) {
      card.remove();
    }

    updatePanel(`已清理 ${extra} 个旧卡片`);
  }

  function exportJson() {
    collectVisibleItems();
    download(
      `zhihu-timeline-${currentProfileToken() || "profile"}.json`,
      JSON.stringify(buildExportPayload(), null, 2),
      "application/json;charset=utf-8",
    );
  }

  function exportCsv() {
    collectVisibleItems();
    const headers = [
      "profileToken",
      "actionType",
      "actionLabel",
      "targetType",
      "targetTitle",
      "targetUrl",
      "timeText",
      "timeIso",
      "capturedAt",
      "source",
      "summary",
    ];
    const rows = [headers, ...state.items.map((item) => headers.map((key) => item[key] || ""))];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    download(`zhihu-timeline-${currentProfileToken() || "profile"}.csv`, csv, "text/csv;charset=utf-8");
  }

  function exportPromptMarkdown(includeSummary) {
    collectVisibleItems();
    const suffix = includeSummary ? "with-summary" : "compact";
    const filename = `zhihu-timeline-for-ai-${suffix}-${currentProfileToken() || "profile"}.md`;
    const content = buildPromptMarkdown({ includeSummary });
    download(filename, content, "text/markdown;charset=utf-8");
    showExportPreview(filename, content);
  }

  function buildExportPayload() {
    return {
      source: "zhihu_user_activity_page",
      profileToken: currentProfileToken(),
      exportedAt: new Date().toISOString(),
      itemCount: state.items.length,
      prompt: buildAnalysisPrompt(),
      timeline: state.items,
    };
  }

  function buildAnalysisPrompt() {
    return [
      "你是一名专业的用户画像分析助手。",
      "",
      "下面提供的是一位知乎用户主页可见的 Timeline 数据（点赞、回答、文章、收藏、关注等公开行为）。",
      "",
      "注意事项：",
      "- Timeline 数据可能不完整，仅覆盖部分时间段。",
      "- 时间可能为页面显示的相对时间（如“昨天”“3天前”），不一定是精确时间。",
      "- 所有分析必须严格基于提供的数据。",
      "- 不允许将推测写成事实。",
      "- 每一个推断都必须给出证据、置信度以及不确定性说明。",
      "- 当存在多个合理解释时，应全部列出，而不是只选择其中一个。",
      "- 当证据不足时，应明确标记为“无法判断”或“低置信度”，不得为了完整而强行推断。",
      "",
      "请尽可能覆盖完整的用户画像维度，包括但不限于：",
      "- 基础属性",
      "- 地域属性",
      "- 兴趣偏好",
      "- 行为特征",
      "- 心理特征",
      "- 内容画像",
      "- 社交画像",
      "- 消费画像",
      "- 技术/专业画像",
      "- 需求与目标",
      "- 生命周期与活跃度",
      "- 用户标签",
      "",
      "说明：",
      "- 知乎 Timeline 对部分画像维度天然支持有限。",
      "- 对于婚姻状况、家庭结构、收入水平、消费能力、价值观、性格、风险偏好等隐私性或间接性较强的信息，如果没有充分证据，必须明确标记为“无法判断”或“低置信度”。",
      "- 可以提出合理推测，但必须说明依据，不得编造不存在的信息。",
      "",
      "请输出一份结构化 Markdown 用户画像分析报告。",
      "",
      "# 0. 整体用户画像（首先输出）",
      "给出用户最可能的：",
      "- 性别",
      "- 年龄层",
      "- 可能居住地",
      "- 可能教育水平",
      "- 可能职业/身份",
      "- 三句话总结整体画像",
      "",
      "每项均需包含：",
      "- 推断结果",
      "- 置信度（高 / 中 / 低）",
      "- 支持证据（引用 Timeline 序号）",
      "- 不确定因素",
      "",
      "# 1. 基础画像",
      "分析以下内容：",
      "- 性别",
      "- 年龄层",
      "- 学历水平",
      "- 职业",
      "- 地域",
      "- 家庭阶段（如可推断）",
      "",
      "每项均标注：",
      "- 推断",
      "- 置信度",
      "- 支持证据",
      "- 是否无法判断",
      "",
      "# 2. 兴趣画像",
      "归纳：",
      "- 长期兴趣",
      "- 最近兴趣",
      "- 高频主题",
      "- 高频关键词",
      "- 高频作者",
      "- 高频问题类型",
      "- 兴趣变化趋势",
      "",
      "尽可能引用 Timeline 序号作为依据。",
      "",
      "# 3. 内容画像",
      "分析：",
      "- 偏好的内容类型",
      "- 偏好的领域",
      "- 喜欢阅读还是创作",
      "- 偏好长文还是短内容",
      "- 偏好知识型、观点型、娱乐型还是资讯型内容",
      "- 内容专业程度",
      "",
      "# 4. 行为画像",
      "统计并分析：",
      "- 点赞",
      "- 回答",
      "- 收藏",
      "- 关注",
      "- 发布内容",
      "",
      "判断该用户更偏向：",
      "- 信息消费者",
      "- 内容创作者",
      "- 收藏整理者",
      "- 深度讨论者",
      "- 社交互动者",
      "",
      "如数据允许，可估计各行为的大致占比。",
      "",
      "# 5. 社交画像",
      "分析：",
      "- 是否喜欢互动",
      "- 是否经常评论或回答",
      "- 是否关注大量作者",
      "- 是否持续关注固定圈层",
      "- 是否更偏向围观还是参与",
      "",
      "# 6. 技术/专业画像",
      "推测可能的：",
      "- 专业方向",
      "- 技术背景",
      "- 所属行业",
      "- 知识深度",
      "- 知识广度",
      "- 兴趣圈层",
      "",
      "例如 AI、金融、法律、医学、科研、互联网、产品等。",
      "",
      "每项均需说明：",
      "- 推断",
      "- 置信度",
      "- 支持证据",
      "",
      "# 7. 心理画像（仅作弱推断）",
      "如有证据，可分析：",
      "- 求知欲",
      "- 理性程度",
      "- 开放程度",
      "- 风险偏好",
      "- 学习驱动力",
      "- 价值取向",
      "",
      "若证据不足，应明确说明无法判断。",
      "",
      "# 8. 消费画像（若数据支持）",
      "分析：",
      "- 消费能力",
      "- 品牌偏好",
      "- 数码产品兴趣",
      "- 生活方式",
      "- 出行偏好",
      "",
      "若 Timeline 无法支持，应明确说明无法判断。",
      "",
      "# 9. 需求与目标",
      "结合 Timeline 推测用户当前可能关注或正在解决的问题，例如：",
      "- 学习",
      "- 求职",
      "- 投资",
      "- 科研",
      "- 创业",
      "- 技术成长",
      "- 考试",
      "- 健康",
      "",
      "必须注明置信度。",
      "",
      "# 10. 活跃规律",
      "分析：",
      "- 活跃日期",
      "- 活跃小时段",
      "- 连续活跃周期",
      "- 是否存在集中活跃窗口",
      "- 数据覆盖限制",
      "",
      "# 11. 用户标签",
      "输出多个最可能的身份标签，并按置信度排序，例如：",
      "- AI 从业者",
      "- AI 学习者",
      "- 程序员",
      "- 独立开发者",
      "- 产品经理",
      "- 科研人员",
      "- 金融从业者",
      "- 学生",
      "",
      "# 12. 兴趣演化时间线",
      "按时间顺序总结：",
      "- 用户近期关注主题变化",
      "- 兴趣迁移",
      "- 新增关注领域",
      "",
      "# 13. 综合结论",
      "分别列出：",
      "",
      "## 明确事实",
      "只能写 Timeline 可以直接证明的事实。",
      "",
      "## 合理推测",
      "具有一定证据支持，但不能确认。",
      "",
      "## 弱信号",
      "证据较少，仅供参考。",
      "",
      "## 无法判断",
      "当前数据不足以支持的结论。",
      "",
      "## 综合可信度",
      "总结哪些画像维度可信度较高，哪些仅属于弱推测，以及哪些完全无法判断。",
      "",
      "输出要求：",
      "- 使用 Markdown。",
      "- 使用清晰标题。",
      "- 多使用 Bullet。",
      "- 所有推断尽可能引用 Timeline 序号。",
      "- 不编造不存在的信息。",
      "- 不为了完整而强行推断。",
      "- 如果多个解释都成立，应同时列出并说明原因。",
    ].join("\n");
  }

  function buildPromptMarkdown({ includeSummary }) {
    const payload = buildExportPayload();
    const timelineLines = state.items.map((item, index) => {
      const time = timelineTimeLabel(item);
      const target = item.targetTitle || "无标题";
      const summary = includeSummary && item.summary ? `\n  摘要: ${item.summary}` : "";
      return `${index + 1}. [${time}] ${item.actionLabel} ${target}${summary}`;
    });

    return [
      "# 分析任务",
      "",
      payload.prompt,
      "",
      "# 元数据",
      "",
      `- 用户 token: ${payload.profileToken}`,
      `- 导出时间: ${formatLocalDateTime(new Date(payload.exportedAt))}`,
      `- 动态条数: ${payload.itemCount}`,
      `- 时间范围: ${buildTimelineTimeRange(state.items)}`,
      "",
      "# Timeline",
      "",
      timelineLines.join("\n\n") || "无数据",
      "",
    ].join("\n");
  }

  function timelineTimeLabel(item) {
    return item.timeText || item.timeIso || "时间未知";
  }

  function buildTimelineTimeRange(items) {
    const knownItems = items.filter((item) => item.timeText || item.timeIso);
    if (knownItems.length === 0) return "未知";
    if (knownItems.length === 1) return timelineTimeLabel(knownItems[0]);

    const first = timelineTimeLabel(knownItems[0]);
    const last = timelineTimeLabel(knownItems[knownItems.length - 1]);
    return `${last} 至 ${first}`;
  }

  function formatLocalDateTime(date) {
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function csvCell(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  function download(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showExportPreview(filename, content) {
    const existing = document.querySelector("#zhihu-activity-watcher-preview");
    if (existing) existing.remove();

    const wrapper = document.createElement("div");
    wrapper.id = "zhihu-activity-watcher-preview";
    wrapper.innerHTML = `
      <div class="zaw-preview-dialog">
        <div class="zaw-preview-head">
          <strong>${escapeHtml(filename)}</strong>
          <button type="button" data-preview-action="close">关闭</button>
        </div>
        <textarea readonly></textarea>
        <div class="zaw-preview-actions">
          <button type="button" data-preview-action="copy">复制内容</button>
        </div>
      </div>
    `;

    const textarea = wrapper.querySelector("textarea");
    if (textarea) textarea.value = content;
    document.body.appendChild(wrapper);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return entities[char];
    });
  }

  function ensureActivityPage() {
    if (/\/activities\/?$/.test(location.pathname)) return;
    const token = currentProfileToken();
    if (!token) return;
    location.href = `/people/${encodeURIComponent(token)}/activities`;
  }

  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "zhihu-activity-watcher-panel";
    panel.innerHTML = `
      <div class="zaw-title">知乎动态采集</div>
      <div class="zaw-status"></div>
      <div class="zaw-row">
        <button data-action="start">开始</button>
        <button data-action="stop">暂停</button>
      </div>
      <div class="zaw-row">
        <button data-action="api-collect">API直采</button>
        <button data-action="trim-page">清理页面</button>
      </div>
      <div class="zaw-row">
        <button data-action="json">JSON</button>
        <button data-action="csv">CSV</button>
      </div>
      <div class="zaw-row">
        <button data-action="prompt-summary">AI+摘要</button>
        <button data-action="prompt-compact">AI精简</button>
      </div>
      <div class="zaw-row">
        <button data-action="clear">清空</button>
        <button data-action="activity-page">动态页</button>
      </div>
      <div class="zaw-row">
        <label>间隔 <input type="number" min="100" step="100" data-field="intervalMs"></label>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #zhihu-activity-watcher-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 999999;
        width: 220px;
        padding: 12px;
        border: 1px solid #d0d7de;
        border-radius: 8px;
        background: #ffffff;
        color: #24292f;
        box-shadow: 0 8px 24px rgba(140, 149, 159, 0.25);
        font-size: 13px;
        line-height: 1.45;
      }
      #zhihu-activity-watcher-panel .zaw-title {
        font-weight: 600;
        margin-bottom: 8px;
      }
      #zhihu-activity-watcher-panel .zaw-status {
        min-height: 36px;
        margin-bottom: 8px;
        color: #57606a;
      }
      #zhihu-activity-watcher-panel .zaw-row {
        display: flex;
        gap: 6px;
        margin-top: 8px;
        align-items: center;
      }
      #zhihu-activity-watcher-panel button {
        flex: 1;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        background: #f6f8fa;
        color: #24292f;
        padding: 5px 8px;
        cursor: pointer;
      }
      #zhihu-activity-watcher-panel button:hover {
        background: #eef1f4;
      }
      #zhihu-activity-watcher-panel label {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
      }
      #zhihu-activity-watcher-panel input {
        width: 88px;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        padding: 4px 6px;
      }
      #zhihu-activity-watcher-preview {
        position: fixed;
        inset: 0;
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.42);
      }
      #zhihu-activity-watcher-preview .zaw-preview-dialog {
        width: min(860px, 92vw);
        height: min(680px, 86vh);
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.28);
      }
      #zhihu-activity-watcher-preview .zaw-preview-head,
      #zhihu-activity-watcher-preview .zaw-preview-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      #zhihu-activity-watcher-preview textarea {
        flex: 1;
        resize: none;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        padding: 10px;
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #24292f;
      }
      #zhihu-activity-watcher-preview button {
        border: 1px solid #d0d7de;
        border-radius: 6px;
        background: #f6f8fa;
        color: #24292f;
        padding: 5px 10px;
        cursor: pointer;
      }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(panel);

    panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      if (action === "start") start();
      if (action === "stop") stop();
      if (action === "api-collect") startApiCollect();
      if (action === "json") exportJson();
      if (action === "csv") exportCsv();
      if (action === "prompt-summary") exportPromptMarkdown(true);
      if (action === "prompt-compact") exportPromptMarkdown(false);
      if (action === "clear") clearItems();
      if (action === "activity-page") ensureActivityPage();
      if (action === "trim-page") trimOldCards();
    });

    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.previewAction;
      if (!action) return;

      const preview = document.querySelector("#zhihu-activity-watcher-preview");
      if (action === "close") {
        if (preview) preview.remove();
        return;
      }

      if (action === "copy") {
        const textarea = preview ? preview.querySelector("textarea") : null;
        if (!(textarea instanceof HTMLTextAreaElement)) return;
        textarea.select();
        try {
          await navigator.clipboard.writeText(textarea.value);
        } catch {
          document.execCommand("copy");
        }
      }
    });

    panel.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.dataset.field !== "intervalMs") return;
      state.settings.intervalMs = Math.max(100, Number(target.value) || 2800);
      saveJson(SETTINGS_KEY, state.settings);
      updatePanel();
    });

    updatePanel();
  }

  function updatePanel(message) {
    const panel = document.querySelector("#zhihu-activity-watcher-panel");
    if (!panel) return;
    const status = panel.querySelector(".zaw-status");
    const intervalInput = panel.querySelector("[data-field='intervalMs']");

    if (status) {
      const parts = [
        state.running ? "运行中" : "已暂停",
        `${state.items.length} 条`,
        state.apiRunning ? `API直采 ${state.apiPageCount}页` : `API ${state.apiAddedCount}`,
        `空闲 ${state.idleRounds}/${state.settings.maxIdleRounds}`,
      ];
      if (message) parts.push(message);
      status.textContent = parts.join(" · ");
    }

    if (intervalInput instanceof HTMLInputElement && document.activeElement !== intervalInput) {
      intervalInput.value = String(state.settings.intervalMs);
    }
  }

  function boot() {
    if (document.querySelector("#zhihu-activity-watcher-panel")) return;
    createPanel();
    collectVisibleItems();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
