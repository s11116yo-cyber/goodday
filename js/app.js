(function () {
  "use strict";
  const cfg = window.APP_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const main = $("#main");
  const STATUS = { todo: "待辦", doing: "進行中", done: "完成" };
  const PRI = { high: "高", medium: "中", low: "低" };
  const WD = ["日", "一", "二", "三", "四", "五", "六"];

  let db, tasks = [], rules = [];
  let view = "board";
  let calMonth = new Date(); calMonth.setDate(1);
  let reportOffset = 0;

  // ---------- 小工具 ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const todayStr = () => ymd(new Date());
  const mmdd = (s) => s ? s.slice(5).replace("-", "/") : "";
  function setMsg(t) { $("#status-msg").textContent = t || ""; }
  function dueClass(t) {
    if (!t.due_date || t.status === "done") return "";
    const diff = (parseYmd(t.due_date) - parseYmd(todayStr())) / 864e5;
    return diff < 0 ? "overdue" : diff <= 2 ? "soon" : "";
  }

  // ---------- 初始化 ----------
  async function init() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      $("#setup").hidden = false; $("#filters").hidden = true;
      main.innerHTML = ""; return;
    }
    db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    await loadAll();
    await generateRecurring();
    render();
    let t;
    db.channel("tasks-live").on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => {
      clearTimeout(t); t = setTimeout(async () => { await loadAll(); render(); }, 400);
    }).subscribe();
  }

  async function loadAll() {
    const [a, b] = await Promise.all([
      db.from("tasks").select("*").order("created_at", { ascending: false }),
      db.from("recurring_rules").select("*").order("created_at"),
    ]);
    if (a.error || b.error) { setMsg("讀取失敗：" + (a.error || b.error).message + "（是否已執行 schema.sql？）"); return; }
    tasks = a.data; rules = b.data;
    refreshFilters();
  }

  function refreshFilters() {
    const uniq = (k) => [...new Set(tasks.map((t) => t[k]).filter(Boolean))].sort();
    for (const [id, key, label, dl] of [["f-client", "client", "全部客戶", "dl-client"], ["f-assignee", "assignee", "全部負責人", "dl-assignee"]]) {
      const sel = $("#" + id), cur = sel.value, vals = uniq(key);
      sel.innerHTML = `<option value="">${label}</option>` + vals.map((v) => `<option>${esc(v)}</option>`).join("");
      sel.value = vals.includes(cur) ? cur : "";
      $("#" + dl).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join("");
    }
  }

  function filtered() {
    const q = $("#f-search").value.trim().toLowerCase();
    const c = $("#f-client").value, a = $("#f-assignee").value;
    return tasks.filter((t) =>
      (!c || t.client === c) && (!a || t.assignee === a) &&
      (!q || (t.title + " " + (t.notes || "") + " " + (t.tags || []).join(" ")).toLowerCase().includes(q)));
  }

  // ---------- 自動：重複任務產生 ----------
  async function generateRecurring() {
    const end = addDays(new Date(), 14);
    for (const r of rules.filter((x) => x.active)) {
      let start = r.last_generated ? addDays(parseYmd(r.last_generated), 1) : parseYmd(todayStr());
      const rows = [];
      for (let d = start; d <= end; d = addDays(d, 1)) {
        const hit = r.frequency === "weekly" ? d.getDay() === r.weekday : d.getDate() === r.month_day;
        if (hit) rows.push({
          title: r.title, status: "todo", due_date: ymd(d), assignee: r.assignee, client: r.client,
          priority: r.priority, notes: r.notes, recurring_rule_id: r.id, tags: ["重複"],
        });
      }
      if (rows.length) await db.from("tasks").upsert(rows, { onConflict: "recurring_rule_id,due_date", ignoreDuplicates: true });
      await db.from("recurring_rules").update({ last_generated: ymd(end) }).eq("id", r.id);
    }
    await loadAll();
  }

  // ---------- 畫面切換 ----------
  function render() {
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $("#filters").style.display = ["board", "calendar", "report"].includes(view) ? "" : "none";
    ({ board: renderBoard, calendar: renderCalendar, report: renderReport, recurring: renderRecurring, import: renderImport })[view]();
  }

  // ---------- 看板 ----------
  function card(t) {
    const tags = (t.tags || []).map((x) => `<span class="tag">${esc(x)}</span>`).join("");
    return `<div class="card p-${t.priority}" draggable="true" data-id="${t.id}">
      <div class="t">${esc(t.title)}</div>
      <div class="meta">
        ${t.client ? `<span>🏷 ${esc(t.client)}</span>` : ""}
        ${t.assignee ? `<span>👤 ${esc(t.assignee)}</span>` : ""}
        ${t.due_date ? `<span class="${dueClass(t)}">📅 ${mmdd(t.due_date)}</span>` : ""}
        ${t.shoot_date ? `<span>🎬 ${mmdd(t.shoot_date)}${t.location ? " @" + esc(t.location) : ""}</span>` : ""}
      </div>${tags ? `<div class="meta">${tags}</div>` : ""}</div>`;
  }

  function renderBoard() {
    const list = filtered();
    const n = (s) => list.filter((t) => t.status === s).length;
    const late = list.filter((t) => dueClass(t) === "overdue").length;
    const stat = (num, label, color) => `<div class="stat" style="--c:${color}"><b>${num}</b><span>${label}</span></div>`;
    main.innerHTML = `<div class="stats">${stat(list.length, "全部工作", "var(--primary)")}${stat(n("doing"), "進行中", "var(--doing)")}${stat(n("done"), "已完成", "var(--done)")}${stat(late, "已逾期", "var(--danger)")}</div>` +
      `<div class="board">` + Object.keys(STATUS).map((s) => {
      const items = list.filter((t) => t.status === s)
        .sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
      return `<div class="col" data-status="${s}"><h3><span>${STATUS[s]}</span><span class="muted">${items.length}</span></h3>${items.map(card).join("") || `<div class="empty">拖曳卡片到這裡</div>`}</div>`;
    }).join("") + `</div>`;
    main.querySelectorAll(".card").forEach((el) => {
      el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", el.dataset.id));
      el.addEventListener("click", () => openDialog(tasks.find((t) => t.id === el.dataset.id)));
    });
    main.querySelectorAll(".col").forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
      col.addEventListener("dragleave", () => col.classList.remove("over"));
      col.addEventListener("drop", (e) => {
        e.preventDefault(); col.classList.remove("over");
        moveTask(e.dataTransfer.getData("text/plain"), col.dataset.status);
      });
    });
  }

  async function moveTask(id, status) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === status) return;
    const patch = { status, completed_at: status === "done" ? new Date().toISOString() : null };
    Object.assign(t, patch); render();
    const { error } = await db.from("tasks").update(patch).eq("id", id);
    if (error) { setMsg("更新失敗：" + error.message); await loadAll(); render(); }
  }

  // ---------- 月曆 ----------
  function renderCalendar() {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const first = new Date(y, m, 1), gridStart = addDays(first, -first.getDay());
    const list = filtered(), today = todayStr();
    let cells = WD.map((w) => `<div class="dow">${w}</div>`).join("");
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i), ds = ymd(d);
      const chips = [];
      list.filter((t) => t.shoot_date === ds).forEach((t) => chips.push(`<span class="chip shoot" data-id="${t.id}">🎬 ${esc(t.title)}</span>`));
      list.filter((t) => t.due_date === ds).forEach((t) => chips.push(
        `<span class="chip ${t.status === "done" ? "done" : dueClass(t) === "overdue" ? "late" : ""}" data-id="${t.id}">${esc(t.title)}</span>`));
      cells += `<div class="day ${d.getMonth() !== m ? "other" : ""} ${ds === today ? "today" : ""}" data-date="${ds}"><div class="num">${d.getDate()}</div>${chips.join("")}</div>`;
    }
    main.innerHTML = `<div class="cal-head"><button id="c-prev">◀</button><h2>${y} 年 ${m + 1} 月</h2><button id="c-next">▶</button><button id="c-today">今天</button>
      <span class="muted">紫色＝拍攝日　紅色＝逾期</span></div><div class="cal">${cells}</div>`;
    $("#c-prev").onclick = () => { calMonth = new Date(y, m - 1, 1); renderCalendar(); };
    $("#c-next").onclick = () => { calMonth = new Date(y, m + 1, 1); renderCalendar(); };
    $("#c-today").onclick = () => { calMonth = new Date(); calMonth.setDate(1); renderCalendar(); };
    main.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", (e) => { e.stopPropagation(); openDialog(tasks.find((t) => t.id === c.dataset.id)); }));
    main.querySelectorAll(".day").forEach((d) => d.addEventListener("click", () => openDialog(null, { due_date: d.dataset.date })));
  }

  // ---------- 自動：週報 ----------
  function weekRange(offset) {
    const now = addDays(new Date(), offset * 7), dow = (now.getDay() + 6) % 7; // 週一為起點
    const start = addDays(now, -dow); start.setHours(0, 0, 0, 0);
    return [start, addDays(start, 6)];
  }

  function buildReport() {
    const [s, e] = weekRange(reportOffset), ss = ymd(s), es = ymd(e);
    const list = filtered(), today = todayStr();
    const doneWeek = list.filter((t) => t.status === "done" && t.completed_at && ymd(new Date(t.completed_at)) >= ss && ymd(new Date(t.completed_at)) <= es);
    const doing = list.filter((t) => t.status === "doing");
    const overdue = list.filter((t) => t.status !== "done" && t.due_date && t.due_date < today);
    const [ns, ne] = [ymd(addDays(s, 7)), ymd(addDays(e, 7))];
    const nextDue = list.filter((t) => t.status !== "done" && t.due_date >= ns && t.due_date <= ne);
    const shoots = list.filter((t) => t.shoot_date >= ns && t.shoot_date <= ne);
    const line = (t) => `${t.title}${t.client ? `（${t.client}）` : ""}${t.assignee ? ` @${t.assignee}` : ""}${t.due_date ? ` 截止 ${mmdd(t.due_date)}` : ""}`;
    const sec = (title, arr, fn = line) => ({ title: `${title}（${arr.length}）`, items: arr.map(fn) });
    return {
      range: `${ss} ～ ${es}`,
      sections: [
        sec("✅ 本週完成", doneWeek), sec("🔧 進行中", doing), sec("⚠️ 逾期未完成", overdue),
        sec("📅 下週到期", nextDue), sec("🎬 下週拍攝", shoots, (t) => `${mmdd(t.shoot_date)} ${t.title}${t.location ? " @" + t.location : ""}${t.client ? `（${t.client}）` : ""}`),
      ],
    };
  }

  function renderReport() {
    const r = buildReport();
    main.innerHTML = `<div class="cal-head"><button id="r-prev">◀ 上週</button><button id="r-this">本週</button><button id="r-next">下週 ▶</button></div>
      <div class="panel"><h2>週報　${r.range}</h2>${r.sections.map((s) =>
        `<h3>${s.title}</h3>${s.items.length ? `<ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted">無</p>`}`).join("")}
      <div class="actions"><button id="r-copy" class="primary">複製文字版</button></div></div>`;
    $("#r-prev").onclick = () => { reportOffset--; renderReport(); };
    $("#r-this").onclick = () => { reportOffset = 0; renderReport(); };
    $("#r-next").onclick = () => { reportOffset++; renderReport(); };
    $("#r-copy").onclick = async () => {
      const txt = `【週報 ${r.range}】\n` + r.sections.map((s) => `\n${s.title}\n` + (s.items.length ? s.items.map((i) => "・" + i).join("\n") : "・無")).join("\n");
      try { await navigator.clipboard.writeText(txt); setMsg("已複製！"); } catch { prompt("請手動複製：", txt); }
    };
  }

  // ---------- 重複任務 ----------
  function ruleDesc(r) { return r.frequency === "weekly" ? `每週${WD[r.weekday]}` : `每月 ${r.month_day} 日`; }

  function renderRecurring() {
    main.innerHTML = `<div class="panel"><h2>重複任務</h2>
      <p class="muted">設定後，系統每次開啟頁面會自動產生未來 14 天內的任務。</p>
      <form id="rule-form" class="form-inline">
        <label>標題<input name="title" required></label>
        <label>頻率<select name="frequency"><option value="weekly">每週</option><option value="monthly">每月</option></select></label>
        <label id="l-wd">星期<select name="weekday">${WD.map((w, i) => `<option value="${i}">${w}</option>`).join("")}</select></label>
        <label id="l-md" hidden>日期<input type="number" name="month_day" min="1" max="28" value="1"></label>
        <label>負責人<input name="assignee" list="dl-assignee"></label>
        <label>客戶<input name="client" list="dl-client"></label>
        <button class="primary">新增規則</button>
      </form>
      ${rules.length ? rules.map((r) => `<div class="list-item"><div class="grow"><b>${esc(r.title)}</b>
        <div class="muted">${ruleDesc(r)}${r.assignee ? "｜" + esc(r.assignee) : ""}${r.client ? "｜" + esc(r.client) : ""}${r.active ? "" : "｜已停用"}</div></div>
        <button data-toggle="${r.id}">${r.active ? "停用" : "啟用"}</button><button class="danger" data-del="${r.id}">刪除</button></div>`).join("")
        : `<p class="muted">還沒有規則</p>`}</div>`;
    const f = $("#rule-form");
    f.frequency.onchange = () => { $("#l-wd").hidden = f.frequency.value !== "weekly"; $("#l-md").hidden = f.frequency.value !== "monthly"; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      const row = { title: v.title.trim(), frequency: v.frequency, assignee: v.assignee.trim() || null, client: v.client.trim() || null };
      if (v.frequency === "weekly") row.weekday = +v.weekday; else row.month_day = +v.month_day;
      const { error } = await db.from("recurring_rules").insert(row);
      if (error) return setMsg("新增失敗：" + error.message);
      await loadAll(); await generateRecurring(); render();
    };
    main.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = async () => {
      const r = rules.find((x) => x.id === b.dataset.toggle);
      await db.from("recurring_rules").update({ active: !r.active }).eq("id", r.id);
      await loadAll(); render();
    });
    main.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      if (!confirm("刪除這條規則？已產生的任務會保留。")) return;
      await db.from("recurring_rules").delete().eq("id", b.dataset.del);
      await loadAll(); render();
    });
  }

  // ---------- Google 日曆匯入（iCal） ----------
  function parseIcs(text) {
    const lines = text.replace(/\r/g, "").replace(/\n[ \t]/g, "").split("\n");
    const events = []; let cur = null;
    const unesc = (s) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
    for (const ln of lines) {
      if (ln === "BEGIN:VEVENT") cur = {};
      else if (ln === "END:VEVENT") { if (cur && cur.uid && cur.date) events.push(cur); cur = null; }
      else if (cur) {
        const i = ln.indexOf(":"); if (i < 0) continue;
        const key = ln.slice(0, i).split(";")[0], val = ln.slice(i + 1);
        if (key === "UID") cur.uid = val;
        else if (key === "SUMMARY") cur.title = unesc(val);
        else if (key === "LOCATION") cur.location = unesc(val);
        else if (key === "DESCRIPTION") cur.notes = unesc(val);
        else if (key === "RRULE") cur.recurring = true;
        else if (key === "DTSTART") {
          const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
          if (m) {
            if (m[7]) { const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])); cur.date = ymd(d); }
            else cur.date = `${m[1]}-${m[2]}-${m[3]}`;
          }
        }
      }
    }
    return events;
  }

  function renderImport() {
    main.innerHTML = `<div class="panel"><h2>Google 日曆匯入</h2>
      <p class="muted">只匯入標題含關鍵字的行程（例如「拍攝」），每個行程會變成一張工作卡，並把日期填入「拍攝日期」。重複匯入不會產生重複卡片。</p>
      <div class="form-inline"><label>關鍵字（留空＝全部）<input id="i-kw" value="拍攝"></label>
        <label><input type="checkbox" id="i-future" checked style="width:auto"> 只匯入今天之後</label></div>
      <h3>方式 A：上傳 .ics 檔</h3>
      <p class="muted">Google 日曆 → 設定 → 匯入與匯出 → 匯出，解壓縮後選擇 .ics</p>
      <input type="file" id="i-file" accept=".ics,text/calendar">
      <h3>方式 B：私密 iCal 網址</h3>
      <p class="muted">Google 日曆 → 該日曆設定 → 整合日曆 →「iCal 格式的私密網址」。${cfg.ICAL_PROXY_URL ? "" : "需先部署 ical-proxy 並填入 config.js（見 README）。"}</p>
      <div class="form-inline"><label style="flex:1"><input id="i-url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" ${cfg.ICAL_PROXY_URL ? "" : "disabled"}></label>
        <button id="i-go" ${cfg.ICAL_PROXY_URL ? "" : "disabled"}>匯入</button></div>
      <p id="i-result"></p></div>`;
    $("#i-file").onchange = async (e) => { const f = e.target.files[0]; if (f) importIcs(await f.text()); };
    $("#i-go").onclick = async () => {
      const url = $("#i-url").value.trim(); if (!url) return;
      try {
        const res = await fetch(cfg.ICAL_PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY, Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY }, body: JSON.stringify({ url }) });
        if (!res.ok) throw new Error(await res.text());
        importIcs(await res.text());
      } catch (err) { $("#i-result").textContent = "抓取失敗：" + err.message; }
    };
  }

  async function importIcs(text) {
    const out = $("#i-result"), kw = $("#i-kw").value.trim(), future = $("#i-future").checked, today = todayStr();
    const evs = parseIcs(text).filter((e) => (!kw || (e.title || "").includes(kw)) && (!future || e.date >= today));
    const skipped = evs.filter((e) => e.recurring).length;
    if (!evs.length) { out.textContent = "沒有符合條件的行程。"; return; }
    let added = 0, updated = 0;
    for (const e of evs) {
      const ex = tasks.find((t) => t.ical_uid === e.uid);
      if (ex) {
        await db.from("tasks").update({ title: e.title || ex.title, shoot_date: e.date, location: e.location || null }).eq("id", ex.id); updated++;
      } else {
        const { error } = await db.from("tasks").insert({ title: e.title || "(未命名行程)", shoot_date: e.date, due_date: e.date, location: e.location || null, notes: e.notes || null, ical_uid: e.uid, tags: ["日曆匯入"] });
        if (!error) added++;
      }
    }
    await loadAll();
    out.textContent = `完成：新增 ${added} 筆、更新 ${updated} 筆。${skipped ? `（${skipped} 筆為重複行程，僅匯入第一次日期）` : ""}`;
  }

  // ---------- 新增 / 編輯視窗 ----------
  const dlg = $("#dlg"), form = $("#task-form");
  let editing = null;
  function openDialog(task, preset = {}) {
    editing = task;
    $("#dlg-title").textContent = task ? "編輯工作" : "新增工作";
    $("#btn-delete").style.visibility = task ? "visible" : "hidden";
    form.reset();
    const t = task || { status: "todo", priority: "medium", ...preset };
    for (const el of form.elements) {
      if (!el.name) continue;
      el.value = el.name === "tags" ? (t.tags || []).join(", ") : (t[el.name] ?? "");
    }
    dlg.showModal();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    const row = {
      title: v.title.trim(), status: v.status, priority: v.priority,
      due_date: v.due_date || null, shoot_date: v.shoot_date || null,
      assignee: v.assignee.trim() || null, client: v.client.trim() || null, location: v.location.trim() || null,
      notes: v.notes.trim() || null, tags: v.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    };
    if (!editing || editing.status !== v.status) row.completed_at = v.status === "done" ? new Date().toISOString() : null;
    const { error } = editing ? await db.from("tasks").update(row).eq("id", editing.id) : await db.from("tasks").insert(row);
    if (error) return setMsg("儲存失敗：" + error.message);
    dlg.close(); await loadAll(); render();
  });
  $("#btn-cancel").onclick = () => dlg.close();
  $("#btn-delete").onclick = async () => {
    if (!confirm("確定刪除這項工作？")) return;
    await db.from("tasks").delete().eq("id", editing.id);
    dlg.close(); await loadAll(); render();
  };

  // ---------- 事件 ----------
  $("#btn-new").onclick = () => db && openDialog(null);
  $("#tabs").addEventListener("click", (e) => { if (e.target.dataset.view) { view = e.target.dataset.view; render(); } });
  ["f-search", "f-client", "f-assignee"].forEach((id) => $("#" + id).addEventListener("input", () => db && render()));

  init();
})();
