'use strict';

/**
 * Page indexability evaluation system.
 * Determines which pages should be indexed by search engines.
 */

class IndexabilityEvaluator {
  constructor(db) {
    this.db = db;
  }

  /**
   * Evaluate if a page should be indexed based on page type and data.
   */
  evaluate(pageType, data, pathname) {
    let result;
    
    switch (pageType) {
      case 'home':
        result = {
          isIndexable: true,
          reason: 'Home page is the primary entry point',
          statusCode: 200,
          robots: 'index, follow',
          priority: 1.0,
        };
        break;
        
      case 'movies':
        result = this.evaluateMoviesPage(data, pathname);
        break;
        
      case 'series':
        result = this.evaluateSeriesPage(data, pathname);
        break;

      case 'seriesDetail':
        result = this.evaluateSeriesDetailPage(data, pathname);
        break;

      case 'genre':
      case 'country':
      case 'year':
        result = this.evaluateArchivePage(data, pathname);
        break;
        
      case 'genres':
        result = this.evaluateGenresPage(data, pathname);
        break;
        
      case 'top250':
        result = {
          isIndexable: true,
          reason: 'Top 250 page has unique, valuable content',
          statusCode: 200,
          robots: 'index, follow',
          priority: 0.9,
        };
        break;
        
      case 'search':
        result = this.evaluateSearchPage(data, pathname);
        break;
        
      case 'movie':
        result = this.evaluateMoviePage(data, pathname);
        break;
        
      case 'person':
        result = this.evaluatePersonPage(data, pathname);
        break;
        
      case 'wishlist':
        result = {
          isIndexable: false,
          reason: 'Wishlist pages are user-specific and should not be indexed',
          statusCode: 200,
          robots: 'noindex, follow',
          priority: 0.0,
        };
        break;

      case '404':
      case '500':
        result = {
          isIndexable: false,
          reason: 'Error pages must never be indexed',
          statusCode: pageType === '404' ? 404 : 500,
          robots: 'noindex, follow',
          priority: 0.0,
        };
        break;
        
      default:
        result = {
          isIndexable: false,
          reason: 'Unknown page type',
          statusCode: 404,
          robots: 'noindex, follow',
          priority: 0.0,
        };
    }
    
    return result;
  }

  /**
   * Evaluate movie listing page.
   */
  evaluateMoviesPage(data, pathname) {
    const result = {
      isIndexable: true,
      reason: 'Movie listing with filters is valuable content',
      priority: 0.7,
      robots: 'index, follow',
      statusCode: 200,
    };
    
    // An empty filter combination is a soft-404; keep it out of the index.
    if (!data || !data.result || data.result.total === 0) {
      result.isIndexable = false;
      result.reason = 'Movie listing with no results';
      result.priority = 0.3;
      result.robots = 'noindex, follow';
    }
    
    // Genre-based pages are more valuable
    if (data.filters?.genre) {
      result.priority = 0.9;
    }
    
    return result;
  }

  /**
   * Evaluate series listing page.
   */
  evaluateSeriesPage(data, pathname) {
    const result = {
      isIndexable: true,
      reason: 'Series listing with filters is valuable content',
      priority: 0.7,
      robots: 'index, follow',
      statusCode: 200,
    };
    
    // An empty filter combination is a soft-404; keep it out of the index.
    if (!data || !data.result || data.result.total === 0) {
      result.isIndexable = false;
      result.reason = 'Series listing with no results';
      result.priority = 0.3;
      result.robots = 'noindex, follow';
    }
    
    // Genre-based pages are more valuable
    if (data.filters?.genre) {
      result.priority = 0.9;
    }
    
    return result;
  }

  /**
   * Evaluate genres page.
   */
  evaluateGenresPage(data, pathname) {
    const result = {
      isIndexable: true,
      reason: 'Genres page provides navigation to movie content',
      priority: 0.5,
      robots: 'index, follow',
      statusCode: 200,
    };
    
    // If no genres found, should not be indexed
    if (!data || !data.genres || data.genres.length === 0) {
      result.isIndexable = false;
      result.reason = 'Genres page has no content to index';
      result.robots = 'noindex, follow';
      result.statusCode = 404;
    }
    
    return result;
  }

  /**
   * Evaluate search page. Internal search results are always noindex: they
   * are user-specific, infinitely combinable and would otherwise compete
   * with the canonical listing/entity pages.
   */
  evaluateSearchPage() {
    return {
      isIndexable: false,
      reason: 'Internal search results are not indexable',
      priority: 0.0,
      robots: 'noindex, follow',
      statusCode: 200,
    };
  }

  /**
   * Genre/country/year archive pages. An archive with zero items is a
   * soft-404 and must not be indexed (the route returns a real 404).
   */
  evaluateArchivePage(data) {
    const total = data && data.result ? data.result.total : 0;
    if (!total) {
      return {
        isIndexable: false,
        reason: 'Archive has no items',
        priority: 0.0,
        robots: 'noindex, follow',
        statusCode: 404,
      };
    }
    return {
      isIndexable: true,
      reason: 'Archive with real content',
      priority: 0.8,
      robots: 'index, follow',
      statusCode: 200,
    };
  }

  /**
   * Evaluate movie detail page.
   */
  evaluateMoviePage(data, pathname) {
    const result = {
      isIndexable: true,
      reason: 'Movie detail page with unique content',
      priority: 1.0,
      robots: 'index, follow',
      statusCode: 200,
    };
    
    const movie = data.movie;
    
    if (!movie) {
      result.isIndexable = false;
      result.reason = 'Movie not found';
      result.robots = 'noindex, follow';
      result.statusCode = 404;
      return result;
    }
    
    // Check if movie is published
    if (movie.published !== 1) {
      result.isIndexable = false;
      result.reason = 'Movie is not published';
      result.robots = 'noindex, follow';
      result.statusCode = 404;
      return result;
    }
    
    // Check if movie has basic content
    if (!movie.title_fa && !movie.title_en) {
      result.isIndexable = false;
      result.reason = 'Movie has no title';
      result.robots = 'noindex, follow';
      result.statusCode = 500;
    }
    
    return result;
  }

  /**
   * Evaluate series detail page.
   */
  evaluateSeriesDetailPage(data, pathname) {
    const result = {
      isIndexable: true,
      reason: 'Series detail page with unique content',
      priority: 1.0,
      robots: 'index, follow',
      statusCode: 200,
    };
    
    const series = data.series;
    
    if (!series) {
      result.isIndexable = false;
      result.reason = 'Series not found';
      result.robots = 'noindex, follow';
      result.statusCode = 404;
      return result;
    }
    
    // Check if series is published
    if (series.published !== 1) {
      result.isIndexable = false;
      result.reason = 'Series is not published';
      result.robots = 'noindex, follow';
      result.statusCode = 404;
      return result;
    }
    
    // Check if series has basic content
    if (!series.title_fa && !series.title_en) {
      result.isIndexable = false;
      result.reason = 'Series has no title';
      result.robots = 'noindex, follow';
      result.statusCode = 500;
    }
    
    return result;
  }

  /**
   * Evaluate person page.
   */
  evaluatePersonPage(data, pathname) {
    const result = {
      isIndexable: true,
      reason: 'Person page with filmography information',
      priority: 0.8,
      robots: 'index, follow',
      statusCode: 200,
    };
    
    const person = data.person;
    
    if (!person) {
      result.isIndexable = false;
      result.reason = 'Person not found';
      result.robots = 'noindex, follow';
      result.statusCode = 404;
      return result;
    }
    
    // Check if person has basic information
    if (!person.name) {
      result.isIndexable = false;
      result.reason = 'Person has no name';
      result.robots = 'noindex, follow';
      result.statusCode = 500;
      return result;
    }
    
    return result;
  }

  /**
   * Check for duplicate pages.
   */
  checkDuplicates(pages, currentPage) {
    const duplicates = [];
    
    for (let i = 0; i < pages.length - 1; i++) {
      if (pages[i].pathname === pages[i + 1].pathname && 
          pages[i].pathname !== currentPage.pathname) {
        duplicates.push({
          page1: pages[i].pathname,
          page2: pages[i + 1].pathname,
          type: 'identical URL',
        });
      }
    }
    
    return duplicates;
  }

  /**
   * Check for empty or low-value pages.
   */
  checkEmptyOrLowValue(pages) {
    const lowValuePages = [];
    
    for (const page of pages) {
      if (page.pageType === 'movie' || page.pageType === 'series') {
        const data = page.data;
        
        if (data && data.movie && !data.movie.title_fa && !data.movie.title_en) {
          lowValuePages.push({
            pathname: page.pathname,
            type: page.pageType,
            reason: 'Movie/series has no title',
          });
        }
        
        if (page.pageType === 'movies' || page.pageType === 'series') {
          if (data && data.result && data.result.total === 0) {
            lowValuePages.push({
              pathname: page.pathname,
              type: page.pageType,
              reason: 'Listing page has no results',
            });
          }
        }
      }
    }
    
    return lowValuePages;
  }
}

module.exports = { IndexabilityEvaluator };