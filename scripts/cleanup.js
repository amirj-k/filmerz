'use strict';
/**
 * cleanup.js — one-shot (but re-runnable) data repair for data/app.db:
 *   1. genres    → canonical names (merges synonyms, splits composites)
 *   2. titles    → strips crawl notices / label bleed
 *   3. people    → splits bled-together names, drops junk
 *   4. countries → one canonical row per country (splits composites, fixes typos)
 *   5. series    → franchise keys + episode numbers on every movie
 *   6. FTS resync for every touched movie + VACUUM
 * Usage: node scripts/cleanup.js [--quiet]
 */
const config = require('../src/config');
const { openAppDb } = require('../src/db');
const { applySchema } = require('../src/schema');
const { normSearch, slugify } = require('../src/normalizer');
const { canonGenres, cleanTitle, splitPersonName, canonCountries, parseSeries, seriesKeyOf, PERSON_BLEED_RE } = require('../src/canon');
const queries = require('../src/queries');

const QUIET = process.argv.includes('--quiet');
const log = (m) => { if (!QUIET) console.log(m); };

const db = openAppDb(config.appDbPath);
applySchema(db);

const touched = new Set();
db.exec('BEGIN');
try {
  /* ---- 1. genres ------------------------------------------------- */
  // Consolidate every genre row into its canonical form:
  //   - single-target groups: pick one surviving row (prefer the row that
  //     already carries the canonical name), rename it, move links, delete
  //     the other variants (rename avoids slug-UNIQUE collisions).
  //   - composite rows («اکشن- جنایی- کمدی»): move links to every target.
  //   - un-mappable rows: drop.
  let genreMoves = 0;
  const unlink = db.prepare('DELETE FROM movie_genres WHERE genre_id = ?');
  const link = db.prepare('INSERT OR IGNORE INTO movie_genres (movie_id, genre_id) VALUES (?, ?)');
  const allGenres = db.prepare('SELECT id, name FROM genres').all();
  const counts = new Map(
    db.prepare('SELECT genre_id, COUNT(*) c FROM movie_genres GROUP BY genre_id').all().map((r) => [r.genre_id, r.c])
  );
  const groups = new Map();
  const junkRows = [];
  for (const g of allGenres) {
    const canon = canonGenres(g.name);
    if (!canon.length) { junkRows.push(g); continue; }
    const key = canon.join('،');
    if (canon.length === 1 && canon[0] === g.name) continue; // already canonical
    if (!groups.has(key)) groups.set(key, { canon, rows: [] });
    groups.get(key).rows.push({ ...g, c: counts.get(g.id) || 0 });
  }
  for (const g of junkRows) { // unmappable labels / glued country names → drop
    for (const m of db.prepare('SELECT movie_id FROM movie_genres WHERE genre_id = ?').all(g.id)) {
      unlink.run(m.movie_id);
      touched.add(m.movie_id);
      genreMoves++;
    }
    db.prepare('DELETE FROM genres WHERE id = ?').run(g.id);
    log(`[genres] junk dropped: «${g.name}»`);
  }
  for (const { canon, rows } of groups.values()) {
    if (canon.length === 1) {
      const [name] = canon;
      // Prefer: an in-group row already named canonically → else the existing
      // canonical row in the table (groups like «انیمیشنکشور سازنده…» whose
      // target «انیمیشن» already exists) → else the biggest variant (rename).
      let keep = rows.find((r) => r.name === name)
        || db.prepare('SELECT id, name FROM genres WHERE name = ?').get(name);
      let fromTable = keep && !rows.some((r) => r.id === keep.id);
      if (!keep) keep = rows.reduce((a, b) => (b.c > a.c ? b : a));
      for (const r of rows) {
        if (r.id === keep.id) continue;
        for (const m of db.prepare('SELECT movie_id FROM movie_genres WHERE genre_id = ?').all(r.id)) {
          link.run(m.movie_id, keep.id);
          touched.add(m.movie_id);
          genreMoves++;
        }
        unlink.run(r.id);
        db.prepare('DELETE FROM genres WHERE id = ?').run(r.id);
        log(`[genres] «${r.name}»(${r.c}) → «${name}»`);
      }
      if (fromTable) {
        log(`[genres] merged variants into existing «${name}»`);
      } else if (keep.name !== name) {
        const newSlug = slugify(name);
        const taken = db.prepare('SELECT 1 FROM genres WHERE slug = ? AND id != ?').get(newSlug, keep.id);
        const finalSlug = taken ? `${newSlug}-${keep.id}` : newSlug;
        db.prepare('UPDATE genres SET name = ?, slug = ?, name_norm = ? WHERE id = ?')
          .run(name, finalSlug, normSearch(name), keep.id);
        for (const m of db.prepare('SELECT movie_id FROM movie_genres WHERE genre_id = ?').all(keep.id)) touched.add(m.movie_id);
        log(`[genres] renamed «${keep.name}» → «${name}» (${keep.c} links kept)`);
      }
    } else {
      for (const r of rows) {
        for (const m of db.prepare('SELECT movie_id FROM movie_genres WHERE genre_id = ?').all(r.id)) {
          for (const name of canon) {
            const t = queries.getOrCreateGenre(db, name);
            if (t && t.id !== r.id) link.run(m.movie_id, t.id);
          }
          touched.add(m.movie_id);
          genreMoves++;
        }
        unlink.run(r.id);
        db.prepare('DELETE FROM genres WHERE id = ?').run(r.id);
        log(`[genres] «${r.name}»(${r.c}) → ${canon.join('، ')}`);
      }
    }
  }
  log(`[genres] done — ${genreMoves} link(s) remapped`);

  /* ---- 2. titles -------------------------------------------------- */
  let titleFixes = 0;
  for (const m of db.prepare("SELECT id, title_en, title_fa FROM movies WHERE title_en != '' OR title_fa != ''").all()) {
    const en = cleanTitle(m.title_en) || m.title_en;
    const fa = m.title_fa ? (cleanTitle(m.title_fa) || m.title_fa) : m.title_fa;
    if (en !== m.title_en || fa !== m.title_fa) {
      db.prepare('UPDATE movies SET title_en = ?, title_en_norm = ?, title_fa = ?, title_fa_norm = ? WHERE id = ?')
        .run(en, normSearch(en), fa, normSearch(fa), m.id);
      touched.add(m.id);
      titleFixes++;
    }
  }
  log(`[titles] done — ${titleFixes} fixed`);

  /* ---- 3. people --------------------------------------------------- */
  let personFixes = 0;
  const moveLinks = db.prepare(
    'INSERT OR IGNORE INTO movie_people (movie_id, person_id, role) SELECT movie_id, ?, role FROM movie_people WHERE person_id = ?'
  );
  for (const p of db.prepare('SELECT id, name FROM people').all()) {
    if (!PERSON_BLEED_RE.test(p.name)) continue;
    const clean = splitPersonName(p.name);
    if (clean && clean !== p.name) {
      const t = queries.getOrCreatePerson(db, clean);
      if (t && t.id !== p.id) {
        moveLinks.run(t.id, p.id);
        for (const r of db.prepare('SELECT movie_id FROM movie_people WHERE person_id = ?').all(p.id)) touched.add(r.movie_id);
        db.prepare('DELETE FROM movie_people WHERE person_id = ?').run(p.id);
        db.prepare('DELETE FROM people WHERE id = ?').run(p.id);
        personFixes++;
        log(`[people] «${p.name.slice(0, 60)}» → «${clean}»`);
      }
    } else if (!clean) {
      db.prepare('DELETE FROM movie_people WHERE person_id = ?').run(p.id);
      db.prepare('DELETE FROM people WHERE id = ?').run(p.id);
      personFixes++;
      log(`[people] junk removed: «${p.name.slice(0, 60)}»`);
    }
  }
  log(`[people] done — ${personFixes} fixed`);

  // 3b. Drop letterless junk names («_____») and merge same-person variants
  //     (identical name_norm: «David Gere»/«David_Gere», آ/ا spellings, stray
  //     diacritics). Keep the most-linked row of each group.
  for (const p of db.prepare('SELECT id, name FROM people').all()) {
    if (/[\u0600-\u06FFA-Za-z]/u.test(p.name)) continue;
    for (const r of db.prepare('SELECT movie_id FROM movie_people WHERE person_id = ?').all(p.id)) touched.add(r.movie_id);
    db.prepare('DELETE FROM movie_people WHERE person_id = ?').run(p.id);
    db.prepare('DELETE FROM people WHERE id = ?').run(p.id);
    personFixes++;
    log(`[people] junk removed: «${p.name.slice(0, 60)}»`);
  }
  for (const { name_norm } of db.prepare('SELECT name_norm FROM people GROUP BY name_norm HAVING COUNT(*) > 1').all()) {
    const rows = db.prepare('SELECT id, name FROM people WHERE name_norm = ?').all(name_norm)
      .map((r) => ({ ...r, links: db.prepare('SELECT COUNT(*) c FROM movie_people WHERE person_id = ?').get(r.id).c }));
    const keep = rows.reduce((a, b) => (b.links > a.links ? b : a));
    for (const r of rows) {
      if (r.id === keep.id) continue;
      moveLinks.run(keep.id, r.id);
      for (const x of db.prepare('SELECT movie_id FROM movie_people WHERE person_id = ?').all(r.id)) touched.add(x.movie_id);
      db.prepare('DELETE FROM movie_people WHERE person_id = ?').run(r.id);
      db.prepare('DELETE FROM people WHERE id = ?').run(r.id);
      personFixes++;
      log(`[people] «${r.name.slice(0, 60)}»(${r.links}) merged into «${keep.name.slice(0, 60)}»(${keep.links})`);
    }
  }

  /* ---- 4. countries -------------------------------------------------- */
  // Movies carry a single country_id; collapse composite («آمریکا , هندوستان»),
  // bled («هندتاریخ اکران…») and misspelled («المان») country rows into one
  // canonical row — the first country the value names. Unmappable rows drop.
  let countryMoves = 0;
  let countryDrops = 0;
  for (const r of db.prepare('SELECT id, name FROM countries').all()) {
    const target = canonCountries(r.name)[0] || '';
    if (target === r.name) continue; // already canonical
    if (!target) {
      db.prepare('UPDATE movies SET country_id = NULL WHERE country_id = ?').run(r.id);
      db.prepare('DELETE FROM countries WHERE id = ?').run(r.id);
      countryDrops++;
      log(`[countries] junk dropped: «${r.name.slice(0, 60)}»`);
      continue;
    }
    const t = queries.getOrCreateCountry(db, target);
    if (t && t.id !== r.id) {
      const moved = db.prepare('UPDATE movies SET country_id = ? WHERE country_id = ?').run(t.id, r.id);
      db.prepare('DELETE FROM countries WHERE id = ?').run(r.id);
      countryMoves += moved.changes;
      log(`[countries] «${r.name.slice(0, 60)}» → «${target}»`);
    }
  }
  log(`[countries] done — ${countryMoves} movie(s) remapped, ${countryDrops} junk row(s) dropped`);

  /* ---- 5. series keys ---------------------------------------------- */
  let seriesCount = 0;
  const setSeries = db.prepare('UPDATE movies SET series_key = ?, episode_no = ? WHERE id = ?');
  for (const m of db.prepare("SELECT id, title_en, title_fa FROM movies WHERE title_en != '' OR title_fa != ''").all()) {
    const key = seriesKeyOf(parseSeries(m.title_en, m.title_fa));
    setSeries.run(key, key ? (parseSeries(m.title_en, m.title_fa).episode || 0) : 0, m.id);
    if (key) seriesCount++;
  }
  log(`[series] done — ${seriesCount} movies carry a franchise key`);

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

/* ---- 6. FTS resync -------------------------------------------------- */
log(`[fts] resyncing ${touched.size} movie(s)…`);
let i = 0;
for (const id of touched) {
  queries.syncMovieFts(db, id);
  if (++i % 500 === 0) log(`[fts] … ${i}`);
}
db.exec('VACUUM');
log('[cleanup] done ✓');
db.close();
