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
const config = require(ExportConfig.dashboardConfig.filename);
const sqlite3 = require("better-sqlite3");
const chalk = require("chalk");
const dbFile = ExportConfig.database || "data.sqlite3";
const util = require("util");
const nodeArg = process.argv;
const Influx = require("influx");
const influx = new Influx.InfluxDB({
    host: ExportConfig["influxdb"]["host"],
    port: ExportConfig["influxdb"]["port"],
    database: ExportConfig["influxdb"]["database"],
});

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
const path = require("path");
const app = express();
app.use(express.static(path.join(__dirname, "public")));

function insertData(db, event, device) {
    const deviceId = event.coreid;
    const deviceName = device.name;
    var eventName = event.data.eName;
    var publishDate;
    // console.log("got event " + eventName + " from device: " + deviceName, event);

    if (!eventName) {
        if (device.eventName) {
            event.data.eName = device.eventName;
            eventName = event.data.eName;
            console.log(
                util.format(
                    "(Dashboard) Overriding event name to %s for device %s",
                    device.eventName,
                    device.id
                )
            );
        } else {
            event.data.eName = "Vacuum/Lignes";
            eventName = event.data.eName;
            console.log(
                util.format(
                    "(Dashboard) Overriding event name from DB to 'Vacuum/Lignes' for device %s",
                    device.id
                )
            );
        }
    }

    if (eventName === "Vacuum/Lignes") {
        publishDate = new Date(event.published_at).getTime();
    } else {
        publishDate = 1000 * event.data.timestamp + (event.data.timer % 1000);
    }

    function runSql(sql, params) {
        return new Promise(function (complete, reject) {
            try {
                complete(db.prepare(sql).run(params));
            } catch (err) {
                reject({ err, sql, params });
            }
        });
    }

    // Handle pump start/stop events
    if (event.data.eName === "pump/T1" || event.data.eName === "pump/T2") {
        const pump_state = event.data.eData;
        const eventType = event.data.eData === 0 ? "start" : "stop";
        const dev_timer = event.data.timer;
        const sql =
            "INSERT INTO pumps (device_id, device_name, published_at, dev_timer, temps_mesure, event_type, pump_state) VALUES (?, ?, ?, ?, ?, ?, ?)";
        const params = [
            deviceId,
            deviceName,
            publishDate,
            dev_timer,
            moment(publishDate).format("YYYY-MM-DD HH:mm:ss"),
            eventType,
            pump_state,
        ];
        return runSql(sql, params);
        // Handle fin de cycle events
    } else if (eventName === "pump/endCycle") {
        if (event.object) {
            const dutycycle = event.data.eData / 1000;
            const rate = event.object.capacity_gph * event.object.duty;
            const ONtime = Math.abs(event.object.ONtime);
            const OFFtime = Math.abs(event.object.OFFtime);
            const volume_gal = (ONtime * event.object.capacity_gph) / 3600;
            const volume_total = event.object.volume;
            const sql =
                "INSERT INTO cycles (device_id, device_name, end_time, fin_cycle, pump_on_time, pump_off_time, volume, volume_total, dutycycle, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
            const params = [
                deviceId,
                deviceName,
                publishDate,
                moment(publishDate).format("YYYY-MM-DD HH:mm:ss"),
                ONtime,
                OFFtime,
                volume_gal,
                volume_total,
                dutycycle,
                rate,
            ];
            return runSql(sql, params);
        } else {
            console.warn(
                util.format(
                    "Got pump/endCycle from device %s, but pump is undefined",
                    event.coreid
                ),
                event
            );
            return Promise.resolve();
        }
        // Handle "pump/debutDeCoulee" and "pump/finDeCoulee" events
    } else if (
        eventName === "pump/debutDeCoulee" ||
        eventName === "pump/finDeCoulee"
    ) {
        const volume_gal = event.object.volume;
        const eventType = event.data.eData === 1 ? "start" : "stop";
        const sql =
            "INSERT INTO coulee (device_id, device_name, start_stop_time, temps_debut_fin ,event_type, volume_total) VALUES (?, ?, ?, ?, ?, ?)";
        const params = [
            deviceId,
            deviceName,
            publishDate,
            moment(publishDate).format("YYYY-MM-DD HH:mm:ss"),
            eventType,
            volume_gal,
        ];
        return runSql(sql, params);
        // Handle "sensor/level" events
    } else if (eventName === "sensor/level") {
        if (event.object) {
            const fill_gallons = liters2gallons(event.object.fill);
            const fill_percent = event.object.fill / event.object.capacity;
            const sql =
                "INSERT INTO tanks (device_id, device_name, published_at, temps_mesure, fill_gallons, fill_percent) VALUES (?, ?, ?, ?, ?, ?)";
            const params = [
                deviceId,
                deviceName,
                publishDate,
                moment(publishDate).format("YYYY-MM-DD HH:mm:ss"),
                fill_gallons,
                fill_percent,
            ];
            return runSql(sql, params);
        } else {
            console.warn(
                util.format(
                    "Got sensor/level from device %s, but tank is undefined",
                    event.coreid
                ),
                event
            );
            return Promise.resolve();
        }
    } else if (eventName === "sensor/vacuum") {
        const in_hg = event.data.eData / 100;
        const sql =
            "INSERT INTO vacuum (device_id, device_name, published_at, temps_mesure, in_hg ) VALUES (?, ?, ?, ?, ?)";
        const params = [
            deviceId,
            deviceName,
            publishDate,
            moment(publishDate).format("YYYY-MM-DD HH:mm:ss"),
            in_hg,
        ];
        return runSql(sql, params);
    } else if (eventName === "Vacuum/Lignes") {
        const data = event.data;
        const sensors = dashboard.getVacuumSensorOfLineVacuumDevice(device);
        sensors.forEach(function (sensor) {
            const line_name = sensor.code;
            const in_hg = data[sensor.inputName];
            const temp = data["temp"];
            const bat_temp = data["batTemp"];
            const Vin = data["Vin"];
            const light = data["li"];
            const soc = data["soc"];
            const volt = data["volt"];
            const rssi = data["rssi"];
            const qual = data["qual"];
            const sql =
                "INSERT INTO linevacuum (device_id, device_name, published_at, temps_mesure, line_name, in_hg, temp, bat_temp,light, soc, volt, rssi, qual, Vin ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
            const params = [
                deviceId,
                deviceName,
                publishDate,
                moment(publishDate).format("YYYY-MM-DD HH:mm:ss"),
                line_name,
                in_hg,
                temp,
                bat_temp,
                light,
                soc,
                volt,
                rssi,
                qual,
                Vin,
            ];
            runSql(sql, params);
        });
        return Promise.resolve();
    } else if (
        eventName === "sensor/Valve1Pos" ||
        eventName === "sensor/Valve2Pos"
    ) {
        const valve_name = event.object.code;
        const position = event.object.position;
        const posToCode = {
            Fermé: 0,
            Ouvert: 1,
            Ouverte: 1,
            Partiel: 2,
            Erreur: 3,
        };
        const position_code = posToCode[position];
        const sql =
            "INSERT INTO valves (device_id, device_name, published_at, temps_mesure, valve_name, position, position_code ) VALUES (?, ?, ?, ?, ?, ?, ?)";
        const params = [
            deviceId,
            deviceName,
            publishDate,
            moment(publishDate).format("YYYY-MM-DD HH:mm:ss"),
            valve_name,
            position,
            position_code,
        ];
        return runSql(sql, params);
    } else {
        return Promise.resolve();
    }
}

function insertInflux(influx, event, device) {
    const deviceId = event.coreid;
    const deviceName = device.name;
    var eventName = event.data.eName;

    if (event.data.timer === undefined) {
        var publishDate = 1000000000 * event.data.timestamp;
    } else {
        var publishDate =
            1000000 * (1000 * event.data.timestamp + (event.data.timer % 1000));
    }

    //     // Handle fin de cycle events
    if (eventName === "pump/endCycle") {
        if (event.object) {
            const dutycycle = event.data.eData / 1000;
            // const rateIn =  event.object.pump_off_time;
            const rateOut = event.object.capacity_gph * event.object.duty;
            const ONtime = Math.abs(event.object.ONtime);
            const OFFtime = Math.abs(event.object.OFFtime);
            // const volume_total = event.object.volume;
            const volume_gal = (ONtime * event.object.capacity_gph) / 3600;
            const point = [
                {
                    measurement: "Cycles",
                    tags: {
                        deviceId: deviceId,
                        deviceName: deviceName,
                    },
                    fields: {
                        // debit_in: rateIn,
                        debit_out: rateOut,
                        volume: volume_gal,
                        dutycycle: dutycycle,
                        ON_time: ONtime,
                        OFF_time: OFFtime,
                    },
                    timestamp: publishDate,
                },
            ];
            return influx.writePoints(point).then(
                () => console.log("Influx-> Cycles ok " + " " + publishDate),
                (e) => console.error(event.object, e)
            );
        } else {
            console.warn(
                util.format(
                    "Got pump/endCycle from device %s, but pump is undefined",
                    event.coreid
                ),
                event
            );
            return Promise.resolve();
        }
        //     // Handle "pump/debutDeCoulee" and "pump/finDeCoulee" events
    } else if (
        eventName === "pump/debutDeCoulee" ||
        eventName === "pump/finDeCoulee"
    ) {
        const volume_gal = event.object.volume;
        const eventType = event.data.eData === 1 ? "start" : "stop";
        const point = [
            {
                measurement: "Coulee",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    etat: eventType,
                },
                fields: {
                    etat_num: event.data.eData,
                    volume_total: volume_gal,
                },
                timestamp: publishDate,
            },
        ];
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> Coulée " +
                        deviceName +
                        " " +
                        eventType +
                        " " +
                        publishDate
                ),
            (e) => console.error(event.object, e)
        );

        // Handle "sensor/level" events
    } else if (eventName === "sensor/level") {
        if (event.object) {
            const fill_gallons = liters2gallons(event.object.fill);
            const fill_percent = event.object.fill / event.object.capacity;

            if (!(isNaN(fill_gallons) || isNaN(fill_percent))) {
                var point = [
                    {
                        measurement: "Reservoirs",
                        tags: {
                            deviceId: deviceId,
                            deviceName: deviceName,
                        },
                        fields: {
                            fill_gallons: fill_gallons,
                            fill_percent: fill_percent,
                        },
                        timestamp: publishDate,
                    },
                ];
                return influx.writePoints(point).then(
                    () =>
                        console.log(
                            "Influx-> Reservoirs " +
                                deviceName +
                                " " +
                                fill_gallons +
                                " gal" +
                                " " +
                                publishDate
                        ),
                    (e) => console.error(event.object, e)
                );
            }
        } else {
            console.warn(
                util.format(
                    "Got sensor/level from device %s, but tank is undefined",
                    event.coreid
                ),
                event
            );
            return Promise.resolve();
        }

        // Handle "sensor/vacuum" events
    } else if (eventName === "sensor/vacuum") {
        const in_hg = event.data.eData / 100;
        const point = [
            {
                measurement: "Vacuum",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                },
                fields: {
                    vacuum: in_hg,
                },
                timestamp: publishDate,
            },
        ];
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> Vacuum " +
                        deviceName +
                        " " +
                        in_hg +
                        " " +
                        publishDate
                ),
            (e) => console.error(event.object, e)
        );

        // Handle "Vacuum/Lignes" events
    } else if (eventName === "Vacuum/Lignes") {
        const data = event.data;
        var publishDate = new Date().getTime() * 1000000;
        for (var i = 0; i < 4; i++) {
            var sensor = dashboard.getVacuumSensorOfLineVacuumDevice(device, i);
            if (sensor !== undefined) {
                var line_name = sensor.code;
                var in_hg = data[sensor.inputName];
                var temp = data["temp"];
                var bat_temp = data["batTemp"];
                var Vin = data["Vin"];
                var light = data["li"];
                var soc = data["soc"];
                var volt = data["volt"];
                var rssi = data["rssi"];
                var qual = data["qual"];
                var point = [
                    {
                        measurement: "Vacuum_ligne",
                        tags: {
                            deviceId: deviceId,
                            deviceName: deviceName,
                            line_name: line_name,
                        },
                        fields: {
                            vacuum: in_hg,
                            ext_temp: temp,
                            bat_temp: bat_temp,
                            light: light,
                            Vin: Vin,
                            soc: soc,
                            bat_volt: volt,
                            rssi: rssi,
                            sig_gual: qual,
                        },
                        timestamp: publishDate,
                    },
                ];
                influx.writePoints(point).then(
                    () =>
                        console.log(
                            "Influx-> Vacuum_ligne " +
                                line_name +
                                " " +
                                in_hg +
                                " " +
                                publishDate
                        ),
                    (e) => console.error(event.object, e)
                );
            } else {
                break;
            }
        }
        return Promise.resolve();
        // Handle "sensor/Valve?Pos" events
    } else if (
        eventName === "sensor/Valve1Pos" ||
        eventName === "sensor/Valve2Pos"
    ) {
        const valve_name = event.object.code;
        const position = event.object.position;
        const posToCode = {
            Fermé: 0,
            Ouvert: 1,
            Ouverte: 1,
            Partiel: 2,
            Erreur: 3,
        };
        const position_code = posToCode[position];
        var point = [
            {
                measurement: "Valves",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    valve_name: valve_name,
                },
                fields: {
                    position: position,
                    pos_code: position_code,
                },
                timestamp: publishDate,
            },
        ];
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> Valve " +
                        deviceName +
                        " " +
                        valve_name +
                        " " +
                        position +
                        " " +
                        publishDate
                ),
            (e) => console.error(event.object, e)
        );
        // Handle "Osmose/Start", "Osmose/Stop"
    } else if (eventName === "Osmose/Start") {
        const osmData = event.object[0];
        const fonction = osmData.fonction;
        const state = osmData.state;
        const alarmNo = osmData.alarmNo;
        const sequence = osmData.sequence;
        const debut = osmData.startStopTime;
        var point = [
            {
                measurement: "Osmose",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    fonction: fonction,
                    sequence: sequence,
                },
                fields: {
                    state: state ? "run" : "stop",
                    alarmNo: alarmNo,
                    debut: debut,
                },
                timestamp: publishDate,
            },
        ];
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> Osmose start " +
                        fonction +
                        " " +
                        sequence +
                        " " +
                        publishDate
                ),
            (e) => console.error(osmData, e)
        );
    } else if (eventName === "Osmose/Stop") {
        const osmData = event.object[0];
        const fonction = osmData.fonction;
        const state = osmData.state;
        const alarmNo = osmData.alarmNo;
        const sequence = osmData.sequence;
        const runTimeSec = osmData.runTimeSec;
        const fin = osmData.startStopTime;
        var point = [
            {
                measurement: "Osmose",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    fonction: fonction,
                    sequence: sequence,
                },
                fields: {
                    state: state ? "run" : "stop",
                    alarmNo: alarmNo,
                    duree: runTimeSec,
                    fin: fin,
                },
                timestamp: publishDate,
            },
        ];
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> Osmose stop " +
                        fonction +
                        " " +
                        sequence +
                        " " +
                        publishDate
                ),
            (e) => console.error(osmData, e)
        );
    } else if (eventName === "Osmose/alarm") {
        const osmData = event.object[0];
        const fonction = osmData.fonction;
        const alarmNo = osmData.alarmNo;
        var point = [
            {
                measurement: "Osmose",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    fonction: fonction,
                },
                fields: {
                    alarmNo: alarmNo,
                },
                timestamp: publishDate,
            },
        ];
        // Save only real alarm
        if (alarmNo < 0) {
            return influx.writePoints(point).then(
                () =>
                    console.log(
                        "Influx-> osmose alarm " +
                            fonction +
                            " alarm no:" +
                            alarmNo +
                            " " +
                            publishDate
                    ),
                (e) => console.error(osmData, e)
            );
        } else {
            return Promise.resolve();
        }
    } else if (eventName === "Osmose/operData") {
        const osmData = event.object[0];
        const fonction = osmData.fonction;
        var point = [
            {
                measurement: "Osmose",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    fonction: fonction,
                    sequence: osmData.sequence,
                },
                fields: {
                    Col1_gpm: osmData.Col1,
                    Col2_gpm: osmData.Col2,
                    Col3_gpm: osmData.Col3,
                    Col4_gpm: osmData.Col4,
                    Conc_gpm: osmData.Conc,
                    temp_f: osmData.Temp,
                    pression: osmData.Pres,
                },
                timestamp: publishDate,
            },
        ];
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> osmose operData " +
                        fonction +
                        " " +
                        sequence +
                        " " +
                        publishDate
                ),
            (e) => console.error(osmData, e)
        );
    } else if (eventName === "Osmose/concData") {
        const osmData = event.object[0];
        const fonction = osmData.fonction;
        const sequence = osmData.sequence;
        var point = [
            {
                measurement: "Osmose",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    fonction: fonction,
                },
                fields: {
                    brix_seve: osmData.BrixSeve,
                    brix_conc: osmData.BrixConc,
                },
                timestamp: publishDate,
            },
        ];
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> osmose concData " +
                        fonction +
                        " " +
                        sequence +
                        " " +
                        publishDate
                ),
            (e) => console.error(osmData, e)
        );
    } else if (eventName === "Osmose/summaryData") {
        const osmData = event.object[0];
        const fonction = osmData.fonction;
        const sequence = osmData.sequence;
        const pc_conc = osmData.PC_Conc;
        const gph_conc = osmData.Conc_GPH;
        const gph_filt = osmData.Filtrat_GPH;
        const gph_tot = osmData.Total_GPH;
        const sumData = pc_conc + gph_conc + gph_filt + gph_tot;
        var point = [
            {
                measurement: "Osmose",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    fonction: fonction,
                    sequence: sequence,
                },
                fields: {
                    pc_conc: pc_conc,
                    gph_conc: gph_conc,
                    gph_filt: gph_filt,
                    gph_tot: gph_tot,
                    duree: osmData.runTimeSec,
                },
                timestamp: publishDate,
            },
        ];
        // Save the data only if its greater than zero
        if (sumData > 0) {
            return influx.writePoints(point).then(
                () =>
                    console.log(
                        "Influx-> osmose summaryData " +
                            fonction +
                            " " +
                            sequence +
                            " " +
                            publishDate
                    ),
                (e) => console.error(osmData, e)
            );
        } else {
            return Promise.resolve();
        }
    } else {
        return Promise.resolve();
    }
}

function startApp(db) {
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
                    "device_id \tdevice_name \tstart_stop_time \tevent_type \tvolume" +
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
    dashboard.onChange(function (data, event, device) {
        return insertInflux(influx, event, device);
        // return insertData(db, event, device);
    });
    server.listen(port);
    console.log("HTTP Server started: http://localhost:" + port);
}

ensureDatabase()
    .then(startApp)
    .catch(function (err) {
        console.error(chalk.red(err));
    });
