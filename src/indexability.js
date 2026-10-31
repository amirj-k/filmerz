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
        result = this.evaluateSeriesDetailPage(data, pathname);
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
          statusCode: 403,
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
    
    // If no movies found, still index but with low priority
    if (!data || !data.result || data.result.total === 0) {
      result.reason = 'Movie listing with no results, still valuable for navigation';
      result.priority = 0.3;
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
    
    // If no series found, still index but with low priority
    if (!data || !data.result || data.result.total === 0) {
      result.reason = 'Series listing with no results, still valuable for navigation';
      result.priority = 0.3;
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
   * Evaluate search page.
   */
  evaluateSearchPage(data, pathname) {
    const result = {
      isIndexable: false,
      reason: 'Search results are dynamic and user-specific',
      priority: 0.0,
      robots: 'noindex, follow',
      statusCode: 200,
    };
    
    // Only index specific searches with meaningful content
    if (data.q && data.q.length >= 2) {
      // Check if we have results
      if (data.result && data.result.total > 0) {
        result.isIndexable = true;
        result.reason = 'Search results with meaningful content';
        result.priority = 0.4;
        result.robots = 'index, follow';
      }
    } else if (!data.q || data.q.length === 0) {
      // Empty search queries should not be indexed
      result.isIndexable = false;
      result.reason = 'Empty search queries should not be indexed';
      result.robots = 'noindex, follow';
    }
    
    return result;
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