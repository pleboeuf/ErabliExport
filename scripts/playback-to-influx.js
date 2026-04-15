#!/usr/bin/env node
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const sqlite3 = require("better-sqlite3");
const Influx = require("influx");
const { insertInflux } = require("../data-handlers");
const { Dashboard } = require("../../ErabliDash/dashboard.js");

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_DELAY_MS = 0;
const PROGRESS_LOG_EVERY = 1000;

function printHelp() {
    console.log(`
Usage:
  node scripts/playback-to-influx.js --sqlite <path> [options]

Required:
  --sqlite <path>       Path to source SQLite raw_events database (ex: Toute_la_Saison_2026.sq3)

Options:
  --batch-size <n>      Events per batch before waiting (default: ${DEFAULT_BATCH_SIZE})
  --delay-ms <n>        Delay in ms between batches (default: ${DEFAULT_DELAY_MS})
  --from <time>         Inclusive lower bound on published_at (ISO string or unix timestamp)
  --to <time>           Inclusive upper bound on published_at (ISO string or unix timestamp)
  --dry-run             Process events without writing to InfluxDB
  -h, --help            Show this help

Examples:
  node scripts/playback-to-influx.js --sqlite ../ErabliCollecteur/Toute_la_Saison_2026.sq3
  node scripts/playback-to-influx.js --sqlite ../ErabliCollecteur/Toute_la_Saison_2026.sq3 --batch-size 200 --delay-ms 100
  node scripts/playback-to-influx.js --sqlite ../ErabliCollecteur/Toute_la_Saison_2026.sq3 --from 2026-01-01T00:00:00Z --to 2026-04-01T00:00:00Z
  node scripts/playback-to-influx.js --sqlite ../ErabliCollecteur/Toute_la_Saison_2026.sq3 --dry-run
`.trim());
}

function parseArgs(argv) {
    const options = {
        sqlite: null,
        batchSize: DEFAULT_BATCH_SIZE,
        delayMs: DEFAULT_DELAY_MS,
        from: null,
        to: null,
        dryRun: false,
        help: false,
    };

    function requireValue(flag, index) {
        const value = argv[index + 1];
        if (typeof value === "undefined") {
            throw new Error(`Option ${flag} requires a value.`);
        }
        return value;
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--sqlite":
                options.sqlite = requireValue(arg, i);
                i++;
                break;
            case "--batch-size":
                options.batchSize = Number(requireValue(arg, i));
                i++;
                break;
            case "--delay-ms":
                options.delayMs = Number(requireValue(arg, i));
                i++;
                break;
            case "--from":
                options.from = requireValue(arg, i);
                i++;
                break;
            case "--to":
                options.to = requireValue(arg, i);
                i++;
                break;
            case "--dry-run":
                options.dryRun = true;
                break;
            case "-h":
            case "--help":
                options.help = true;
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function validateOptions(options) {
    if (!options.help && !options.sqlite) {
        throw new Error("Missing required option --sqlite <path>.");
    }
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
        throw new Error("--batch-size must be an integer greater than 0.");
    }
    if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
        throw new Error("--delay-ms must be an integer greater than or equal to 0.");
    }
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function unixToMs(value) {
    if (!Number.isFinite(value)) {
        return NaN;
    }

    const absValue = Math.abs(value);
    if (absValue >= 1e17) {
        return Math.floor(value / 1e6); // nanoseconds
    }
    if (absValue >= 1e14) {
        return Math.floor(value / 1e3); // microseconds
    }
    if (absValue >= 1e11) {
        return Math.floor(value); // milliseconds
    }
    return Math.floor(value * 1000); // seconds
}

function normalizeBoundaryInput(value, optionName) {
    if (value === null || typeof value === "undefined") {
        return null;
    }

    const raw = String(value).trim();
    if (raw.length === 0) {
        return null;
    }

    if (/^-?\d+(\.\d+)?$/.test(raw)) {
        const asNumber = Number(raw);
        const ms = unixToMs(asNumber);
        const date = new Date(ms);
        if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) {
            throw new Error(
                `Invalid numeric value for ${optionName}: '${value}'`,
            );
        }
        return date.toISOString();
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(
            `Invalid date value for ${optionName}: '${value}'. Use ISO format or unix timestamp.`,
        );
    }
    return parsed.toISOString();
}

function normalizePublishedAt(value) {
    if (value === null || typeof value === "undefined") {
        return new Date().toISOString();
    }

    if (typeof value === "number") {
        const ms = unixToMs(value);
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) {
            return date.toISOString();
        }
        return new Date().toISOString();
    }

    const raw = String(value).trim();
    if (raw.length === 0) {
        return new Date().toISOString();
    }

    if (/^-?\d+(\.\d+)?$/.test(raw)) {
        const ms = unixToMs(Number(raw));
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) {
            return date.toISOString();
        }
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
    }

    return raw;
}

function buildRawEventsQuery(bounds) {
    const where = [];
    const params = [];

    if (bounds.fromIso) {
        where.push("published_at >= ?");
        params.push(bounds.fromIso);
    }
    if (bounds.toIso) {
        where.push("published_at <= ?");
        params.push(bounds.toIso);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    return {
        selectSql: `
            SELECT rowid, device_id, published_at, generation_id, serial_no, raw_data
            FROM raw_events
            ${whereClause}
            ORDER BY published_at, generation_id, serial_no, rowid
        `,
        countSql: `
            SELECT COUNT(*) AS total
            FROM raw_events
            ${whereClause}
        `,
        params,
    };
}

function readJsonFile(filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
}

function loadExportConfig(exportRoot) {
    const configPath = path.join(exportRoot, "config.json");
    const fallbackPath = path.join(exportRoot, "config.json.sample");

    if (fs.existsSync(configPath)) {
        return { config: readJsonFile(configPath), sourcePath: configPath };
    }
    if (fs.existsSync(fallbackPath)) {
        return { config: readJsonFile(fallbackPath), sourcePath: fallbackPath };
    }

    throw new Error(
        `Missing ErabliExport config file. Tried ${configPath} and ${fallbackPath}.`,
    );
}

function createPlaybackTransport() {
    const clientCallbacks = {};
    const connectionCallbacks = {};

    const connection = {
        connected: false,
        sendUTF: function () {
            // No-op: this playback transport does not query a remote collector.
        },
        on: function (event, callback) {
            connectionCallbacks[event] = callback;
        },
        close: function () {
            this.connected = false;
            if (typeof connectionCallbacks.close === "function") {
                connectionCallbacks.close();
            }
        },
    };

    function PlaybackWebSocketClient() {}

    PlaybackWebSocketClient.prototype.on = function (event, callback) {
        clientCallbacks[event] = callback;
    };

    PlaybackWebSocketClient.prototype.connect = function () {
        connection.connected = true;
        if (typeof clientCallbacks.connect === "function") {
            clientCallbacks.connect(connection);
        }
    };

    async function injectCollectorEvent(eventPayload) {
        if (typeof connectionCallbacks.message !== "function") {
            throw new Error(
                "Dashboard connection is not ready to receive playback messages.",
            );
        }

        const message = {
            type: "utf8",
            utf8Data: JSON.stringify(eventPayload),
        };

        await Promise.resolve(connectionCallbacks.message(message));
    }

    return {
        WebSocketClient: PlaybackWebSocketClient,
        injectCollectorEvent,
        close: function () {
            if (typeof connection.close === "function") {
                connection.close();
            }
        },
    };
}

function toCollectorEvent(row) {
    let data;
    try {
        data = JSON.parse(row.raw_data);
    } catch (err) {
        return { event: null, skipReason: "invalid_json" };
    }

    if (!data || typeof data !== "object") {
        return { event: null, skipReason: "invalid_payload" };
    }

    if (
        (typeof data.generation === "undefined" || data.generation === null) &&
        typeof row.generation_id !== "undefined" &&
        row.generation_id !== null
    ) {
        data.generation = row.generation_id;
    }

    if (
        (typeof data.noSerie === "undefined" || data.noSerie === null) &&
        typeof row.serial_no !== "undefined" &&
        row.serial_no !== null
    ) {
        data.noSerie = row.serial_no;
    }

    if (
        typeof data.generation === "undefined" ||
        data.generation === null ||
        typeof data.noSerie === "undefined" ||
        data.noSerie === null
    ) {
        return { event: null, skipReason: "missing_generation_or_serial" };
    }

    return {
        event: {
            coreid: row.device_id,
            published_at: normalizePublishedAt(row.published_at),
            name: data.eName || "collector/playback",
            data: JSON.stringify(data),
        },
        skipReason: null,
    };
}

async function ensureInfluxDatabaseExists(influx, databaseName) {
    const dbNames = await influx.getDatabaseNames();
    if (!dbNames.includes(databaseName)) {
        throw new Error(
            `InfluxDB database '${databaseName}' does not exist on target server.`,
        );
    }
}

function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return "n/a";
    }
    const seconds = Math.floor(ms / 1000);
    const hh = Math.floor(seconds / 3600)
        .toString()
        .padStart(2, "0");
    const mm = Math.floor((seconds % 3600) / 60)
        .toString()
        .padStart(2, "0");
    const ss = Math.floor(seconds % 60)
        .toString()
        .padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
}

async function run() {
    const options = parseArgs(process.argv.slice(2));
    validateOptions(options);

    if (options.help) {
        printHelp();
        return;
    }

    const sourceSqlitePath = path.resolve(process.cwd(), options.sqlite);
    if (!fs.existsSync(sourceSqlitePath)) {
        throw new Error(`Source SQLite file not found: ${sourceSqlitePath}`);
    }

    const bounds = {
        fromIso: normalizeBoundaryInput(options.from, "--from"),
        toIso: normalizeBoundaryInput(options.to, "--to"),
    };
    if (
        bounds.fromIso &&
        bounds.toIso &&
        new Date(bounds.fromIso) > new Date(bounds.toIso)
    ) {
        throw new Error("--from must be earlier than or equal to --to.");
    }

    const exportRoot = path.resolve(__dirname, "..");
    const { config: exportConfig, sourcePath: exportConfigPath } =
        loadExportConfig(exportRoot);
    const dashboardConfigPath = path.resolve(
        exportRoot,
        exportConfig.dashboardConfig &&
            exportConfig.dashboardConfig.filename
            ? exportConfig.dashboardConfig.filename
            : "../ErabliDash/config.json",
    );
    if (!fs.existsSync(dashboardConfigPath)) {
        throw new Error(`Dashboard config not found: ${dashboardConfigPath}`);
    }

    const baseDashboardConfig = readJsonFile(dashboardConfigPath);
    const playbackDashboardConfig = deepClone(baseDashboardConfig);
    const playbackStorePath = path.resolve(
        exportRoot,
        "data/dashboard.playback.json",
    );
    playbackDashboardConfig.collectors = [{ uri: "ws://playback.local/" }];
    playbackDashboardConfig.store = Object.assign(
        {},
        playbackDashboardConfig.store || {},
        {
            filename: playbackStorePath,
        },
    );

    if (fs.existsSync(playbackStorePath)) {
        fs.unlinkSync(playbackStorePath);
    }

    const sourceDb = new sqlite3(sourceSqlitePath, {
        readonly: true,
        fileMustExist: true,
    });

    const transport = createPlaybackTransport();
    const dashboard = Dashboard(playbackDashboardConfig, transport.WebSocketClient);

    const influx = options.dryRun
        ? null
        : new Influx.InfluxDB({
              host: exportConfig.influxdb.host,
              port: exportConfig.influxdb.port,
              database: exportConfig.influxdb.database,
          });

    try {
        console.log(
            `Playback source: ${sourceSqlitePath}\nExport config: ${exportConfigPath}\nDashboard config: ${dashboardConfigPath}`,
        );
        console.log(
            `Mode: ${options.dryRun ? "DRY-RUN (no Influx writes)" : "WRITE InfluxDB"} | batch-size=${options.batchSize} | delay-ms=${options.delayMs}`,
        );
        if (bounds.fromIso || bounds.toIso) {
            console.log(
                `Window: from=${bounds.fromIso || "beginning"} to=${bounds.toIso || "end"}`,
            );
        }

        if (!options.dryRun) {
            await ensureInfluxDatabaseExists(influx, exportConfig.influxdb.database);
            console.log(
                `Influx target confirmed: ${exportConfig.influxdb.database} (${exportConfig.influxdb.host}:${exportConfig.influxdb.port})`,
            );
        }

        await dashboard.init();
        await dashboard.connect();

        dashboard.onChange((data, event, device) => {
            void data;
            if (options.dryRun) {
                return Promise.resolve();
            }
            return insertInflux(influx, event, device, {
                tankConfigs: playbackDashboardConfig.tanks,
                dashboardDataPath: null,
            });
        });

        const query = buildRawEventsQuery(bounds);
        const totalRows =
            sourceDb.prepare(query.countSql).get(query.params).total || 0;
        console.log(`Rows selected from raw_events: ${totalRows}`);

        const startMs = Date.now();
        let scanned = 0;
        let emitted = 0;
        let skipped = 0;
        let failed = 0;
        const skipReasons = {};

        const iterator = sourceDb.prepare(query.selectSql).iterate(query.params);
        for (const row of iterator) {
            scanned += 1;
            const { event, skipReason } = toCollectorEvent(row);

            if (!event) {
                skipped += 1;
                skipReasons[skipReason] = (skipReasons[skipReason] || 0) + 1;
            } else {
                try {
                    await transport.injectCollectorEvent(event);
                    emitted += 1;
                } catch (err) {
                    failed += 1;
                    console.error(
                        `Failed to process rowid=${row.rowid} device=${row.device_id}: ${err.message}`,
                    );
                }
            }

            if (
                options.delayMs > 0 &&
                emitted > 0 &&
                emitted % options.batchSize === 0
            ) {
                await sleep(options.delayMs);
            }

            if (scanned % PROGRESS_LOG_EVERY === 0) {
                const elapsed = Date.now() - startMs;
                const rate = elapsed > 0 ? (emitted / elapsed) * 1000 : 0;
                console.log(
                    `Progress ${scanned}/${totalRows} | emitted=${emitted} skipped=${skipped} failed=${failed} | rate=${rate.toFixed(1)} ev/s`,
                );
            }
        }

        const elapsedMs = Date.now() - startMs;
        const finalRate = elapsedMs > 0 ? (emitted / elapsedMs) * 1000 : 0;
        console.log("Playback completed.");
        console.log(
            `Summary: scanned=${scanned}, emitted=${emitted}, skipped=${skipped}, failed=${failed}, elapsed=${formatElapsed(elapsedMs)}, avg-rate=${finalRate.toFixed(1)} ev/s`,
        );

        const reasonKeys = Object.keys(skipReasons);
        if (reasonKeys.length > 0) {
            console.log(
                `Skip reasons: ${reasonKeys
                    .map((key) => `${key}=${skipReasons[key]}`)
                    .join(", ")}`,
            );
        }
    } finally {
        try {
            await dashboard.stop();
        } catch (err) {
            console.warn(`Warning: failed to stop dashboard cleanly: ${err.message}`);
        }
        transport.close();
        sourceDb.close();
    }
}

run().catch((err) => {
    console.error(`Playback failed: ${err.message}`);
    process.exit(1);
});
