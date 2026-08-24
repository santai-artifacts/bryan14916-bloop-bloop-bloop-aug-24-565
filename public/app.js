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

  // Direction filter (labels are station-specific). Buttons are built once;
  // their active state is updated in place.
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
  card.appendChild(seg);

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

  // Active state on the segmented control.
  for (const b of card.querySelector(".seg").children) {
    b.classList.toggle("active", b.dataset.value === dir);
  }

  // Arrival columns. Rebuilding this subtree is synchronous (one paint, no
  // blank frame) and carries no animation, so it doesn't flash.
  const northLabel = s.north_label || "Northbound";
  const southLabel = s.south_label || "Southbound";
  const dirs = card.querySelector(".dirs");
  dirs.replaceChildren();
  if (dir !== "S") dirs.appendChild(dirColumn(northLabel, s.arrivals?.N));
  if (dir !== "N") dirs.appendChild(dirColumn(southLabel, s.arrivals?.S));
  dirs.style.gridTemplateColumns = dir !== "both" ? "1fr" : "";
}

async function setDirection(id, dir) {
  const fav = favorites.find((f) => f.gtfs_stop_id === id);
  if (fav) fav.direction = dir;
  render(lastData); // reflect immediately
  try {
    await fetch("/api/favorites/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: dir }),
    });
  } catch (e) {
    /* preference is best-effort */
  }
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
