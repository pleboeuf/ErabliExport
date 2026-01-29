# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

ErabliExport is a Node.js data export and persistence layer for maple syrup farm (érablière) monitoring systems. It consumes real-time events from ErabliDash/ErabliCollecteur via WebSocket, stores the data in both SQLite and InfluxDB databases, and provides CSV export endpoints for data analysis.

## Development Commands

### Essential Commands
```bash
# Install dependencies
npm install

# Create SQLite database (first time setup)
sqlite3 data/db.sqlite3 < schema.sql

# Configure the application
cp config.json.sample config.json
# Edit config.json with your database and collector settings

# Start the application
node app.js
# or
npm start

# Run in playback-only mode (no real-time subscriptions)
node app.js playbackOnly
```

### Database Management
```bash
# View SQLite database contents
sqlite3 data/db.sqlite "SELECT * FROM pumps LIMIT 10;"
sqlite3 data/db.sqlite "SELECT * FROM vacuum LIMIT 10;"

# Backup database
cp data/db.sqlite data/db.sqlite_$(date +%Y-%m-%dT%H%M%S).sq3.bk

# Reset database (WARNING: destroys all data)
rm data/db.sqlite
sqlite3 data/db.sqlite < schema.sql
```

## Architecture Overview

### Core Components

**app.js** - Main application and data ingestion pipeline
- Initializes SQLite and InfluxDB connections
- Imports `Dashboard` class from `../ErabliDash/dashboard.js` (peer dependency)
- Subscribes to real-time events from ErabliCollecteur via WebSocket
- Processes events and stores them in SQLite (historical) and InfluxDB (time-series)
- Exposes Express web server with CSV export endpoints

**dashboard.js** - Shared data processing module (from ErabliDash)
- Contains core classes: `Device`, `Tank`, `Pump`, `VacuumSensor`
- Handles WebSocket communication with ErabliCollecteur
- Processes raw IoT events into structured data
- Provides tank volume calculations for different geometries

### Data Flow Architecture

1. **Event Collection**: ErabliCollecteur broadcasts IoT device events via WebSocket
2. **Event Processing**: Dashboard module processes events by topic and enriches with device metadata
3. **Dual Storage**:
   - **SQLite**: Relational storage for structured queries and CSV exports
   - **InfluxDB**: Time-series storage optimized for monitoring and visualization
4. **CSV Export**: Express endpoints serve data as tab-delimited CSV files
5. **JSON API**: `/data.json` endpoint provides current dashboard state

### Event Types and Storage

Events are categorized by topic and stored in specific tables:

**pump/T1, pump/T2** → `pumps` table
- Tracks pump start/stop events
- Fields: device_id, device_name, published_at, dev_timer, event_type, pump_state

**pump/endCycle** → `cycles` table
- Records completed pump cycles with volume calculations
- Fields: end_time, pump_on_time, pump_off_time, volume, dutycycle, rate, volume_total

**pump/debutDeCoulee, pump/finDeCoulee** → `coulee` table
- Tracks sap flow start/stop events ("coulée" = sap run)
- Fields: start_stop_time, event_type, volume_total

**sensor/level** → `tanks` table
- Tank fill level measurements
- Fields: published_at, fill_gallons, fill_percent

**sensor/vacuum** → `vacuum` table
- Vacuum pressure readings
- Fields: published_at, in_hg (inches of mercury)

**Vacuum/Lignes** → `linevacuum` table
- Multi-sensor vacuum line monitoring
- Fields: line_name, in_hg, temp, bat_temp, light, soc, volt, rssi, qual, Vin

**sensor/Valve1Pos, sensor/Valve2Pos** → `valves` table
- Valve position tracking
- Fields: valve_name, position (Fermé/Ouvert/Partiel/Erreur), position_code

**Osmose/** events → InfluxDB only
- Reverse osmosis system operations (Start/Stop/alarm/operData/concData/summaryData)
- Too complex for simple relational storage, stored only in InfluxDB

### Timestamp Handling

Two timestamp formats are used depending on event type:
- **Vacuum/Lignes**: Uses `event.published_at` (server timestamp)
- **Other events**: Uses `event.data.timestamp` + `event.data.timer` (device timestamp)

Published timestamps are stored in milliseconds since epoch and formatted as `YYYY-MM-DD HH:mm:ss` for database storage.

## Configuration System

### config.json Structure
```json
{
  "port": 3003,
  "database": "data/db.sqlite",
  "dashboardConfig": {
    "filename": "../ErabliDash/config.json"
  },
  "influxdb": {
    "host": "servername.local",
    "port": 8086,
    "database": "Test_2023",
    "schema": "influxDbSchema.json"
  }
}
```

### Dependencies on ErabliDash

**Critical**: This application has a hard dependency on the ErabliDash sibling project:
- Located at `../ErabliDash/` relative to this project
- Imports `dashboard.js` module directly
- Shares device configuration via `../ErabliDash/config.json`
- Both projects must be cloned side-by-side in the same parent directory

## Environment Variables

Required in `.env`:
- `ENDPOINT_VAC`: External vacuum data API endpoint (used by dashboard.js)
- `ENDPOINT_TANK`: Tank data API endpoint
- `ENDPOINT_WATER`: Water data API endpoint
- `ENDPOINT_ALL`: Combined data endpoint
- `PARTICLE_TOKEN`: Particle.io API token for device access

## HTTP Endpoints

The Express server (default port 3003) provides CSV export endpoints:

- **GET /pumps.csv**: Pump start/stop events
- **GET /tanks.csv**: Tank fill level history
- **GET /cycles.csv**: Completed pump cycles with volumes
- **GET /coulee.csv**: Sap flow start/stop events
- **GET /data.json**: Current dashboard state (JSON)

All CSV endpoints return tab-delimited data with headers.

## Database Schema

See `schema.sql` for complete table definitions. Key tables:
- `pumps`: Pump start/stop events
- `cycles`: Pump cycle completions with volume data
- `coulee`: Sap flow tracking
- `tanks`: Tank level measurements
- `vacuum`: Vacuum pressure readings
- `linevacuum`: Multi-sensor vacuum line data
- `valves`: Valve position history
- `saison`: Season start/end dates (currently unused)

## Development Guidelines

### Adding Support for New Event Types

1. Add event handler in `insertData()` function (SQLite storage)
2. Add corresponding handler in `insertInflux()` function (InfluxDB storage)
3. Update `schema.sql` if new table needed
4. Add measurement definition to `influxdbSchema.json`
5. Consider adding CSV export endpoint if data needs to be analyzed

### Modifying Data Processing

- Event processing logic is split between `insertData()` (SQLite) and `insertInflux()` (InfluxDB)
- Both functions receive the same event data but may transform it differently
- SQLite uses `better-sqlite3` with synchronous API wrapped in Promises
- InfluxDB uses async `writePoints()` API
- All database errors are logged but don't crash the application

### Testing Database Changes

Since there's no automated test suite:
1. Create test database: `sqlite3 test.sqlite < schema.sql`
2. Manually verify schema changes
3. Test with playback mode: `node app.js playbackOnly`
4. Check InfluxDB writes with InfluxDB CLI or GUI

## Production Deployment

- Use `ErabliExport.service` for systemd service configuration
- Application runs on port 3003 by default (configurable in `config.json`)
- Ensure both ErabliExport and ErabliDash are deployed in sibling directories
- Set up InfluxDB instance and create database before starting
- Monitor logs for WebSocket connection issues
- Implement database backup strategy for SQLite file
- Consider log rotation for console output

## Key Dependencies

- **better-sqlite3**: Fast synchronous SQLite3 binding
- **influx**: InfluxDB client for time-series data
- **express**: Web server for CSV exports
- **websocket**: WebSocket client (used by dashboard.js)
- **moment**: Date/time formatting and manipulation
- **chalk**: Colored console output
- **dotenv**: Environment variable management
- **node-fetch**: HTTP client for external APIs

## Unit Conversion

The codebase uses `liters2gallons()` helper function:
- Converts metric liters to imperial gallons
- Uses UK/Imperial gallon: 4.54609188 liters
- Note: This is NOT US gallons (3.78541 liters)
