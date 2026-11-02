'use strict';
const { nowIso, withTransaction } = require('./util');

/**
 * Server-side favorites, watchlist and watch history. Every query is scoped
 * by user_id, so one account can never read or mutate another's lists.
 */

const LISTS = {
  favorites: { table: 'user_favorites', label: 'favorites' },
  watchlist: { table: 'user_watchlist', label: 'watchlist' },
};
const TYPES = new Set(['movie', 'series']);

function tableFor(list) {
  const entry = LISTS[list];
  return entry ? entry.table : null;
}

function contentType(type) {
  return type === 'movie' ? 'movies' : (type === 'series' ? 'series' : null);
}

/** Only published catalogue rows may be added to a personal list. */
function contentExists(db, type, id) {
  const table = contentType(type);
  if (!table) return false;
  return Boolean(db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ? AND published = 1`).get(id));
}

function loadContent(db, rows) {
  const out = new Map();
  const byType = { movie: [], series: [] };
  for (const row of rows) {
    if (byType[row.item_type]) byType[row.item_type].push(row.item_id);
  }
  for (const type of ['movie', 'series']) {
    const ids = [...new Set(byType[type])];
    if (!ids.length) continue;
    const table = contentType(type);
    const placeholders = ids.map(() => '?').join(',');
    const select = type === 'movie'
      ? 'SELECT id, slug, title_en, title_fa, year, poster_url, poster_valid FROM movies WHERE id IN'
      : 'SELECT id, slug, title_en, title_fa, year, poster_url, poster_valid, season_count, episode_count FROM series WHERE id IN';
    for (const item of db.prepare(`${select} (${placeholders}) AND published = 1`).all(...ids)) {
      out.set(`${type}:${item.id}`, item);
    }
  }
  return out;
}

function listRows(db, table, userId, limit) {
  return db.prepare(
    `SELECT item_type, item_id, created_at FROM ${table}
      WHERE user_id = ? ORDER BY id DESC LIMIT ?`
  ).all(userId, limit);
}

function listFor(db, list, userId, limit = 200) {
  const table = tableFor(list);
  if (!table) return [];
  const rows = listRows(db, table, userId, limit);
  const content = loadContent(db, rows);
  const out = [];
  for (const row of rows) {
    const item = content.get(`${row.item_type}:${row.item_id}`);
    if (item) out.push({ type: row.item_type, item, createdAt: row.created_at });
  }
  return out;
}

function isIn(db, list, userId, type, id) {
  const table = tableFor(list);
  if (!table || !TYPES.has(type)) return false;
  return Boolean(db.prepare(
    `SELECT 1 AS x FROM ${table} WHERE user_id = ? AND item_type = ? AND item_id = ?`
  ).get(userId, type, id));
}

function count(db, list, userId) {
  const table = tableFor(list);
  if (!table) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).get(userId).c || 0);
}

/**
 * Idempotent toggle. Returns null for an unknown list/type or missing content.
 */
function toggle(db, list, userId, type, id) {
  const table = tableFor(list);
  if (!table || !TYPES.has(type) || !contentExists(db, type, id)) return null;
  return withTransaction(db, () => {
    const existing = db.prepare(
      `SELECT id FROM ${table} WHERE user_id = ? AND item_type = ? AND item_id = ?`
    ).get(userId, type, id);
    if (existing) {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(existing.id);
    } else {
      db.prepare(
        `INSERT INTO ${table} (user_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)`
      ).run(userId, type, id, nowIso());
    }
    return { active: !existing, count: count(db, list, userId) };
  });
}

/* ------------------------------ history ------------------------------ */

function episodeBelongsToSeries(db, episodeId, seriesId) {
  if (!episodeId) return true;
  return Boolean(db.prepare(
    'SELECT 1 AS x FROM episodes WHERE id = ? AND series_id = ?'
  ).get(episodeId, seriesId));
}

/**
 * Record a real playback event. `position` is only stored when the caller
 * (the player) actually supplies it — nothing is fabricated.
 */
function recordWatch(db, userId, { itemType, itemId, episodeId = null, position = null, duration = null }) {
  if (!TYPES.has(itemType) || !contentExists(db, itemType, itemId)) return null;
  if (itemType === 'series' && !episodeBelongsToSeries(db, episodeId, itemId)) return null;
  if (itemType === 'movie' && episodeId != null) return null;
  const pos = Number.isFinite(position) ? Math.max(0, position) : null;
  const dur = Number.isFinite(duration) && duration > 0 ? duration : null;
  db.prepare(
    `INSERT INTO user_watch_history
       (user_id, item_type, item_id, episode_id, last_watched_at, progress_seconds, duration_seconds, watch_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT DO UPDATE SET
       last_watched_at = excluded.last_watched_at,
       progress_seconds = COALESCE(excluded.progress_seconds, user_watch_history.progress_seconds),
       duration_seconds = COALESCE(excluded.duration_seconds, user_watch_history.duration_seconds),
       watch_count = user_watch_history.watch_count + 1`
  ).run(userId, itemType, itemId, episodeId, nowIso(), pos, dur);
  return true;
}

function historyFor(db, userId, limit = 100) {
  const rows = db.prepare(
    `SELECT h.item_type, h.item_id, h.episode_id, h.last_watched_at,
            h.progress_seconds, h.duration_seconds, h.watch_count,
            e.season_no, e.episode_no, e.title AS episode_title
       FROM user_watch_history h
       LEFT JOIN episodes e ON e.id = h.episode_id
      WHERE h.user_id = ?
      ORDER BY h.last_watched_at DESC
      LIMIT ?`
  ).all(userId, limit);
  const content = loadContent(db, rows);
  const out = [];
  for (const row of rows) {
    const item = content.get(`${row.item_type}:${row.item_id}`);
    if (!item) continue;
    out.push({
      type: row.item_type,
      item,
      episodeId: row.episode_id,
      seasonNo: row.season_no,
      episodeNo: row.episode_no,
      episodeTitle: row.episode_title,
      watchedAt: row.last_watched_at,
      progressSeconds: row.progress_seconds,
      durationSeconds: row.duration_seconds,
      watchCount: row.watch_count,
    });
  }
  return out;
}

/** Only genuinely started, unfinished items belong in "continue watching". */
function continueWatching(db, userId, limit = 12) {
  return historyFor(db, userId, 100)
    .filter((h) => Number.isFinite(h.progressSeconds) && h.progressSeconds > 5
      && (!Number.isFinite(h.durationSeconds) || h.durationSeconds - h.progressSeconds > 30))
    .slice(0, limit);
}

module.exports = {
  listFor,
  isIn,
  count,
  toggle,
  contentExists,
  recordWatch,
  historyFor,
  continueWatching,
  LISTS,
  TYPES,
};
