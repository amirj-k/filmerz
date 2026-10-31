'use strict';

const config = require('./config');

/**
 * Centralized SEO metadata generation and validation.
 * All functions are server-side only - no client-side execution.
 */

class SEOEngine {
  constructor(db) {
    this.db = db;
    this.siteUrl = config.env === 'production'
      ? 'https://filmerz.ir'
      : `http://localhost:${config.port}`;
    this.siteName = config.siteName;
    this.defaultTitle = `${this.siteName} — تماشا و دانلود فیلم`;
    this.defaultDescription = 'فیلمرز - بهترین پلتفرم برای تماشای و دانلود فیلم و سریال با کیفیت بالا';
    this.defaultImage = `${this.siteUrl}/apple-touch-icon.png`;
    this.defaultType = 'website';
  }

  /**
   * Generate comprehensive SEO metadata for a page.
   * Returns an object with all SEO-related fields.
   */
  generateMetadata(pageType, data = {}, pathname = '/', currentPage = 1, totalPages = 1) {
    const metadata = {
      // Basic metadata
      title: this.generateTitle(pageType, data),
      description: this.generateDescription(pageType, data),
      canonicalUrl: this.generateCanonicalUrl(pathname, currentPage, totalPages),

      // Open Graph metadata
      og: {
        type: this.getOgType(pageType),
        title: this.generateTitle(pageType, data),
        description: this.generateDescription(pageType, data),
        url: this.generateCanonicalUrl(pathname, currentPage, totalPages),
        image: this.getOgImage(pageType, data),
        siteName: this.siteName,
      },

      // Twitter Card metadata
      twitter: {
        card: this.getTwitterCard(pageType, data),
        title: this.generateTitle(pageType, data),
        description: this.generateDescription(pageType, data),
        image: this.getOgImage(pageType, data),
        site: '@filmerz',
        creator: '@filmerz',
      },

      // Robots and indexing
      robots: this.getRobots(pageType, data),

      // Breadcrumbs
      breadcrumbs: this.generateBreadcrumbs(pageType, data),

      // Structured data (JSON-LD)
      structuredData: this.generateStructuredData(pageType, data),

      // Pagination
      pagination: this.generatePaginationLinks(pathname, currentPage, totalPages),
    };

    return metadata;
  }

  /**
   * Generate page title based on page type and data.
   */
  generateTitle(pageType, data) {
    switch (pageType) {
      case 'home':
        return this.defaultTitle;

      case 'movies':
        if (data.filters?.genre) {
          return `${data.filters.genre} — فیلم‌ها — ${this.siteName}`;
        } else if (data.filters?.year) {
          return `${data.filters.year} — فیلم‌ها — ${this.siteName}`;
        } else {
          return 'فیلم‌ها — فیلمرز';
        }

      case 'series':
        if (data.filters?.genre) {
          return `${data.filters.genre} — سریال‌ها — ${this.siteName}`;
        } else if (data.filters?.year) {
          return `${data.filters.year} — سریال‌ها — ${this.siteName}`;
        } else {
          return 'سریال‌ها — فیلمرز';
        }

      case 'genres':
        return 'ژانرها — فیلمرز';

      case 'top250':
        return '۲۵۰ فیلم برتر — فیلمرز';

      case 'search':
        const query = data.q || '';
        if (query) {
          return `جستجو: ${query} — ${this.siteName}`;
        }
        return 'جستجو — فیلمرز';

      case 'movie':
        const movie = data.movie || {};
        const title = movie.title_fa || movie.title_en || 'فیلم';
        return `${title} — فیلمرز`;

      case 'series':
        const series = data.series || {};
        const seriesTitle = series.title_fa || series.title_en || 'سریال';
        return `${seriesTitle} — سریال — ${this.siteName}`;

      case 'person':
        const person = data.person || {};
        return `${person.name} — بازیگر/کارگردان — ${this.siteName}`;

      case 'wishlist':
        return 'نشان‌ها — فیلمرز';

      default:
        return this.defaultTitle;
    }
  }

  /**
   * Generate meta description based on page type and data.
   */
  generateDescription(pageType, data) {
    switch (pageType) {
      case 'home':
        return 'تماشای هزاران فیلم و سریال با کیفیت بالا. فیلمرز، مقصد نهایی برای سرگرمی آنلاین.';

      case 'movies':
        if (data.filters?.genre) {
          return `مشاهده تمام فیلم‌های ژانر ${data.filters.genre}. فیلمرز، بزرگترین koleksiyon فیلم.`;
        } else if (data.filters?.year) {
          return `فیلم‌های سال ${data.filters.year}. لیست کامل فیلم‌های جدید و قدیمی در فیلمرز.`;
        } else {
          return 'فهرست کامل فیلم‌ها با فیلترهای متنوع. تماشا و دانلود فیلم.';
        }

      case 'series':
        if (data.filters?.genre) {
          return `مشاهده تمام سریال‌های ژانر ${data.filters.genre}. فیلمرز، مرکز سریال‌های ایرانی و خارجی.`;
        } else if (data.filters?.year) {
          return `سریال‌های سال ${data.filters.year}. لیست کامل سریال‌های جدید در فیلمرز.`;
        } else {
          return 'فهرست کامل سریال‌ها با فیلترهای متنوع. تماشا و دانلود سریال.';
        }

      case 'genres':
        return 'فهرست تمام ژانرهای فیلم و سریال. جستجوی آسان فیلم‌ها بر اساس ژانر.';

      case 'top250':
        return '۲۵۰ فیلم برتر تاریخ سینما. انتخاب بهترین فیلم‌ها از سراسر جهان.';

      case 'search':
        const query = data.q || '';
        if (query) {
          return `نتایج جستجو برای "${query}". جستجوی فیلم، سریال و بازیگر در فیلمرز.`;
        }
        return 'جستجوی فیلم، سریال، بازیگر و بیشتر در فیلمرز.';

      case 'movie':
        const movie = data.movie || {};
        const year = movie.year ? ` (${movie.year})` : '';
        const genres = movie.genres?.map(g => g.name).join(', ') || '';
        return `تماشا و دانلود ${movie.title_fa || movie.title_en || ''}${year}. ${genres}`;

      case 'series':
        const series = data.series || {};
        const seriesYear = series.year ? ` (${series.year})` : '';
        return `تماشا و دانلود ${series.title_fa || series.title_en || ''}${seriesYear}. سریال کامل با کیفیت بالا.`;

      case 'person':
        const person = data.person || {};
        return `تماشای فیلم‌ها و سریال‌های ${person.name}. فیلمography کامل ${person.name} در فیلمرز.`;

      case 'wishlist':
        return 'لیست فیلم‌ها و سریال‌های مورد علاقه شما. ادامه تماشا.';

      default:
        return this.defaultDescription;
    }
  }

  /**
   * Generate canonical URL for the page.
   */
  generateCanonicalUrl(pathname, currentPage, totalPages) {
    // Remove trailing slash for consistency
    let canonicalUrl = pathname.replace(/\/+$/);

    // Remove pagination parameters except for first page
    if (currentPage > 1) {
      canonicalUrl = canonicalUrl.replace(/\/page\/\d+\/?$/);
    }

    return `${this.siteUrl}${canonicalUrl}`;
  }

  /**
   * Get Open Graph type based on page type.
   */
  getOgType(pageType) {
    switch (pageType) {
      case 'movie':
        return 'video.movie';
      case 'series':
        return 'video.tv_show';
      case 'person':
        return 'profile';
      case 'genres':
        return 'website';
      case 'search':
        return 'website';
      case 'wishlist':
        return 'profile';
      default:
        return this.defaultType;
    }
  }

  /**
   * Get Open Graph image based on page type and data.
   */
  getOgImage(pageType, data) {
    switch (pageType) {
      case 'movie':
        const movie = data.movie || {};
        if (movie.poster_valid && movie.poster_url) {
          if (movie.poster_valid === 2) {
            return movie.poster_url;
          }
          return `/poster?u=${encodeURIComponent(movie.poster_url)}`;
        }
        return this.defaultImage;

      case 'series':
        const series = data.series || {};
        if (series.poster_valid && series.poster_url) {
          if (series.poster_valid === 2) {
            return series.poster_url;
          }
          return `/poster?u=${encodeURIComponent(series.poster_url)}`;
        }
        return this.defaultImage;

      case 'person':
        return this.defaultImage;

      default:
        return this.defaultImage;
    }
  }

  /**
   * Get Twitter Card type based on page type and data.
   */
  getTwitterCard(pageType, data) {
    switch (pageType) {
      case 'movie':
      case 'series':
        return 'summary_large_image';
      case 'person':
        return 'summary';
      default:
        return 'summary_large_image';
    }
  }

  /**
   * Get robots meta based on page type and data.
   */
  getRobots(pageType, data) {
    switch (pageType) {
      case 'search':
        if (!data.q) {
          return 'noindex, follow';
        }
        return 'index, follow';

      case 'wishlist':
        return 'noindex, follow';

      default:
        return 'index, follow';
    }
  }

  /**
   * Generate breadcrumb navigation data.
   */
  generateBreadcrumbs(pageType, data) {
    const breadcrumbs = [
      {
        name: 'فیلمرز',
        url: this.siteUrl,
      },
    ];

    switch (pageType) {
      case 'movies':
        breadcrumbs.push({
          name: 'فیلم‌ها',
          url: `${this.siteUrl}/movies`,
        });
        if (data.filters?.genre) {
          breadcrumbs.push({
            name: data.filters.genre,
            url: `${this.siteUrl}/movies?genre=${data.filters.genre.toLowerCase().replace(/\s+/g, '-')}`,
          });
        }
        break;

      case 'series':
        breadcrumbs.push({
          name: 'سریال‌ها',
          url: `${this.siteUrl}/series`,
        });
        if (data.filters?.genre) {
          breadcrumbs.push({
            name: data.filters.genre,
            url: `${this.siteUrl}/series?genre=${data.filters.genre.toLowerCase().replace(/\s+/g, '-')}`,
          });
        }
        break;

      case 'genres':
        breadcrumbs.push({
          name: 'ژانرها',
          url: `${this.siteUrl}/genres`,
        });
        break;

      case 'top250':
        breadcrumbs.push({
          name: '۲۵۰ فیلم برتر',
          url: `${this.siteUrl}/top250`,
        });
        break;

      case 'search':
        breadcrumbs.push({
          name: 'جستجو',
          url: `${this.siteUrl}/search`,
        });
        if (data.q) {
          breadcrumbs.push({
            name: data.q,
            url: `${this.siteUrl}/search?q=${encodeURIComponent(data.q)}`,
          });
        }
        break;

      case 'movie':
        const movie = data.movie || {};
        breadcrumbs.push({
          name: 'فیلم‌ها',
          url: `${this.siteUrl}/movies`,
        });
        if (movie.genres?.length) {
          breadcrumbs.push({
            name: movie.genres[0].name,
            url: `${this.siteUrl}/movies?genre=${movie.genres[0].slug}`,
          });
        }
        breadcrumbs.push({
          name: movie.title_fa || movie.title_en || 'فیلم',
          url: `${this.siteUrl}/movie/${movie.id}-${movie.slug}`,
        });
        break;

      case 'series':
        const series = data.series || {};
        breadcrumbs.push({
          name: 'سریال‌ها',
          url: `${this.siteUrl}/series`,
        });
        if (series.genres?.length) {
          breadcrumbs.push({
            name: series.genres[0].name,
            url: `${this.siteUrl}/series?genre=${series.genres[0].slug}`,
          });
        }
        breadcrumbs.push({
          name: series.title_fa || series.title_en || 'سریال',
          url: `${this.siteUrl}/series/${series.id}-${series.slug}`,
        });
        break;

      case 'person':
        const person = data.person || {};
        breadcrumbs.push({
          name: 'بازیگران و کارگردانان',
          url: `${this.siteUrl}/movies`,
        });
        breadcrumbs.push({
          name: person.name,
          url: `${this.siteUrl}/person/${person.id}-${person.slug}`,
        });
        break;

      case 'wishlist':
        breadcrumbs.push({
          name: 'نشان‌ها',
          url: `${this.siteUrl}/wishlist`,
        });
        break;
    }

    return breadcrumbs;
  }

  /**
   * Generate structured data (JSON-LD) based on page type and data.
   */
  generateStructuredData(pageType, data) {
    switch (pageType) {
      case 'movie':
        return this.generateMovieStructuredData(data.movie);
      case 'series':
        return this.generateSeriesStructuredData(data.series);
      case 'person':
        return this.generatePersonStructuredData(data.person);
      case 'home':
        return this.generateWebsiteStructuredData();
      case 'genres':
        return this.generateWebsiteStructuredData();
      case 'top250':
        return this.generateWebsiteStructuredData();
      default:
        return this.generateWebsiteStructuredData();
    }
  }

  /**
   * Generate structured data for movie page.
   */
  generateMovieStructuredData(movie) {
    if (!movie) return null;

    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'Movie',
      name: movie.title_fa || movie.title_en,
      description: movie.plot || `تماشا و دانلود ${movie.title_fa || movie.title_en}`,
      url: `${this.siteUrl}/movie/${movie.id}-${movie.slug}`,
      image: movie.poster_valid && movie.poster_url
        ? (movie.poster_valid === 2
          ? movie.poster_url
          : `/poster?u=${encodeURIComponent(movie.poster_url)}`)
        : `${this.siteUrl}/apple-touch-icon.png`,
      datePublished: movie.year || undefined,
      genre: movie.genres?.map(g => g.name) || [],
      director: movie.directors?.map(d => ({ '@type': 'Person', name: d.name })) || [],
      actor: movie.actors?.map(a => ({ '@type': 'Person', name: a.name })) || [],
      countryOfOrigin: movie.country_name || undefined,
    };

    return JSON.stringify(structuredData);
  }

  /**
   * Generate structured data for series page.
   */
  generateSeriesStructuredData(series) {
    if (!series) return null;

    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'TVSeries',
      name: series.title_fa || series.title_en,
      description: series.plot || `تماشا و دانلود ${series.title_fa || series.title_en}`,
      url: `${this.siteUrl}/series/${series.id}-${series.slug}`,
      image: series.poster_valid && series.poster_url
        ? (series.poster_valid === 2
          ? series.poster_url
          : `/poster?u=${encodeURIComponent(series.poster_url)}`)
        : `${this.siteUrl}/apple-touch-icon.png`,
      datePublished: series.year || undefined,
      numberOfSeasons: series.season_count || 0,
      numberOfEpisodes: series.episode_count || 0,
      genre: series.genres?.map(g => g.name) || [],
      director: series.directors?.map(d => ({ '@type': 'Person', name: d.name })) || [],
      actor: series.actors?.map(a => ({ '@type': 'Person', name: a.name })) || [],
      countryOfOrigin: series.country_name || undefined,
    };

    return JSON.stringify(structuredData);
  }

  /**
   * Generate structured data for person page.
   */
  generatePersonStructuredData(person) {
    if (!person) return null;

    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: person.name,
      url: `${this.siteUrl}/person/${person.id}-${person.slug}`,
      image: `${this.siteUrl}/apple-touch-icon.png`,
      worksFor: {
        '@type': 'Organization',
        name: this.siteName,
      },
    };

    return JSON.stringify(structuredData);
  }

  /**
   * Generate structured data for website.
   */
  generateWebsiteStructuredData() {
    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: this.siteName,
      url: this.siteUrl,
      description: this.defaultDescription,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${this.siteUrl}/search?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    };

    return JSON.stringify(structuredData);
  }

  /**
   * Generate pagination links for navigation.
   */
  generatePaginationLinks(pathname, currentPage, totalPages) {
    const pagination = {};

    if (totalPages > 1) {
      pagination.prev = currentPage > 1
        ? `${this.siteUrl}${pathname}?page=${currentPage - 1}`
        : null;

      pagination.next = currentPage < totalPages
        ? `${this.siteUrl}${pathname}?page=${currentPage + 1}`
        : null;

      pagination.pages = [];
      for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
        pagination.pages.push({
          url: `${this.siteUrl}${pathname}?page=${i}`,
          number: i,
          isCurrent: i === currentPage,
        });
      }
    }

    return pagination;
  }

  /**
   * Validate SEO metadata for a page.
   */
  validateMetadata(metadata, pageType) {
    const errors = [];
    const warnings = [];

    // Check title length
    if (metadata.title && metadata.title.length > 70) {
      warnings.push('عنوان خیلی طولانی است. برای نتایج بهتر در گوگل، باید کمتر از ۷۰ کاراکتر باشد.');
    }

    // Check description length
    if (metadata.description && metadata.description.length > 160) {
      warnings.push('توضیحات خیلی طولانی است. برای نتایج بهتر در گوگل، باید کمتر از ۱۶۰ کاراکتر باشد.');
    }

    // Check canonical URL
    if (!metadata.canonicalUrl) {
      errors.push('آدرس canonical لازم است.');
    }

    // Check Open Graph metadata
    if (!metadata.og?.title) {
      warnings.push('اطلاعات Open Graph ناموجود است.');
    }

    // Check Twitter Card metadata
    if (!metadata.twitter?.title) {
      warnings.push('اطلاعات Twitter Card ناموجود است.');
    }

    // Check structured data
    if (!metadata.structuredData) {
      warnings.push('اطلاعات ساختاری (JSON-LD) ناموجود است.');
    }

    // Check breadcrumbs
    if (!metadata.breadcrumbs?.length) {
      warnings.push('اطلاعات نانو اشاره (breadcrumbs) ناموجود است.');
    }

    return { errors, warnings };
  }
}

module.exports = { SEOEngine };