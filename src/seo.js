'use strict';

const config = require('./config');

/**
 * Trim text to a search-friendly length without cutting a word in half.
 */
function truncate(text, max = 158) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const safe = cut.replace(/\s+\S*$/, '').trim();
  return `${safe || cut}…`;
}

/** First sentence of a (possibly long) synopsis, capped. */
function firstSentence(text, max = 110) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^(.{20,}?)[.!؟?…](?:\s|$)/u);
  const sentence = m ? m[1] : s;
  return truncate(sentence, max);
}

function joinFa(items) {
  return (items || []).filter(Boolean).join('، ');
}

function uniqInline(items) {
  const out = [];
  for (const item of items || []) if (item && !out.includes(item)) out.push(item);
  return out;
}

function movieUrl(movie) {
  return `/movie/${movie.id}-${movie.slug}`;
}

function seriesUrl(series) {
  return `/series/${series.id}-${series.slug}`;
}

/** Drop empty properties from a JSON-LD object (never emit "" / [] / null). */
function compact(value) {
  if (Array.isArray(value)) {
    const arr = value.map(compact).filter((v) => v !== undefined && v !== null && v !== '');
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      if (c !== undefined && c !== null && c !== '') out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

function personNodes(people) {
  return (people || []).slice(0, 20).map((p) => ({
    '@type': 'Person',
    name: p.name,
  })).filter((p) => p.name);
}

/**
 * Centralised, server-side metadata builder.
 *
 * Rules baked in here:
 * - every value comes from the database/route, never from a per-template
 *   hand-written string;
 * - titles and descriptions are derived from the page's own entity;
 * - canonical URLs are absolute and keep only the query parameters that
 *   change the rendered content;
 * - JSON-LD never invents ratings, reviews, release dates or video objects.
 */
class SEOEngine {
  constructor(db) {
    this.db = db;
    this.siteUrl = config.appBaseUrl;
    this.siteName = config.siteName;
    this.defaultTitle = 'دانلود فیلم و سریال و پخش آنلاین | فیلمرز';
    this.defaultDescription = 'در فیلمرز فیلم‌ها و سریال‌ها را جست‌وجو کنید، ژانر و سال را فیلتر کنید، '
      + 'اطلاعات بازیگران و جزئیات هر عنوان را ببینید و نسخه‌های موجود را دریافت کنید.';
    this.defaultImage = `${this.siteUrl}/apple-touch-icon.png`;
    this.defaultType = 'website';
  }

  /* ------------------------------ metadata ------------------------------ */

  generateMetadata(pageType, data = {}, pathname = '/', currentPage = 1, totalPages = 1) {
    const title = this.generateTitle(pageType, data, currentPage);
    const description = truncate(this.generateDescription(pageType, data, currentPage));
    const canonicalUrl = this.generateCanonicalUrl(pathname, currentPage, totalPages, data);
    const image = this.getOgImage(pageType, data);

    return {
      pageType,
      title,
      description,
      heading: this.generateHeading(pageType, data),
      canonicalUrl,
      og: {
        type: this.getOgType(pageType, data),
        title,
        description,
        url: canonicalUrl,
        image,
        siteName: this.siteName,
        locale: 'fa_IR',
      },
      twitter: {
        card: this.getTwitterCard(pageType, data),
        title,
        description,
        image,
      },
      robots: this.getRobots(pageType, data),
      breadcrumbs: this.generateBreadcrumbs(pageType, data),
      structuredData: this.generateStructuredData(pageType, data),
      siteStructuredData: this.generateSiteStructuredData(),
      pagination: this.generatePaginationLinks(canonicalUrl, currentPage, totalPages),
    };
  }

  /* -------------------------------- titles ------------------------------- */

  generateTitle(pageType, data = {}, currentPage = 1) {
    const pageSuffix = currentPage > 1 ? ` | صفحه ${currentPage}` : '';
    const name = (obj, enFirst = true) => {
      if (!obj) return '';
      return (enFirst ? (obj.title_en || obj.title_fa) : (obj.title_fa || obj.title_en)) || '';
    };

    switch (pageType) {
      case 'home':
        return this.defaultTitle;

      case 'movies':
      case 'genre':
      case 'country':
      case 'year': {
        const f = data.filters || {};
        const names = data.names || {};
        const total = data.result ? data.result.total : 0;
        const count = total > 0 ? ` (${total} عنوان)` : '';
        if (pageType === 'genre' || (f.genre && !f.year && !f.country && !f.person)) {
          const label = names.genre || f.genreName;
          return label
            ? `دانلود فیلم ${label}${count} | فیلمرز${pageSuffix}`
            : `دانلود فیلم${pageSuffix} | فیلمرز`;
        }
        if (pageType === 'country' || (f.country && !f.genre && !f.year && !f.person)) {
          const label = names.country || f.countryName;
          return label
            ? `فیلم‌های ${label}${count} | دانلود و معرفی | فیلمرز${pageSuffix}`
            : `فیلم‌ها${pageSuffix} | فیلمرز`;
        }
        if (pageType === 'year' || (f.year && !f.genre && !f.country && !f.person)) {
          const year = names.year || f.year;
          return year
            ? `دانلود فیلم‌های سال ${year}${count} | فیلمرز${pageSuffix}`
            : `فیلم‌ها${pageSuffix} | فیلمرز`;
        }
        if (f.person) {
          const label = names.person || f.personName;
          return label
            ? `فیلم‌های ${label}${count} | فیلمرز${pageSuffix}`
            : `فیلم‌ها${pageSuffix} | فیلمرز`;
        }
        return `دانلود فیلم جدید و آرشیو فیلم‌ها | فیلمرز${pageSuffix}`;
      }

      case 'series': {
        const f = data.filters || {};
        const names = data.names || {};
        const total = data.result ? data.result.total : 0;
        const count = total > 0 ? ` (${total} عنوان)` : '';
        if (f.genre) {
          const label = names.genre || f.genreName;
          return label
            ? `دانلود سریال ${label}${count} | فیلمرز${pageSuffix}`
            : `سریال‌ها${pageSuffix} | فیلمرز`;
        }
        if (f.year) {
          return `سریال‌های سال ${names.year || f.year}${count} | فیلمرز${pageSuffix}`;
        }
        if (f.country) {
          const label = names.country || f.countryName;
          return label
            ? `سریال‌های ${label}${count} | فیلمرز${pageSuffix}`
            : `سریال‌ها${pageSuffix} | فیلمرز`;
        }
        return `دانلود سریال جدید و آرشیو سریال‌ها | فیلمرز${pageSuffix}`;
      }

      case 'movie': {
        const m = data.movie || {};
        const t = name(m);
        if (!t) return `فیلم | فیلمرز`;
        const year = m.year ? ` (${m.year})` : '';
        const hasLinks = this.hasMovieLinks(m);
        return hasLinks
          ? `دانلود فیلم ${t}${year} | پخش آنلاین | فیلمرز`
          : `فیلم ${t}${year} | اطلاعات و جزئیات | فیلمرز`;
      }

      case 'seriesDetail': {
        const s = data.series || {};
        const t = name(s);
        if (!t) return `سریال | فیلمرز`;
        const year = s.year ? ` (${s.year})` : '';
        const hasLinks = (s.link_count || 0) > 0 || (data.episodes && data.episodes.length);
        return hasLinks
          ? `دانلود سریال ${t}${year} | معرفی و قسمت‌ها | فیلمرز`
          : `سریال ${t}${year} | معرفی و اطلاعات | فیلمرز`;
      }

      case 'genres':
        return `ژانرهای فیلم و سریال | فیلمرز`;

      case 'top250':
        return `۲۵۰ فیلم برتر تاریخ سینما | فیلمرز`;

      case 'search': {
        const q = String(data.q || '').trim();
        return q ? `جستجو: ${q} | فیلمرز` : `جستجو در فیلمرز`;
      }

      case 'wishlist':
        return `نشان‌های من | فیلمرز`;

      case '404':
        return `صفحه پیدا نشد | فیلمرز`;

      case '500':
        return `خطای سرور | فیلمرز`;

      default:
        return this.defaultTitle;
    }
  }

  /* ----------------------------- descriptions --------------------------- */

  generateDescription(pageType, data = {}, currentPage = 1) {
    const pagePart = currentPage > 1 ? ` صفحه ${currentPage}.` : '';

    switch (pageType) {
      case 'home':
        return this.defaultDescription;

      case 'movies':
      case 'genre':
      case 'country':
      case 'year': {
        const f = data.filters || {};
        const names = data.names || {};
        const result = data.result || {};
        const bits = [];
        if (pageType === 'genre' || (f.genre && !f.year && !f.country && !f.person)) {
          const label = names.genre || f.genreName;
          bits.push(label ? `آرشیو فیلم‌های ژانر ${label}` : 'آرشیو فیلم‌ها');
        } else if (pageType === 'country' || (f.country && !f.genre && !f.year && !f.person)) {
          const label = names.country || f.countryName;
          bits.push(label ? `فیلم‌های محصول ${label}` : 'آرشیو فیلم‌ها');
        } else if (pageType === 'year' || (f.year && !f.genre && !f.country && !f.person)) {
          bits.push(`فیلم‌های سال ${names.year || f.year}`);
        } else if (f.person) {
          bits.push(names.person ? `فیلم‌های ${names.person}` : 'آرشیو فیلم‌ها');
        } else {
          bits.push('آرشیو فیلم‌های جدید و قدیمی');
        }
        if (result.total) bits.push(`${result.total} عنوان`);
        bits.push('با فیلتر ژانر، سال و کشور، اطلاعات و نسخه‌های موجود هر عنوان را در فیلمرز ببینید.');
        return `${bits.join('؛ ')}${pagePart}`;
      }

      case 'series': {
        const f = data.filters || {};
        const names = data.names || {};
        const result = data.result || {};
        const bits = [];
        if (f.genre) bits.push(names.genre ? `آرشیو سریال‌های ژانر ${names.genre}` : 'آرشیو سریال‌ها');
        else if (f.year) bits.push(`سریال‌های سال ${names.year || f.year}`);
        else if (f.country) bits.push(names.country ? `سریال‌های محصول ${names.country}` : 'آرشیو سریال‌ها');
        else bits.push('آرشیو سریال‌های جدید و محبوب');
        if (result.total) bits.push(`${result.total} عنوان`);
        bits.push('فصل‌ها، قسمت‌ها و اطلاعات هر سریال را در فیلمرز ببینید.');
        return `${bits.join('؛ ')}${pagePart}`;
      }

      case 'movie':
        return this.movieDescription(data.movie || {});

      case 'seriesDetail':
        return this.seriesDescription(data.series || {}, data);

      case 'genres': {
        const count = Array.isArray(data.genres) ? data.genres.length : 0;
        return count
          ? `فهرست ${count} ژانر فیلم و سریال در فیلمرز؛ برای هر ژانر آرشیو فیلم‌های همان ژانر را ببینید.`
          : 'فهرست ژانرهای فیلم و سریال در فیلمرز.';
      }

      case 'top250': {
        const available = Array.isArray(data.items)
          ? data.items.filter((x) => x.movie).length
          : 0;
        return available
          ? `فهرست ۲۵۰ فیلم برتر تاریخ سینما؛ ${available} عنوان از این فهرست در فیلمرز موجود است و اطلاعات و نسخه‌های آن قابل مشاهده است.`
          : 'فهرست ۲۵۰ فیلم برتر تاریخ سینما و اطلاعات عنوان‌های موجود در فیلمرز.';
      }

      case 'search': {
        const q = String(data.q || '').trim();
        return q
          ? `نتایج جست‌وجوی «${q}» در فیلمرز؛ فیلم‌ها و سریال‌های مرتبط را ببینید.`
          : 'جست‌وجوی فیلم، سریال، بازیگر و عوامل در فیلمرز.';
      }

      case 'wishlist':
        return 'فهرست فیلم‌ها و سریال‌های نشان‌شده شما در فیلمرز.';

      case '404':
        return 'صفحه‌ای که به دنبال آن بودید در فیلمرز پیدا نشد.';

      case '500':
        return 'خطایی در سرور فیلمرز رخ داد. لطفاً دوباره تلاش کنید.';

      default:
        return this.defaultDescription;
    }
  }

  movieDescription(movie) {
    const t = movie.title_fa || movie.title_en || 'این فیلم';
    const name = movie.title_en && movie.title_fa ? `${movie.title_en} (${movie.title_fa})` : t;
    const year = movie.year ? ` (${movie.year})` : '';
    const bits = [];
    if (this.hasMovieLinks(movie)) bits.push(`دانلود و تماشای ${name}${year}`);
    else bits.push(`اطلاعات فیلم ${name}${year}`);

    const genres = uniqInline((movie.genres || []).map((g) => g.name)).slice(0, 3);
    if (genres.length) bits.push(`ژانر ${joinFa(genres)}`);
    if (movie.country_name) bits.push(`محصول ${movie.country_name}`);
    if (movie.quality_res) bits.push(`کیفیت ${movie.quality_res}`);
    if (movie.hardsub) bits.push('زیرنویس چسبیده');
    if (movie.age_rating) bits.push(`رده سنی ${movie.age_rating}+`);

    const plot = firstSentence(movie.plot, 80);
    if (plot) bits.push(plot);
    else bits.push('داستان، بازیگران، عوامل و مشخصات این فیلم را در فیلمرز ببینید');

    return truncate(`${bits.join('؛ ')}.`);
  }

  seriesDescription(series, data = {}) {
    const t = series.title_fa || series.title_en || 'این سریال';
    const name = series.title_en && series.title_fa ? `${series.title_en} (${series.title_fa})` : t;
    const year = series.year ? ` (${series.year})` : '';
    const bits = [];
    const hasLinks = (series.link_count || 0) > 0;
    bits.push(hasLinks ? `دانلود و تماشای سریال ${name}${year}` : `معرفی سریال ${name}${year}`);

    const genres = uniqInline((series.genres || []).map((g) => g.name)).slice(0, 3);
    if (genres.length) bits.push(`ژانر ${joinFa(genres)}`);
    if (series.country_name) bits.push(`محصول ${series.country_name}`);
    if (series.season_count) bits.push(`${series.season_count} فصل`);
    if (series.episode_count) bits.push(`${series.episode_count} قسمت`);
    if (series.status_text) bits.push(series.status_text);

    const plot = firstSentence(series.plot, 70);
    if (plot) bits.push(plot);
    else bits.push('فصل‌ها، قسمت‌ها، بازیگران و مشخصات این سریال را در فیلمرز ببینید');

    return truncate(`${bits.join('؛ ')}.`);
  }

  /* -------------------------------- headings ---------------------------- */

  generateHeading(pageType, data = {}) {
    const f = data.filters || {};
    const names = data.names || {};
    switch (pageType) {
      case 'home':
        return 'دانلود فیلم و سریال و پخش آنلاین';
      case 'movies':
        if (f.genre) return names.genre ? `فیلم‌های ${names.genre}` : 'آرشیو فیلم‌ها';
        if (f.year) return `فیلم‌های سال ${names.year || f.year}`;
        if (f.country) return names.country ? `فیلم‌های ${names.country}` : 'آرشیو فیلم‌ها';
        if (f.person) return names.person ? `فیلم‌های ${names.person}` : 'آرشیو فیلم‌ها';
        return 'آرشیو فیلم‌ها';
      case 'genre':
        return `فیلم‌های ${names.genre || ''}`.trim();
      case 'country':
        return `فیلم‌های ${names.country || ''}`.trim();
      case 'year':
        return `فیلم‌های سال ${names.year || ''}`.trim();
      case 'series':
        if (f.genre) return names.genre ? `سریال‌های ${names.genre}` : 'آرشیو سریال‌ها';
        if (f.year) return `سریال‌های سال ${names.year || f.year}`;
        if (f.country) return names.country ? `سریال‌های ${names.country}` : 'آرشیو سریال‌ها';
        return 'آرشیو سریال‌ها';
      case 'seriesDetail': {
        const s = data.series || {};
        return `سریال ${s.title_en || s.title_fa || ''}`.trim();
      }
      case 'movie': {
        const m = data.movie || {};
        const t = m.title_en || m.title_fa || '';
        return `فیلم ${t}${m.year ? ` (${m.year})` : ''}`.trim();
      }
      case 'genres':
        return 'ژانرهای فیلم و سریال';
      case 'top250':
        return '۲۵۰ فیلم برتر';
      case 'search': {
        const q = String(data.q || '').trim();
        return q ? `نتایج جست‌وجو برای «${q}»` : 'جست‌وجو در فیلمرز';
      }
      case 'wishlist':
        return 'نشان‌های من';
      case '404':
        return 'صفحه پیدا نشد';
      case '500':
        return 'خطای سرور';
      default:
        return this.siteName;
    }
  }

  /* -------------------------------- canonical --------------------------- */

  /** Split "/path?query" into a clean pathname + URLSearchParams. */
  parseRequestUrl(originalUrl) {
    const raw = String(originalUrl || '/');
    const qIndex = raw.indexOf('?');
    const rawPath = qIndex === -1 ? raw : raw.slice(0, qIndex);
    const rawQuery = qIndex === -1 ? '' : raw.slice(qIndex + 1);
    const pathname = rawPath.replace(/\/+$/, '') || '/';
    const params = new URLSearchParams(rawQuery);
    for (const key of [...params.keys()]) {
      const value = params.get(key);
      if (value === undefined || value === '') params.delete(key);
      else if (key === 'page' && value === '1') params.delete(key);
    }
    // Sorting never changes which entities a page contains; keep the
    // canonical on the unsorted URL so sort variants do not compete.
    params.delete('sort');
    return { pathname, params };
  }

  /**
   * Canonical URL for the current route.
   *
   * Only parameters that change the rendered item set are kept. A single
   * filter is canonicalised to its dedicated archive URL.
   */
  generateCanonicalUrl(pathname, currentPage = 1, totalPages = 1, data = {}) {
    const { pathname: p, params } = this.parseRequestUrl(pathname);
    const page = Math.max(1, parseInt(currentPage, 10) || 1);
    const filters = data.filters || {};
    const listLike = p === '/movies' || p === '/series';
    let canonicalPath = p;
    let keep = [];

    if (listLike) {
      const keys = p === '/movies'
        ? ['genre', 'year', 'country', 'person']
        : ['genre', 'year', 'country'];
      for (const key of keys) {
        if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
          keep.push([key, String(filters[key])]);
        } else if (params.get(key)) {
          keep.push([key, params.get(key)]);
        }
      }

      const only = (key) => keep.length === 1 && keep[0][0] === key;
      const names = data.names || {};
      if (only('genre') && names.genre && p === '/movies') {
        canonicalPath = `/genre/${encodeURIComponent(keep[0][1])}`;
        keep = [];
      } else if (only('year') && (names.year || filters.year) && p === '/movies') {
        canonicalPath = `/year/${encodeURIComponent(keep[0][1])}`;
        keep = [];
      } else if (only('country') && names.country && p === '/movies') {
        canonicalPath = `/country/${encodeURIComponent(keep[0][1])}`;
        keep = [];
      }
    } else if (/^\/(genre|country|year)\/[^/]+$/.test(p)) {
      // Archives keep only pagination.
    } else if (/^\/(movie|series)\/[^/]+$/.test(p)) {
      // Season/episode panels are views of the same entity.
    } else if (p === '/search') {
      // Internal search results are noindex and canonical to the search page.
    } else {
      // Static pages (/ , /movies , /series , /genres , /top250 , ...) keep
      // no query parameters at all.
      keep = [];
    }

    if (page > 1 && page <= Math.max(1, totalPages)) keep.push(['page', String(page)]);

    const qs = new URLSearchParams();
    for (const [key, value] of keep) qs.set(key, value);
    const query = qs.toString();
    return `${this.siteUrl}${canonicalPath}${query ? `?${query}` : ''}`;
  }

  /**
   * Backwards-compatible helper used by middleware. Delegates to the same
   * allowlist so no route can self-canonicalise tracking parameters.
   */
  canonicalUrl(originalUrl) {
    return this.generateCanonicalUrl(originalUrl, 1, 1, {});
  }

  /* ------------------------------ social -------------------------------- */

  getOgType(pageType, data = {}) {
    if (pageType === 'movie') return 'video.movie';
    if (pageType === 'seriesDetail') return 'video.tv_show';
    return this.defaultType;
  }

  getOgImage(pageType, data = {}) {
    const entity = (pageType === 'movie' ? data.movie : (pageType === 'seriesDetail' ? data.series : null));
    if (entity && entity.poster_valid && entity.poster_url) {
      const raw = entity.poster_valid === 2
        ? entity.poster_url
        : `/poster?u=${encodeURIComponent(entity.poster_url)}`;
      return this.absoluteUrl(raw);
    }
    return this.defaultImage;
  }

  getTwitterCard(pageType) {
    return pageType === 'movie' || pageType === 'seriesDetail' ? 'summary_large_image' : 'summary_large_image';
  }

  absoluteUrl(url) {
    if (!url) return this.defaultImage;
    return /^https?:\/\//i.test(url) ? url : `${this.siteUrl}${url}`;
  }

  hasMovieLinks(movie) {
    return Boolean((movie && (movie.link_count > 0)) || (movie && Array.isArray(movie.links) && movie.links.length));
  }

  /* -------------------------------- robots ------------------------------ */

  getRobots(pageType, data = {}) {
    if (pageType === 'search' || pageType === 'wishlist') return 'noindex, follow';
    if (pageType === '404' || pageType === '500') return 'noindex, follow';
    if (pageType === 'genres' && (!Array.isArray(data.genres) || data.genres.length === 0)) {
      return 'noindex, follow';
    }
    if (data.result && data.result.total === 0 && ['movies', 'series', 'genre', 'country', 'year'].includes(pageType)) {
      return 'noindex, follow';
    }
    if (pageType === 'movie') {
      const m = data.movie || {};
      if (!m.title_en && !m.title_fa) return 'noindex, follow';
    }
    if (pageType === 'seriesDetail') {
      const s = data.series || {};
      if (!s.title_en && !s.title_fa) return 'noindex, follow';
    }
    return 'index, follow';
  }

  /* ------------------------------ breadcrumbs --------------------------- */

  generateBreadcrumbs(pageType, data = {}) {
    const home = { name: 'فیلمرز', url: this.siteUrl };
    const crumbs = [home];
    const f = data.filters || {};
    const names = data.names || {};

    switch (pageType) {
      case 'movies':
      case 'genre':
      case 'country':
      case 'year': {
        crumbs.push({ name: 'فیلم‌ها', url: `${this.siteUrl}/movies` });
        if (f.genre) {
          const label = names.genre || f.genreName;
          if (label) crumbs.push({
            name: label,
            url: `${this.siteUrl}/genre/${encodeURIComponent(f.genre)}`,
          });
        } else if (f.year) {
          crumbs.push({ name: `سال ${f.year}`, url: `${this.siteUrl}/year/${encodeURIComponent(f.year)}` });
        } else if (f.country) {
          const label = names.country || f.countryName;
          if (label) crumbs.push({
            name: label,
            url: `${this.siteUrl}/country/${encodeURIComponent(f.country)}`,
          });
        } else if (f.person) {
          const label = names.person || f.personName;
          if (label) crumbs.push({
            name: label,
            url: `${this.siteUrl}/movies?person=${encodeURIComponent(f.person)}`,
          });
        }
        break;
      }

      case 'series': {
        crumbs.push({ name: 'سریال‌ها', url: `${this.siteUrl}/series` });
        if (f.genre) {
          const label = names.genre || f.genreName;
          if (label) crumbs.push({ name: label, url: `${this.siteUrl}/series?genre=${encodeURIComponent(f.genre)}` });
        } else if (f.year) crumbs.push({ name: `سال ${f.year}`, url: `${this.siteUrl}/series?year=${encodeURIComponent(f.year)}` });
        else if (f.country) {
          const label = names.country || f.countryName;
          if (label) crumbs.push({ name: label, url: `${this.siteUrl}/series?country=${encodeURIComponent(f.country)}` });
        }
        break;
      }

      case 'movie': {
        const m = data.movie || {};
        crumbs.push({ name: 'فیلم‌ها', url: `${this.siteUrl}/movies` });
        if (m.genres && m.genres.length) {
          crumbs.push({ name: m.genres[0].name, url: `${this.siteUrl}/genre/${encodeURIComponent(m.genres[0].slug)}` });
        }
        crumbs.push({ name: m.title_en || m.title_fa || 'فیلم', url: `${this.siteUrl}${movieUrl(m)}` });
        break;
      }

      case 'seriesDetail': {
        const s = data.series || {};
        crumbs.push({ name: 'سریال‌ها', url: `${this.siteUrl}/series` });
        if (s.genres && s.genres.length) {
          crumbs.push({ name: s.genres[0].name, url: `${this.siteUrl}/series?genre=${encodeURIComponent(s.genres[0].slug)}` });
        }
        crumbs.push({ name: s.title_en || s.title_fa || 'سریال', url: `${this.siteUrl}${seriesUrl(s)}` });
        break;
      }

      case 'genres':
        crumbs.push({ name: 'ژانرها', url: `${this.siteUrl}/genres` });
        break;

      case 'top250':
        crumbs.push({ name: '۲۵۰ فیلم برتر', url: `${this.siteUrl}/top250` });
        break;

      case 'search':
        crumbs.push({ name: 'جست‌وجو', url: `${this.siteUrl}/search` });
        break;

      case 'wishlist':
        crumbs.push({ name: 'نشان‌ها', url: `${this.siteUrl}/wishlist` });
        break;

      default:
        break;
    }

    return crumbs;
  }

  /* ----------------------------- structured data ------------------------ */

  generateSiteStructuredData() {
    const orgId = `${this.siteUrl}/#organization`;
    const siteId = `${this.siteUrl}/#website`;
    return JSON.stringify(compact({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': orgId,
          name: this.siteName,
          alternateName: 'Filmerz',
          url: this.siteUrl,
          logo: {
            '@type': 'ImageObject',
            url: `${this.siteUrl}/apple-touch-icon.png`,
            width: 180,
            height: 180,
          },
        },
        {
          '@type': 'WebSite',
          '@id': siteId,
          name: this.siteName,
          url: this.siteUrl,
          inLanguage: 'fa-IR',
          publisher: { '@id': orgId },
          potentialAction: {
            '@type': 'SearchAction',
            target: `${this.siteUrl}/search?q={search_term_string}`,
            'query-input': 'required name=search_term_string',
          },
        },
      ],
    }));
  }

  generateStructuredData(pageType, data = {}) {
    switch (pageType) {
      case 'movie':
        return this.generateMovieStructuredData(data.movie);
      case 'seriesDetail':
        return this.generateSeriesStructuredData(data.series, data);
      case 'person':
        return this.generatePersonStructuredData(data.person);
      default:
        return null;
    }
  }

  generateMovieStructuredData(movie) {
    if (!movie) return null;
    const schema = compact({
      '@context': 'https://schema.org',
      '@type': 'Movie',
      name: movie.title_en || movie.title_fa,
      alternateName: movie.title_fa && movie.title_en && movie.title_fa !== movie.title_en ? movie.title_fa : undefined,
      url: `${this.siteUrl}${movieUrl(movie)}`,
      image: this.getOgImage('movie', { movie }),
      description: movie.plot || undefined,
      genre: uniqInline((movie.genres || []).map((g) => g.name)),
      director: personNodes(movie.directors),
      actor: personNodes(movie.actors),
      countryOfOrigin: movie.country_name ? { '@type': 'Country', name: movie.country_name } : undefined,
      inLanguage: 'fa-IR',
    });
    return schema ? JSON.stringify(schema) : null;
  }

  generateSeriesStructuredData(series, data = {}) {
    if (!series) return null;
    const schema = compact({
      '@context': 'https://schema.org',
      '@type': 'TVSeries',
      name: series.title_en || series.title_fa,
      alternateName: series.title_fa && series.title_en && series.title_fa !== series.title_en ? series.title_fa : undefined,
      url: `${this.siteUrl}${seriesUrl(series)}`,
      image: this.getOgImage('seriesDetail', { series }),
      description: series.plot || undefined,
      genre: uniqInline((series.genres || []).map((g) => g.name)),
      director: personNodes(series.directors),
      actor: personNodes(series.actors),
      countryOfOrigin: series.country_name ? { '@type': 'Country', name: series.country_name } : undefined,
      numberOfSeasons: series.season_count > 0 ? series.season_count : undefined,
      numberOfEpisodes: series.episode_count > 0 ? series.episode_count : undefined,
      inLanguage: 'fa-IR',
    });
    return schema ? JSON.stringify(schema) : null;
  }

  generatePersonStructuredData(person) {
    if (!person) return null;
    const schema = compact({
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: person.name,
      url: `${this.siteUrl}/person/${person.id}-${person.slug}`,
    });
    return schema ? JSON.stringify(schema) : null;
  }

  /* ------------------------------ pagination ---------------------------- */

  generatePaginationLinks(canonicalUrl, currentPage = 1, totalPages = 1) {
    const pagination = { prev: null, next: null, pages: [] };
    if (totalPages <= 1) return pagination;
    const base = String(canonicalUrl || this.siteUrl).replace(/([?&])page=\d+&?/g, '$1').replace(/[?&]$/, '');
    const withPage = (n) => `${base}${base.includes('?') ? '&' : '?'}page=${n}`;
    pagination.prev = currentPage > 1 ? withPage(currentPage - 1) : null;
    pagination.next = currentPage < totalPages ? withPage(currentPage + 1) : null;
    for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
      pagination.pages.push({ url: withPage(i), number: i, isCurrent: i === currentPage });
    }
    return pagination;
  }

  /* ------------------------------ validation ---------------------------- */

  validateMetadata(metadata) {
    const errors = [];
    const warnings = [];
    if (!metadata.title) errors.push('عنوان صفحه لازم است.');
    if (!metadata.description) warnings.push('توضیحات متا وجود ندارد.');
    if (!metadata.canonicalUrl) errors.push('آدرس canonical لازم است.');
    if (metadata.title && metadata.title.length > 75) warnings.push('عنوان صفحه بلندتر از حد پیشنهادی است.');
    if (metadata.description && metadata.description.length > 165) warnings.push('توضیحات متا بلندتر از حد پیشنهادی است.');
    if (!metadata.og || !metadata.og.title) warnings.push('Open Graph کامل نیست.');
    if (!metadata.twitter || !metadata.twitter.title) warnings.push('Twitter Card کامل نیست.');
    if (!metadata.breadcrumbs || metadata.breadcrumbs.length < 2) warnings.push('BreadcrumbList تولید نشده است.');
    return { errors, warnings };
  }
}

module.exports = {
  SEOEngine,
  truncate,
  firstSentence,
};
