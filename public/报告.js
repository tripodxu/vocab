/**
 * 报告.js —— 学习报告 / 控制台（报告.html）
 *
 * 数据边界：
 *  - 词状态/每日目标（settings.daily）来自云端同步的存档；易错权重与分模式
 *    台账（modes）是本机数据，界面明确标注「仅本机」；
 *  - 全部聚合在浏览器本地完成，唯一网络请求是登录用户的「我的报错」
 *    （GET /api/quiz/report/mine）；不新增任何写接口；
 *  - 命名空间复用 vocab-auth 的账号解析：登录但资料未验证时先按 guest 展示，
 *    验证完成后 onAuthChange 触发重渲染。
 */
import { CHAPTERS } from "./chapters.js";
import Auth from "./vocab-auth.js";
import { normalizeModeLedger, normalizeWeights } from "./core.js";
import { $, el, initTheme } from "./ui.js";

const C = 251.33; // 2πr（r=40）

/** el() 只能建 HTML 元素；SVG 要走 createElementNS */
function svgEl(tag, props = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(key, value === true ? "" : String(value));
  }
  return node;
}

const state = {
  userKey: "guest",
  lastRender: 0,
};

function storageKey(userKey) {
  return `vocab:v3:${userKey}`;
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readBlob() {
  const blob = readJSON(storageKey(state.userKey)) || {};
  return {
    settings: blob.settings && typeof blob.settings === "object" ? blob.settings : {},
    words: blob.words && typeof blob.words === "object" ? blob.words : {},
    modes: normalizeModeLedger(blob.modes),
    weights: normalizeWeights(blob.weights),
  };
}

function readStars() {
  // 返回按章聚合的生词数：{ "1": 3, "2": 1 }
  const records = readJSON(`vocab:star-records:${state.userKey}`) || {};
  const perChapter = {};
  for (const [key, item] of Object.entries(records)) {
    if (!item || !item.starred) continue;
    const c = String(key.split(":")[0]);
    perChapter[c] = (perChapter[c] || 0) + 1;
  }
  return perChapter;
}

function localDateKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 每题的本地时间戳：seen 只保留最后一次，at 取权重时间戳与 seen 的较大者 */
function touchedAt(entry) {
  return Math.max(Number(entry?.seen) || 0, Number(entry?.at) || 0);
}

/* ============ 聚合 ============ */

function aggregate(blob) {
  const perChapter = new Map(); // chapter -> {mastered, learning, wrong, words}
  const days = new Map(); // dateKey -> count
  for (let i = 0; i < 7; i++) days.set(localDateKey(-i), 0);
  const modeTotals = {
    spell: { c: 0, t: 0 },
    choice: { c: 0, t: 0 },
  };
  for (const entry of Object.values(blob.words)) {
    if (!entry) continue;
    const ch = String(entry.c);
    const bucket = perChapter.get(ch) || { mastered: 0, learning: 0, wrong: 0 };
    if (entry.s === "mastered") bucket.mastered++;
    else if (entry.s === "wrong") bucket.wrong++;
    else bucket.learning++;
    perChapter.set(ch, bucket);
    // 近 7 天活跃：seen 是最后一次作答时间（毫秒），落在哪天算哪天的活跃
    const seen = Number(entry.seen) || 0;
    if (seen > 0) {
      const key = localDateKeyFromTs(seen);
      if (days.has(key)) days.set(key, (days.get(key) || 0) + 1);
    }
  }
  for (const ledger of Object.values(blob.modes)) {
    for (const mode of ["spell", "choice"]) {
      const m = ledger?.[mode];
      if (!m) continue;
      modeTotals[mode].c += Number(m.c) || 0;
      modeTotals[mode].t += Number(m.w) || 0;
    }
  }
  return { perChapter, days, modeTotals };
}

function localDateKeyFromTs(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/* ============ 渲染 ============ */

function sectionCard(title, note, body) {
  return el("section", { class: "card report-section" }, [
    el("h2", { class: "section-h", text: title }),
    note ? el("p", { class: "local-note", text: note }) : el("span"),
    body,
  ]);
}

function renderHero(blob) {
  const daily = blob.settings.daily || {};
  const count = Math.max(0, Number(daily.count) || 0);
  const target = Math.max(1, Number(daily.target) || 50);
  const pct = Math.min(1, count / target);
  const streak = Number(daily.streak) || 0;
  const best = Math.max(streak, Number(daily.best) || 0);
  const total = Math.max(0, Number(daily.total) || 0);
  const stat = (label, value) => el("div", { class: "stat-card" }, [el("b", { text: String(value) }), el("small", { text: label })]);
  return el("section", { class: "card report-hero" }, [
    el("div", { class: `report-ring${pct >= 1 ? " done" : ""}`, role: "img", "aria-label": `今日目标 ${count}/${target}` }, [
      (() => {
        const svg = svgEl("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });
        svg.append(
          svgEl("circle", { class: "ring-bg", cx: "50", cy: "50", r: "40" }),
          (() => {
            const fg = svgEl("circle", { class: "ring-fg", cx: "50", cy: "50", r: "40" });
            fg.style.strokeDashoffset = String(C * (1 - pct));
            return fg;
          })()
        );
        return svg;
      })(),
      el("span", { class: "ring-num", text: String(count) }),
      el("span", { class: "ring-sub", text: `目标 ${target}` }),
    ]),
    stat("今日进度", `${count}/${target}`),
    stat("连续天数", streak),
    stat("历史最佳", best),
    stat("累计答题", total),
  ]);
}

function renderBars(days) {
  const max = Math.max(1, ...days.values());
  const today = localDateKey();
  const cols = [...days.entries()].reverse().map(([date, n]) => {
    const label = date === today ? "今天" : date.slice(5);
    return el("div", { class: `bar-col${date === today ? " today" : ""}` }, [
      el("span", { class: "bar-num", text: String(n) }),
      el("div", { class: "bar", style: `height:${Math.max(2, Math.round((n / max) * 100))}%`, title: `${date} · ${n} 词` }),
      el("span", { class: "bar-day", text: label }),
    ]);
  });
  return el("div", { class: "report-bars", role: "img", "aria-label": "近 7 天每天作答的词数" }, cols);
}

function renderChapters(perChapter, stars) {
  const cells = CHAPTERS.map((ch) => {
    const bucket = perChapter.get(String(ch.id)) || { mastered: 0, learning: 0, wrong: 0 };
    const total = Math.max(1, Number(ch.count) || 0);
    const pct = Math.min(1, bucket.mastered / total);
    const fill = el("div", { class: "mini-fill" });
    fill.style.transform = `scaleX(${pct})`;
    const starCount = stars[String(ch.id)];
    return el("a", { class: "chapter-cell", href: `index.html?chapter=${ch.id}` }, [
      el("span", { class: "ch-name" }, [
        el("span", { text: `第${ch.id}章 ${ch.title}` }),
        el("span", { class: "ch-count", text: `${bucket.mastered}/${total}` }),
      ]),
      el("div", { class: "mini-track" }, [fill]),
      el("span", { class: "ch-meta" }, [
        el("span", { text: `学习中 ${bucket.learning}` }),
        el("span", { class: "wrong", text: `易错 ${bucket.wrong}` }),
        el("span", { text: starCount ? `生词 ${starCount}` : "" }),
      ]),
    ]);
  });
  return el("div", { class: "chapter-grid" }, cells);
}

async function renderWrongWords(weights) {
  const list = Object.entries(weights)
    .sort((a, b) => (b[1].w || 0) - (a[1].w || 0))
    .slice(0, 24);
  if (!list.length) {
    return el("p", { class: "empty", text: "还没有易错词——答错的词会自动进入这里（按复现权重排序）" });
  }
  // 词面按章节懒加载（浏览器自身缓存 data JSON）
  const chaptersNeeded = [...new Set(list.map(([key]) => key.split(":")[0]))];
  await Promise.all(chaptersNeeded.map((c) => wordList(Number(c))));
  const rows = list.map(([key, w]) => {
    const [c, wordId] = key.split(":").map(Number);
    const face = wordFace(c, wordId);
    return el("a", { class: "report-row", href: `index.html?chapter=${c}` }, [
      el("div", { class: "row-main" }, [
        el("b", { text: face }),
        el("small", { text: `第${c}章 · 答错 ${w.bad || 0} 次 / 答对 ${w.ok || 0} 次` }),
      ]),
      el("div", { class: "row-side mono", text: `×${(w.w || 1).toFixed(1)}` }),
    ]);
  });
  return el("div", { class: "report-list" }, rows);
}

const wordCache = new Map(); // chapter -> Map(wordId -> word)

async function wordList(chapter) {
  if (wordCache.has(chapter)) return wordCache.get(chapter);
  try {
    const list = await fetch(`data-${chapter}.json`).then((r) => r.json());
    const map = new Map(list.map((w) => [Number(w.id), String(w.word)]));
    wordCache.set(chapter, map);
    return map;
  } catch {
    wordCache.set(chapter, new Map());
    return new Map();
  }
}

function wordFace(chapter, wordId) {
  return wordCache.get(chapter)?.get(wordId) || `#${wordId}`;
}

function renderModes(modeTotals) {
  const row = (label, m) => {
    const acc = m.t ? Math.round((m.c / m.t) * 100) : null;
    return el("div", { class: "stat-card" }, [
      el("b", { text: acc === null ? "—" : `${acc}%` }),
      el("small", { text: `${label} ${m.c}/${m.t}` }),
    ]);
  };
  return el("div", { class: "stat-grid" }, [row("拼写正确率", modeTotals.spell), row("认词正确率", modeTotals.choice)]);
}

async function renderMyReports(loggedIn) {
  if (!loggedIn) {
    return el("p", { class: "empty", text: "登录后可在这里看到你提交过的报错与处理状态" });
  }
  try {
    const res = await fetch("/api/quiz/report/mine", {
      headers: { authorization: `Bearer ${Auth.token()}` },
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (!data.reports?.length) {
      return el("p", { class: "empty", text: "还没有提交过报错——在辨析卡上点报错按钮可以反馈题目问题" });
    }
    const rows = data.reports.map((r) =>
      el("div", { class: "report-row" }, [
        el("div", { class: "row-main" }, [
          el("b", { text: `第${r.chapter}章 · 词 #${r.wordId}` }),
          el("small", { text: `${r.note || r.kind} · ${String(r.createdAt || "").slice(0, 10)}` }),
        ]),
        el("span", { class: `badge ${r.status}`, text: r.status === "handled" ? "已处理" : "待处理" }),
      ])
    );
    return el("div", { class: "report-list" }, rows);
  } catch {
    return el("p", { class: "empty", text: "报错记录加载失败，请稍后重试" });
  }
}

/* ============ 主渲染 ============ */

async function render() {
  state.lastRender++;
  const blob = readBlob();
  const stars = readStars();
  const { perChapter, days, modeTotals } = aggregate(blob);
  const daily = blob.settings.daily || {};
  $("#reportSub").textContent = state.userKey === "guest" ? "本机（游客）数据" : `账号 ${Auth.nickname() || Auth.email() || state.userKey}`;

  const root = $("#reportRoot");
  root.replaceChildren(
    renderHero(blob),
    sectionCard("近 7 天活跃", "按词的最后一次作答时间统计；同一词多天重复作答只计入最后一天。", renderBars(days)),
    sectionCard("章节进度", "点章节卡直达该章练习。", renderChapters(perChapter, stars)),
    sectionCard("易错词总览", "仅本机数据（不同步云端），按复现权重降序。", await renderWrongWords(blob.weights)),
    sectionCard("分模式成绩", "仅本机数据；拼写与认词分开记账。", renderModes(modeTotals)),
    sectionCard(
      "我的报错",
      null,
      await renderMyReports(Auth.isLoggedIn() && state.userKey !== "guest")
    )
  );
}

/* ============ 启动 ============ */

async function boot() {
  initTheme();
  Auth.onAuthChange(async (user) => {
    const nextKey = user ? `u${user.userId}` : "guest";
    if (nextKey === state.userKey) return;
    state.userKey = nextKey;
    wordCache.clear();
    await render();
  });
  // init 完成后 onAuthChange 的首次回调会触发第一次 render；网络失败时这里兜底渲染 guest
  const user = await Auth.init().catch(() => null);
  // 有 token 但资料没验证成功（网络失败）才提示离线；纯未登录不提示
  if (!user && state.userKey === "guest" && Auth.token()) {
    $("#offlineHint").hidden = false;
  }
  if (!state.lastRender) {
    try {
      await render();
    } catch (err) {
      $("#offlineHint").hidden = false;
      $("#offlineHint").textContent = `报告生成失败：${err instanceof Error ? err.message : String(err)}`;
      $("#reportRoot").replaceChildren();
    }
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot());
  else void boot();
}

export { boot };
