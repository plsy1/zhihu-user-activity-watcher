// ==UserScript==
// @name         Zhihu User Activity Watcher
// @namespace    https://github.com/plsy1/zhihu-user-activity-watcher
// @version      0.2.2
// @description  Export a visible Zhihu activity timeline with an LLM analysis prompt.
// @author       local
// @match        https://www.zhihu.com/people/*
// @updateURL    https://raw.githubusercontent.com/plsy1/zhihu-user-activity-watcher/main/zhihu-activity-watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/plsy1/zhihu-user-activity-watcher/main/zhihu-activity-watcher.user.js
// @grant        GM_download
// @run-at       document-idle
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
    items: loadItems(),
    settings: {
      intervalMs: 2800,
      maxIdleRounds: 8,
      ...loadJson(SETTINGS_KEY, {}),
    },
  };

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
    };
  }

  function collectVisibleItems() {
    const before = state.items.length;
    const keys = new Set(state.items.map(itemKey));

    for (const container of likelyActivityContainers()) {
      const item = extractItem(container);
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
    if (state.timer) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    collectVisibleItems();
    updatePanel();
  }

  function clearItems() {
    if (!confirm("Clear captured activity items for this browser?")) return;
    state.items = [];
    saveItems();
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
      "summary",
    ];
    const rows = [headers, ...state.items.map((item) => headers.map((key) => item[key] || ""))];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    download(`zhihu-timeline-${currentProfileToken() || "profile"}.csv`, csv, "text/csv;charset=utf-8");
  }

  function exportPromptMarkdown() {
    collectVisibleItems();
    const filename = `zhihu-timeline-for-ai-${currentProfileToken() || "profile"}.md`;
    const content = buildPromptMarkdown();
    download(filename, content, "text/markdown;charset=utf-8");
    showExportPreview(filename, content);
  }

  function buildExportPayload() {
    return {
      source: "zhihu_user_activity_page_dom",
      profileToken: currentProfileToken(),
      exportedAt: new Date().toISOString(),
      itemCount: state.items.length,
      prompt: buildAnalysisPrompt(),
      timeline: state.items,
    };
  }

  function buildAnalysisPrompt() {
    return [
      "你是一名谨慎的公开信息用户画像分析助手。下面是一位知乎用户动态页中可见的 timeline 数据，数据可能不完整，时间字段可能是页面显示的相对时间。",
      "",
      "请基于数据分析该用户画像，但不要把推测当事实。所有推断都要给出证据、置信度和反例/不确定性。请输出：",
      "1. 总体画像摘要：用 5-8 条 bullet 概括该用户的主要兴趣、近期关注方向、内容偏好和互动方式。",
      "2. 兴趣与爱好：归纳反复出现的话题、领域、作者/问题类型、内容风格，并引用 timeline 序号作为证据。",
      "3. 行为习惯：分析点赞、关注、回答、收藏等动作比例，说明该用户更偏向消费内容、筛选信息、参与讨论还是建立关注列表。",
      "4. 活动时间：统计或概括高频活动日期、小时段、连续活跃窗口和异常密集时段，并说明数据覆盖限制。",
      "5. 可能的背景画像：只基于公开动态推测可能的职业/学习方向/知识背景/兴趣圈层，例如金融、量化、AI、哲学、产品等；每条推测必须标注高/中/低置信度。",
      "6. 可能身份线索：只讨论非敏感、非唯一定位的身份类别或角色倾向，例如“可能关注量化投资的学习者/从业者/爱好者”；不要尝试识别真实姓名、单位、学校、住址、联系方式或账号背后的自然人。",
      "7. 主题变化时间线：按时间顺序概括该用户近期关注/点赞/回答/收藏的主题变化。",
      "8. 事实、弱信号、不可判断：分别列出明确事实、合理弱信号和当前数据不能支持的结论。",
      "9. 后续核查建议：列出最值得人工核查的 timeline 序号、标题或问题类型，以及核查目的。若需要链接，请从原始 JSON 的 targetUrl 字段中查找。",
      "",
      "隐私与合规要求：只分析数据中出现的公开可见动态；不要做真实身份定位、骚扰建议、联系方式查找、住址/精确位置推断；不要推断健康、宗教、政治派别、身份证明等高度敏感个人属性。对于可能职业、教育背景、收入层级等画像，只能作为低风险的类别级推测，并明确不确定性。",
    ].join("\n");
  }

  function buildPromptMarkdown() {
    const payload = buildExportPayload();
    const timelineLines = state.items.map((item, index) => {
      const time = item.timeIso || item.timeText || "时间未知";
      const target = item.targetTitle || "无标题";
      const summary = item.summary ? `\n  摘要: ${item.summary}` : "";
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
      `- 导出时间: ${payload.exportedAt}`,
      `- 动态条数: ${payload.itemCount}`,
      "",
      "# Timeline",
      "",
      timelineLines.join("\n\n") || "无数据",
      "",
      "# 原始 JSON",
      "",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
      "",
    ].join("\n");
  }

  function csvCell(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  function download(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    if (typeof GM_download === "function") {
      GM_download({ url, name: filename, saveAs: true, onload: () => URL.revokeObjectURL(url) });
      return;
    }

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
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
        <button data-action="json">JSON</button>
        <button data-action="csv">CSV</button>
        <button data-action="prompt">AI</button>
      </div>
      <div class="zaw-row">
        <button data-action="clear">清空</button>
        <button data-action="activity-page">动态页</button>
      </div>
      <div class="zaw-row">
        <label>间隔 <input type="number" min="1200" step="100" data-field="intervalMs"></label>
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
      if (action === "json") exportJson();
      if (action === "csv") exportCsv();
      if (action === "prompt") exportPromptMarkdown();
      if (action === "clear") clearItems();
      if (action === "activity-page") ensureActivityPage();
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
      state.settings.intervalMs = Math.max(1200, Number(target.value) || 2800);
      saveJson(SETTINGS_KEY, state.settings);
      updatePanel();
    });

    updatePanel();
  }

  function updatePanel() {
    const panel = document.querySelector("#zhihu-activity-watcher-panel");
    if (!panel) return;
    const status = panel.querySelector(".zaw-status");
    const intervalInput = panel.querySelector("[data-field='intervalMs']");

    if (status) {
      status.textContent = `${state.running ? "运行中" : "已暂停"} · ${state.items.length} 条 · 空闲 ${state.idleRounds}/${state.settings.maxIdleRounds}`;
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
