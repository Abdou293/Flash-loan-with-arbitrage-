"use strict";

const COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"];
const $ = (id) => document.getElementById(id);
const usd = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids) e.append(kid);
  return e; // text goes through textContent/append only: no innerHTML with data
}

async function load() {
  // data/live.json (local, git-ignored) wins over the committed demo data.
  const local = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  for (const url of local ? ["data/live.json", "data/sample.json"] : ["data/sample.json"]) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return r.json();
    } catch (_) { /* try next */ }
  }
  throw new Error("Could not load data/sample.json. Serve this folder over HTTP (e.g. `npx serve dashboard`); opening index.html directly from disk is blocked by the browser.");
}

function renderStatus(d) {
  const s = $("status");
  s.replaceChildren(
    el("span", { class: "pill ok" }, d.status.dryRun ? "● DRY-RUN (no real transactions)" : "● LIVE"),
    el("span", { class: "pill " + (d.status.paused ? "bad" : "ok") }, d.status.paused ? "Auto-paused by risk engine" : "Risk engine: active"),
    el("span", { class: "pill" }, `Module 1 data: ${d.meta.dataSource}`),
  );
  if (d.meta.dataSource === "synthetic") {
    const b = $("banner");
    b.hidden = false;
    b.replaceChildren(el("div", {}, el("strong", {}, "Module 1 (arbitrage) shows synthetic demo data. "), d.meta.note + " Module 2 (liquidation monitor) is separate and uses real on-chain reads."));
  }
}

function renderKpis(d) {
  const found = d.strategies.reduce((a, s) => a + s.profitableBeforeRisk, 0);
  const net = d.strategies.reduce((a, s) => a + s.estimatedNetProfitUsd, 0);
  const tiles = [
    ["Opportunities found", found, "profitable before risk checks"],
    ["Simulated trades", d.trades.simulated, `${d.trades.simulatedSucceeded} ok · ${d.trades.simulatedFailed} failed`],
    ["Executed trades", d.trades.executed, "this version cannot send transactions"],
    ["Gas actually spent", usd(d.gas.gasActuallySpentUsd), `est. for simulated: ${usd(d.gas.estimatedGasOfSimulatedTradesUsd)}`],
    ["Est. net profit", usd(net), "simulated, not realised"],
  ];
  $("kpis").replaceChildren(...tiles.map(([label, value, note]) =>
    el("div", { class: "kpi" }, el("div", { class: "label" }, label), el("div", { class: "value" }, String(value)), el("div", { class: "note" }, note))));
}

function renderStrategies(d) {
  const body = document.querySelector("#strategies tbody");
  body.replaceChildren(...d.strategies.map((s) => {
    const cls = s.estimatedNetProfitUsd > 0 ? "n pos" : "n";
    return el("tr", {},
      el("td", {}, s.name),
      el("td", {}, el("span", { class: "tag" }, s.enabled ? "enabled" : "disabled")),
      el("td", { class: "n" }, s.routesEvaluated.toLocaleString("en-US")),
      el("td", { class: "n" }, String(s.profitableBeforeRisk)),
      el("td", { class: "n" }, String(s.rejectedByRisk)),
      el("td", { class: "n" }, String(s.simulatedOk)),
      el("td", { class: "n" }, String(s.simulatedRevert)),
      el("td", { class: cls }, usd(s.estimatedNetProfitUsd)));
  }));
}

function renderOpps(d) {
  const body = document.querySelector("#opps tbody");
  if (!d.recentOpportunities.length) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "empty" }, "No opportunities recorded yet.")));
    return;
  }
  body.replaceChildren(...d.recentOpportunities.map((o) =>
    el("tr", {},
      el("td", {}, String(o.cycle)),
      el("td", {}, o.strategy),
      el("td", { title: o.route }, o.route.length > 56 ? o.route.slice(0, 55) + "…" : o.route),
      el("td", { class: "n" }, "$" + o.amountInUsd.toLocaleString("en-US")),
      el("td", { class: "n " + (o.netProfitUsd >= 0 ? "pos" : "neg") }, usd(o.netProfitUsd)),
      el("td", {}, el("span", { class: "tag " + o.status, title: o.reason || "" }, o.status.replace("_", " "))))));
}

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderChart(d) {
  const names = d.strategies.map((s) => s.name);
  const pts = d.series;
  const box = $("chart");
  if (!pts.length) { box.replaceChildren(el("div", { class: "empty" }, "No data.")); return; }
  const W = 720, H = 280, L = 52, R = 16, T = 12, B = 28;
  const vals = pts.flatMap((p) => names.map((n) => p.cumNetUsd[n] ?? 0));
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const x = (i) => L + (i / Math.max(1, pts.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-labelledby": "ct cd" });
  s.append(svg("title", { id: "ct" }, "Cumulative estimated net profit per strategy"),
           svg("desc", { id: "cd" }, "Line chart over scan cycles; values are simulated estimates."));
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    s.append(svg("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }),
             svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, "$" + v.toFixed(v >= 10 ? 0 : 1)));
  }
  s.append(svg("text", { x: L, y: H - 6 }, `cycle ${pts[0].cycle}`),
           svg("text", { x: W - R, y: H - 6, "text-anchor": "end" }, `cycle ${pts[pts.length - 1].cycle}`));
  names.forEach((n, k) => {
    const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cumNetUsd[n] ?? 0).toFixed(1)}`).join(" ");
    s.append(svg("path", { d: path, fill: "none", stroke: COLORS[k % COLORS.length], "stroke-width": 2, "stroke-linejoin": "round" }));
  });
  box.replaceChildren(s);
  $("legend").replaceChildren(...names.map((n, k) => {
    const i = el("i"); i.style.background = COLORS[k % COLORS.length];
    return el("li", {}, i, n);
  }));
}

function renderCaveats(d) {
  const box = $("caveats");
  const items = d.meta.caveats || [];
  box.hidden = items.length === 0;
  const ul = el("ul", {});
  items.forEach((t) => ul.append(el("li", {}, t)));
  box.replaceChildren(el("div", {}, el("strong", {}, "Read before interpreting: "), ul));
}

function renderMeta(d) {
  $("meta").textContent = `Generated ${new Date(d.meta.generatedAt).toLocaleString()} · ${d.status.cyclesRun} scan cycles · seed ${d.meta.seed ?? "n/a"}`;
}

async function loadShadow() {
  try {
    const r = await fetch("data/shadow.json", { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

function renderShadow(sh) {
  if (!sh) { $("shadow-empty").hidden = false; return; }
  const m = sh.meta, last = sh.latest;
  $("shadow-body").hidden = false;
  const tiles = [
    ["Observed", `${m.hoursObserved} h`, `${m.cycles} cycles · ${m.accountsWatched} accounts watched`],
    ["Cycles with a liquidatable account", m.cyclesWithLiquidatable, "health factor below 1"],
    ["Dry-run 'would attempt'", m.cyclesWithWouldAttempt, "passed the same risk limits as module 1"],
    ["Est. gross bonus if all won", usd(m.estimatedGrossBonusUsdIfAllWon), "ESTIMATE, not earnings: ignores swap cost and competition"],
    ["Executed transactions", 0, "this tool has no wallet"],
  ];
  $("shadow-kpis").replaceChildren(...tiles.map(([label, value, note]) =>
    el("div", { class: "kpi" }, el("div", { class: "label" }, label), el("div", { class: "value" }, String(value)), el("div", { class: "note" }, note))));

  const pts = sh.series, box = $("shadow-chart");
  if (pts.length < 2) {
    box.replaceChildren(el("div", { class: "empty" }, "Need at least 2 cycles to draw a chart."));
  } else {
    const lines = [["liquidatable", "Liquidatable (hf < 1)", 3], ["atRisk", "At risk (hf < 1.02)", 1], ["watch", "Watch (hf < 1.10)", 2]];
    const W = 720, H = 220, L = 40, R = 16, T = 12, B = 28;
    const max = Math.max(1, ...pts.flatMap((p) => lines.map(([k]) => p[k])));
    const x = (i) => L + (i / (pts.length - 1)) * (W - L - R);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-labelledby": "sht shd" });
    s.append(svg("title", { id: "sht" }, "Accounts near liquidation over time"), svg("desc", { id: "shd" }, "Counts of watched accounts per risk band at each recorded cycle."));
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      s.append(svg("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }), svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, String(Math.round(v))));
    }
    s.append(svg("text", { x: L, y: H - 6 }, new Date(pts[0].t).toLocaleString()), svg("text", { x: W - R, y: H - 6, "text-anchor": "end" }, new Date(pts[pts.length - 1].t).toLocaleString()));
    for (const [k, , ci] of lines) {
      const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
      s.append(svg("path", { d: path, fill: "none", stroke: COLORS[ci], "stroke-width": 2, "stroke-linejoin": "round" }));
    }
    box.replaceChildren(s);
    $("shadow-legend").replaceChildren(...lines.map(([, label, ci]) => { const i = el("i"); i.style.background = COLORS[ci]; return el("li", {}, i, label); }));
  }

  const body = document.querySelector("#shadow-rows tbody");
  const rows = last ? last.rows.slice(0, 10) : [];
  if (!rows.length) body.replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "empty" }, "No account was in a risk band at the last cycle.")));
  else body.replaceChildren(...rows.map((r) => {
    const a = r.assets;
    const detail = a && a.debtSymbol ? `${a.debtSymbol} / ${a.collateralSymbol || "?"} / ${a.lender || "no lender"}` : "";
    const dec = r.estimate ? (r.estimate.decision === "would_attempt" ? "would attempt" : "reject: " + (r.estimate.reason || "")) : "";
    return el("tr", {}, el("td", {}, r.band.replace("_", " ")), el("td", { class: "n" }, r.hf.toFixed(4)), el("td", { class: "n" }, "$" + Math.round(r.debtUsd).toLocaleString("en-US")),
      el("td", { title: r.user }, r.user.slice(0, 6) + "…" + r.user.slice(-4)), el("td", {}, detail), el("td", {}, dec));
  }));

  const ul = el("ul", {});
  (m.caveats || []).forEach((t) => ul.append(el("li", {}, t)));
  $("shadow-caveats").replaceChildren(el("div", {}, el("strong", {}, "Read before interpreting: "), ul,
    el("div", {}, `Source: ${m.dataSource}. Generated ${new Date(m.generatedAt).toLocaleString()}.`)));
}

loadShadow().then(renderShadow);

load().then((d) => {
  renderStatus(d); renderKpis(d); renderStrategies(d); renderChart(d); renderCaveats(d); renderOpps(d); renderMeta(d);
}).catch((e) => {
  const box = $("error");
  box.hidden = false;
  box.replaceChildren(el("div", {}, e.message));
});
