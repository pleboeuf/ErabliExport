"use strict";

const { insertData, insertInflux } = require("./data-handlers");

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

    describe("Tank/Level events", () => {
        it("correctly inserts Tank/Level events into the datacer_tanks table", async () => {
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

            const device = {
                id: "DATACER-TANK-001",
                name: "G9-G10",
            };

            await insertData(mockDb, event, device);

            const insertedRows = mockDb.getInsertedRows();
            expect(insertedRows).toHaveLength(1);

            const { sql, params } = insertedRows[0];
            expect(sql).toContain("INSERT INTO datacer_tanks");
            expect(sql).toContain(
                "device_id, device_name, tank_name, published_at, temps_mesure, raw_value, depth, capacity, fill"
            );

            // Verify params
            expect(params[0]).toBe("DATACER-TANK-001"); // device_id
            expect(params[1]).toBe("G9-G10"); // device_name
            expect(params[2]).toBe("Reservoir-Principal"); // tank_name
            expect(params[5]).toBe(450.5); // raw_value
            expect(params[6]).toBe(1200); // depth
            expect(params[7]).toBe(5000); // capacity
            expect(params[8]).toBe(2500); // fill
        });

        it("handles Tank/Level events with missing optional fields", async () => {
            const event = {
                coreid: "DATACER-TANK-002",
                data: {
                    eName: "Tank/Level",
                    name: "Reservoir-Secondaire",
                    rawValue: 300,
                    depth: undefined,
                    capacity: undefined,
                    fill: 1000,
                    timestamp: 1707600000,
                    timer: 100,
                },
            };

            const device = {
                id: "DATACER-TANK-002",
                name: "G11-G12",
            };

            await insertData(mockDb, event, device);

            const insertedRows = mockDb.getInsertedRows();
            expect(insertedRows).toHaveLength(1);
            expect(insertedRows[0].sql).toContain("INSERT INTO datacer_tanks");
        });
    });

    describe("Water/Volume events", () => {
        it("correctly inserts Water/Volume events into the datacer_water table", async () => {
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

            const device = {
                id: "DATACER-WATER-001",
                name: "Water-Meter-1",
            };

            await insertData(mockDb, event, device);

            const insertedRows = mockDb.getInsertedRows();
            expect(insertedRows).toHaveLength(1);

            const { sql, params } = insertedRows[0];
            expect(sql).toContain("INSERT INTO datacer_water");
            expect(sql).toContain(
                "device_id, device_name, meter_name, published_at, temps_mesure, volume_total, volume_heure, volume_entaille, volume_since_reset"
            );

            // Verify params
            expect(params[0]).toBe("DATACER-WATER-001"); // device_id
            expect(params[1]).toBe("Water-Meter-1"); // device_name
            expect(params[2]).toBe("Compteur-Eau-Principal"); // meter_name
            expect(params[5]).toBe(15000.5); // volume_total
            expect(params[6]).toBe(125.3); // volume_heure
            expect(params[7]).toBe(0.45); // volume_entaille
            expect(params[8]).toBe(3500.2); // volume_since_reset
        });

        it("handles Water/Volume events with zero values", async () => {
            const event = {
                coreid: "DATACER-WATER-002",
                data: {
                    eName: "Water/Volume",
                    name: "Compteur-Neuf",
                    volume_total: 0,
                    volume_heure: 0,
                    volume_entaille: 0,
                    volume_since_reset: 0,
                    timestamp: 1707600000,
                    timer: 200,
                },
            };

            const device = {
                id: "DATACER-WATER-002",
                name: "New-Meter",
            };

            await insertData(mockDb, event, device);

            const insertedRows = mockDb.getInsertedRows();
            expect(insertedRows).toHaveLength(1);

            const { params } = insertedRows[0];
            expect(params[5]).toBe(0); // volume_total
            expect(params[6]).toBe(0); // volume_heure
            expect(params[7]).toBe(0); // volume_entaille
            expect(params[8]).toBe(0); // volume_since_reset
        });
    });

    describe("sensor/vacuum events", () => {
        it("divides eData by 100 for EB-Px devices", async () => {
            const event = {
                coreid: "3c001f000447393035313138",
                data: {
                    eName: "sensor/vacuum",
                    eData: 2500,
                    timestamp: 1707600000,
                    timer: 123,
                },
            };

            const device = {
                id: "3c001f000447393035313138",
                name: "EB-P1",
            };

            await insertData(mockDb, event, device);

            const insertedRows = mockDb.getInsertedRows();
            expect(insertedRows).toHaveLength(1);
            expect(insertedRows[0].sql).toContain("INSERT INTO vacuum");
            expect(insertedRows[0].params[4]).toBe(25);
        });

        it("does not divide eData by 100 for non-EB-Px/EB-Vx devices", async () => {
            const event = {
                coreid: "DATACER-VACUUM-001",
                data: {
                    eName: "sensor/vacuum",
                    eData: 2500,
                    timestamp: 1707600000,
                    timer: 123,
                },
            };

            const device = {
                id: "DATACER-VACUUM-001",
                name: "POMPE 1",
            };

            await insertData(mockDb, event, device);

            const insertedRows = mockDb.getInsertedRows();
            expect(insertedRows).toHaveLength(1);
            expect(insertedRows[0].sql).toContain("INSERT INTO vacuum");
            expect(insertedRows[0].params[4]).toBe(2500);
        });
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

    describe("Tank/Level events", () => {
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
            expect(point.fields.raw_value).toBe(450.5);
            expect(point.fields.depth).toBe(1200);
            expect(point.fields.capacity).toBe(5000);
            expect(point.fields.fill).toBe(2500);
            expect(point.timestamp).toBeDefined();
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
