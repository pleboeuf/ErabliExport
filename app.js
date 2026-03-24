require("dotenv").config();
// const fetch = (...args) =>
//     import("node-fetch").then(({ default: fetch }) => fetch(...args)); // Add this line
const fs = require("fs");
const moment = require("moment");
const Promise = require("promise");
const readFile = Promise.denodeify(fs.readFile);
const WebSocketClient = require("websocket").client;
const Schema = require("./influxdbSchema.json");
const ExportConfig = require("./config.json");
const path = require("path");
const dashboardConfigPath = path.resolve(
    __dirname,
    ExportConfig.dashboardConfig.filename,
);
const baseDashboardConfig = require(dashboardConfigPath);
const dashboardDataPathForInflux = path.resolve(
    path.dirname(dashboardConfigPath),
    baseDashboardConfig.store.filename,
);
const config = JSON.parse(JSON.stringify(baseDashboardConfig));
config.store = Object.assign({}, baseDashboardConfig.store, {
    filename: path.resolve(__dirname, "data/dashboard.json"),
});
const sqlite3 = require("better-sqlite3");
const chalk = require("chalk");
const dbFile = ExportConfig.database || "data.sqlite3";
const util = require("util");
const nodeArg = process.argv;
const Influx = require("influx");
const { ensureRawEventsTable } = require("./db-utils");
const influx = new Influx.InfluxDB({
    host: ExportConfig["influxdb"]["host"],
    port: ExportConfig["influxdb"]["port"],
    database: ExportConfig["influxdb"]["database"],
});
const { insertData, insertInflux } = require("./data-handlers");

// Global references for graceful shutdown
let mainDb = null;
let httpServer = null;
let isShuttingDown = false;

function ensureDatabase() {
    return new Promise(function (resolve, reject) {
        fs.open(dbFile, "r", function (err, fd) {
            if (err) {
                console.log(chalk.gray("Creating database: %s"), dbFile);
                readFile("schema.sql", "utf8")
                    .then(createDatabase)
                    .then(resolve, reject);
            } else {
                console.log(chalk.gray("Using existing database: %s"), dbFile);
                try {
                    resolve(ensureRawEventsTable(new sqlite3(dbFile)));
                } catch (dbErr) {
                    reject(dbErr);
                }
            }
        });
    });
}

function createDatabase(schema) {
    return new Promise(function (resolve, reject) {
        try {
            var db = new sqlite3(dbFile);
            db.exec(schema);
            resolve(ensureRawEventsTable(db));
        } catch (err) {
            reject(err);
        }
    });
}

const dashboard = require("../ErabliDash/dashboard.js").Dashboard(
    config,
    WebSocketClient
);
dashboard
    .init()
    .then(function () {
        return dashboard
            .connect(function () {
                // Connected or re-connected
                // TODO: Don't update from last state from dashboard.json, but instead from DATABASE
                // (or commit transaction only after writing dashboard.json)
                return dashboard.update();
            })
            .then(function () {
                // Connected for first time
                dashboard.onQueryComplete(function () {
                    if (
                        nodeArg[2] === undefined ||
                        nodeArg[2] !== "playbackOnly"
                    ) {
                        dashboard.subscribe();
                    }
                });
                return dashboard.start();
            });
    })
    .catch(function (err) {
        console.error("Error starting dashboard: ", err.stack);
    });
const express = require("express");
const app = express();
app.use(express.static(path.join(__dirname, "public")));
function startApp(db) {
    mainDb = db; // Store database reference for shutdown
    const http = require("http");
    const port = ExportConfig.port || "3003";
    app.set("port", port);
    app.get("/pumps.csv", function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        return new Promise(function (complete, reject) {
            try {
                res.write(
                    "device_id \tdevice_name \tpublished_at \tevent_type" + "\n"
                );
                const sql = "select * from pumps";
                for (const row of db.prepare(sql).iterate()) {
                    res.write(row.device_id + "\t");
                    res.write(row.device_name + "\t");
                    res.write(
                        moment(row.published_at).format("YYYY-MM-DD HH:mm:ss") +
                            "\t"
                    );
                    res.write(row.event_type + "\t");
                    res.write("\n");
                }
                complete();
            } catch (err) {
                reject(err);
            }
        });
    });
    app.get("/tanks.csv", function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        return new Promise(function (complete, reject) {
            try {
                res.write(
                    "device_id \tdevice_name \tpublished_at \fill_gallons \tfill_percent" +
                        "\n"
                );
                const sql = "select * from tanks";
                for (const row of db.prepare(sql).iterate()) {
                    res.write(row.device_id + "\t");
                    res.write(row.device_name + "\t");
                    res.write(
                        moment(row.published_at).format("YYYY-MM-DD HH:mm:ss") +
                            "\t"
                    );
                    res.write(row.fill_gallons + "\t");
                    res.write(row.fill_percent + "\t");
                    res.write("\n");
                }
                complete();
            } catch (err) {
                reject(err);
            }
        });
    });
    app.get("/cycles.csv", function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        return new Promise(function (complete, reject) {
            try {
                res.write(
                    "device_id \tdevice_name \tend_time \tpump_on_time(sec) \tpump_off_time(sec) \tvolume \tdutycycle \trate" +
                        "\n"
                );
                const sql = "select * from cycles";
                for (const row of db.prepare(sql).iterate()) {
                    res.write(row.device_id + "\t");
                    res.write(row.device_name + "\t");
                    res.write(
                        moment(row.end_time).format("YYYY-MM-DD HH:mm:ss") +
                            "\t"
                    );
                    res.write(row.pump_on_time + "\t");
                    res.write(row.pump_off_time + "\t");
                    res.write(row.volume + "\t");
                    res.write(row.dutycycle + "\t");
                    res.write(row.rate + "\t");
                    res.write("\n");
                }
                complete();
            } catch (err) {
                reject(err);
            }
        });
    });
    app.get("/coulee.csv", function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        return new Promise(function (complete, reject) {
            try {
                res.write(
                    "device_id \tdevice_name \tstart_stop_time \tevent_type \tvolume \twater_volumes" +
                        "\n"
                );
                const sql = "select * from coulee";
                for (const row of db.prepare(sql).iterate()) {
                    res.write(row.device_id + "\t");
                    res.write(row.device_name + "\t");
                    res.write(
                        moment(row.start_stop_time).format(
                            "YYYY-MM-DD HH:mm:ss"
                        ) + "\t"
                    );
                    res.write(row.event_type + "\t");
                    res.write(row.volume + "\t");
                    res.write((row.water_volumes_json || "") + "\t");
                    res.write("\n");
                }
                complete();
            } catch (err) {
                reject(err);
            }
        });
    });
    app.get("/data.json", function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        res.send(JSON.stringify(dashboard.getData(), null, 2));
    });

    const server = http.createServer(app);
    httpServer = server; // Store server reference for shutdown
    dashboard.onChange(function (data, event, device) {
        void data;
        return Promise.all([
            insertInflux(influx, event, device, {
                tankConfigs: config.tanks,
                dashboardDataPath: dashboardDataPathForInflux,
            }),
            insertData(db, event, device, { dashboard }),
        ]);
    });
    server.listen(port);
    console.log(chalk.green("HTTP Server started: http://localhost:" + port));
}

// Graceful shutdown handler
function gracefulShutdown(signal) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    
    console.log(chalk.yellow(`\n${signal} received, shutting down gracefully...`));
    
    // Close HTTP server
    if (httpServer) {
        console.log(chalk.gray("Closing HTTP server..."));
        httpServer.close(() => {
            console.log(chalk.gray("HTTP server closed"));
        });
    }
    
    // Disconnect dashboard WebSocket
    if (dashboard && dashboard.disconnect) {
        console.log(chalk.gray("Disconnecting from dashboard..."));
        try {
            dashboard.disconnect();
        } catch (err) {
            console.error(chalk.red("Error disconnecting dashboard:"), err.message);
        }
    }
    
    // Close database connection
    if (mainDb) {
        console.log(chalk.gray("Closing database connection..."));
        try {
            mainDb.close();
            console.log(chalk.gray("Database closed"));
        } catch (err) {
            console.error(chalk.red("Error closing database:"), err.message);
        }
    }
    
    console.log(chalk.green("Shutdown complete. Exiting."));
    process.exit(0);
}

// Register signal handlers for graceful shutdown
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

ensureDatabase()
    .then(startApp)
    .catch(function (err) {
        console.error(chalk.red(err));
        process.exit(1);
    });
