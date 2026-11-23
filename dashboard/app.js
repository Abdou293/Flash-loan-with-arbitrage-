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
    el("span", { class: "pill" }, `Data: ${d.meta.dataSource}`),
  );
  if (d.meta.dataSource === "synthetic") {
    const b = $("banner");
    b.hidden = false;
    b.replaceChildren(el("div", {}, el("strong", {}, "Synthetic demo data. "), d.meta.note));
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

load().then((d) => {
  renderStatus(d); renderKpis(d); renderStrategies(d); renderChart(d); renderCaveats(d); renderOpps(d); renderMeta(d);
}).catch((e) => {
  const box = $("error");
  box.hidden = false;
  box.replaceChildren(el("div", {}, e.message));
});
