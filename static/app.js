/* Who Stays On? - screen.
   Every plan comes from POST /api/roster (the same endpoint other markets call).
   Nothing here decides who is powered: this file only sends the input and draws the answer. */
(function () {
  "use strict";

  const API = "/api/roster";
  const HOURS = Array.from({ length: 10 }, (_, i) => (10 + i) + ":00");
  const $ = (s, el) => (el || document).querySelector(s);

  const state = {
    text: "",        // the exact input JSON that was (or will be) sent
    input: null,     // parsed copy for drawing, null if the text is not an object
    out: null,       // parsed response
    http: 0,
    ms: 0,
    source: "",
    sel: null,       // {id, slot} - the dark cell being explained
    seq: 0
  };

  /* ---------- helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => Number(n).toFixed(2);
  const pretty = id => String(id).replace(/[_-]+/g, " ").trim().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bAtm\b/, "ATM");
  const cap1 = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const isNum = v => typeof v === "number" && isFinite(v);

  function outageRanges(grid) {
    const r = []; let a = null;
    for (let t = 0; t <= 10; t++) {
      const out = t < 10 && grid[t] === false;
      if (out && a === null) a = t;
      if (!out && a !== null) { r.push(HOURS[a] + "\u2013" + (10 + t) + ":00"); a = null; }
    }
    return r;
  }

  function parseInput(text) {
    try { const o = JSON.parse(text); return (o && typeof o === "object" && !Array.isArray(o)) ? o : null; }
    catch (e) { return null; }
  }

  /* ---------- talking to the API ---------- */
  async function plan(text, source) {
    const my = ++state.seq;
    if (source) state.source = source;
    state.text = text;
    state.input = parseInput(text);
    document.body.classList.add("is-busy");
    $("#busy").hidden = false;
    renderDay();
    const t0 = performance.now();
    let http = 0, out;
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
      http = r.status;
      const raw = await r.text();
      try { out = JSON.parse(raw); } catch (e) { out = { status: "invalid_input", message: "The server answered with something that is not JSON." }; }
    } catch (e) {
      http = 0;
      out = { status: "unreachable", message: "Cannot reach " + API + " (" + e.message + "). Is the server running?" };
    }
    if (my !== state.seq) return;          // a newer request has already replaced this one
    state.out = out; state.http = http; state.ms = performance.now() - t0; state.sel = null;
    document.body.classList.remove("is-busy");
    $("#busy").hidden = true;
    render();
  }

  /* ---------- derive per-shop facts from input + output ---------- */
  function block() {
    const o = state.out;
    if (!o) return null;
    if (o.status === "ok") return o;
    if (o.status === "infeasible" && o.best_effort) return o.best_effort;
    return null;
  }

  function derive(inp, blk) {
    const maxd = inp.max_consecutive_dark;
    const by = new Map(blk.roster.map(r => [r.slot, r]));
    const viol = new Set();            // "id|slot" cells that sit in a dark run longer than allowed
    const info = {};
    inp.shops.forEach(s => {
      let run = 0, cells = [], longest = 0, earned = 0, possible = 0;
      for (let t = 0; t < 10; t++) {
        const r = by.get(t);
        if (inp.grid_available[t] || !r) { flush(); run = 0; continue; }
        const dark = r.dark.some(d => d.id === s.id);
        if (dark) { run++; cells.push(t); longest = Math.max(longest, run); }
        else { flush(); run = 0; earned += s.value_per_slot[t]; }
        possible += s.value_per_slot[t];
      }
      flush();
      function flush() {
        if (s.type !== "mandatory" && cells.length > maxd) cells.forEach(t => viol.add(s.id + "|" + t));
        cells = [];
      }
      info[s.id] = { longest, earned, possible };
    });
    return { by, viol, info };
  }

  /* ---------- rendering ---------- */
  function render() {
    renderDay();
    renderMessage();
    const inp = state.input, blk = block();
    const ok = !!(inp && blk && Array.isArray(inp.shops));
    $("#btn-download").disabled = !state.out || state.out.status === "unreachable";
    $("#btn-print").disabled = !ok;
    if (!ok) { $("#summary").innerHTML = ""; $("#board-wrap").innerHTML = ""; $("#why").innerHTML = ""; $("#print-head").innerHTML = ""; return; }
    const d = derive(inp, blk);
    renderSummary(inp, blk, d);
    renderBoard(inp, blk, d);
    renderWhy(inp, blk, d);
    renderPrintHead(inp, blk);
  }

  /* the day: hour chips (click = what-if) + the three limits */
  function renderDay() {
    const el = $("#day"), inp = state.input;
    if (!inp || !Array.isArray(inp.grid_available) || inp.grid_available.length !== 10) { el.innerHTML = ""; el.hidden = true; return; }
    el.hidden = false;
    const ranges = outageRanges(inp.grid_available);
    const n = inp.grid_available.filter(g => g === false).length;
    const chips = inp.grid_available.map((g, t) =>
      `<button type="button" class="chip" data-hour="${t}" aria-pressed="${g === false}" title="Click to flip ${HOURS[t]} between grid and outage and re-plan">
         <b>${HOURS[t]}</b><span>${g === false ? "outage" : "grid"}</span></button>`).join("");
    const keep = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.field || null : null;
    el.innerHTML =
      `<div class="day-head"><h2>Today: ${n === 0 ? "no outage" : n + (n === 1 ? " outage hour" : " outage hours") + " (" + esc(ranges.join(" and ")) + ")"}</h2>
         <p>Click an hour to flip it between grid and outage; the roster is planned again.</p></div>
       <div class="hours">${chips}</div>
       <div class="limits">
         <label>Generator capacity<span class="unit"><input type="number" min="1" step="1" data-field="generator_capacity_kw" value="${esc(inp.generator_capacity_kw)}"> kW</span></label>
         <label>Diesel for the day<span class="unit"><input type="number" min="0" step="0.01" data-field="fuel_budget_litres" value="${esc(inp.fuel_budget_litres)}"> litres</span></label>
         <label>Longest a shop may be dark<span class="unit"><input type="number" min="0" step="1" data-field="max_consecutive_dark" value="${esc(inp.max_consecutive_dark)}"> hours in a row</span></label>
       </div>`;
    if (keep) { const f = el.querySelector(`[data-field="${keep}"]`); if (f) { f.focus(); } }
  }

  function renderMessage() {
    const o = state.out, el = $("#message");
    if (!o) { el.innerHTML = ""; return; }
    if (o.status === "invalid_input" || o.status === "unreachable") {
      const head = o.status === "unreachable" ? "The planner could not be reached" : "This input cannot be planned (invalid_input" + (state.http ? ", HTTP " + state.http : "") + ")";
      el.innerHTML = `<div class="notice" role="alert"><h2>${esc(head)}</h2><p>${esc(o.message || "")}</p>
        <p>Fix the field named above, or open <b>Load input</b> to load a different file.</p></div>`;
      return;
    }
    if (o.status === "infeasible") {
      const c = o.conflict || {};
      const shops = (c.shops || []).map(s => `<span class="tag">${esc(pretty(s))}</span>`).join("");
      const hours = (c.hours || []).map(h => `<span class="tag">${esc(h)}</span>`).join("");
      let html = `<div class="notice" role="alert"><h2>Infeasible: no roster can follow every rule</h2>
        <p><b>Rule in conflict:</b> ${esc(c.rule || "")}</p><p>${esc(c.message || "")}</p>
        ${shops ? `<div class="tags"><span>Shops:</span>${shops}</div>` : ""}
        ${hours ? `<div class="tags"><span>Hours:</span>${hours}</div>` : ""}
        <p>To get a valid plan, change one of the limits above: add diesel or capacity, allow a longer dark run, or put an hour back on the grid.</p></div>`;
      if (o.best_effort) html += `<div class="notice soft"><h2>${esc(cap1(o.best_effort.label || "best effort"))}</h2>
        <p>The board below is for reference only. Shops whose dark hours break the longest-run rule are outlined in red.</p></div>`;
      el.innerHTML = html;
      return;
    }
    el.innerHTML = "";
  }

  function renderSummary(inp, blk, d) {
    const out = state.out, bud = Number(inp.fuel_budget_litres), cap = inp.generator_capacity_kw;
    const ok = out.status === "ok";
    const outage = inp.grid_available.filter(g => g === false).length;
    const peak = blk.roster.reduce((m, r) => Math.max(m, r.load_kw), 0);
    let ceiling = 0;
    inp.shops.forEach(s => { ceiling += d.info[s.id].possible; });
    const pct = ceiling ? Math.round(100 * blk.value_total / ceiling) : 0;
    const fuelPct = bud > 0 ? Math.min(100, 100 * blk.fuel_total_litres / bud) : 0;
    const left = bud - blk.fuel_total_litres;
    $("#summary").innerHTML =
      `<div class="stats">
        <div class="stat"><div class="k">Status</div><div class="v ${ok ? "ok" : "bad"}">${ok ? "OK" : "Infeasible"}</div>
          <div class="s">${ok ? "every rule is met" : "best effort breaks a rule"}</div></div>
        <div class="stat"><div class="k">Total value served</div><div class="v">${blk.value_total}</div>
          <div class="s">${outage ? pct + "% of the " + ceiling + " if nobody were cut" : "no outage hours"}</div></div>
        <div class="stat"><div class="k">Diesel used</div><div class="v">${money(blk.fuel_total_litres)}<small> / ${money(bud)} L</small></div>
          <div class="meter ${left < 0 ? "over" : ""}"><i style="width:${fuelPct}%"></i></div>
          <div class="s">${left >= 0 ? money(left) + " L left in the tank" : money(-left) + " L over budget"}</div></div>
        <div class="stat"><div class="k">Outage hours</div><div class="v">${outage}</div>
          <div class="s">${outage ? esc(outageRanges(inp.grid_available).join(", ")) : "grid all day"}</div></div>
        <div class="stat"><div class="k">Highest load</div><div class="v">${peak}<small> / ${cap} kW</small></div>
          <div class="s">${peak > cap ? "over capacity" : peak === cap ? "touches the limit" : "inside capacity"}</div></div>
      </div>
      <div class="meta"><span>Planned by <code>POST ${API}</code> &rarr; HTTP ${state.http}</span><span>${(state.ms / 1000).toFixed(2)} s</span><span>Input: ${esc(state.source || "pasted JSON")}</span></div>`;
  }

  function renderBoard(inp, blk, d) {
    const cap = inp.generator_capacity_kw, bud = Number(inp.fuel_budget_litres);
    const shops = inp.shops.slice().sort((a, b) => (b.type === "mandatory") - (a.type === "mandatory"));
    const sel = state.sel;

    let head = `<tr><th class="name" scope="col">Shop</th><th scope="col">kW</th>`;
    for (let t = 0; t < 10; t++) {
      const g = inp.grid_available[t];
      head += `<th scope="col" class="${g ? "col-grid" : ""}">${HOURS[t]}<small>${g ? "grid" : "outage"}</small></th>`;
    }
    head += `<th scope="col" class="sumh">Dark<small>hours</small></th><th scope="col" class="sumh">Value<small>earned</small></th></tr>`;

    let body = "";
    shops.forEach(s => {
      const mand = s.type === "mandatory";
      const dh = blk.dark_hours ? blk.dark_hours[s.id] : 0;
      const f = d.info[s.id];
      body += `<tr class="${mand ? "mand" : ""}"><td class="name" title="${esc(s.id)}">${mand ? '<span class="star" title="Mandatory: always on" aria-label="mandatory">\u2605</span>' : ""}${esc(pretty(s.id))}<small>${mand ? "mandatory" : "normal"}</small></td><td class="kw">${s.kw}</td>`;
      for (let t = 0; t < 10; t++) {
        if (inp.grid_available[t]) { body += `<td class="cell grid">grid</td>`; continue; }
        const r = d.by.get(t);
        if (!r) { body += `<td class="cell blank">\u2013</td>`; continue; }
        const dk = r.dark.find(x => x.id === s.id);
        if (dk) {
          const v = d.viol.has(s.id + "|" + t);
          const isSel = sel && sel.id === s.id && sel.slot === t;
          body += `<td class="cell off${v ? " viol" : ""}${isSel ? " sel" : ""}" data-id="${esc(s.id)}" data-slot="${t}">` +
                  `<button type="button" aria-label="${esc(pretty(s.id))} at ${HOURS[t]} is dark. ${esc(dk.reason)}">\u2717</button></td>`;
        } else {
          body += `<td class="cell lit" aria-label="${esc(pretty(s.id))} at ${HOURS[t]} is powered">\u2713</td>`;
        }
      }
      const bad = !mand && f.longest > inp.max_consecutive_dark;
      body += `<td class="sum ${bad ? "warn" : ""}">${dh}<small>${dh ? "longest run " + f.longest : "never dark"}</small></td>`;
      body += `<td class="sum">${f.earned}<small>of ${f.possible}</small></td></tr>`;
    });

    let foot = `<tr class="first"><th colspan="2" scope="row">Load vs capacity<small>kW, limit ${cap}</small></th>`;
    for (let t = 0; t < 10; t++) {
      const r = d.by.get(t);
      if (!r) { foot += `<td><div class="fcell gridf"></div></td>`; continue; }
      const over = r.load_kw > cap;
      foot += `<td><div class="fcell ${over ? "over" : ""}">${r.load_kw}<small> / ${cap}</small><span class="m"><i style="width:${Math.min(100, 100 * r.load_kw / cap)}%"></i></span></div></td>`;
    }
    foot += `<td colspan="2"></td></tr><tr><th colspan="2" scope="row">Fuel this hour<small>litres</small></th>`;
    for (let t = 0; t < 10; t++) {
      const r = d.by.get(t);
      foot += r ? `<td><div class="fcell">${money(r.fuel_litres)}<small> L</small></div></td>` : `<td><div class="fcell gridf"></div></td>`;
    }
    foot += `<td colspan="2"></td></tr><tr><th colspan="2" scope="row">Running total<small>budget ${money(bud)} L</small></th>`;
    for (let t = 0; t < 10; t++) {
      const r = d.by.get(t);
      if (!r) { foot += `<td><div class="fcell gridf"></div></td>`; continue; }
      const over = r.fuel_cumulative_litres > bud + 1e-9;
      foot += `<td><div class="fcell ${over ? "over" : ""}">${money(r.fuel_cumulative_litres)}<span class="m"><i style="width:${bud > 0 ? Math.min(100, 100 * r.fuel_cumulative_litres / bud) : 0}%"></i></span></div></td>`;
    }
    foot += `<td colspan="2"></td></tr>`;

    $("#board-wrap").innerHTML =
      `<div class="board-scroll"><table class="board"><caption class="sr-only" style="position:absolute;left:-9999px">Roster board: powered or dark for each shop in each hour</caption>
         <colgroup><col class="c-name"><col class="c-kw">${"<col>".repeat(10)}<col class="c-sum"><col class="c-sum"></colgroup><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>
       <div class="legend"><span><i class="sw lit">\u2713</i>powered</span><span><i class="sw off">\u2717</i>dark (click for the reason)</span>
         <span><i class="sw grid"></i>grid: everyone is on, nothing to decide</span><span><span style="color:var(--star);font-weight:700">\u2605</span>mandatory shop</span>
         ${d.viol.size ? '<span><i class="sw viol">\u2717</i>breaks the longest-dark-run rule</span>' : ""}</div>`;
  }

  /* split "Diesel: ... Dark run so far: 1 (max 2)." into category / body / run note */
  function splitReason(txt) {
    let cat = "", rest = String(txt), run = "";
    const m = rest.match(/^([A-Za-z ]{3,24}):\s*/);
    if (m) { cat = m[1]; rest = rest.slice(m[0].length); }
    const r = rest.match(/\s*(Dark run so far:.*)$/);
    if (r) { run = r[1]; rest = rest.slice(0, r.index); }
    return { cat, body: rest, run };
  }
  const catClass = c => /diesel|fuel/i.test(c) ? "diesel" : /capacity/i.test(c) ? "capacity" : "other";

  function reasonHTML(txt) {
    const p = splitReason(txt);
    return `${p.cat ? `<span class="cat ${catClass(p.cat)}">${esc(p.cat)}</span>` : ""}${esc(p.body)}${p.run ? `<span class="run">${esc(p.run)}</span>` : ""}`;
  }

  function renderWhy(inp, blk, d) {
    const shops = inp.shops.slice().sort((a, b) => (b.type === "mandatory") - (a.type === "mandatory"));
    let n = 0, items = "";
    shops.forEach(s => {
      const rows = [];
      blk.roster.forEach(r => { const dk = r.dark.find(x => x.id === s.id); if (dk) rows.push({ r, dk }); });
      n += rows.length;
      const open = state.sel && state.sel.id === s.id ? " open" : "";
      if (!rows.length) {
        items += `<details class="shop"><summary>${esc(pretty(s.id))}<span class="n">${s.type === "mandatory" ? "mandatory, on every outage hour" : "never dark"}</span></summary></details>`;
        return;
      }
      items += `<details class="shop" data-shop="${esc(s.id)}"${open}><summary>${esc(pretty(s.id))}<span class="n">dark ${rows.length} h</span></summary><ul>` +
        rows.map(x => `<li data-key="${esc(s.id)}|${x.r.slot}" class="${state.sel && state.sel.id === s.id && state.sel.slot === x.r.slot ? "sel" : ""}"><span class="time">${esc(x.r.time)}</span><div class="reason">${reasonHTML(x.dk.reason)}</div></li>`).join("") +
        `</ul></details>`;
    });
    $("#why").innerHTML =
      `<div class="why-head"><h2>Why each shop is dark</h2><button type="button" class="btn quiet" id="toggle-all">Open all</button></div>
       <div class="callout empty" id="callout">${n ? "Hover or click a \u2717 on the board to see why that shop is dark." : "Nobody is dark in any outage hour."}</div>
       <div class="why-list">${items}</div>`;
    if (state.sel) showCallout(state.sel.id, state.sel.slot);
  }

  function showCallout(id, slot) {
    const blk = block(); if (!blk) return;
    const r = blk.roster.find(x => x.slot === slot); if (!r) return;
    const dk = r.dark.find(x => x.id === id); if (!dk) return;
    const c = $("#callout"); if (!c) return;
    c.className = "callout";
    c.innerHTML = `<h3>${esc(pretty(id))} is dark at ${esc(r.time)}</h3><div class="reason">${reasonHTML(dk.reason)}</div>`;
  }

  function renderPrintHead(inp, blk) {
    const ranges = outageRanges(inp.grid_available);
    const ok = state.out.status === "ok";
    const stamp = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    $("#print-head").innerHTML =
      `<div><h1>Who Stays On? \u2013 generator roster</h1>
         <div class="sub">${ranges.length ? "Outage: " + esc(ranges.join(" and ")) : "No outage today"} \u00b7 generator ${inp.generator_capacity_kw} kW \u00b7 no shop dark more than ${inp.max_consecutive_dark} h in a row${ok ? "" : " \u00b7 <b>INFEASIBLE \u2013 best effort, rules broken</b>"}</div>
         <div class="stamp">Printed ${esc(stamp)}</div></div>
       <div class="figs"><div>Value<b>${blk.value_total}</b></div><div>Diesel<b>${money(blk.fuel_total_litres)} / ${money(inp.fuel_budget_litres)} L</b></div></div>`;
  }

  /* ---------- tooltip on dark cells ---------- */
  const tip = $("#tip");
  function showTip(td, ev) {
    const blk = block(); if (!blk) return;
    const id = td.dataset.id, slot = Number(td.dataset.slot);
    const r = blk.roster.find(x => x.slot === slot), dk = r && r.dark.find(x => x.id === id);
    if (!dk) return;
    const p = splitReason(dk.reason);
    tip.innerHTML = `<b>${esc(pretty(id))} \u00b7 ${esc(r.time)}</b>${p.cat ? esc(p.cat) + ": " : ""}${esc(p.body)}${p.run ? "<br>" + esc(p.run) : ""}`;
    tip.hidden = false;
    moveTip(ev, td);
  }
  function moveTip(ev, td) {
    const b = td.getBoundingClientRect();
    const x = ev && ev.clientX ? ev.clientX + 14 : b.right + 8;
    const y = ev && ev.clientY ? ev.clientY + 16 : b.bottom + 6;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
    tip.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  function selectCell(id, slot, scroll) {
    state.sel = { id, slot };
    document.querySelectorAll("td.cell.off.sel").forEach(e => e.classList.remove("sel"));
    document.querySelectorAll("#why li.sel").forEach(e => e.classList.remove("sel"));
    const td = document.querySelector(`td.cell.off[data-id="${CSS.escape(id)}"][data-slot="${slot}"]`);
    if (td) td.classList.add("sel");
    const det = document.querySelector(`details.shop[data-shop="${CSS.escape(id)}"]`);
    if (det) det.open = true;
    const li = document.querySelector(`#why li[data-key="${CSS.escape(id + "|" + slot)}"]`);
    if (li) li.classList.add("sel");
    showCallout(id, slot);
    if (scroll) { const c = $("#callout"); if (c) { const r = c.getBoundingClientRect(); if (r.bottom > window.innerHeight || r.top < 0) c.scrollIntoView({ block: "nearest", behavior: "smooth" }); } }
  }

  /* ---------- events ---------- */
  document.addEventListener("mouseover", e => { const td = e.target.closest && e.target.closest("td.cell.off"); if (td) showTip(td, e); });
  document.addEventListener("mousemove", e => { if (!tip.hidden) { const td = e.target.closest && e.target.closest("td.cell.off"); if (td) moveTip(e, td); } });
  document.addEventListener("mouseout", e => { const td = e.target.closest && e.target.closest("td.cell.off"); if (td && !td.contains(e.relatedTarget)) hideTip(); });
  document.addEventListener("focusin", e => { const td = e.target.closest && e.target.closest("td.cell.off"); if (td) showTip(td, null); });
  document.addEventListener("focusout", e => { if (e.target.closest && e.target.closest("td.cell.off")) hideTip(); });

  document.addEventListener("click", e => {
    const td = e.target.closest("td.cell.off");
    if (td) { selectCell(td.dataset.id, Number(td.dataset.slot), true); return; }
    const chip = e.target.closest(".chip");
    if (chip && state.input) {
      const t = Number(chip.dataset.hour);
      const o = JSON.parse(state.text); o.grid_available[t] = !o.grid_available[t];
      plan(JSON.stringify(o, null, 2), (state.source || "input") .replace(/ \(edited\)$/, "") + " (edited)");
      return;
    }
    if (e.target.id === "toggle-all") {
      const ds = document.querySelectorAll("details.shop[data-shop]");
      const anyClosed = Array.from(ds).some(d => !d.open);
      ds.forEach(d => { d.open = anyClosed; });
      e.target.textContent = anyClosed ? "Close all" : "Open all";
    }
  });

  let editTimer = null;
  document.addEventListener("input", e => {
    const f = e.target.dataset && e.target.dataset.field;
    if (!f || !state.input) return;
    clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      const v = e.target.value.trim();
      const o = JSON.parse(state.text);
      const num = Number(v);
      o[f] = (v === "" || !isFinite(num)) ? v : num;
      plan(JSON.stringify(o, null, 2), (state.source || "input").replace(/ \(edited\)$/, "") + " (edited)");
    }, 450);
  });

  /* loader dialog */
  const dlg = $("#loader"), ta = $("#json-text"), err = $("#json-error");
  $("#btn-load").onclick = () => { ta.value = state.text; err.textContent = ""; dlg.showModal(); ta.focus(); };
  $("#btn-cancel").onclick = () => dlg.close();
  function runFromDialog(label) {
    const t = ta.value;
    try { JSON.parse(t); } catch (e) { err.textContent = "That is not valid JSON: " + e.message; return; }
    dlg.close(); plan(t, label || "pasted JSON");
  }
  $("#btn-run").onclick = () => runFromDialog("pasted JSON");
  async function fetchText(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ": HTTP " + r.status); return r.text(); }
  $("#btn-sample").onclick = async () => { try { ta.value = await fetchText("/examples/sample_input.json"); err.textContent = ""; } catch (e) { err.textContent = e.message; } };
  $("#btn-worked").onclick = async () => { try { ta.value = await fetchText("/examples/worked_example.json"); err.textContent = ""; } catch (e) { err.textContent = e.message; } };
  $("#file").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    ta.value = await f.text(); e.target.value = "";
    runFromDialog(f.name);
  };

  /* drop a file anywhere */
  let dragDepth = 0;
  const veil = $("#dropveil");
  window.addEventListener("dragenter", e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) { dragDepth++; veil.hidden = false; } });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) veil.hidden = true; });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", async e => {
    e.preventDefault(); dragDepth = 0; veil.hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files[0]; if (!f) return;
    if (dlg.open) dlg.close();
    plan(await f.text(), f.name);
  });

  $("#btn-download").onclick = () => {
    const blob = new Blob([JSON.stringify(state.out, null, 2) + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "roster_output.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("#btn-print").onclick = () => window.print();

  $("#curl").textContent = "curl -X POST " + location.origin + API + " \\\n  -H 'Content-Type: application/json' \\\n  --data @input.json";

  /* start with the practice input so the board is never empty */
  fetchText("/examples/sample_input.json")
    .then(t => plan(t, "practice input (examples/sample_input.json)"))
    .catch(() => { $("#message").innerHTML = `<div class="notice"><h2>Load an input to begin</h2><p>Use <b>Load input</b> to choose or paste today's JSON.</p></div>`; });
})();
