"use strict";

function ensureRawEventsTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS raw_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id VARCHAR(64),
            device_name VARCHAR(64),
            event_name VARCHAR(128),
            published_at timestamp,
            temps_mesure datetime,
            payload_json TEXT,
            event_json TEXT
        )
    `);
    return db;
}

module.exports = {
    ensureRawEventsTable,
};
