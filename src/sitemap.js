'use strict';

const path = require('path');
const config = require('./config');

/**
 * Sitemap generation system.
 * Generates XML sitemaps for the Filmerz website.
 */

class SitemapGenerator {
  constructor(db) {
    this.db = db;
    this.siteUrl = config.env === 'production' 
      ? 'https://filmerz.amirjk.ir' 
      : `http://localhost:${config.port}`;
  }

  /**
   * Generate main sitemap index.
   */
  generateSitemapIndex(sitemaps) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${this.siteUrl}/</loc>
    <priority>1.0</priority>
    <changefreq>daily</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>
  ${sitemaps.map(sitemap => `
  <url>
    <loc>${sitemap.url}</loc>
    <priority>${sitemap.priority}</priority>
    <changefreq>${sitemap.changefreq}</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>`).join('')}
</urlset>`;
    
    return xml;
  }

  /**
   * Generate movies sitemap.
   */
  async generateMoviesSitemap(page = 1, limit = 50000) {
    const offset = (page - 1) * limit;
    const movies = this.db.prepare(
      `SELECT id, slug, year, last_link_at, last_seen FROM movies 
        WHERE published = 1 
        ORDER BY id DESC 
        LIMIT ? OFFSET ?`
    ).all(limit, offset);
    
    if (movies.length === 0 && page > 1) {
      return null; // No more pages
    }
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${movies.map(movie => `
  <url>
    <loc>${this.siteUrl}/movie/${movie.id}-${movie.slug}</loc>
    <priority>0.9</priority>
    <changefreq>weekly</changefreq>
    <lastmod>${movie.last_link_at || movie.last_seen || new Date().toISOString().split('T')[0]}</lastmod>
  </url>`).join('')
  }
  
  ${movies.length > 0 ? `
  <url>
    <loc>${this.siteUrl}/movies</loc>
    <priority>0.8</priority>
    <changefreq>daily</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>` : ''}
</urlset>`;
    
    return xml;
  }

  /**
   * Generate series sitemap.
   */
  async generateSeriesSitemap(page = 1, limit = 50000) {
    const offset = (page - 1) * limit;
    const series = this.db.prepare(
      `SELECT id, slug, year, last_link_at, last_seen FROM series 
        WHERE published = 1 
        ORDER BY id DESC 
        LIMIT ? OFFSET ?`
    ).all(limit, offset);
    
    if (series.length === 0 && page > 1) {
      return null; // No more pages
    }
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${series.map(s => `
  <url>
    <loc>${this.siteUrl}/series/${s.id}-${s.slug}</loc>
    <priority>0.9</priority>
    <changefreq>weekly</changefreq>
    <lastmod>${s.last_link_at || s.last_seen || new Date().toISOString().split('T')[0]}</lastmod>
  </url>`).join('')
  }
  
  ${series.length > 0 ? `
  <url>
    <loc>${this.siteUrl}/series</loc>
    <priority>0.8</priority>
    <changefreq>daily</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>` : ''}
</urlset>`;
    
    return xml;
  }

  /**
   * Generate people sitemap.
   */
  async generatePeopleSitemap(page = 1, limit = 50000) {
    const offset = (page - 1) * limit;
    const people = this.db.prepare(
      `SELECT id, slug, name FROM people 
        ORDER BY id DESC 
        LIMIT ? OFFSET ?`
    ).all(limit, offset);
    
    if (people.length === 0 && page > 1) {
      return null; // No more pages
    }
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${people.map(p => `
  <url>
    <loc>${this.siteUrl}/person/${p.id}-${p.slug}</loc>
    <priority>0.6</priority>
    <changefreq>monthly</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>`).join('')
  }
  
  ${people.length > 0 ? `
  <url>
    <loc>${this.siteUrl}/movies</loc>
    <priority>0.8</priority>
    <changefreq>daily</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>` : ''}
</urlset>`;
    
    return xml;
  }

  /**
   * Generate genres sitemap.
   */
  async generateGenresSitemap() {
    const genres = this.db.prepare(
      `SELECT slug, name FROM genres 
        ORDER BY name`
    ).all();
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${genres.map(g => `
  <url>
    <loc>${this.siteUrl}/movies?genre=${g.slug}</loc>
    <priority>0.7</priority>
    <changefreq>monthly</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>`).join('')
  }
  
  ${genres.length > 0 ? `
  <url>
    <loc>${this.siteUrl}/genres</loc>
    <priority>0.8</priority>
    <changefreq>weekly</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>` : ''}
</urlset>`;
    
    return xml;
  }

  /**
   * Generate top250 sitemap.
   */
  async generateTop250Sitemap() {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${this.siteUrl}/top250</loc>
    <priority>0.9</priority>
    <changefreq>monthly</changefreq>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
  </url>
</urlset>`;
    
    return xml;
  }

  /**
   * Generate wishlist sitemap (should be excluded).
   */
  async generateWishlistSitemap() {
    return null; // Wishlist should not be in sitemap
  }

  /**
   * Get all sitemap files that should be generated.
   */
  getSitemapFiles() {
    return [
      { name: 'movies-1', generator: () => this.generateMoviesSitemap(1) },
      { name: 'series-1', generator: () => this.generateSeriesSitemap(1) },
      { name: 'people-1', generator: () => this.generatePeopleSitemap(1) },
      { name: 'genres-1', generator: () => this.generateGenresSitemap() },
      { name: 'top250-1', generator: () => this.generateTop250Sitemap() },
    ];
  }

  /**
   * Get paginated sitemap files.
   */
  async getAllSitemapFiles() {
    const files = [];
    
    // Get main sitemaps
    for (const sitemap of this.getSitemapFiles()) {
      const xml = await sitemap.generator();
      if (xml) {
        files.push({
          name: sitemap.name,
          xml,
          contentType: 'application/xml',
        });
      }
    }
    
    return files;
  }
}

module.exports = { SitemapGenerator };