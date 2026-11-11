"use strict";

// Labels in this order keep their color everywhere (color follows the label,
// never its rank). Labels not listed here take the next slots.
const KNOWN_LABELS = ["ubicloud-standard-2", "ubicloud-premium-2", "ubicloud-standard-2-arm"];
const SLOTS = 8;

const HOUR = 36e5;
const DAY = 24 * HOUR;
// Ranges are whole UTC hours, the current one included: charts plot one
// median per hour. Values are hour counts.
const RANGES = { "1d": 24, "7d": 7 * 24, "30d": 30 * 24, "90d": 90 * 24, all: Infinity };
// x64 and arm64 runners never share a chart: the page shows one at a time.
const ARCHES = ["x64", "arm64"];
const GAP = 3 * HOUR; // a line breaks across an outage longer than this
const SNAP = 30 * 60e3; // tooltip matches series points within this of the crosshair
const PAGE = 50;

const state = {
  index: null,
  months: new Map(),
  extraLabels: [],
  range: "7d",
  arch: "x64",
  rows: [],
  runsShown: PAGE,
};

// ── formatting ─────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
// Chart hours are UTC hours, so everyone sees the same hourly medians.
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const dayHourFmt = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const utcHour = (t) => Math.floor(t / HOUR) * HOUR; // start of the UTC hour

const fmtScore = (v) => (v == null ? "–" : nf.format(v));

function fmtDuration(s) {
  if (s == null || !Number.isFinite(s)) return "–";
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${m}m ${String(r).padStart(2, "0")}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

const shortLabel = (label) => label.replace(/^ubicloud-/, "");

function colorOf(label) {
  let i = KNOWN_LABELS.indexOf(label);
  if (i < 0) i = KNOWN_LABELS.length + state.extraLabels.indexOf(label);
  return i < SLOTS ? `var(--series-${i + 1})` : "var(--text-muted)";
}

function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

// ── data ───────────────────────────────────────────────────────────────

async function loadIndex() {
  const res = await fetch("data/index.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`data/index.json: HTTP ${res.status}`);
  return res.json();
}

function parseLines(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      r.t = Date.parse(r.created_at);
      if (Number.isFinite(r.t) && typeof r.label === "string") rows.push(r);
    } catch {
      // a torn line never hides the rest of the month
    }
  }
  return rows;
}

function loadMonth(month) {
  if (!state.months.has(month)) {
    state.months.set(
      month,
      fetch(`data/runs/${encodeURIComponent(month)}.jsonl`, { cache: "no-cache" })
        .then((r) => (r.ok ? r.text() : ""))
        .then(parseLines)
        .catch(() => []),
    );
  }
  return state.months.get(month);
}

function rangeStart(range) {
  return range === "all" ? -Infinity : utcHour(Date.now()) - (RANGES[range] - 1) * HOUR;
}

function monthsFor(range) {
  const months = state.index?.months || [];
  if (range === "all") return months;
  const first = new Date(rangeStart(range)).toISOString().slice(0, 7);
  return months.filter((m) => m >= first);
}

async function rowsFor(range) {
  const lists = await Promise.all(monthsFor(range).map(loadMonth));
  const all = lists.flat();
  const extra = new Set(state.extraLabels);
  for (const r of all) if (!KNOWN_LABELS.includes(r.label)) extra.add(r.label);
  state.extraLabels = [...extra].sort();
  const start = rangeStart(range);
  return all.filter((r) => r.t >= start).sort((a, b) => a.t - b.t);
}

function archOf(row) {
  const arch = String(row.arch || "").toLowerCase();
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  if (arch === "x86_64" || arch === "amd64") return "x64";
  // Jobs that never got a runner have no arch; their label tells.
  return /(^|-)arm(64)?($|-)/.test(row.label) ? "arm64" : "x64";
}

function visibleRows() {
  return state.rows.filter((r) => archOf(r) === state.arch);
}

function labelsIn(rows) {
  const present = new Set(rows.map((r) => r.label));
  return [...KNOWN_LABELS, ...state.extraLabels].filter((l) => present.has(l));
}

// ── summary cards ──────────────────────────────────────────────────────

function stat(label, value, note) {
  return el("div", {}, el("dt", { text: label }), el("dd", {}, value, note ? el("small", { text: ` ${note}` }) : null));
}

function renderSummary(rows, labels) {
  const root = document.getElementById("summary");
  root.replaceChildren();
  if (!labels.length) {
    root.append(el("p", { class: "empty", text: "No results in this range yet." }));
    return;
  }
  for (const label of labels) {
    const mine = rows.filter((r) => r.label === label);
    const failed = mine.filter((r) => r.conclusion && r.conclusion !== "success").length;
    const queue = mine.map((r) => r.queue_seconds);
    const models = countBy(mine.filter((r) => r.cpu_model), (r) => r.cpu_model);
    const modelTotal = models.reduce((s, [, n]) => s + n, 0);
    const modelText = models.length
      ? models.slice(0, 3).map(([m, n]) => `${m} (${Math.round((100 * n) / modelTotal)}%)`).join(" · ") +
        (models.length > 3 ? ` · +${models.length - 3} more` : "")
      : "CPU model unknown";

    root.append(
      el("article", { class: "label-card" },
        el("h2", {}, el("span", { class: "key-dot", style: { background: colorOf(label) } }), label),
        el("dl", { class: "stats" },
          stat("CPU Mark, median", fmtScore(quantile(mine.map((r) => r.cpu_mark), 0.5))),
          stat("Single-thread, median", fmtScore(quantile(mine.map((r) => r.single_thread), 0.5))),
          stat("Queue, median", fmtDuration(quantile(queue, 0.5))),
          stat("Queue, p95", fmtDuration(quantile(queue, 0.95))),
        ),
        el("p", { class: "models-line" },
          `${nf.format(mine.length)} runs` + (failed ? `, ${nf.format(failed)} failed` : "") + ` · ${modelText}`),
      ),
    );
  }
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const it of items) counts.set(keyFn(it), (counts.get(keyFn(it)) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

// ── line chart ─────────────────────────────────────────────────────────

const X_STEPS = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY];
const DUR_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200];

function xTicks(t0, t1, width) {
  const maxTicks = Math.max(3, Math.floor(width / 80));
  const step = X_STEPS.find((s) => (t1 - t0) / s <= maxTicks);
  const ticks = [];
  if (!step) {
    const every = Math.ceil((t1 - t0) / (30 * DAY) / (maxTicks + 1));
    const d = new Date(Math.floor(t0 / DAY) * DAY);
    d.setUTCDate(1);
    for (; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + every)) if (d.getTime() >= t0) ticks.push(d.getTime());
    return { ticks, fmt: (t) => monthFmt.format(t) };
  }
  // The epoch is a UTC midnight, so multiples of the step land on UTC hours/days.
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  return { ticks, fmt: (t) => (t % DAY === 0 ? dayFmt.format(t) : hourFmt.format(t)) };
}

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * pow;
}

function scoreTicks(min, max, count) {
  // Keep at least a 10% window so run-to-run noise doesn't look like a cliff.
  const minSpan = Math.max(Math.abs(max) * 0.1, 1);
  if (max - min < minSpan) {
    const mid = (max + min) / 2;
    min = Math.max(0, mid - minSpan / 2);
    max = min + minSpan;
  }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toPrecision(12));
  const big = hi >= 10000;
  return { lo, hi, ticks, fmt: (v) => (big ? compact.format(v) : nf.format(v)) };
}

function durationTicks(max, count) {
  const step = DUR_STEPS.find((s) => s >= max / count) || Math.ceil(max / count / 3600) * 3600;
  const hi = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let v = 0; v <= hi; v += step) ticks.push(v);
  return { lo: 0, hi, ticks, fmt: fmtDuration };
}

// One point per label per UTC hour: the median of that hour's runs.
function seriesFor(rows, labels, field) {
  return labels.map((label) => {
    const hours = new Map();
    for (const r of rows) {
      if (r.label !== label || !Number.isFinite(r[field])) continue;
      const hour = utcHour(r.t);
      if (!hours.has(hour)) hours.set(hour, []);
      hours.get(hour).push(r);
    }
    const points = [...hours]
      .sort((a, b) => a[0] - b[0])
      .map(([t, runs]) => ({ t, v: quantile(runs.map((r) => r[field]), 0.5), runs }));
    return { label, color: colorOf(label), points };
  });
}

function runsNote(runs) {
  const models = countBy(runs.filter((r) => r.cpu_model), (r) => r.cpu_model);
  const n = runs.length;
  const which = models.length === 1
    ? models[0][0]
    : models.map(([m, c]) => `${m} (${c})`).join(", ");
  if (n === 1) return which || "1 run";
  return `median of ${n} runs${which ? ` · ${which}` : ""}`;
}

function renderLegend(key, series) {
  const root = document.querySelector(`[data-legend="${key}"]`);
  root.replaceChildren(
    ...series.map((s) =>
      el("span", {}, el("span", { class: "line-key", style: { background: s.color } }), s.label)),
  );
}

function renderChart(container, cfg) {
  container._cfg = cfg;
  const width = Math.floor(container.clientWidth);
  if (!width) return;
  const height = 284;
  const { series, domain, kind } = cfg;
  const [t0, t1] = domain;
  const values = series.flatMap((s) => s.points.map((p) => p.v));
  const yAxis = kind === "duration"
    ? durationTicks(Math.max(1, ...values), 5)
    : values.length ? scoreTicks(Math.min(...values), Math.max(...values), 5) : scoreTicks(0, 1, 5);
  if (!values.length) yAxis.ticks = [yAxis.lo]; // just the baseline, no made-up scale

  const m = { top: 12, right: 16, bottom: 28, left: 56 };
  const yOf = (v) => m.top + (1 - (v - yAxis.lo) / (yAxis.hi - yAxis.lo || 1)) * (height - m.top - m.bottom);

  // Direct labels at line ends, only when wide enough and they don't collide;
  // the legend above the chart always carries identity.
  const ends = series.filter((s) => s.points.length).map((s) => ({ s, p: s.points[s.points.length - 1] }));
  let direct = width >= 640 && ends.length > 1;
  if (direct) {
    const ys = ends.map((e) => yOf(e.p.v)).sort((a, b) => a - b);
    direct = ys.every((y, i) => i === 0 || y - ys[i - 1] >= 14);
  }
  if (direct) m.right = 112;

  const plotW = width - m.left - m.right;
  const xOf = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });

  for (const v of yAxis.ticks) {
    const y = Math.round(yOf(v)) + 0.5;
    svg("line", { class: v === yAxis.lo ? "baseline" : "grid", x1: m.left, x2: width - m.right, y1: y, y2: y }, root);
    svg("text", { x: m.left - 8, y: y + 4, "text-anchor": "end" }, root).textContent = yAxis.fmt(v);
  }
  const xt = xTicks(t0, t1, plotW);
  for (const t of xt.ticks) {
    svg("text", { x: xOf(t), y: height - 8, "text-anchor": "middle" }, root).textContent = xt.fmt(t);
  }

  if (!values.length) {
    svg("text", { class: "no-data", x: m.left + plotW / 2, y: height / 2, "text-anchor": "middle" }, root)
      .textContent = "No results in this range";
  }

  for (const s of series) {
    let d = "";
    const singles = [];
    s.points.forEach((p, i) => {
      const prev = s.points[i - 1], next = s.points[i + 1];
      const startsRun = !prev || p.t - prev.t > GAP;
      const endsRun = !next || next.t - p.t > GAP;
      if (startsRun && endsRun) singles.push(p);
      d += `${startsRun ? "M" : "L"}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`;
    });
    if (d) svg("path", { class: "series", d, style: `stroke:${s.color}` }, root);
    const last = s.points[s.points.length - 1];
    for (const p of new Set([...singles, ...(last ? [last] : [])])) {
      svg("circle", { class: "dot", cx: xOf(p.t), cy: yOf(p.v), r: 4, style: `fill:${s.color}` }, root);
    }
  }

  if (direct) {
    for (const { s, p } of ends) {
      svg("text", { class: "direct-label", x: xOf(p.t) + 10, y: yOf(p.v) + 4 }, root).textContent = shortLabel(s.label);
    }
  }

  // Hover layer: a crosshair snapped to the nearest run, one tooltip for all series.
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const hover = svg("g", { visibility: "hidden" }, root);
  const cross = svg("line", { class: "crosshair", y1: m.top, y2: height - m.bottom }, hover);
  const hoverDots = series.map((s) => svg("circle", { class: "dot", r: 4, style: `fill:${s.color}` }, hover));
  const hit = svg("rect", { x: m.left, y: 0, width: plotW, height, fill: "transparent" }, root);

  const show = (i, clientY) => {
    container._hoverIndex = i;
    const t = times[i];
    const x = xOf(t);
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    const rows = [];
    series.forEach((s, k) => {
      const p = nearest(s.points, t);
      const dot = hoverDots[k];
      if (p && Math.abs(p.t - t) <= SNAP) {
        dot.setAttribute("cx", xOf(p.t));
        dot.setAttribute("cy", yOf(p.v));
        dot.setAttribute("visibility", "visible");
        rows.push({ s, p });
      } else {
        dot.setAttribute("visibility", "hidden");
      }
    });
    hover.setAttribute("visibility", "visible");
    showTooltip(container, x, clientY, t, rows, kind);
  };
  const hide = () => {
    hover.setAttribute("visibility", "hidden");
    hideTooltip();
  };
  const fromPointer = (ev) => {
    if (!times.length) return;
    const box = root.getBoundingClientRect();
    const t = t0 + ((ev.clientX - box.left - m.left) / plotW) * (t1 - t0);
    show(nearestIndex(times, t), ev.clientY);
  };
  hit.addEventListener("pointermove", fromPointer);
  hit.addEventListener("pointerdown", fromPointer);
  hit.addEventListener("pointerleave", hide);

  container.onkeydown = (ev) => {
    if (!times.length) return;
    let i = container._hoverIndex ?? times.length - 1;
    if (ev.key === "ArrowLeft") i = Math.max(0, i - 1);
    else if (ev.key === "ArrowRight") i = Math.min(times.length - 1, i + 1);
    else if (ev.key === "Home") i = 0;
    else if (ev.key === "End") i = times.length - 1;
    else if (ev.key === "Escape") return hide();
    else return;
    ev.preventDefault();
    show(i);
  };
  container.onfocus = () => times.length && show(Math.min(container._hoverIndex ?? times.length - 1, times.length - 1));
  container.onblur = hide;
  container._hoverIndex = undefined;

  container.replaceChildren(root);
}

function nearestIndex(sorted, t) {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - t) <= Math.abs(sorted[lo] - t)) lo -= 1;
  return lo;
}

function nearest(points, t) {
  if (!points.length) return null;
  return points[nearestIndex(points.map((p) => p.t), t)];
}

const tooltip = document.getElementById("tooltip");

function showTooltip(container, x, clientY, t, rows, kind) {
  const fmt = kind === "duration" ? fmtDuration : fmtScore;
  tooltip.replaceChildren(
    el("div", { class: "tt-time", text: `${dayHourFmt.format(t)} UTC` }),
    ...(rows.length
      ? rows.map(({ s, p }) =>
        el("div", { class: "tt-row" },
          el("span", { class: "line-key", style: { background: s.color } }),
          el("span", { class: "tt-value", text: fmt(p.v) }),
          el("span", { class: "tt-label", text: s.label }),
          el("span", { class: "tt-cpu", text: runsNote(p.runs) })))
      : [el("div", { class: "tt-label", text: "No result" })]),
  );
  tooltip.hidden = false;
  const box = container.getBoundingClientRect();
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let left = box.left + x + 14;
  if (left + tw > window.innerWidth - 8) left = box.left + x - tw - 14;
  left = Math.max(8, left);
  let top = (clientY ?? box.top + 24) - th / 2;
  top = Math.min(Math.max(8, top), window.innerHeight - th - 8);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

// ── tables ─────────────────────────────────────────────────────────────

function labelCell(label) {
  return el("td", {}, el("span", { class: "label-cell" },
    el("span", { class: "key-dot", style: { background: colorOf(label) } }), label));
}

function renderModels(rows, labels) {
  const body = document.querySelector("#models tbody");
  body.replaceChildren();
  for (const label of labels) {
    const mine = rows.filter((r) => r.label === label && r.cpu_model);
    for (const [model, n] of countBy(mine, (r) => r.cpu_model)) {
      const group = mine.filter((r) => r.cpu_model === model);
      body.append(el("tr", {},
        labelCell(label),
        el("td", { class: "cpu", text: model }),
        el("td", { class: "num", text: nf.format(n) }),
        el("td", { class: "num", text: `${Math.round((100 * n) / mine.length)}%` }),
        el("td", { class: "num", text: fmtScore(quantile(group.map((r) => r.cpu_mark), 0.5)) }),
        el("td", { class: "num", text: fmtScore(quantile(group.map((r) => r.single_thread), 0.5)) }),
        el("td", { class: "num", text: fmtDuration(quantile(group.map((r) => r.queue_seconds), 0.5)) }),
      ));
    }
  }
  if (!body.children.length) {
    body.append(el("tr", {}, el("td", { class: "empty", colspan: "7", text: "No results in this range." })));
  }
}

function renderRuns(rows) {
  const body = document.querySelector("#runs tbody");
  const newest = rows.slice().reverse();
  const shown = newest.slice(0, state.runsShown);
  body.replaceChildren(...shown.map((r) => {
    const ok = r.conclusion === "success";
    const result = r.url
      ? el("a", { href: r.url, target: "_blank", rel: "noopener", text: r.conclusion || "unknown" })
      : document.createTextNode(r.conclusion || "unknown");
    const cell = el("td", { class: ok ? "" : "status-failed" }, result);
    if (r.error) cell.title = r.error;
    return el("tr", {},
      el("td", { text: dateTimeFmt.format(r.t) }),
      labelCell(r.label),
      el("td", { class: "cpu", text: r.cpu_model || "–" }),
      el("td", { class: "num", text: fmtScore(r.cpu_mark) }),
      el("td", { class: "num", text: fmtScore(r.single_thread) }),
      el("td", { class: "num", text: fmtDuration(r.queue_seconds) }),
      cell,
    );
  }));
  if (!shown.length) {
    body.append(el("tr", {}, el("td", { class: "empty", colspan: "7", text: "No results in this range." })));
  }
  document.getElementById("runs-caption").textContent =
    `Every benchmark job in this range, newest first (${nf.format(Math.min(shown.length, newest.length))} of ${nf.format(newest.length)}).`;
  document.getElementById("runs-more").hidden = newest.length <= shown.length;
}

// ── page ───────────────────────────────────────────────────────────────

const CHARTS = [
  { id: "chart-cpu-mark", field: "cpu_mark", kind: "score", name: "CPU Mark" },
  { id: "chart-single", field: "single_thread", kind: "score", name: "Single-thread score" },
  { id: "chart-queue", field: "queue_seconds", kind: "duration", name: "Queue time" },
];

function render() {
  const rows = visibleRows();
  const labels = labelsIn(rows);
  const current = utcHour(Date.now());
  const first = state.range === "all"
    ? (rows.length ? utcHour(rows[0].t) : current - DAY)
    : current - (RANGES[state.range] - 1) * HOUR;
  const domain = [first - HOUR / 2, current + HOUR / 2];
  for (const c of CHARTS) {
    const series = seriesFor(rows, labels, c.field);
    renderLegend(c.field, series);
    const node = document.getElementById(c.id);
    node.tabIndex = 0;
    node.setAttribute("role", "img");
    node.setAttribute("aria-label",
      `${c.name} over time by runner label. Focus and use the arrow keys to read values; the runs table lists every value.`);
    renderChart(node, { series, domain, kind: c.kind });
  }
  renderSummary(rows, labels);
  renderModels(rows, labels);
  renderRuns(rows);

  const meta = document.getElementById("meta");
  const updated = state.index?.updated_at ? `Last result stored ${dateTimeFmt.format(Date.parse(state.index.updated_at))}` : "";
  meta.textContent = rows.length
    ? `${nf.format(rows.length)} jobs in range${updated ? ` · ${updated}` : ""}`
    : updated || "No results yet. The first hourly run will add some.";
}

function syncHash() {
  history.replaceState(null, "", `#range=${state.range}&arch=${state.arch}`);
}

function markChecked(group, key, value) {
  for (const b of document.querySelectorAll(`#${group} button`)) {
    b.setAttribute("aria-checked", String(b.dataset[key] === value));
  }
}

function setArch(arch, { push = true } = {}) {
  if (!ARCHES.includes(arch)) arch = ARCHES[0];
  state.arch = arch;
  state.runsShown = PAGE;
  markChecked("arch", "arch", arch);
  if (push) {
    syncHash();
    render();
  }
}

async function setRange(range, { push = true } = {}) {
  if (!(range in RANGES)) range = "7d";
  state.range = range;
  state.runsShown = PAGE;
  markChecked("range", "range", range);
  if (push) syncHash();
  const content = document.getElementById("content");
  content.classList.add("loading");
  const rows = await rowsFor(range);
  // A newer range click wins; its load renders instead.
  if (state.range !== range) return;
  content.classList.remove("loading");
  state.rows = rows;
  render();
}

async function main() {
  for (const b of document.querySelectorAll("#range button")) {
    b.addEventListener("click", () => setRange(b.dataset.range));
  }
  for (const b of document.querySelectorAll("#arch button")) {
    b.addEventListener("click", () => setArch(b.dataset.arch));
  }
  document.getElementById("runs-more").addEventListener("click", () => {
    state.runsShown += PAGE;
    renderRuns(visibleRows());
  });

  let pending = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      for (const c of CHARTS) {
        const node = document.getElementById(c.id);
        if (node._cfg && node._width !== node.clientWidth) {
          node._width = node.clientWidth;
          renderChart(node, node._cfg);
        }
      }
    });
  });
  for (const c of CHARTS) ro.observe(document.getElementById(c.id));

  try {
    state.index = await loadIndex();
  } catch {
    state.index = { months: [] };
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  setArch(hash.get("arch"), { push: false });
  await setRange(hash.get("range") || "7d", { push: false });
}

main();
