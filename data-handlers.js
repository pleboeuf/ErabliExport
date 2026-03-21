"use strict";
const moment = require("moment");
const Promise = require("promise");
const util = require("util");

function liters2gallons(liters) {
    return Math.ceil(liters / 4.54609188);
}

const DATACER_RESERVOIR_MIRROR_TANKS = new Set(["RF2"]);

function getDatacerReservoirMirrorDeviceName(tankName) {
    if (typeof tankName !== "string") {
        return null;
    }
    const normalized = tankName.trim().toUpperCase();
    if (!DATACER_RESERVOIR_MIRROR_TANKS.has(normalized)) {
        return null;
    }
    return `EB-${normalized}`;
}

function shouldScaleVacuumEData(deviceName) {
    const isEbPumpOrVacuumDevice =
        typeof deviceName === "string" && /^EB-[PV]\d+$/i.test(deviceName);
    return isEbPumpOrVacuumDevice;
}

function normalizeForMatching(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();
}

function isDatacerTankAlias(value) {
    const normalized = normalizeForMatching(value);
    return (
        normalized === "reservoirs" ||
        normalized === "reservoir" ||
        normalized === "tank" ||
        normalized === "bassin"
    );
}

function isDatacerTankEventName(eventName) {
    const normalized = normalizeForMatching(eventName);
    if (normalized === "tank/level") {
        return true;
    }
    const [mainTopic] = normalized.split("/");
    return isDatacerTankAlias(mainTopic);
}

function parseNumberOrNull(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function stringifySafely(value) {
    try {
        return JSON.stringify(value);
    } catch (err) {
        return null;
    }
}

function getDatacerTankFillMetrics(data, tankObject) {
    const objectFillValue = parseNumberOrNull(tankObject && tankObject.fill);
    const objectCapacityValue = parseNumberOrNull(
        tankObject && tankObject.capacity,
    );
    const payloadFillValue = parseNumberOrNull(data && data.fill);
    const payloadCapacityValue = parseNumberOrNull(data && data.capacity);
    const fillValue =
        objectFillValue !== null ? objectFillValue : payloadFillValue;
    const capacityValue =
        objectCapacityValue !== null
            ? objectCapacityValue
            : payloadCapacityValue;
    if (fillValue === null) {
        return null;
    }

    return {
        fillGallons: liters2gallons(fillValue),
        fillPercent:
            capacityValue !== null && capacityValue > 0
                ? fillValue / capacityValue
                : 0,
    };
}

/**
 * Insert event data into SQLite database
 * @param {Object} db - SQLite database instance
 * @param {Object} event - Event data
 * @param {Object} device - Device information
 * @param {Object} options - Optional dependencies for testing (dashboard)
 */
function insertData(db, event, device, options = {}) {
    const deviceId = event.coreid;
    const deviceName = device.name;
    var eventName = event.data.eName;
    var publishDate;

    if (!eventName) {
        if (device.eventName) {
            event.data.eName = device.eventName;
            eventName = event.data.eName;
            console.log(
                util.format(
                    "(Dashboard) Overriding event name to %s for device %s",
                    device.eventName,
                    device.id,
                ),
            );
        } else {
            event.data.eName = "Vacuum/Lignes";
            eventName = event.data.eName;
            console.log(
                util.format(
                    "(Dashboard) Overriding event name from DB to 'Vacuum/Lignes' for device %s",
                    device.id,
                ),
            );
        }
    }

    if (event.data.lastUpdatedAt) {
        publishDate = new Date(event.data.lastUpdatedAt).getTime();
    } else if (eventName === "Vacuum/Lignes") {
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

    void options;

    const sql =
        "INSERT INTO raw_events (device_id, device_name, event_name, published_at, temps_mesure, payload_json, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)";
    const params = [
        deviceId,
        deviceName,
        eventName,
        publishDate,
        moment(publishDate).format("YYYY-MM-DD HH:mm:ss"),
        stringifySafely(event.data),
        stringifySafely(event),
    ];
    return runSql(sql, params);
}

/**
 * Insert event data into InfluxDB
 * @param {Object} influx - InfluxDB client instance
 * @param {Object} event - Event data
 * @param {Object} device - Device information
 */
function insertInflux(influx, event, device) {
    const deviceId = event.coreid;
    const deviceName = device.name;
    var eventName = event.data.eName;

    // Calculate publishDate based on event type
    var publishDate;
    if (event.data.lastUpdatedAt) {
        // Datacer events use lastUpdatedAt timestamp
        publishDate = new Date(event.data.lastUpdatedAt).getTime() * 1000000;
    } else if (event.data.timer === undefined) {
        // Legacy events without timer
        publishDate = 1000000000 * event.data.timestamp;
    } else {
        // Legacy events with timer
        publishDate =
            1000000 * (1000 * event.data.timestamp + (event.data.timer % 1000));
    }

    //     // Handle fin de cycle events
    if (eventName === "pump/endCycle") {
        if (event.object) {
            const dutycycle = event.data.eData / 1000;
            const rateOut = event.object.capacity_gph * event.object.duty;
            const ONtime = Math.abs(event.object.ONtime);
            const OFFtime = Math.abs(event.object.OFFtime);
            const volume_gal = (ONtime * event.object.capacity_gph) / 3600;
            const point = [
                {
                    measurement: "Cycles",
                    tags: {
                        deviceId: deviceId,
                        deviceName: deviceName,
                    },
                    fields: {
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
                (e) => console.error(event.object, e),
            );
        } else {
            console.warn(
                util.format(
                    "Got pump/endCycle from device %s, but pump is undefined",
                    event.coreid,
                ),
                event,
            );
            return Promise.resolve();
        }
    } else if (
        eventName === "pump/debutDeCoulee" ||
        eventName === "pump/finDeCoulee"
    ) {
        const volume_gal = event.object.volume;
        const eventType = event.data.eData === 1 ? "start" : "stop";
        // Build fields including water meter volumes
        const fields = {
            etat_num: event.data.eData,
            volume_total: volume_gal,
        };
        if (event.object.waterMeters) {
            event.object.waterMeters.forEach((meter) => {
                const fieldKey = meter.name.replace(/[^a-zA-Z0-9_]/g, "_");
                fields[fieldKey] = parseFloat(meter.volume_since_reset) || 0;
            });
        }
        const point = [
            {
                measurement: "Coulee",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    etat: eventType,
                },
                fields: fields,
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
                        publishDate,
                ),
            (e) => console.error(event.object, e),
        );
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
                            sensorType: "ultrasonic",
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
                                publishDate,
                        ),
                    (e) => console.error(event.object, e),
                );
            }
        } else {
            console.warn(
                util.format(
                    "Got sensor/level from device %s, but tank is undefined",
                    event.coreid,
                ),
                event,
            );
            return Promise.resolve();
        }
    } else if (eventName === "sensor/vacuum") {
        const in_hg = shouldScaleVacuumEData(deviceName)
            ? event.data.eData / 100
            : event.data.eData;
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
                        publishDate,
                ),
            (e) => console.error(event.object, e),
        );
    } else if (eventName === "Vacuum/Lignes") {
        const data = event.data;
        const line_name = data.label;
        const in_hg = data.eData;
        const temp = data.temp;
        const percentCharge = data.percentCharge;
        const ref = data.ref;

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
                    percentCharge: percentCharge,
                    ref: ref,
                },
                timestamp: publishDate,
            },
        ];

        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> Vacuum_ligne " +
                        line_name +
                        " " +
                        in_hg +
                        " inHg " +
                        publishDate,
                ),
            (e) => console.error(event.object, e),
        );
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
                        publishDate,
                ),
            (e) => console.error(event.object, e),
        );
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
                        publishDate,
                ),
            (e) => console.error(osmData, e),
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
                        publishDate,
                ),
            (e) => console.error(osmData, e),
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
        if (alarmNo < 0) {
            return influx.writePoints(point).then(
                () =>
                    console.log(
                        "Influx-> osmose alarm " +
                            fonction +
                            " alarm no:" +
                            alarmNo +
                            " " +
                            publishDate,
                    ),
                (e) => console.error(osmData, e),
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
                        osmData.sequence +
                        " " +
                        publishDate,
                ),
            (e) => console.error(osmData, e),
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
                        publishDate,
                ),
            (e) => console.error(osmData, e),
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
        if (sumData > 0) {
            return influx.writePoints(point).then(
                () =>
                    console.log(
                        "Influx-> osmose summaryData " +
                            fonction +
                            " " +
                            sequence +
                            " " +
                            publishDate,
                    ),
                (e) => console.error(osmData, e),
            );
        } else {
            return Promise.resolve();
        }
        // Handle "Tank/Level" events from Datacer
    } else if (isDatacerTankEventName(eventName)) {
        const data = event.data;
        const tank_name = data.name;
        const raw_value = data.rawValue;
        const tankMetrics = getDatacerTankFillMetrics(data, event.object);
        const fill_gallons = tankMetrics ? tankMetrics.fillGallons : 0;
        const mirroredReservoirDeviceName =
            getDatacerReservoirMirrorDeviceName(tank_name);
        var point = [
            {
                measurement: "Tank_level",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    tank_name: tank_name,
                    sensorType: "pressure",
                },
                fields: {
                    raw_value: raw_value,
                    fill: fill_gallons,
                    fill_gallons: fill_gallons,
                    fill_percent: tankMetrics ? tankMetrics.fillPercent : 0,
                },
                timestamp: publishDate,
            },
        ];
        if (tankMetrics && mirroredReservoirDeviceName) {
            point.push({
                measurement: "Reservoirs",
                tags: {
                    deviceId: mirroredReservoirDeviceName,
                    deviceName: mirroredReservoirDeviceName,
                    sensorType: "pressure",
                },
                fields: {
                    fill_gallons: tankMetrics.fillGallons,
                    fill_percent: tankMetrics.fillPercent,
                },
                timestamp: publishDate,
            });
        }
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> Tank_level " +
                        tank_name +
                        " fill: " +
                        fill_gallons +
                        " gal" +
                        " " +
                        publishDate,
                ),
            (e) => console.error(event.data, e),
        );
        // Handle "Water/Volume" events from Datacer
    } else if (eventName === "Water/Volume") {
        const data = event.data;
        const meter_name = data.name;
        const volume_total = data.volume_total;
        const volume_heure = data.volume_heure;
        const volume_entaille = data.volume_entaille;
        const volume_since_reset = data.volume_since_reset;
        var point = [
            {
                measurement: "Water_volume",
                tags: {
                    deviceId: deviceId,
                    deviceName: deviceName,
                    meter_name: meter_name,
                },
                fields: {
                    volume_total: volume_total,
                    volume_heure: volume_heure,
                    volume_entaille: volume_entaille,
                    volume_since_reset: volume_since_reset,
                },
                timestamp: publishDate,
            },
        ];
        return influx.writePoints(point).then(
            () =>
                console.log(
                    "Influx-> Water_volume " +
                        meter_name +
                        " vol_since_reset: " +
                        volume_since_reset +
                        " " +
                        publishDate,
                ),
            (e) => console.error(event.data, e),
        );
    } else {
        return Promise.resolve();
    }
}

module.exports = {
    insertData,
    insertInflux,
    liters2gallons,
    stringifySafely,
};
