import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const DB_PATH = process.env.DATABASE_URL || "./data/app.db";
try {
  mkdirSync(DB_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
} catch {}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS stations (
    gtfs_stop_id TEXT PRIMARY KEY,
    stop_name    TEXT NOT NULL,
    borough      TEXT,
    routes       TEXT,
    north_label  TEXT,
    south_label  TEXT,
    lat          REAL,
    lon          REAL
  );
  CREATE TABLE IF NOT EXISTS favorites (
    gtfs_stop_id TEXT PRIMARY KEY,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    added_at     INTEGER NOT NULL
  );
`);

// Migration: per-station direction preference ('both' | 'N' | 'S').
{
  const cols = db.query("PRAGMA table_info(favorites)").all() as any[];
  if (!cols.some((c) => c.name === "direction")) {
    db.exec(
      "ALTER TABLE favorites ADD COLUMN direction TEXT NOT NULL DEFAULT 'both'"
    );
  }
}

// ---------------------------------------------------------------------------
// Station catalogue (cached from the public MTA / NY Open Data dataset)
// ---------------------------------------------------------------------------
const BOROUGHS: Record<string, string> = {
  M: "Manhattan",
  Bk: "Brooklyn",
  Bx: "Bronx",
  Q: "Queens",
  SI: "Staten Island",
};

async function ensureStations(force = false) {
  const count = (db.query("SELECT COUNT(*) AS n FROM stations").get() as any).n;
  if (count > 0 && !force) return count;
  const url = "https://data.ny.gov/resource/39hk-dx4f.json?$limit=2000";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`station dataset fetch failed: ${res.status}`);
  const rows = (await res.json()) as any[];
  const insert = db.prepare(
    `INSERT OR REPLACE INTO stations
       (gtfs_stop_id, stop_name, borough, routes, north_label, south_label, lat, lon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((items: any[]) => {
    for (const r of items) {
      if (!r.gtfs_stop_id) continue;
      insert.run(
        r.gtfs_stop_id,
        r.stop_name ?? "",
        BOROUGHS[r.borough] ?? r.borough ?? "",
        r.daytime_routes ?? "",
        r.north_direction_label ?? "Northbound",
        r.south_direction_label ?? "Southbound",
        r.gtfs_latitude ? Number(r.gtfs_latitude) : null,
        r.gtfs_longitude ? Number(r.gtfs_longitude) : null
      );
    }
  });
  tx(rows);
  return (db.query("SELECT COUNT(*) AS n FROM stations").get() as any).n;
}

// ---------------------------------------------------------------------------
// Real-time GTFS feeds
// ---------------------------------------------------------------------------
const FEED_BASE =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";
const FEEDS = [
  "gtfs",
  "gtfs-ace",
  "gtfs-bdfm",
  "gtfs-g",
  "gtfs-jz",
  "gtfs-nqrw",
  "gtfs-l",
  "gtfs-si",
];

type Arrival = { stop: string; route: string; dir: "N" | "S"; time: number };

let feedCache: { at: number; arrivals: Arrival[] } = { at: 0, arrivals: [] };
let inflight: Promise<Arrival[]> | null = null;
const CACHE_MS = 25_000;

async function fetchFeed(name: string): Promise<Arrival[]> {
  const out: Arrival[] = [];
  try {
    const res = await fetch(FEED_BASE + name, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return out;
    const buf = new Uint8Array(await res.arrayBuffer());
    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu?.stopTimeUpdate) continue;
      const route = tu.trip?.routeId ?? "?";
      for (const stu of tu.stopTimeUpdate) {
        const sid = stu.stopId;
        if (!sid) continue;
        const last = sid.slice(-1);
        if (last !== "N" && last !== "S") continue;
        const t = stu.arrival?.time ?? stu.departure?.time;
        if (t == null) continue;
        out.push({
          stop: sid.slice(0, -1),
          route,
          dir: last,
          time: Number(t),
        });
      }
    }
  } catch {
    /* a single feed failing should not sink the whole request */
  }
  return out;
}

async function getArrivals(): Promise<Arrival[]> {
  const now = Date.now();
  if (now - feedCache.at < CACHE_MS) return feedCache.arrivals;
  if (inflight) return inflight;
  inflight = (async () => {
    const results = await Promise.all(FEEDS.map(fetchFeed));
    const arrivals = results.flat();
    feedCache = { at: Date.now(), arrivals };
    inflight = null;
    return arrivals;
  })();
  return inflight;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stationRow(id: string) {
  return db.query("SELECT * FROM stations WHERE gtfs_stop_id = ?").get(id) as
    | any
    | null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const publicDir = `${import.meta.dir}/public`;

// Warm the catalogue at boot (non-fatal if offline).
ensureStations().catch((e) => console.error("station load:", e.message));

const server = {
  port: process.env.PORT || 3000,
  hostname: "0.0.0.0",
  async fetch(req: Request) {
    const url = new URL(req.url);
    const { pathname } = url;

    // ---- API ----
    if (pathname === "/api/stations") {
      try {
        await ensureStations();
      } catch (e: any) {
        return json({ error: e.message, stations: [] }, 502);
      }
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      let rows: any[];
      if (q) {
        rows = db
          .query(
            `SELECT * FROM stations
             WHERE lower(stop_name) LIKE ?
             ORDER BY stop_name LIMIT 40`
          )
          .all(`%${q}%`) as any[];
      } else {
        rows = db
          .query("SELECT * FROM stations ORDER BY stop_name LIMIT 40")
          .all() as any[];
      }
      return json({ stations: rows.map(toStation) });
    }

    if (pathname === "/api/favorites" && req.method === "GET") {
      const favs = db
        .query(
          `SELECT s.*, f.direction FROM favorites f
           JOIN stations s ON s.gtfs_stop_id = f.gtfs_stop_id
           ORDER BY f.sort_order, f.added_at`
        )
        .all() as any[];
      return json({
        favorites: favs.map((r) => ({ ...toStation(r), direction: r.direction || "both" })),
      });
    }

    if (pathname === "/api/favorites" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as any;
      const id = body.gtfs_stop_id;
      if (!id || !stationRow(id))
        return json({ error: "unknown station" }, 400);
      const max =
        (db.query("SELECT MAX(sort_order) AS m FROM favorites").get() as any)
          .m ?? 0;
      db.prepare(
        `INSERT OR IGNORE INTO favorites (gtfs_stop_id, sort_order, added_at)
         VALUES (?, ?, ?)`
      ).run(id, max + 1, Math.floor(Date.now() / 1000));
      return json({ ok: true });
    }

    const favMatch = pathname.match(/^\/api\/favorites\/(.+)$/);
    if (favMatch && req.method === "DELETE") {
      db.prepare("DELETE FROM favorites WHERE gtfs_stop_id = ?").run(
        decodeURIComponent(favMatch[1])
      );
      return json({ ok: true });
    }
    if (favMatch && req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as any;
      const dir = body.direction;
      if (!["both", "N", "S"].includes(dir))
        return json({ error: "bad direction" }, 400);
      db.prepare(
        "UPDATE favorites SET direction = ? WHERE gtfs_stop_id = ?"
      ).run(dir, decodeURIComponent(favMatch[1]));
      return json({ ok: true });
    }

    if (pathname === "/api/arrivals") {
      const stopsParam = url.searchParams.get("stops") || "";
      const ids = stopsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) return json({ now: nowSec(), stations: [] });

      let all: Arrival[];
      try {
        all = await getArrivals();
      } catch (e: any) {
        return json({ error: "feed unavailable", now: nowSec(), stations: [] }, 502);
      }
      const now = nowSec();
      const wanted = new Set(ids);
      const byStop: Record<string, Arrival[]> = {};
      for (const a of all) {
        if (!wanted.has(a.stop)) continue;
        if (a.time < now - 30) continue;
        (byStop[a.stop] ||= []).push(a);
      }

      const stations = ids.map((id) => {
        const meta = stationRow(id);
        const list = (byStop[id] || []).sort((a, b) => a.time - b.time);
        const pick = (dir: "N" | "S") =>
          list
            .filter((a) => a.dir === dir)
            .slice(0, 6)
            .map((a) => ({
              route: a.route,
              time: a.time,
              minutes: Math.max(0, Math.round((a.time - now) / 60)),
            }));
        return {
          ...(meta ? toStation(meta) : { gtfs_stop_id: id, stop_name: id }),
          arrivals: { N: pick("N"), S: pick("S") },
        };
      });
      return json({ now, stations });
    }

    // ---- Static files ----
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const file = Bun.file(publicDir + filePath);
    if (await file.exists()) return new Response(file);
    // SPA-ish fallback
    return new Response(Bun.file(publicDir + "/index.html"));
  },
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toStation(r: any) {
  return {
    gtfs_stop_id: r.gtfs_stop_id,
    stop_name: r.stop_name,
    borough: r.borough,
    routes: (r.routes || "").split(/\s+/).filter(Boolean),
    north_label: r.north_label,
    south_label: r.south_label,
    lat: r.lat,
    lon: r.lon,
  };
}

console.log(`NYC Subway Tracker listening on :${server.port}`);
export default server;
