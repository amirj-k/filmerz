'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { applySchema } = require('./schema');

/** Open the application DB (creating it + its schema when needed). */
function openAppDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  applySchema(db);
  return db;
}

/** Open the crawler's links.db strictly read-only. */
function openLinksDbReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false });
  return db;
}

module.exports = { openAppDb, openLinksDbReadOnly };
