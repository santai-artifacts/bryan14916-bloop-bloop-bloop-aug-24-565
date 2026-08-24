// ---------------------------------------------------------------------------
// NYC Subway Tracker — client
// ---------------------------------------------------------------------------

// Official MTA route colors.
const ROUTE_COLORS = {
  "1": "#EE352E", "2": "#EE352E", "3": "#EE352E",
  "4": "#00933C", "5": "#00933C", "6": "#00933C", "6X": "#00933C",
  "7": "#B933AD", "7X": "#B933AD",
  A: "#0039A6", C: "#0039A6", E: "#0039A6",
  B: "#FF6319", D: "#FF6319", F: "#FF6319", FX: "#FF6319", M: "#FF6319",
  G: "#6CBE45",
  J: "#996633", Z: "#996633",
  L: "#A7A9AC",
  N: "#FCCC0A", Q: "#FCCC0A", R: "#FCCC0A", W: "#FCCC0A",
  S: "#808183", GS: "#808183", FS: "#808183", H: "#808183", SS: "#808183",
  SI: "#0039A6", SIR: "#0039A6", SF: "#808183",
};
const LIGHT_ROUTES = new Set(["N", "Q", "R", "W"]); // need dark text

function routeColor(r) {
  return ROUTE_COLORS[r] || "#5a6474";
}
function routeLabel(r) {
  // GTFS names like "GS" -> "S", "FS" -> "S", "SS"/"H" shuttle -> "S"
  if (["GS", "FS", "SS", "H", "SF"].includes(r)) return "S";
  if (r === "6X") return "6";
  if (r === "7X") return "7";
  if (r === "FX") return "F";
  return r;
}

function bullet(r, small) {
  const el = document.createElement("span");
  el.className = "bullet" + (small ? " sm" : "");
  el.style.background = routeColor(r);
  if (LIGHT_ROUTES.has(r)) el.style.color = "#111";
  el.textContent = routeLabel(r);
  return el;
}

// Largest per-direction train count the user may request (matches the server).
const MAX_TRAINS = 12;

// The distinct line labels that serve a station (collapses variants: 6X->6 …).
function stationLines(s) {
  const out = [];
  const seen = new Set();
  for (const r of s.routes || []) {
    const l = routeLabel(r);
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

// The set of currently-shown lines. Empty filter == all lines.
function enabledLines(s, fav) {
  const all = stationLines(s);
  const f = fav.routes_filter;
  if (!f || f.length === 0) return new Set(all);
  const set = new Set(f.filter((l) => all.includes(l)));
  return set.size ? set : new Set(all);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let favorites = [];
let refreshTimer = null;

const $ = (sel) => document.querySelector(sel);
const board = $("#board");
const emptyEl = $("#empty");
const statusEl = $("#status");

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadFavorites() {
  const res = await fetch("/api/favorites");
  const data = await res.json();
  favorites = data.favorites || [];
}

async function addFavorite(id) {
  await fetch("/api/favorites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gtfs_stop_id: id }),
  });
  await loadFavorites();
  await refresh();
}

async function removeFavorite(id) {
  await fetch("/api/favorites/" + encodeURIComponent(id), { method: "DELETE" });
  await loadFavorites();
  render(lastData);
}

let lastData = null;
async function refresh() {
  if (favorites.length === 0) {
    render(null);
    return;
  }
  const ids = favorites.map((f) => f.gtfs_stop_id).join(",");
  try {
    const res = await fetch("/api/arrivals?stops=" + encodeURIComponent(ids));
    const data = await res.json();
    lastData = data;
    render(data);
    setStatus("");
  } catch (e) {
    setStatus("Couldn’t reach the live feed. Retrying…");
  }
}

function setStatus(msg) {
  statusEl.textContent = msg;
  statusEl.hidden = !msg;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
// Cards are kept alive across renders (keyed by station id) so that refreshing
// data or toggling direction updates in place instead of tearing the board down
// and replaying the entrance animation — which is what caused the flashing.
const cardIndex = new Map();

function render(data) {
  if (favorites.length === 0) {
    board.innerHTML = "";
    cardIndex.clear();
    emptyEl.hidden = false;
    $("#lastUpdated").textContent = "";
    return;
  }
  emptyEl.hidden = true;

  const map = {};
  if (data) for (const s of data.stations) map[s.gtfs_stop_id] = s;

  // Drop cards for stations that are no longer favorites.
  const favIds = new Set(favorites.map((f) => f.gtfs_stop_id));
  for (const [id, card] of cardIndex) {
    if (!favIds.has(id)) {
      card.remove();
      cardIndex.delete(id);
    }
  }

  // Create or update a card per favorite, in order.
  for (const fav of favorites) {
    const s = map[fav.gtfs_stop_id] || fav;
    let card = cardIndex.get(fav.gtfs_stop_id);
    if (!card) {
      card = stationCard(s, fav);
      cardIndex.set(fav.gtfs_stop_id, card);
    } else {
      updateCard(card, s, fav);
    }
    board.appendChild(card); // re-appending in order keeps favorites order
  }

  if (data)
    $("#lastUpdated").textContent =
      "Updated " +
      new Date(data.now * 1000).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
}

// Build a card's stable structure once. Volatile parts (direction state and the
// arrival columns) are filled by updateCard so later refreshes never recreate it.
function stationCard(s, fav) {
  const card = document.createElement("article");
  card.className = "station";
  card.dataset.id = s.gtfs_stop_id;

  // Head (static for the life of the card)
  const head = document.createElement("div");
  head.className = "station-head";

  const title = document.createElement("div");
  title.className = "station-title";
  const h3 = document.createElement("h3");
  h3.textContent = s.stop_name || fav.stop_name;
  const sub = document.createElement("div");
  sub.className = "station-sub";
  sub.textContent = s.borough || fav.borough || "";
  title.append(h3, sub);

  const routes = document.createElement("div");
  routes.className = "routes";
  (s.routes || fav.routes || []).forEach((r) => routes.appendChild(bullet(r, true)));

  const rm = document.createElement("button");
  rm.className = "remove";
  rm.textContent = "Remove";
  rm.onclick = () => removeFavorite(s.gtfs_stop_id);

  head.append(title, routes, rm);
  card.appendChild(head);

  // Controls bar: direction filter + (multi-line) line filter + train count.
  // Built once; live state is applied in updateCard.
  const controls = document.createElement("div");
  controls.className = "controls";

  // Direction segmented control (labels are station-specific).
  const seg = document.createElement("div");
  seg.className = "seg";
  const options = [
    ["both", "Both"],
    ["N", s.north_label || "Northbound"],
    ["S", s.south_label || "Southbound"],
  ];
  for (const [value, label] of options) {
    const b = document.createElement("button");
    b.className = "seg-btn";
    b.dataset.value = value;
    b.textContent = label;
    b.onclick = () => setDirection(s.gtfs_stop_id, value);
    seg.appendChild(b);
  }
  controls.appendChild(seg);

  // Line filter — only meaningful when more than one line serves the station.
  const lines = stationLines(s);
  if (lines.length > 1) {
    const lineWrap = document.createElement("div");
    lineWrap.className = "lines";
    for (const line of lines) {
      const chip = bullet(line, true);
      chip.classList.add("line-chip");
      chip.dataset.line = line;
      chip.title = `Show/hide ${line} trains`;
      chip.onclick = () => toggleLine(s.gtfs_stop_id, line);
      lineWrap.appendChild(chip);
    }
    controls.appendChild(lineWrap);
  }

  // Train-count stepper.
  const count = document.createElement("div");
  count.className = "count";
  count.innerHTML =
    `<span class="count-label">Trains</span>` +
    `<button class="step" data-d="-1" aria-label="Show fewer trains">−</button>` +
    `<span class="n"></span>` +
    `<button class="step" data-d="1" aria-label="Show more trains">+</button>`;
  count
    .querySelectorAll(".step")
    .forEach(
      (btn) =>
        (btn.onclick = () =>
          setCount(s.gtfs_stop_id, Number(btn.dataset.d)))
    );
  controls.appendChild(count);

  card.appendChild(controls);

  const dirs = document.createElement("div");
  dirs.className = "dirs";
  card.appendChild(dirs);

  updateCard(card, s, fav);
  return card;
}

// Update only the parts of an existing card that can change.
function updateCard(card, s, fav) {
  const dir = fav.direction || "both";
  card.classList.toggle("half", dir !== "both");

  // Active state on the direction control.
  for (const b of card.querySelector(".seg").children) {
    b.classList.toggle("active", b.dataset.value === dir);
  }

  // Line filter state.
  const enabled = enabledLines(s, fav);
  const lineWrap = card.querySelector(".lines");
  if (lineWrap) {
    for (const chip of lineWrap.children) {
      chip.classList.toggle("off", !enabled.has(chip.dataset.line));
    }
  }

  // Train-count value + stepper bounds.
  const count = fav.max_trains || 6;
  const nEl = card.querySelector(".count .n");
  if (nEl) nEl.textContent = count;
  card.querySelectorAll(".count .step").forEach((btn) => {
    const d = Number(btn.dataset.d);
    btn.disabled = (d < 0 && count <= 1) || (d > 0 && count >= MAX_TRAINS);
  });

  // Arrival columns: filter by enabled lines, then trim to the chosen count.
  // Rebuilding this subtree is synchronous (one paint, no blank frame) and
  // carries no animation, so it doesn't flash.
  const northLabel = s.north_label || "Northbound";
  const southLabel = s.south_label || "Southbound";
  const trim = (arr) =>
    (arr || [])
      .filter((a) => enabled.has(routeLabel(a.route)))
      .slice(0, count);
  const dirs = card.querySelector(".dirs");
  dirs.replaceChildren();
  if (dir !== "S") dirs.appendChild(dirColumn(northLabel, trim(s.arrivals?.N)));
  if (dir !== "N") dirs.appendChild(dirColumn(southLabel, trim(s.arrivals?.S)));
  dirs.style.gridTemplateColumns = dir !== "both" ? "1fr" : "";
}

// Best-effort persistence of a preference change.
function patchFav(id, body) {
  return fetch("/api/favorites/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Latest station data (arrivals + metadata) or the favorite as a fallback.
function currentStation(id) {
  if (lastData) {
    const s = lastData.stations.find((x) => x.gtfs_stop_id === id);
    if (s) return s;
  }
  return favorites.find((f) => f.gtfs_stop_id === id);
}

function setDirection(id, dir) {
  const fav = favorites.find((f) => f.gtfs_stop_id === id);
  if (fav) fav.direction = dir;
  render(lastData); // reflect immediately
  patchFav(id, { direction: dir });
}

function toggleLine(id, line) {
  const fav = favorites.find((f) => f.gtfs_stop_id === id);
  if (!fav) return;
  const s = currentStation(id) || fav;
  const all = stationLines(s);
  const enabled = new Set(enabledLines(s, fav));
  if (enabled.has(line)) {
    if (enabled.size <= 1) return; // always keep at least one line visible
    enabled.delete(line);
  } else {
    enabled.add(line);
  }
  const arr = all.filter((l) => enabled.has(l)); // preserve line order
  fav.routes_filter = arr.length === all.length ? [] : arr; // [] == all
  render(lastData);
  patchFav(id, { routes: fav.routes_filter });
}

function setCount(id, delta) {
  const fav = favorites.find((f) => f.gtfs_stop_id === id);
  if (!fav) return;
  const cur = fav.max_trains || 6;
  const next = Math.max(1, Math.min(MAX_TRAINS, cur + delta));
  if (next === cur) return;
  fav.max_trains = next;
  render(lastData);
  patchFav(id, { max_trains: next });
}

function dirColumn(label, arrivals) {
  const col = document.createElement("div");
  col.className = "dir";
  const h4 = document.createElement("h4");
  h4.textContent = label;
  col.appendChild(h4);

  if (!arrivals || arrivals.length === 0) {
    const none = document.createElement("div");
    none.className = "no-trains";
    none.textContent = "No trains scheduled";
    col.appendChild(none);
    return col;
  }

  for (const a of arrivals) {
    const row = document.createElement("div");
    row.className = "arr" + (a.minutes <= 1 ? " soon" : "");
    row.appendChild(bullet(a.route, false));

    const when = document.createElement("div");
    when.className = "when";
    if (a.minutes <= 0) {
      when.textContent = "Now";
    } else {
      when.innerHTML = `${a.minutes} <small>min</small>`;
    }
    row.appendChild(when);
    col.appendChild(row);
  }
  return col;
}

// ---------------------------------------------------------------------------
// Add-station modal
// ---------------------------------------------------------------------------
const modal = $("#modal");
const searchInput = $("#search");
const resultsEl = $("#results");

function openModal() {
  modal.hidden = false;
  searchInput.value = "";
  runSearch("");
  setTimeout(() => searchInput.focus(), 30);
}
function closeModal() {
  modal.hidden = true;
}

let searchDebounce = null;
function onSearchInput() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(searchInput.value.trim()), 180);
}

async function runSearch(q) {
  resultsEl.innerHTML = `<li class="hint">Searching…</li>`;
  try {
    const res = await fetch("/api/stations?q=" + encodeURIComponent(q));
    const data = await res.json();
    const favIds = new Set(favorites.map((f) => f.gtfs_stop_id));
    const stations = data.stations || [];
    if (stations.length === 0) {
      resultsEl.innerHTML = `<li class="hint">No stations found.</li>`;
      return;
    }
    resultsEl.innerHTML = "";
    for (const s of stations) {
      const li = document.createElement("li");
      li.className = "result";

      const routes = document.createElement("div");
      routes.className = "routes";
      (s.routes || []).forEach((r) => routes.appendChild(bullet(r, true)));

      const name = document.createElement("div");
      name.className = "r-name";
      name.innerHTML = `<b></b><span></span>`;
      name.querySelector("b").textContent = s.stop_name;
      name.querySelector("span").textContent = s.borough || "";

      li.append(routes, name);

      if (favIds.has(s.gtfs_stop_id)) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "✓ Added";
        li.appendChild(tag);
      } else {
        li.style.cursor = "pointer";
        li.onclick = async () => {
          await addFavorite(s.gtfs_stop_id);
          closeModal();
        };
      }
      resultsEl.appendChild(li);
    }
  } catch (e) {
    resultsEl.innerHTML = `<li class="hint">Couldn’t load stations.</li>`;
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
$("#addBtn").onclick = openModal;
$("#closeModal").onclick = closeModal;
document.addEventListener("click", (e) => {
  if (e.target.matches("[data-open-add]")) openModal();
});
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closeModal();
});
searchInput.addEventListener("input", onSearchInput);

async function init() {
  await loadFavorites();
  await refresh();
  refreshTimer = setInterval(refresh, 30000);
  // Re-render every 15s so the "min" countdown stays fresh between fetches.
  setInterval(() => lastData && render(lastData), 15000);
}
init();
