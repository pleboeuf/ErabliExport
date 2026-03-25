"use strict";
const fs = require("fs");
const moment = require("moment");
const Promise = require("promise");
const util = require("util");
const LITERS_PER_GALLON = 4.54609188;
const MM_PER_INCH = 25.4;
const dashboardSnapshotCache = {
    path: null,
    mtimeMs: null,
    data: null,
};

function liters2gallons(liters) {
    return Math.ceil(liters / LITERS_PER_GALLON);
}

function litersToDisplayedDatacerGallons(liters) {
    if (!Number.isFinite(liters)) {
        return null;
    }
    return Number((liters / LITERS_PER_GALLON).toFixed(0));
}

function normalizeTankKey(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim().toUpperCase();
}

const DATACER_RESERVOIR_MIRROR_TANKS = new Set(["RS1"]);

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
function readDashboardDataSnapshot(dashboardDataPath) {
    if (typeof dashboardDataPath !== "string" || dashboardDataPath.length === 0) {
        return null;
    }
    try {
        const stat = fs.statSync(dashboardDataPath);
        if (
            dashboardSnapshotCache.path === dashboardDataPath &&
            dashboardSnapshotCache.mtimeMs === stat.mtimeMs &&
            dashboardSnapshotCache.data
        ) {
            return dashboardSnapshotCache.data;
        }
        const content = fs.readFileSync(dashboardDataPath, "utf8");
        const parsed = JSON.parse(content);
        dashboardSnapshotCache.path = dashboardDataPath;
        dashboardSnapshotCache.mtimeMs = stat.mtimeMs;
        dashboardSnapshotCache.data = parsed;
        return parsed;
    } catch (err) {
        if (
            dashboardSnapshotCache.path === dashboardDataPath &&
            dashboardSnapshotCache.data
        ) {
            return dashboardSnapshotCache.data;
        }
        return null;
    }
}

function isPressureTank(tankDefinition) {
    return normalizeForMatching(tankDefinition && tankDefinition.sensorType) === "pressure";
}

function findPressureTankDefinition(tanks, deviceName, tankName) {
    if (!Array.isArray(tanks)) {
        return null;
    }
    const normalizedTankName = normalizeTankKey(tankName);
    if (!normalizedTankName) {
        return null;
    }
    const normalizedDeviceName = normalizeTankKey(deviceName);
    const codeMatches = tanks.filter(
        (tankDefinition) =>
            isPressureTank(tankDefinition) &&
            normalizeTankKey(tankDefinition.code) === normalizedTankName,
    );
    if (codeMatches.length === 0) {
        return null;
    }
    if (normalizedDeviceName) {
        const exactDeviceMatch = codeMatches.find(
            (tankDefinition) =>
                normalizeTankKey(tankDefinition.device) === normalizedDeviceName,
        );
        if (exactDeviceMatch) {
            return exactDeviceMatch;
        }
    }
    return codeMatches.length === 1 ? codeMatches[0] : null;
}

function getTankRawUnit(tankDefinition) {
    const rawUnit = tankDefinition.rawUnit || tankDefinition.units;
    if (typeof rawUnit !== "string") {
        return "";
    }
    return rawUnit.toLowerCase();
}

function convertRawToMillimeters(rawValue, rawUnit) {
    const numericRawValue = parseNumberOrNull(rawValue);
    if (!Number.isFinite(numericRawValue)) {
        return NaN;
    }
    switch (rawUnit) {
        case "in":
        case "inch":
        case "inches":
        case "po":
        case "pouce":
        case "pouces":
            return numericRawValue * MM_PER_INCH;
        case "mm":
        case "millimeter":
        case "millimeters":
        case "millimetre":
        case "millimetres":
        default:
            return numericRawValue;
    }
}

function getTankLevelMmFromRaw(rawValue, tankDefinition) {
    const sensorType = normalizeForMatching(tankDefinition.sensorType) || "ultrasonic";
    const rawUnit =
        getTankRawUnit(tankDefinition) || (sensorType === "pressure" ? "in" : "mm");
    const scaleFactor = parseNumberOrNull(tankDefinition.scaleFactor);
    let rawValueMm = convertRawToMillimeters(rawValue, rawUnit);

    if (!Number.isFinite(rawValueMm)) {
        return NaN;
    }
    if (Number.isFinite(scaleFactor)) {
        rawValueMm *= scaleFactor;
    }
    if (sensorType === "pressure") {
        const offsetMm = parseNumberOrNull(tankDefinition.offset);
        const calibratedLevelMm =
            rawValueMm - (Number.isFinite(offsetMm) ? offsetMm : 0);
        return Math.max(0, calibratedLevelMm);
    }

    const sensorHeightMm = parseNumberOrNull(tankDefinition.sensorHeight);
    if (!Number.isFinite(sensorHeightMm)) {
        return Math.max(0, rawValueMm);
    }
    return Math.max(0, sensorHeightMm - rawValueMm);
}

function getHorizontalCylinderFillLiters(levelMm, diameterMm, lengthMm) {
    if (
        !Number.isFinite(levelMm) ||
        !Number.isFinite(diameterMm) ||
        !Number.isFinite(lengthMm) ||
        diameterMm <= 0 ||
        lengthMm <= 0
    ) {
        return NaN;
    }
    const level = Math.max(0, Math.min(levelMm, diameterMm));
    const h = level / 1000;
    const d = diameterMm / 1000;
    const r = d / 2;
    return (
        (Math.pow(r, 2) * Math.acos((r - h) / r) -
            (r - h) * Math.sqrt(d * h - Math.pow(h, 2))) *
        lengthMm
    );
}

function getUShapedTankFillLiters(levelMm, diameterMm, lengthMm) {
    if (
        !Number.isFinite(levelMm) ||
        !Number.isFinite(diameterMm) ||
        !Number.isFinite(lengthMm)
    ) {
        return NaN;
    }
    const level = Math.max(0, levelMm);
    const bottomLevel = Math.min(level, diameterMm / 2);
    const bottomFill = getHorizontalCylinderFillLiters(
        bottomLevel,
        diameterMm,
        lengthMm,
    );
    const topFill =
        (((diameterMm / 1000) * lengthMm) / 1000) *
        Math.max(0, level - diameterMm / 2);
    return bottomFill + topFill;
}

function calculateTankFillLitersFromRaw(rawValue, tankDefinition) {
    const levelMm = getTankLevelMmFromRaw(rawValue, tankDefinition);
    if (!Number.isFinite(levelMm)) {
        return NaN;
    }
    const diameterMm = parseNumberOrNull(tankDefinition.diameter);
    const lengthMm = parseNumberOrNull(tankDefinition.length);
    if (
        tankDefinition.shape === "cylinder" &&
        tankDefinition.orientation === "horizontal"
    ) {
        return getHorizontalCylinderFillLiters(levelMm, diameterMm, lengthMm);
    }
    if (tankDefinition.shape === "u") {
        return getUShapedTankFillLiters(levelMm, diameterMm, lengthMm);
    }
    return NaN;
}

function calculateTankCapacityLiters(tankDefinition) {
    const diameterMm = parseNumberOrNull(tankDefinition.diameter);
    const lengthMm = parseNumberOrNull(tankDefinition.length);

    if (
        tankDefinition.shape === "cylinder" &&
        tankDefinition.orientation === "horizontal"
    ) {
        if (!Number.isFinite(diameterMm) || !Number.isFinite(lengthMm)) {
            return null;
        }
        return Math.PI * Math.pow(diameterMm / 2000, 2) * lengthMm;
    }
    if (tankDefinition.shape === "u") {
        const totalHeightMm = parseNumberOrNull(tankDefinition.totalHeight);
        const capacity = getUShapedTankFillLiters(
            totalHeightMm,
            diameterMm,
            lengthMm,
        );
        return Number.isFinite(capacity) ? capacity : null;
    }
    return null;
}

function buildDatacerTankFillMetrics(fillLiters, capacityLiters, source) {
    const fillGallons = litersToDisplayedDatacerGallons(fillLiters);
    if (!Number.isFinite(fillGallons)) {
        return null;
    }
    return {
        source: source,
        fillLiters: fillLiters,
        fillGallons: fillGallons,
        fillPercent:
            Number.isFinite(capacityLiters) && capacityLiters > 0
                ? fillLiters / capacityLiters
                : 0,
    };
}

function getDatacerTankFillMetricsFromDashboardData(data, options) {
    const dashboardData = readDashboardDataSnapshot(options.dashboardDataPath);
    if (!dashboardData) {
        return null;
    }
    const tankDefinition = findPressureTankDefinition(
        dashboardData.tanks,
        options.deviceName,
        data && data.name,
    );
    if (!tankDefinition) {
        return null;
    }
    const snapshotRawValue = parseNumberOrNull(tankDefinition.rawValue);
    if (!Number.isFinite(snapshotRawValue)) {
        return null;
    }
    const eventRawValue = parseNumberOrNull(
        data &&
            (typeof data.rawValue !== "undefined"
                ? data.rawValue
                : data.ReadingValue),
    );
    if (
        Number.isFinite(eventRawValue) &&
        Math.abs(snapshotRawValue - eventRawValue) > 0.001
    ) {
        return null;
    }
    const fillLiters = parseNumberOrNull(tankDefinition.fill);
    const capacityLiters = parseNumberOrNull(tankDefinition.capacity);
    if (!Number.isFinite(fillLiters)) {
        return null;
    }
    if (
        Number.isFinite(capacityLiters) &&
        capacityLiters > 0 &&
        (fillLiters < 0 || fillLiters > capacityLiters * 1.1)
    ) {
        return null;
    }
    return buildDatacerTankFillMetrics(
        fillLiters,
        capacityLiters,
        "dashboard_data_json",
    );
}

function getDatacerTankFillMetricsFromRawAndConfig(data, options) {
    const rawValue = parseNumberOrNull(data && data.rawValue);
    if (!Number.isFinite(rawValue)) {
        return null;
    }
    const tankDefinition = findPressureTankDefinition(
        options.tankConfigs,
        options.deviceName,
        data && data.name,
    );
    if (!tankDefinition) {
        return null;
    }
    const fillLiters = calculateTankFillLitersFromRaw(rawValue, tankDefinition);
    const capacityLiters = calculateTankCapacityLiters(tankDefinition);
    if (!Number.isFinite(fillLiters)) {
        return null;
    }
    return buildDatacerTankFillMetrics(fillLiters, capacityLiters, "raw+config");
}

function getDatacerTankFillMetricsFromEventFallback(data, tankObject) {
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
    const source =
        objectFillValue !== null ? "event_object_fallback" : "event_payload_fallback";
    return buildDatacerTankFillMetrics(fillValue, capacityValue, source);
}

function getDatacerTankFillMetrics(data, tankObject, options = {}) {
    return (
        getDatacerTankFillMetricsFromDashboardData(data, options) ||
        getDatacerTankFillMetricsFromRawAndConfig(data, options) ||
        getDatacerTankFillMetricsFromEventFallback(data, tankObject)
    );
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
function insertInflux(influx, event, device, options = {}) {
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
        const tankMetrics = getDatacerTankFillMetrics(data, event.object, {
            deviceName: deviceName,
            tankConfigs: options.tankConfigs,
            dashboardDataPath: options.dashboardDataPath,
        });
        if (!tankMetrics) {
            console.warn(
                "Skipping Tank_level write for '%s' on '%s': unable to resolve calibrated fill",
                tank_name,
                deviceName,
            );
            return Promise.resolve();
        }
        const fill_gallons = tankMetrics.fillGallons;
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
                    fill_percent: tankMetrics.fillPercent,
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
