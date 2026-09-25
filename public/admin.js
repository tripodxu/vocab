/**
 * admin.js —— 后台管理页（/admin.html）
 *
 * 鉴权：管理令牌只存 sessionStorage（关浏览器即清），所有 /api/admin/* 请求带
 * Bearer header；401 时回到登录门。无任何第三方依赖，颜色走 tokens 语义变量。
 */
import { $, el, toast } from "./ui.js";

const TOKEN_KEY = "vocab:admin-token";

const KIND_LABEL = {
  similar: "选项过近",
  "options-wrong": "选项有误",
  "meaning-wrong": "释义有误",
  other: "其他",
};

const sessionStore =
  typeof sessionStorage !== "undefined"
    ? sessionStorage
    : {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      };

const state = {
  token: sessionStore.getItem(TOKEN_KEY) || "",
  reportsOffset: 0,
  usersOffset: 0,
  wordFaceCache: new Map(), // chapter -> Map(wordId -> word)
};

function isAdminToken(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 200;
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    return { ok: false, status: 0, data: null, msg: "网络连接失败" };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) {
    setToken("");
    showGate("管理令牌已失效，请重新输入");
    return { ok: false, status: 401, data, msg: data?.msg || "管理令牌无效" };
  }
  return { ok: res.ok, status: res.status, data, msg: data?.msg };
}

function setToken(token) {
  state.token = token;
  try {
    if (token) sessionStore.setItem(TOKEN_KEY, token);
    else sessionStore.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式等 storage 不可用：仅本页内存持有 */
  }
  $("#logoutAdmin").hidden = !token;
}

function showGate(message = "") {
  $("#gateError").textContent = message;
  $("#loginGate").hidden = false;
  $("#console").hidden = true;
}

function showConsole() {
  $("#loginGate").hidden = true;
  $("#console").hidden = false;
  void renderOverview();
}

/* ============ 总览 ============ */

async function renderOverview() {
  const panel = $("#tab-overview");
  panel.replaceChildren(el("p", { class: "empty", text: "加载中…" }));
  const res = await api("/api/admin/overview");
  if (!res.ok) {
    panel.replaceChildren(el("p", { class: "empty", text: res.msg || "加载失败" }));
    return;
  }
  const d = res.data;
  const card = (label, value, warn = false) =>
    el("div", { class: `stat-card${warn ? " warn" : ""}` }, [el("b", { text: String(value) }), el("small", { text: label })]);
  panel.replaceChildren(
    el("div", { class: "stat-grid" }, [
      card("注册用户", d.users),
      card("活跃会话", d.activeSessions),
      card("近 7 天新增用户", d.newUsers),
      card("报错总数", d.reports),
      card("待处理报错", d.openReports, d.openReports > 0),
      card("近 7 天报错", d.newReports),
    ])
  );
}

/* ============ 报错 ============ */

async function wordFace(chapter, wordId) {
  if (!state.wordFaceCache.has(chapter)) {
    try {
      const list = await fetch(`/data-${chapter}.json`).then((r) => r.json());
      const map = new Map(list.map((w) => [Number(w.id), String(w.word)]));
      state.wordFaceCache.set(chapter, map);
    } catch {
      state.wordFaceCache.set(chapter, new Map());
    }
  }
  return state.wordFaceCache.get(chapter)?.get(wordId) || `#${wordId}`;
}

/** 导出全部报错为 CSV（/api/quiz/report/export，Bearer 鉴权） */
async function exportReportsCsv(btn) {
  btn.disabled = true;
  try {
    const res = await fetch("/api/quiz/report/export", {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (res.status === 401) {
      setToken("");
      showGate("管理令牌已失效，请重新输入");
      return;
    }
    if (!res.ok) {
      toast("导出失败，请稍后重试", { type: "bad" });
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `question-reports-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("已导出 CSV", { type: "ok" });
  } catch {
    toast("导出失败，请稍后重试", { type: "bad" });
  } finally {
    btn.disabled = false;
  }
}

async function renderReports() {
  const panel = $("#tab-reports");
  const kind = panel.dataset.kind || "";
  const status = panel.dataset.status || "";
  const q = panel.dataset.q || "";
  panel.replaceChildren(el("p", { class: "empty", text: "加载中…" }));
  const params = new URLSearchParams({ limit: "50", offset: String(state.reportsOffset) });
  if (kind) params.set("kind", kind);
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  const res = await api(`/api/admin/reports?${params}`);
  if (!res.ok) {
    panel.replaceChildren(el("p", { class: "empty", text: res.msg || "加载失败" }));
    return;
  }
  const { total, reports } = res.data;

  const kindSel = el(
    "select",
    { "aria-label": "按类型筛选" },
    [
      el("option", { value: "", text: "全部类型" }),
      ...Object.entries(KIND_LABEL).map(([value, label]) => el("option", { value, text: label, selected: value === kind })),
    ]
  );
  kindSel.addEventListener("change", () => {
    panel.dataset.kind = kindSel.value;
    state.reportsOffset = 0;
    void renderReports();
  });
  const statusSel = el("select", { "aria-label": "按状态筛选" }, [
    el("option", { value: "", text: "全部状态" }),
    el("option", { value: "open", text: "待处理", selected: status === "open" }),
    el("option", { value: "handled", text: "已处理", selected: status === "handled" }),
  ]);
  statusSel.addEventListener("change", () => {
    panel.dataset.status = statusSel.value;
    state.reportsOffset = 0;
    void renderReports();
  });
  const qInput = el("input", { class: "input", type: "search", placeholder: "搜备注或邮箱", value: q, "aria-label": "搜索备注或邮箱" });
  let qTimer = 0;
  qInput.addEventListener("input", () => {
    window.clearTimeout(qTimer);
    qTimer = window.setTimeout(() => {
      panel.dataset.q = qInput.value.trim();
      state.reportsOffset = 0;
      void renderReports();
    }, 300);
  });

  const rows = await Promise.all(
    reports.map(async (r) => {
      const face = await wordFace(r.chapter, r.wordId);
      const badge = el("span", { class: `badge ${r.status}`, text: r.status === "handled" ? "已处理" : "待处理" });
      const toggle = el("button", {
        class: "btn btn-sm",
        type: "button",
        text: r.status === "handled" ? "重新打开" : "标记已处理",
        onclick: async () => {
          toggle.disabled = true;
          const next = r.status === "handled" ? "open" : "handled";
          const res2 = await api(`/api/admin/reports/${r.id}`, { method: "PATCH", body: { status: next } });
          toggle.disabled = false;
          if (!res2.ok) {
            toast(res2.msg || "操作失败", { type: "bad" });
            return;
          }
          toast(next === "handled" ? "已标记处理" : "已重新打开", { type: "ok" });
          void renderReports();
          void renderOverview();
        },
      });
      return el("tr", {}, [
        el("td", { class: "mono", text: r.createdAt.replace("T", " ").slice(0, 16) }),
        el("td", { text: r.userEmail || `用户 ${r.userId}` }),
        el("td", { class: "mono", text: `第${r.chapter}章` }),
        el("td", { class: "mono", text: face }),
        el("td", { text: KIND_LABEL[r.kind] || r.kind }),
        el("td", {}, [el("span", { class: "note", text: r.note || "—" })]),
        el("td", {}, [badge]),
        el("td", {}, [toggle]),
      ]);
    })
  );

  const table = el("table", { class: "admin-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "时间" }),
        el("th", { text: "用户" }),
        el("th", { text: "章节" }),
        el("th", { text: "词" }),
        el("th", { text: "类型" }),
        el("th", { text: "备注" }),
        el("th", { text: "状态" }),
        el("th", { text: "操作" }),
      ]),
    ]),
    el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "8" }, [el("p", { class: "empty", text: "没有匹配的报错" })])])]),
  ]);

  const pageStart = total === 0 ? 0 : state.reportsOffset + 1;
  const pageEnd = Math.min(total, state.reportsOffset + 50);
  const prev = el("button", { class: "btn btn-sm", type: "button", text: "上一页", disabled: String(state.reportsOffset <= 0) });
  prev.addEventListener("click", () => {
    state.reportsOffset = Math.max(0, state.reportsOffset - 50);
    void renderReports();
  });
  const next = el("button", { class: "btn btn-sm", type: "button", text: "下一页", disabled: String(pageEnd >= total) });
  next.addEventListener("click", () => {
    state.reportsOffset += 50;
    void renderReports();
  });

  const exportBtn = el("button", { class: "btn btn-sm", type: "button", text: "导出 CSV", title: "下载全部报错（含已处理），CSV 可用 Excel 打开" });
  exportBtn.addEventListener("click", () => void exportReportsCsv(exportBtn));

  panel.replaceChildren(
    el("div", { class: "admin-filters" }, [kindSel, statusSel, qInput, exportBtn]),
    el("div", { class: "table-scroll" }, [table]),
    ...(total > 0
      ? [el("div", { class: "admin-pager" }, [el("span", { text: `${pageStart}-${pageEnd} / ${total}` }), prev, next])]
      : [])
  );
}

/* ============ 用户 ============ */

async function renderUsers() {
  const panel = $("#tab-users");
  const q = panel.dataset.q || "";
  panel.replaceChildren(el("p", { class: "empty", text: "加载中…" }));
  const params = new URLSearchParams({ limit: "50", offset: String(state.usersOffset) });
  if (q) params.set("q", q);
  const res = await api(`/api/admin/users?${params}`);
  if (!res.ok) {
    panel.replaceChildren(el("p", { class: "empty", text: res.msg || "加载失败" }));
    return;
  }
  const { total, users } = res.data;

  const qInput = el("input", { class: "input", type: "search", placeholder: "搜邮箱或昵称", value: q, "aria-label": "搜索邮箱或昵称" });
  let qTimer = 0;
  qInput.addEventListener("input", () => {
    window.clearTimeout(qTimer);
    qTimer = window.setTimeout(() => {
      panel.dataset.q = qInput.value.trim();
      state.usersOffset = 0;
      void renderUsers();
    }, 300);
  });

  const fmtActive = (ts) => {
    if (!ts) return "—";
    const days = Math.floor((Date.now() - ts) / 86_400_000);
    return days <= 0 ? "今天" : `${days} 天前`;
  };

  const rows = users.map((u) => {
    const tr = el("tr", { tabindex: "0", role: "button", "aria-label": `查看 ${u.email} 的详情` }, [
      el("td", { class: "mono", text: `#${u.id}` }),
      el("td", { text: u.email }),
      el("td", { text: u.nickname || "—" }),
      el("td", { class: "mono", text: String(u.createdAt || "—").slice(0, 10) }),
      el("td", { text: fmtActive(u.lastSeen) }),
      el("td", { class: "mono", text: String(u.stars) }),
      el("td", { class: "mono", text: String(u.notes) }),
    ]);
    const activate = () => toggleDetail(tr, u.id);
    tr.addEventListener("click", activate);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    return tr;
  });

  const table = el("table", { class: "admin-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "ID" }),
        el("th", { text: "邮箱" }),
        el("th", { text: "昵称" }),
        el("th", { text: "注册" }),
        el("th", { text: "最近活跃" }),
        el("th", { text: "生词" }),
        el("th", { text: "备注" }),
      ]),
    ]),
    el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "7" }, [el("p", { class: "empty", text: "没有匹配的用户" })])])]),
  ]);

  const pageStart = total === 0 ? 0 : state.usersOffset + 1;
  const pageEnd = Math.min(total, state.usersOffset + 50);
  const prev = el("button", { class: "btn btn-sm", type: "button", text: "上一页", disabled: String(state.usersOffset <= 0) });
  prev.addEventListener("click", () => {
    state.usersOffset = Math.max(0, state.usersOffset - 50);
    void renderUsers();
  });
  const next = el("button", { class: "btn btn-sm", type: "button", text: "下一页", disabled: String(pageEnd >= total) });
  next.addEventListener("click", () => {
    state.usersOffset += 50;
    void renderUsers();
  });

  panel.replaceChildren(
    el("div", { class: "admin-filters" }, [qInput]),
    el("div", { class: "table-scroll" }, [table]),
    ...(total > 0
      ? [el("div", { class: "admin-pager" }, [el("span", { text: `${pageStart}-${pageEnd} / ${total}` }), prev, next])]
      : [])
  );
}

async function toggleDetail(tr, userId) {
  const existing = tr.nextElementSibling;
  if (existing?.classList?.contains("admin-detail-row")) {
    existing.remove();
    return;
  }
  document.querySelectorAll(".admin-detail-row").forEach((n) => n.remove());
  const detailRow = el("tr", { class: "admin-detail-row" }, [el("td", { colspan: "7" }, [el("div", { class: "admin-detail" }, [el("p", { class: "empty", text: "加载详情…" })])])]);
  tr.after(detailRow);
  const res = await api(`/api/admin/users/${userId}`);
  const box = detailRow.querySelector(".admin-detail");
  if (!res.ok) {
    box.replaceChildren(el("p", { class: "empty", text: res.msg || "详情加载失败" }));
    return;
  }
  const d = res.data;
  const chips = Object.entries(d.chapters)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([ch, s]) => el("span", { class: "badge", text: `第${ch}章 掌握${s.mastered} · 错${s.wrong} · 学${s.learning}` }));
  const reports = d.reports.length
    ? el("div", {}, [el("small", { class: "muted", text: `报错 ${d.reports.length} 条` }), el("div", { class: "chips" }, d.reports.slice(0, 5).map((r) => el("span", { class: `badge ${r.status}`, text: `第${r.chapter}章 #${r.wordId} ${KIND_LABEL[r.kind] || r.kind}` })))])
    : el("small", { class: "muted", text: "暂无报错" });
  box.replaceChildren(
    el("div", { class: "chips" }, [
      el("span", { class: "badge", text: d.nickname || "无昵称" }),
      el("span", { class: "badge", text: d.email }),
      el("span", { class: "badge", text: `注册于 ${String(d.createdAt || "—").slice(0, 10)}` }),
    ]),
    chips.length ? el("div", { class: "chips" }, chips) : el("small", { class: "muted", text: "尚无学习记录" }),
    reports
  );
}

/* ============ Tab 切换与启动 ============ */

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll(".admin-tabs [role=tab]"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
      for (const panel of document.querySelectorAll(".admin-panel")) panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
      if (tab.dataset.tab === "overview") void renderOverview();
      if (tab.dataset.tab === "reports") void renderReports();
      if (tab.dataset.tab === "users") void renderUsers();
    });
  }
}

function boot() {
  bindTabs();
  $("#logoutAdmin").addEventListener("click", () => {
    setToken("");
    showGate("已清除本机令牌");
  });
  $("#gateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#adminToken");
    const value = input.value.trim();
    if (!isAdminToken(value)) {
      $("#gateError").textContent = "令牌格式不正确";
      return;
    }
    setToken(value);
    const probe = await api("/api/admin/overview");
    if (!probe.ok) {
      if (probe.status !== 401) showGate(probe.msg || "校验失败");
      input.value = "";
      return;
    }
    input.value = "";
    showConsole();
  });
  // 已有令牌（本标签页）→ 直接探测进入
  if (isAdminToken(state.token)) {
    void api("/api/admin/overview").then((probe) => {
      if (probe.ok) showConsole();
      else if (probe.status !== 401) showGate(probe.msg || "校验失败");
    });
  } else {
    setToken("");
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot());
  else void boot();
}

export { boot };
