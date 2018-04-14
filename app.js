const fs = require('fs');
const moment = require('moment');
const Promise = require('promise');
const readFile = Promise.denodeify(fs.readFile);
const WebSocketClient = require('websocket').client;
const ExportConfig = require('./config.json');
const config = require(ExportConfig.dashboardConfig.filename);
const sqlite3 = require('better-sqlite3');
const chalk = require('chalk');
const dbFile = ExportConfig.database || 'data.sqlite3';
const util = require('util');

function ensureDatabase() {
    return new Promise(function (resolve, reject) {
        fs.open(dbFile, 'r', function (err, fd) {
            if (err) {
                console.log(chalk.gray("Creating database: %s"), dbFile);
                readFile('schema.sql', 'utf8').then(createDatabase).then(resolve, reject);
            } else {
                console.log(chalk.gray("Using existing database: %s"), dbFile);
                resolve(new sqlite3(dbFile));
            }
        });
    });
}

function createDatabase(schema) {
    return new Promise(function (resolve, reject) {
        try {
            var db = new sqlite3(dbFile);
            db.exec(schema);
            resolve(db);
        } catch (err) {
            reject(err);
        }
    });
}

function liters2gallons(liters) {
    return Math.ceil(liters / 4.54609188);
}

const dashboard = require('./dashboard.js').Dashboard(config, WebSocketClient);
dashboard.init().then(function () {
    return dashboard.connect(function () {
        // Connected or re-connected
        // TODO: Don't update from last state from dashboard.json, but instead from DATABASE
        // (or commit transaction only after writing dashboard.json)
        return dashboard.update();
    }).then(function () {
        // Connected for first time
        dashboard.onQueryComplete(function () {
            dashboard.subscribe();
        });
        return dashboard.start();
    });
}).catch(function (err) {
    console.error("Error starting dashboard: ", err.stack);
});
const express = require('express');
const path = require('path');
const app = express();
app.use(app.router);
app.use(express.logger());
app.use(express.static(path.join(__dirname, 'public')));

function insertData(db, event, device) {
    const deviceId = event.coreid;
    const deviceName = device.name;
    const eventName = event.data.eName;
    // console.log("got event " + eventName + " from device: " + deviceName, event);

    if (eventName === "Vacuum/Lignes") {
        var publishDate = new Date(event.published_at).getTime();
    } else {
        var publishDate = 1000 * event.data.timestamp;
    }

    function runSql(sql, params) {
        return new Promise(function (complete, reject) {
            try {
                complete(db.prepare(sql).run(params));
            } catch (err) {
                reject({err, sql, params});
            }
        });
    }

    // Handle pump start/stop events
    if (event.data.eName === "pump/T1" || event.data.eName === "pump/T2") {
        const eventType = (event.data.eData === 0) ? "start" : "stop";
        const sql = "INSERT INTO pumps (device_id, device_name, published_at, temps_mesure, event_type) VALUES (?, ?, ?, ?, ?)";
        const params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), eventType];
        return runSql(sql, params);
        // Handle fin de cycle events
    } else if (eventName === "pump/endCycle") {
        const dutycycle = event.data.eData / 1000;
        const rate = event.object.capacity_gph * event.object.duty;
        const ONtime = Math.abs(event.object.T2ONtime);
        const volume_gal = ONtime * event.object.capacity_gph / 3600;
        const volume_total = event.object.volume;
        const sql = "INSERT INTO cycles (device_id, device_name, end_time, fin_cycle, pump_on_time, volume, volume_total, dutycycle, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
        const params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), ONtime, volume_gal, volume_total, dutycycle, rate];
        return runSql(sql, params);
        // Handle "pump/debutDeCoulee" and "pump/finDeCoulee" events
    } else if (eventName === "pump/debutDeCoulee" || eventName === "pump/finDeCoulee") {
        const volume_gal = event.object.volume;
        const eventType = (event.data.eData === 1) ? "start" : "stop";
        const sql = "INSERT INTO coulee (device_id, device_name, start_stop_time, temps_debut_fin ,event_type, volume) VALUES (?, ?, ?, ?, ?, ?)";
        const params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), eventType, volume_gal];
        return runSql(sql, params);
        // Handle "sensor/level" events
    } else if (eventName === "sensor/level") {
        if (event.object) {
            const fill_gallons = liters2gallons(event.object.fill);
            const fill_percent = event.object.fill / event.object.capacity;
            const sql = "INSERT INTO tanks (device_id, device_name, published_at, temps_mesure, fill_gallons, fill_percent) VALUES (?, ?, ?, ?, ?, ?)";
            const params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), fill_gallons, fill_percent];
            return runSql(sql, params);
        } else {
            console.warn(util.format("Got sensor/level from device %s, but tank is undefined", event.coreid), event);
            return Promise.resolve();
        }
    } else if (eventName === "sensor/vacuum") {
        const mm_hg = event.data.eData / 100;
        const sql = "INSERT INTO vacuum (device_id, device_name, published_at, temps_mesure, mm_hg ) VALUES (?, ?, ?, ?, ?)";
        const params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), mm_hg];
        return runSql(sql, params);
    } else if (eventName === "Vacuum/Lignes") {
        const data = event.data;
        // TODO FIX THIS TERRIBLE CODE
        for (var i = 0; i < 4; i++) {
            try {
                const sensor = dashboard.getVacuumSensorOfLineVacuumDevice(device, i);
                if (sensor !== undefined) {
                    console.log("sensor", sensor);
                    var line_name = sensor.inputName;
                    var mm_hg = data[sensor.inputName];
                    var temp = data["temp"];
                    var Vin = data["Vin"];
                    var light = data["li"];
                    var soc = data["soc"];
                    var volt = data["volt"];
                    var rssi = data["rssi"];
                    var qual = data["qual"];
                } else {
                    break;
                }
            } catch (err) {
                console.log("Device " + device.name + " has no vacuum sensor");
            }
        }
        const sql = "INSERT INTO linevacuum (device_id, device_name, published_at, temps_mesure, line_name, mm_hg, Vin, light, soc, volt, temp, rssi, qual ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        const params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), line_name, mm_hg, Vin, light, soc, volt, temp, rssi, qual];
        return runSql(sql, params);
    } else if (eventName === "sensor/Valve1Pos" || eventName === "sensor/Valve2Pos") {
        const valve_name = event.object.code;
        const position = event.object.position;
        const posToCode = {"Fermé": 0, "Ouvert": 1, "Partiel": 2, "Erreur": 3};
        const position_code = posToCode.position;
        const sql = "INSERT INTO valves (device_id, device_name, published_at, temps_mesure, valve_name, position ) VALUES (?, ?, ?, ?, ?,?)";
        const params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), valve_name, position];
        return runSql(sql, params);
    } else {
        return Promise.resolve();
    }
}

function startApp(db) {
    const http = require('http');
    const port = ExportConfig.port || '3003';
    app.set('port', port);
    app.get('/pumps.csv', function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        return new Promise(function (complete, reject) {
            try {
                res.write("device_id \tdevice_name \tpublished_at \tevent_type" + '\n');
                const sql = "select * from pumps";
                for (const row of db.prepare(sql).iterate()) {
                    res.write(row.device_id + '\t');
                    res.write(row.device_name + '\t');
                    res.write(moment(row.published_at).format("YYYY-MM-DD HH:mm:ss") + '\t');
                    res.write(row.event_type + '\t');
                    res.write('\n');
                }
                complete();
            } catch (err) {
                reject(err);
            }
        });
    });
    app.get('/tanks.csv', function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        return new Promise(function (complete, reject) {
            try {
                res.write("device_id \tdevice_name \tpublished_at \fill_gallons \tfill_percent" + '\n');
                const sql = "select * from tanks";
                for (const row of db.prepare(sql).iterate()) {
                    res.write(row.device_id + '\t');
                    res.write(row.device_name + '\t');
                    res.write(moment(row.published_at).format("YYYY-MM-DD HH:mm:ss") + '\t');
                    res.write(row.fill_gallons + '\t');
                    res.write(row.fill_percent + '\t');
                    res.write('\n');
                }
                complete();
            } catch (err) {
                reject(err);
            }
        });
    });
    app.get('/cycles.csv', function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        return new Promise(function (complete, reject) {
            try {
                res.write("device_id \tdevice_name \tend_time \tpump_on_time(sec) \tvolume \tdutycycle \trate" + '\n');
                const sql = "select * from cycles";
                for (const row of db.prepare(sql).iterate()) {
                    res.write(row.device_id + '\t');
                    res.write(row.device_name + '\t');
                    res.write(moment(row.end_time).format("YYYY-MM-DD HH:mm:ss") + '\t');
                    res.write(row.pump_on_time + '\t');
                    res.write(row.volume + '\t');
                    res.write(row.dutycycle + '\t');
                    res.write(row.rate + '\t');
                    res.write('\n');
                }
                complete();
            } catch (err) {
                reject(err);
            }
        });
    });
    app.get('/coulee.csv', function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        return new Promise(function (complete, reject) {
            try {
                res.write("device_id \tdevice_name \tstart_stop_time \tevent_type \tvolume" + '\n');
                const sql = "select * from coulee";
                for (const row of db.prepare(sql).iterate()) {
                    res.write(row.device_id + '\t');
                    res.write(row.device_name + '\t');
                    res.write(moment(row.start_stop_time).format("YYYY-MM-DD HH:mm:ss") + '\t');
                    res.write(row.event_type + '\t');
                    res.write(row.volume + '\t');
                    res.write('\n');
                }
                complete();
            } catch (err) {
                reject(err);
            }
        });
    });
    app.get('/data.json', function (req, res) {
        res.setHeader("Content-Type", "text/plain");
        res.send(JSON.stringify(dashboard.getData(), null, 2));
    });

    const server = http.createServer(app);
    dashboard.onChange(function (data, event, device) {
        return insertData(db, event, device);
    });
    server.listen(port);
    console.log('HTTP Server started: http://localhost:' + port);
}

ensureDatabase().then(startApp).catch(function (err) {
    console.error(chalk.red(err));
});
