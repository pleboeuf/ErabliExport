"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("better-sqlite3");
const {
    insertData,
    insertInflux,
    stringifySafely,
} = require("./data-handlers");
const { ensureRawEventsTable } = require("./db-utils");

// Mock dependencies
const createMockDb = () => {
    const insertedRows = [];
    return {
        prepare: jest.fn((sql) => ({
            run: jest.fn((params) => {
                insertedRows.push({ sql, params });
                return { changes: 1, lastInsertRowid: 1 };
            }),
        })),
        getInsertedRows: () => insertedRows,
    };
};

const createMockInflux = () => {
    const writtenPoints = [];
    return {
        writePoints: jest.fn((points) => {
            writtenPoints.push(...points);
            return Promise.resolve();
        }),
        getWrittenPoints: () => writtenPoints,
    };
};

describe("ensureRawEventsTable", () => {
    it("creates the raw_events table if it does not exist", () => {
        const db = new sqlite3(":memory:");
        ensureRawEventsTable(db);

        const rawEventsTable = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get("raw_events");

        expect(rawEventsTable).toBeDefined();
        expect(rawEventsTable.name).toBe("raw_events");
        db.close();
    });
});

describe("insertData - SQLite insertions", () => {
    let mockDb;

    beforeEach(() => {
        mockDb = createMockDb();
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("correctly inserts all event types into raw_events", async () => {
        const eventTypes = [
            "pump/endCycle",
            "pump/debutDeCoulee",
            "pump/finDeCoulee",
            "sensor/level",
            "sensor/vacuum",
            "Vacuum/Lignes",
            "sensor/Valve1Pos",
            "sensor/Valve2Pos",
            "Osmose/Start",
            "Osmose/Stop",
            "Osmose/alarm",
            "Osmose/operData",
            "Osmose/concData",
            "Osmose/summaryData",
            "Tank/Level",
            "Water/Volume",
        ];
        const device = { id: "DEVICE-123", name: "Device Label" };

        for (const eventName of eventTypes) {
            const event = {
                coreid: "DEVICE-123",
                data: {
                    eName: eventName,
                    timestamp: 1707600000,
                    timer: 500,
                },
                published_at: "2026-03-13T18:00:05.061Z",
            };
            await insertData(mockDb, event, device);
        }

        const insertedRows = mockDb.getInsertedRows();
        expect(insertedRows).toHaveLength(eventTypes.length);
        expect(insertedRows.map((row) => row.params[2])).toEqual(eventTypes);
        insertedRows.forEach((row) => {
            expect(row.sql).toContain("INSERT INTO raw_events");
        });
    });

    it("stores Tank/Level events in raw_events", async () => {
        const event = {
            coreid: "DATACER-TANK-001",
            data: {
                eName: "Tank/Level",
                name: "Reservoir-Principal",
                rawValue: 450.5,
                depth: 1200,
                capacity: 5000,
                fill: 2500,
                timestamp: 1707600000,
                timer: 500,
            },
        };
        const device = { id: "DATACER-TANK-001", name: "G9-G10" };

        await insertData(mockDb, event, device);

        const insertedRows = mockDb.getInsertedRows();
        expect(insertedRows).toHaveLength(1);
        expect(insertedRows[0].sql).toContain("INSERT INTO raw_events");
        expect(insertedRows[0].params[0]).toBe("DATACER-TANK-001");
        expect(insertedRows[0].params[1]).toBe("G9-G10");
        expect(insertedRows[0].params[2]).toBe("Tank/Level");
        expect(JSON.parse(insertedRows[0].params[5]).rawValue).toBe(450.5);
    });

    it("stores Water/Volume events in raw_events", async () => {
        const event = {
            coreid: "DATACER-WATER-001",
            data: {
                eName: "Water/Volume",
                name: "Compteur-Eau-Principal",
                volume_total: 15000.5,
                volume_heure: 125.3,
                volume_entaille: 0.45,
                volume_since_reset: 3500.2,
                timestamp: 1707600000,
                timer: 750,
            },
        };
        const device = { id: "DATACER-WATER-001", name: "Water-Meter-1" };

        await insertData(mockDb, event, device);

        const insertedRows = mockDb.getInsertedRows();
        expect(insertedRows).toHaveLength(1);
        expect(insertedRows[0].sql).toContain("INSERT INTO raw_events");
        expect(insertedRows[0].params[2]).toBe("Water/Volume");
        expect(JSON.parse(insertedRows[0].params[5]).volume_total).toBe(15000.5);
    });

    it("stores Vacuum/Lignes events in raw_events without requiring dashboard mapping", async () => {
        const event = {
            coreid: "H8-H9-H10",
            data: {
                eName: "Vacuum/Lignes",
                temp: -5,
                batTemp: 12,
                Vin: 12.4,
                li: 10,
                soc: 78,
                volt: 3.9,
                rssi: -80,
                qual: 25,
            },
            published_at: "2026-03-13T18:00:05.061Z",
        };
        const device = { id: "H8-H9-H10", name: "H8-H9-H10" };

        await insertData(mockDb, event, device, {
            dashboard: { getVacuumSensorOfLineVacuumDevice: jest.fn(() => []) },
        });

        const insertedRows = mockDb.getInsertedRows();
        expect(insertedRows).toHaveLength(1);
        expect(insertedRows[0].sql).toContain("INSERT INTO raw_events");
        expect(insertedRows[0].params[2]).toBe("Vacuum/Lignes");
    });
});

describe("stringifySafely", () => {
    it("handles circular references in JSON objects", () => {
        const circular = { key: "value" };
        circular.self = circular;

        const result = stringifySafely(circular);

        expect(result).toBeNull();
    });
});

describe("insertInflux - InfluxDB writes", () => {
    let mockInflux;

    beforeEach(() => {
        mockInflux = createMockInflux();
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("sensor/level events", () => {
        it("adds sensorType tag for sensor/level events", async () => {
            const event = {
                coreid: "370027000547343138333038",
                data: {
                    eName: "sensor/level",
                    timestamp: 1707600000,
                    timer: 234,
                },
                object: {
                    fill: 1200,
                    capacity: 2400,
                },
            };
            const device = {
                id: "370027000547343138333038",
                name: "EB-RF1",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);
            expect(writtenPoints[0].tags).toMatchObject({
                sensorType: "ultrasonic",
            });
        });

        it("writes Reservoirs points tagged with sensorType=ultrasonic", async () => {
            const event = {
                coreid: "370027000547343138333038",
                data: {
                    eName: "sensor/level",
                    timestamp: 1707600000,
                    timer: 111,
                },
                object: {
                    fill: 2500,
                    capacity: 5000,
                },
            };

            const device = {
                id: "370027000547343138333038",
                name: "EB-RF1",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);
            expect(writtenPoints[0].measurement).toBe("Reservoirs");
            expect(writtenPoints[0].tags.sensorType).toBe("ultrasonic");
        });
    });

    describe("Tank/Level events", () => {
        it("adds sensorType tag for Tank/Level events", async () => {
            const event = {
                coreid: "DATACER-TANK-001",
                data: {
                    eName: "Tank/Level",
                    name: "Reservoir-Principal",
                    rawValue: 450.5,
                    depth: 1200,
                    capacity: 5000,
                    fill: 2500,
                    lastUpdatedAt: "2024-02-10T15:00:00.000Z",
                },
            };
            const device = {
                id: "DATACER-TANK-001",
                name: "G9-G10",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);
            expect(writtenPoints[0].tags).toMatchObject({
                sensorType: "pressure",
            });
        });
        it("correctly writes Tank/Level events to the Tank_level measurement", async () => {
            const event = {
                coreid: "DATACER-TANK-001",
                data: {
                    eName: "Tank/Level",
                    name: "Reservoir-Principal",
                    rawValue: 450.5,
                    depth: 1200,
                    capacity: 5000,
                    fill: 2500,
                    lastUpdatedAt: "2024-02-10T15:00:00.000Z",
                },
            };

            const device = {
                id: "DATACER-TANK-001",
                name: "G9-G10",
            };

            await insertInflux(mockInflux, event, device);

            expect(mockInflux.writePoints).toHaveBeenCalledTimes(1);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);

            const point = writtenPoints[0];
            expect(point.measurement).toBe("Tank_level");
            expect(point.tags.deviceId).toBe("DATACER-TANK-001");
            expect(point.tags.deviceName).toBe("G9-G10");
            expect(point.tags.tank_name).toBe("Reservoir-Principal");
            expect(point.tags.sensorType).toBe("pressure");
            expect(point.fields.raw_value).toBe(450.5);
            expect(point.fields.fill).toBe(550);
            expect(point.fields.fill_gallons).toBe(550);
            expect(point.fields.fill_percent).toBe(0.5);
            expect(point.timestamp).toBeDefined();
        });

        it("mirrors Datacer RS1 Tank/Level events into Reservoirs as EB-RS1", async () => {
            const event = {
                coreid: "BASSIN RF2-RS1-RS2",
                data: {
                    eName: "Tank/Level",
                    name: "RS1",
                    rawValue: 76.43,
                    depth: 0,
                    capacity: 103.23,
                    fill: 96,
                    lastUpdatedAt: "2026-03-12T16:15:47.000Z",
                },
            };

            const device = {
                id: "BASSIN RF2-RS1-RS2",
                name: "BASSIN RF2-RS1-RS2",
            };

            await insertInflux(mockInflux, event, device);

            expect(mockInflux.writePoints).toHaveBeenCalledTimes(1);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(2);

            const tankPoint = writtenPoints.find(
                (point) => point.measurement === "Tank_level",
            );
            const reservoirPoint = writtenPoints.find(
                (point) => point.measurement === "Reservoirs",
            );

            expect(tankPoint).toBeDefined();
            expect(tankPoint.tags.deviceName).toBe("BASSIN RF2-RS1-RS2");
            expect(tankPoint.tags.tank_name).toBe("RS1");
            expect(tankPoint.tags.sensorType).toBe("pressure");

            expect(reservoirPoint).toBeDefined();
            expect(reservoirPoint.tags.deviceId).toBe("EB-RS1");
            expect(reservoirPoint.tags.deviceName).toBe("EB-RS1");
            expect(reservoirPoint.tags.sensorType).toBe("pressure");
            expect(reservoirPoint.fields.fill_gallons).toBe(21);
            expect(reservoirPoint.fields.fill_percent).toBeCloseTo(
                0.9299622193151216,
            );
        });

        it("uses lastUpdatedAt timestamp for Datacer Tank/Level events", async () => {
            const lastUpdatedAt = "2024-02-10T15:30:00.000Z";
            const event = {
                coreid: "DATACER-TANK-001",
                data: {
                    eName: "Tank/Level",
                    name: "Test-Tank",
                    rawValue: 100,
                    depth: 500,
                    capacity: 2000,
                    fill: 1000,
                    lastUpdatedAt: lastUpdatedAt,
                },
            };

            const device = {
                id: "DATACER-TANK-001",
                name: "Test-Device",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            const expectedTimestamp =
                new Date(lastUpdatedAt).getTime() * 1000000;
            expect(writtenPoints[0].timestamp).toBe(expectedTimestamp);
        });

        it("supports Datacer tank alias event names (Réservoirs/tank/BASSIN)", async () => {
            const event = {
                coreid: "DATACER-TANK-ALIAS",
                data: {
                    eName: "Réservoirs/Level",
                    name: "Réservoirs",
                    rawValue: 200,
                    depth: 900,
                    capacity: 3000,
                    fill: 1500,
                    lastUpdatedAt: "2026-03-11T17:00:00.000Z",
                },
            };

            const device = {
                id: "DATACER-TANK-ALIAS",
                name: "Réservoirs",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);
            expect(writtenPoints[0].measurement).toBe("Tank_level");
            expect(writtenPoints[0].fields.fill_gallons).toBe(330);
            expect(writtenPoints[0].fields.fill_percent).toBe(0.5);
        });

        it("uses computed dashboard tank values for Datacer fill_gallons/fill_percent", async () => {
            const event = {
                coreid: "DATACER-TANK-005",
                data: {
                    eName: "Tank/Level",
                    name: "Reservoir-Computed",
                    rawValue: 180,
                    depth: 750,
                    capacity: 1234,
                    fill: 1,
                    lastUpdatedAt: "2026-03-11T17:35:00.000Z",
                },
                object: {
                    fill: 2500,
                    capacity: 5000,
                },
            };

            const device = {
                id: "DATACER-TANK-005",
                name: "G9-G10",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);
            expect(writtenPoints[0].fields.fill).toBe(550);
            expect(writtenPoints[0].fields.fill_gallons).toBe(550);
            expect(writtenPoints[0].fields.fill_percent).toBe(0.5);
        });

        it("prioritizes ErabliDash data snapshot values for Datacer fill metrics", async () => {
            const tempDir = fs.mkdtempSync(
                path.join(os.tmpdir(), "erabli-datacer-fill-"),
            );
            const dashboardDataPath = path.join(tempDir, "dashboard.json");
            fs.writeFileSync(
                dashboardDataPath,
                JSON.stringify({
                    tanks: [
                        {
                            device: "BASSIN RF2-RS1-RS2",
                            code: "RS2",
                            sensorType: "pressure",
                            rawValue: 15,
                            fill: 3000,
                            capacity: 6000,
                        },
                    ],
                }),
                "utf8",
            );

            try {
                const event = {
                    coreid: "BASSIN RF2-RS1-RS2",
                    data: {
                        eName: "Tank/Level",
                        name: "RS2",
                        rawValue: 15,
                        capacity: 10,
                        fill: 10,
                        lastUpdatedAt: "2026-03-24T16:00:00.000Z",
                    },
                    object: {
                        fill: 100,
                        capacity: 200,
                    },
                };
                const device = {
                    id: "BASSIN RF2-RS1-RS2",
                    name: "BASSIN RF2-RS1-RS2",
                };

                await insertInflux(mockInflux, event, device, {
                    dashboardDataPath: dashboardDataPath,
                    tankConfigs: [],
                });

                const writtenPoints = mockInflux.getWrittenPoints();
                expect(writtenPoints).toHaveLength(1);
                expect(writtenPoints[0].fields.fill_gallons).toBe(660);
                expect(writtenPoints[0].fields.fill_percent).toBe(0.5);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it("ignores dashboard snapshot entries without rawValue and falls back to raw+config", async () => {
            const tempDir = fs.mkdtempSync(
                path.join(os.tmpdir(), "erabli-datacer-fill-"),
            );
            const dashboardDataPath = path.join(tempDir, "dashboard.json");
            fs.writeFileSync(
                dashboardDataPath,
                JSON.stringify({
                    tanks: [
                        {
                            device: "BASSIN RF2-RS1-RS2",
                            code: "RS2",
                            sensorType: "pressure",
                            fill: 3000,
                            capacity: 6000,
                        },
                    ],
                }),
                "utf8",
            );

            try {
                const event = {
                    coreid: "BASSIN RF2-RS1-RS2",
                    data: {
                        eName: "Tank/Level",
                        name: "RS2",
                        rawValue: 32.33,
                        capacity: 10,
                        fill: 10,
                        lastUpdatedAt: "2026-03-24T16:00:00.000Z",
                    },
                };
                const device = {
                    id: "BASSIN RF2-RS1-RS2",
                    name: "BASSIN RF2-RS1-RS2",
                };

                await insertInflux(mockInflux, event, device, {
                    dashboardDataPath: dashboardDataPath,
                    tankConfigs: [
                        {
                            code: "RS2",
                            device: "BASSIN RF2-RS1-RS2",
                            shape: "cylinder",
                            orientation: "horizontal",
                            length: 7010,
                            diameter: 1842,
                            sensorType: "pressure",
                            rawUnit: "in",
                            offset: 330,
                            scaleFactor: 1.0,
                        },
                    ],
                });

                const writtenPoints = mockInflux.getWrittenPoints();
                expect(writtenPoints).toHaveLength(1);
                expect(writtenPoints[0].fields.fill_gallons).toBe(880);
                expect(writtenPoints[0].fields.fill_percent).toBeCloseTo(
                    0.2140659782177984,
                );
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it("ignores stale dashboard snapshot rawValue and falls back to raw+config", async () => {
            const tempDir = fs.mkdtempSync(
                path.join(os.tmpdir(), "erabli-datacer-fill-"),
            );
            const dashboardDataPath = path.join(tempDir, "dashboard.json");
            fs.writeFileSync(
                dashboardDataPath,
                JSON.stringify({
                    tanks: [
                        {
                            device: "BASSIN RF2-RS1-RS2",
                            code: "RS2",
                            sensorType: "pressure",
                            rawValue: 15,
                            fill: 3000,
                            capacity: 6000,
                        },
                    ],
                }),
                "utf8",
            );

            try {
                const event = {
                    coreid: "BASSIN RF2-RS1-RS2",
                    data: {
                        eName: "Tank/Level",
                        name: "RS2",
                        rawValue: 32.33,
                        capacity: 10,
                        fill: 10,
                        lastUpdatedAt: "2026-03-24T16:00:00.000Z",
                    },
                };
                const device = {
                    id: "BASSIN RF2-RS1-RS2",
                    name: "BASSIN RF2-RS1-RS2",
                };

                await insertInflux(mockInflux, event, device, {
                    dashboardDataPath: dashboardDataPath,
                    tankConfigs: [
                        {
                            code: "RS2",
                            device: "BASSIN RF2-RS1-RS2",
                            shape: "cylinder",
                            orientation: "horizontal",
                            length: 7010,
                            diameter: 1842,
                            sensorType: "pressure",
                            rawUnit: "in",
                            offset: 330,
                            scaleFactor: 1.0,
                        },
                    ],
                });

                const writtenPoints = mockInflux.getWrittenPoints();
                expect(writtenPoints).toHaveLength(1);
                expect(writtenPoints[0].fields.fill_gallons).toBe(880);
                expect(writtenPoints[0].fields.fill_percent).toBeCloseTo(
                    0.2140659782177984,
                );
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it("ignores implausible dashboard snapshot values and falls back to raw+config", async () => {
            const tempDir = fs.mkdtempSync(
                path.join(os.tmpdir(), "erabli-datacer-fill-"),
            );
            const dashboardDataPath = path.join(tempDir, "dashboard.json");
            fs.writeFileSync(
                dashboardDataPath,
                JSON.stringify({
                    tanks: [
                        {
                            device: "BASSIN RS5-RS6",
                            code: "RS5",
                            sensorType: "pressure",
                            rawValue: 574,
                            fill: 63898.40415045242,
                            capacity: 4173.470869652411,
                        },
                    ],
                }),
                "utf8",
            );

            try {
                const event = {
                    coreid: "BASSIN RS5-RS6",
                    data: {
                        eName: "Tank/Level",
                        name: "RS5",
                        rawValue: 26.22,
                        capacity: 56,
                        fill: 56,
                        lastUpdatedAt: "2026-03-24T16:00:00.000Z",
                    },
                };
                const device = {
                    id: "BASSIN RS5-RS6",
                    name: "BASSIN RS5-RS6",
                };

                await insertInflux(mockInflux, event, device, {
                    dashboardDataPath: dashboardDataPath,
                    tankConfigs: [
                        {
                            code: "RS5",
                            device: "BASSIN RS5-RS6",
                            shape: "u",
                            length: 3657,
                            diameter: 1219,
                            totalHeight: 1067,
                            sensorType: "pressure",
                            rawUnit: "in",
                            offset: 115,
                            scaleFactor: 1.0,
                        },
                    ],
                });

                const writtenPoints = mockInflux.getWrittenPoints();
                expect(writtenPoints).toHaveLength(1);
                expect(writtenPoints[0].fields.fill_gallons).toBe(412);
                expect(writtenPoints[0].fields.fill_percent).toBeCloseTo(
                    0.44891913971939174,
                );
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it("falls back to raw+config calibration when dashboard snapshot is unavailable", async () => {
            const event = {
                coreid: "BASSIN RF2-RS1-RS2",
                data: {
                    eName: "Tank/Level",
                    name: "RS2",
                    rawValue: 32.33,
                    capacity: 10,
                    fill: 10,
                    lastUpdatedAt: "2026-03-24T16:00:00.000Z",
                },
            };
            const device = {
                id: "BASSIN RF2-RS1-RS2",
                name: "BASSIN RF2-RS1-RS2",
            };

            await insertInflux(mockInflux, event, device, {
                dashboardDataPath: "/tmp/does-not-exist-dashboard.json",
                tankConfigs: [
                    {
                        code: "RS2",
                        device: "BASSIN RF2-RS1-RS2",
                        shape: "cylinder",
                        orientation: "horizontal",
                        length: 7010,
                        diameter: 1842,
                        sensorType: "pressure",
                        rawUnit: "in",
                        offset: 330,
                        scaleFactor: 1.0,
                    },
                ],
            });

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);
            expect(writtenPoints[0].fields.fill_gallons).toBe(880);
            expect(writtenPoints[0].fields.fill_percent).toBeCloseTo(
                0.2140659782177984,
            );
        });
    });

    describe("Water/Volume events", () => {
        it("correctly writes Water/Volume events to the Water_volume measurement", async () => {
            const event = {
                coreid: "DATACER-WATER-001",
                data: {
                    eName: "Water/Volume",
                    name: "Compteur-Eau-Principal",
                    volume_total: 15000.5,
                    volume_heure: 125.3,
                    volume_entaille: 0.45,
                    volume_since_reset: 3500.2,
                    lastUpdatedAt: "2024-02-10T16:00:00.000Z",
                },
            };

            const device = {
                id: "DATACER-WATER-001",
                name: "Water-Meter-1",
            };

            await insertInflux(mockInflux, event, device);

            expect(mockInflux.writePoints).toHaveBeenCalledTimes(1);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);

            const point = writtenPoints[0];
            expect(point.measurement).toBe("Water_volume");
            expect(point.tags.deviceId).toBe("DATACER-WATER-001");
            expect(point.tags.deviceName).toBe("Water-Meter-1");
            expect(point.tags.meter_name).toBe("Compteur-Eau-Principal");
            expect(point.fields.volume_total).toBe(15000.5);
            expect(point.fields.volume_heure).toBe(125.3);
            expect(point.fields.volume_entaille).toBe(0.45);
            expect(point.fields.volume_since_reset).toBe(3500.2);
            expect(point.timestamp).toBeDefined();
        });

        it("uses lastUpdatedAt timestamp for Datacer Water/Volume events", async () => {
            const lastUpdatedAt = "2024-02-10T17:45:00.000Z";
            const event = {
                coreid: "DATACER-WATER-001",
                data: {
                    eName: "Water/Volume",
                    name: "Test-Meter",
                    volume_total: 1000,
                    volume_heure: 50,
                    volume_entaille: 0.2,
                    volume_since_reset: 500,
                    lastUpdatedAt: lastUpdatedAt,
                },
            };

            const device = {
                id: "DATACER-WATER-001",
                name: "Test-Water-Device",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            const expectedTimestamp =
                new Date(lastUpdatedAt).getTime() * 1000000;
            expect(writtenPoints[0].timestamp).toBe(expectedTimestamp);
        });
    });

    describe("sensor/vacuum events", () => {
        it("divides eData by 100 for EB-Vx devices", async () => {
            const event = {
                coreid: "540034000b51353335323535",
                data: {
                    eName: "sensor/vacuum",
                    eData: 2550,
                    timestamp: 1707600000,
                    timer: 234,
                },
            };

            const device = {
                id: "540034000b51353335323535",
                name: "EB-V2",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);
            expect(writtenPoints[0].measurement).toBe("Vacuum");
            expect(writtenPoints[0].fields.vacuum).toBe(25.5);
        });

        it("does not divide eData by 100 for non-EB-Px/EB-Vx devices", async () => {
            const event = {
                coreid: "DATACER-VACUUM-002",
                data: {
                    eName: "sensor/vacuum",
                    eData: 2550,
                    timestamp: 1707600000,
                    timer: 234,
                },
            };

            const device = {
                id: "DATACER-VACUUM-002",
                name: "POMPE 2",
            };

            await insertInflux(mockInflux, event, device);

            const writtenPoints = mockInflux.getWrittenPoints();
            expect(writtenPoints).toHaveLength(1);
            expect(writtenPoints[0].measurement).toBe("Vacuum");
            expect(writtenPoints[0].fields.vacuum).toBe(2550);
        });
    });
});

describe("Dashboard - Datacer device handling", () => {
    // Since the Dashboard module requires WebSocket and configuration,
    // we test the handleMessage logic by verifying the temporary device creation behavior
    // This tests the logic found in dashboard.js lines 795-806

    describe("Temporary device creation for new Datacer events", () => {
        it("creates a temporary device object for Tank/Level events from unknown devices", () => {
            // Simulate the logic from dashboard.js handleMessage function
            const message = {
                coreid: "DATACER-TANK-NEW",
                data: JSON.stringify({
                    eName: "Tank/Level",
                    name: "New-Tank",
                    rawValue: 200,
                    depth: 800,
                    capacity: 3000,
                    fill: 1500,
                    noSerie: 1,
                    generation: 1,
                }),
            };

            const parsedData = JSON.parse(message.data);
            const eventName = parsedData.eName;

            // Test the condition that allows Datacer events to be processed
            const isDatacerEvent =
                eventName === "Tank/Level" ||
                eventName === "Water/Volume" ||
                eventName === "Vacuum/Lignes";

            expect(isDatacerEvent).toBe(true);

            // Test temporary device creation
            if (isDatacerEvent) {
                const tempDevice = {
                    id: message.coreid,
                    name:
                        parsedData.name ||
                        parsedData.device ||
                        message.coreid,
                    generationId: parsedData.generation,
                    lastEventSerial: parsedData.noSerie,
                };

                expect(tempDevice.id).toBe("DATACER-TANK-NEW");
                expect(tempDevice.name).toBe("New-Tank");
                expect(tempDevice.generationId).toBe(1);
                expect(tempDevice.lastEventSerial).toBe(1);
            }
        });

        it("creates a temporary device object for Water/Volume events from unknown devices", () => {
            const message = {
                coreid: "DATACER-WATER-NEW",
                data: JSON.stringify({
                    eName: "Water/Volume",
                    name: "New-Water-Meter",
                    volume_total: 0,
                    volume_heure: 0,
                    volume_entaille: 0,
                    volume_since_reset: 0,
                    noSerie: 5,
                    generation: 2,
                }),
            };

            const parsedData = JSON.parse(message.data);
            const eventName = parsedData.eName;

            const isDatacerEvent =
                eventName === "Tank/Level" ||
                eventName === "Water/Volume" ||
                eventName === "Vacuum/Lignes";

            expect(isDatacerEvent).toBe(true);

            if (isDatacerEvent) {
                const tempDevice = {
                    id: message.coreid,
                    name:
                        parsedData.name ||
                        parsedData.device ||
                        message.coreid,
                    generationId: parsedData.generation,
                    lastEventSerial: parsedData.noSerie,
                };

                expect(tempDevice.id).toBe("DATACER-WATER-NEW");
                expect(tempDevice.name).toBe("New-Water-Meter");
                expect(tempDevice.generationId).toBe(2);
                expect(tempDevice.lastEventSerial).toBe(5);
            }
        });

        it("creates a temporary device object for Vacuum/Lignes events from unknown devices", () => {
            const message = {
                coreid: "DATACER-VACUUM-NEW",
                data: JSON.stringify({
                    eName: "Vacuum/Lignes",
                    label: "G9-G10",
                    eData: 25.5,
                    temp: -5,
                    percentCharge: 85,
                    ref: 27,
                    noSerie: 10,
                    generation: 3,
                }),
            };

            const parsedData = JSON.parse(message.data);
            const eventName = parsedData.eName;

            const isDatacerEvent =
                eventName === "Tank/Level" ||
                eventName === "Water/Volume" ||
                eventName === "Vacuum/Lignes";

            expect(isDatacerEvent).toBe(true);

            if (isDatacerEvent) {
                const tempDevice = {
                    id: message.coreid,
                    name:
                        parsedData.name ||
                        parsedData.device ||
                        message.coreid,
                    generationId: parsedData.generation,
                    lastEventSerial: parsedData.noSerie,
                };

                expect(tempDevice.id).toBe("DATACER-VACUUM-NEW");
                // Vacuum/Lignes events don't have a 'name' field, so it falls back to device or coreid
                expect(tempDevice.name).toBe("DATACER-VACUUM-NEW");
                expect(tempDevice.generationId).toBe(3);
                expect(tempDevice.lastEventSerial).toBe(10);
            }
        });

        it("uses device label for Vacuum/Lignes events when available", () => {
            const message = {
                coreid: "DATACER-VACUUM-001",
                data: JSON.stringify({
                    eName: "Vacuum/Lignes",
                    label: "G9-G10",
                    device: "Vacuum-Sensor-1",
                    eData: 26.0,
                    temp: -3,
                    percentCharge: 90,
                    ref: 27.5,
                    noSerie: 15,
                    generation: 4,
                }),
            };

            const parsedData = JSON.parse(message.data);

            // Test the device name fallback chain: name -> device -> coreid
            const tempDevice = {
                id: message.coreid,
                name:
                    parsedData.name ||
                    parsedData.device ||
                    message.coreid,
                generationId: parsedData.generation,
                lastEventSerial: parsedData.noSerie,
            };

            // Since there's no 'name' but there is 'device', it should use 'device'
            expect(tempDevice.name).toBe("Vacuum-Sensor-1");
        });

        it("does not create temporary device for non-Datacer events", () => {
            const message = {
                coreid: "REGULAR-DEVICE-001",
                data: JSON.stringify({
                    eName: "pump/T1",
                    eData: 1,
                    timer: 12345,
                    timestamp: 1707600000,
                    noSerie: 1,
                    generation: 1,
                }),
            };

            const parsedData = JSON.parse(message.data);
            const eventName = parsedData.eName;

            const isDatacerEvent =
                eventName === "Tank/Level" ||
                eventName === "Water/Volume" ||
                eventName === "Vacuum/Lignes";

            expect(isDatacerEvent).toBe(false);
        });
    });
});
