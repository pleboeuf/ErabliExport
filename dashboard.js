"use strict";
// require("dotenv").config();
// const accessToken = process.env.PARTICLE_TOKEN;
const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args)); // Add this line
const fs = require("fs");
const path = require("path");
const util = require("util");
const Promise = require("promise");
const _ = require("underscore");

// const datacerVac = process.env.ENDPOINT_VAC;
const datacerVac = "/api/vacuum"; // Use the new proxy route
const datacerTank = process.env.ENDPOINT_TANK;
const datacerWater = process.env.ENDPOINT_WATER;
const datacerAll = process.env.Endpoint_all;

const readFile = Promise.denodeify(fs.readFile);
const writeFile = Promise.denodeify(fs.writeFile);

exports.Device = function (
    id,
    name,
    generationId,
    lastEventSerial,
    maxDelayMinutes,
    eventName,
    retired
) {
    this.id = id;
    this.name = name;
    this.generationId = generationId;
    this.lastEventSerial = lastEventSerial;
    this.maxDelayMinutes = maxDelayMinutes;
    this.eventName = eventName;
    this.retired = retired;
};

exports.Device.prototype.updateFrom = function (dev) {
    this.generationId = dev.generationId;
    this.lastEventSerial = dev.lastEventSerial;
    this.name = dev.name;
    return this;
};

var HorizontalCylindricTank = function (self) {
    self.getCapacity = function () {
        return Math.PI * Math.pow(self.diameter / 2000, 2) * self.length;
    };
    self.getFill = function () {
        try {
            var h = self.sensorHeight - self.rawValue;
            h = h <= 0 ? 0 : h;
            return HorizontalCylindricTank.getFill(
                h,
                self.diameter,
                self.length
            );
        } catch (error) {
            console.error(error);
            return 0;
        }
    };
};

HorizontalCylindricTank.getFill = function (level, diameter, length) {
    // All measures in millimeters
    if (level !== NaN) {
        level = level <= 0 ? 0 : level;
    } else {
        return 9999;
    }
    var h = level / 1000;
    var d = diameter / 1000;
    var r = d / 2;
    return (
        (Math.pow(r, 2) * Math.acos((r - h) / r) -
            (r - h) * Math.sqrt(d * h - Math.pow(h, 2))) *
        length
    );
};

var UShapedTank = function (self) {
    self.getCapacity = function () {
        return getFill(self.totalHeight);
    };
    self.getFill = function () {
        return getFill(self.sensorHeight - self.rawValue);
    };

    function getFill(level) {
        // All measures in millimeters
        level = level <= 0 ? 0 : level;
        return getBottomFill(level) + getTopFill(level);
    }

    function getBottomFill(level) {
        const adjustedLevel = Math.min(level, self.diameter / 2);
        return HorizontalCylindricTank.getFill(
            adjustedLevel,
            self.diameter,
            self.length
        );
    }

    function getTopFill(level) {
        const adjustedLevel = Math.max(0, level - self.diameter / 2);
        return (
            ((((self.diameter / 100) * self.length) / 100) * adjustedLevel) /
            100
        );
    }
};

exports.Tank = function (attrs) {
    var self = this;
    _.extend(self, attrs);
    if (self.shape === "cylinder" && self.orientation === "horizontal") {
        HorizontalCylindricTank(self);
    } else if (self.shape === "u") {
        UShapedTank(self);
    } else {
        throw (
            "Unsupported tank (shape: " +
            self.shape +
            ", " +
            self.orientation +
            ")"
        );
    }
};

exports.VacuumSensor = function (attrs) {
    var self = this;
    _.extend(self, attrs);
    self.getValue = function () {
        return self.value;
    };
};

exports.osmose = function () {
    return theOsmose;
};

var PumpEvent = function (generationId, serialNo, data) {
    var self = this;
    self.generationId = generationId;
    self.serialNo = serialNo;
    _.extend(self, data);
};

PumpEvent.comparator = function (a, b) {
    if (a.generationId !== b.generationId) {
        return a.generationId - b.generationId;
    } else {
        return a.serialNo - b.serialNo;
    }
};

var Pump = (exports.Pump = function (pumpConfig) {
    var self = this;
    _.extend(self, pumpConfig);
    var events = [];
    self.load = function (pumpData) {
        console.log(
            "Loading configured pump '%s' on device '%s'",
            self.code,
            self.device
        );
        return _.extend(self, _.omit(pumpData, "code", "device"));
    };
    self.update = function (event) {
        self.state = event.data.eData === 0;
        var pumpEvent = new PumpEvent(event.generationId, event.serialNo, {
            timer: event.data.timer,
            state: self.state,
        });
        events.push(pumpEvent);
        while (events.length > 3) {
            events.shift();
        }
        if (
            events.length === 3 &&
            !events[0].state &&
            events[1].state &&
            !events[2].state
        ) {
            self.cycleEnded(events[0], events[1], events[2]);
        }
    };
    self.cycleEnded = function (t0Event, t1Event, t2Event) {
        // self.duty = (t2Event.timer - t1Event.timer) / (t2Event.timer - t0Event.timer);
        console.log(
            "Pump cycle ended: " +
                (t1Event.timer - t0Event.timer) +
                " ms off, then " +
                (t2Event.timer - t1Event.timer) +
                " ms on (" +
                (self.duty * 100).toFixed(0) +
                "% duty)"
        );
    };
});

exports.Dashboard = function (config, WebSocketClient) {
    var Device = exports.Device;
    var Tank = exports.Tank;
    var osmose = exports.osmose;

    var uri = config.collectors[0].uri;
    var filename = config.store.filename;

    var listeners = []; // For onChange(data, event)
    var connectCallbacks = [];
    const queryCompleteCallbacks = [];
    var eventsSinceStore = 0;
    var devices = [];
    var tanks = [];
    var valves = [];
    var vacuumSensors = [];
    var pumps = [];
    var theOsmose = [];
    const pendingRequests = {};

    var dir = path.dirname(filename);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }

    function getTank(name) {
        return tanks
            .filter(function (tank) {
                return tank.name === name;
            })
            .shift();
    }

    function addDevice(device) {
        devices.push(device);
        return Promise.resolve(device);
    }

    function getDevices() {
        return Promise.resolve(devices);
    }

    function getDevice(deviceId) {
        return getDevices().then(function (devs) {
            return devs
                .filter(function (dev) {
                    return dev.id === deviceId;
                })
                .shift();
        });
    }

    function updateDevice(device) {
        return getDevice(device.id).then(function (dev) {
            return dev.updateFrom(device);
        });
    }

    function requestEvents(device) {
        if (connection.connected) {
            console.log(
                "Requesting events from device %s (%s) at %s,%s",
                device.name,
                device.id,
                device.generationId,
                device.lastEventSerial
            );
            pendingRequests[device.id] = true;
            connection.sendUTF(
                JSON.stringify({
                    command: "query",
                    device: device.id,
                    generation: device.generationId,
                    after: device.lastEventSerial,
                })
            );
        }
    }

    function subscribe() {
        if (connection.connected) {
            console.log("Subscribing to events from collector");
            connection.sendUTF(
                JSON.stringify({
                    command: "subscribe",
                })
            );
        }
    }

    function connect() {
        client.connect(uri, "event-stream");
    }

    var connectBackoff = 50;

    function reconnect() {
        connectBackoff = Math.min(connectBackoff * 1.5, 1000 * 60);
        setTimeout(connect, connectBackoff);
    }

    function getValveOfDevice(device, identifier) {
        var valve = valves
            .filter(function (valve) {
                return (
                    valve.device === device.name &&
                    valve.identifier === identifier
                );
            })
            .shift();
        if (valve === undefined) {
            throw util.format(
                "Device %s has no valve with identifier %d at gen: %d, serial: %d",
                device.name,
                identifier,
                device.generationId,
                device.lastEventSerial
            );
        }
        return valve;
    }

    function getValveByCode(code) {
        var valve = valves
            .filter(function (valve) {
                return valve.code === code;
            })
            .shift();
        if (valve === undefined) {
            throw "No valve with code " + code + " is defined";
        }
        return valve;
    }

    function getOsmoseDevice(device) {
        var sensor = theOsmose
            .filter(function (sensor) {
                return sensor.device === device.name;
            })
            .shift();
        // if (sensor === undefined) {
        //     throw "Device " + device.name + " has no vacuum sensor";
        // }
        return sensor;
    }

    function getVacuumSensorOfDevice(device) {
        var sensor = vacuumSensors
            .filter(function (sensor) {
                return sensor.device === device.name;
            })
            .shift();
        if (sensor === undefined) {
            throw "Device " + device.name + " has no vacuum sensor";
        }
        return sensor;
    }

    function getVacuumSensorOfLineVacuumDevice(device, input) {
        var sensor = vacuumSensors.filter(function (sensor) {
            return sensor.device === device.name;
        });
        if (sensor === undefined) {
            throw (
                "Device " +
                device.name +
                " has no vacuum sensor on input: " +
                input
            );
        }
        return sensor[input];
    }

    function getVacuumSensorByCode(code) {
        var sensor = vacuumSensors
            .filter(function (sensor) {
                return sensor.code === code;
            })
            .shift();
        if (sensor === undefined) {
            throw "Dashboard has no vacuum sensor with code " + code;
        }
        return sensor;
    }

    function getPumpOfDevice(device) {
        var pump = pumps
            .filter(function (pump) {
                return pump.device === device.name;
            })
            .shift();
        if (pump === undefined) {
            throw "Device " + device.name + " has no pump";
        }
        return pump;
    }

    const positionCode = ["Erreur", "Ouverte", "Fermé", "Partiel"];

    function handlePumpEvent(device, event, evTopic, data, value) {
        var pump = getPumpOfDevice(device);
        switch (evTopic) {
            case "T1":
                pump.update(event, value);
                break;
            case "T2":
                pump.update(event, value);
                pump.run2long = false;
                break;
            case "state":
                pump.update(event, value);
                break;
            case "T2_ONtime":
                pump.ONtime = Math.abs(value / 1000);
                break;
            case "T1_OFFtime":
                pump.OFFtime = Math.abs(value / 1000);
                break;
            case "CurrentDutyCycle":
                pump.duty = value / 1000;
                break;
            case "endCycle":
                pump.volume += (pump.ONtime * pump.capacity_gph) / 3600;
                pumps.forEach(function (pump) {
                    if (pump.device === device.name) {
                        pump.duty = value / 1000;
                        pump.lastUpdatedAt = event.published_at;
                        event.object = extendPump(pump);
                    }
                });
                break;
            case "warningRunTooLong":
                pump.run2long = true;
                break;
            case "debutDeCoulee":
                pump.couleeEnCour = true;
                pump.debutDeCouleeTS = data.timestamp;
                if (pump.device === device.name) {
                    pump.duty = value / 1000;
                    pump.lastUpdatedAt = event.published_at;
                    event.object = extendPump(pump);
                }
                break;
            case "finDeCoulee":
                pump.couleeEnCour = false;
                if (pump.device === device.name) {
                    pump.duty = value / 1000;
                    pump.lastUpdatedAt = event.published_at;
                    event.object = extendPump(pump);
                }
                pump.duty = 0;
                pump.volume = 0;
                break;
            case "RunTimeSinceMaint": // Vacuum pump event
                var sensor = getVacuumSensorOfDevice(device);
                if (sensor.device === device.name) {
                    sensor.RunTimeSinceMaint = value;
                    event.object = extendVacuum(sensor);
                }
                break;
            case "NeedMaintenance": // Vacuum pump event
                var sensor = getVacuumSensorOfDevice(device);
                if (sensor.device === device.name) {
                    sensor.NeedMaintenance = value;
                    event.object = extendVacuum(sensor);
                }
                break;
            default:
                console.warn(
                    "Unknown 'Pump' event topic from %s: %s %s",
                    device.name,
                    evTopic,
                    event.data.eData
                );
        }
    }

    function handleSensorEvent(device, event, evTopic, value) {
        const updateDevice = (property, value) => {
            device[property] = value;
        };

        const updateTank = (tank, value) => {
            tank.rawValue = value;
            tank.lastUpdatedAt = event.published_at;
            event.object = extendTank(tank);
        };

        const updateValve = (device, valveNumber, value) => {
            const valve = getValveOfDevice(device, valveNumber);
            if (valve.device === device.name) {
                valve.position = positionCode[value];
                event.object = extendValve(valve);
            }
        };

        switch (evTopic) {
            case "ambientTemp":
                updateDevice("ambientTemp", value);
                break;
            case "US100sensorTemp":
                updateDevice("sensorTemp", value);
                break;
            case "enclosureTemp":
                updateDevice("enclosureTemp", value);
                break;
            case "level":
                tanks.forEach((tank) => {
                    if (tank.device === device.name) {
                        updateTank(tank, value);
                    }
                });
                break;
            case "outOfRange":
                // To do
                break;
            case "Valve1Pos":
                updateValve(device, 1, value);
                break;
            case "Valve2Pos":
                updateValve(device, 2, value);
                break;
            case "vacuum":
                const sensor = getVacuumSensorOfDevice(device);
                sensor.rawValue = value;
                sensor.lastUpdatedAt = event.published_at;
                break;
            default:
                console.warn(
                    "Unknown 'Sensor' event topic from %s: %s %s",
                    device.name,
                    evTopic,
                    event.data.eData
                );
        }
    }

    function handleVacuumEvent(device, event, evTopic, data) {
        switch (evTopic) {
            case "Lignes":
                for (let i = 0; i < 4; i++) {
                    const sensor = getVacuumSensorOfLineVacuumDevice(device, i);
                    if (sensor !== undefined) {
                        Object.assign(sensor, {
                            rawValue: data[sensor.inputName] * 100,
                            lastUpdatedAt: event.published_at,
                            temp: data["temp"],
                            lightIntensity: data["li"],
                            percentCharge: data["soc"],
                            batteryVolt: data["volt"],
                            rssi: data["rssi"],
                            signalQual: data["qual"],
                        });
                    } else {
                        break;
                    }
                }
                break;
            default:
                console.warn(
                    "Unknown 'Vacuum' event topic from %s: %s %s",
                    device.name,
                    evTopic,
                    event
                );
        }
    }

    function handleOutputEvent(device, event, evTopic, value) {
        const updateDevice = (property, value) => {
            device[property] = value;
        };

        switch (evTopic) {
            case "enclosureHeating":
                updateDevice("enclosureHeating", value);
                break;
            case "ssrRelayState":
                updateDevice("ssrRelayState", value);
                break;
            default:
                console.warn(
                    "Unknown 'Output' event topic from %s: %s %s",
                    device.name,
                    evTopic,
                    event
                );
        }
    }

    function handleDeviceEvent(device, event, evTopic) {
        switch (evTopic) {
            case "boot":
                // TODO Ignored
                break;
            case "NewGenSN":
                // TODO Ignored
                break;
            default:
                console.warn(
                    "Unknown 'Device' event topic from %s: %s %s",
                    device.name,
                    evTopic,
                    event
                );
        }
    }

    function handleOsmoseEvent(device, event, evTopic, data) {
        const sensor = getOsmoseDevice(device);
        const commonUpdates = (updates) => {
            Object.assign(sensor, updates);
            sensor.lastUpdatedAt = event.published_at;
            event.object = extendOsmose(theOsmose);
        };

        switch (evTopic) {
            case "Start":
            case "Stop":
                commonUpdates({
                    state: data.state,
                    fonction: data.fonction,
                    sequence: data.sequence,
                    alarmNo: data.alarmNo,
                    alarmMsg: data.alarmMsg,
                    startStopTime: data.startStopTime,
                    runTimeSec: data.runTimeSec,
                });
                break;
            case "timeCounter":
                commonUpdates({
                    state: data.state,
                    TempsOperEnCour: data.TempsOperEnCour,
                    TempsSeq1234: data.TempsSeq1234,
                    TempsSeq4321: data.TempsSeq4321,
                    TempsDepuisLavage: data.TempsDepuisLavage,
                });
                break;
            case "operData":
                commonUpdates({
                    sequence: data.sequence,
                    Col1: data.Col1,
                    Col2: data.Col2,
                    Col3: data.Col3,
                    Col4: data.Col4,
                    Conc: data.Conc,
                    Temp: data.Temp,
                    Pres: data.Pres,
                });
                break;
            case "concData":
                commonUpdates({
                    sequence: data.sequence,
                    BrixSeve: data.BrixSeve,
                    BrixConc: data.BrixConc,
                });
                break;
            case "summaryData":
                commonUpdates({
                    sequence: data.sequence,
                    PC_Conc: data.PC_Conc,
                    Conc_GPH: data.Conc_GPH,
                    Filtrat_GPH: data.Filtrat_GPH,
                    Total_GPH: data.Total_GPH,
                    runTimeSec: data.runTimeSec,
                });
                break;
            case "alarm":
                commonUpdates({
                    state: data.state,
                    fonction: data.fonction,
                    sequence: data.sequence,
                    alarmNo: data.alarmNo,
                    alarmMsg: data.alarmMsg,
                });
                break;
            default:
                console.warn(
                    "Unknown 'Osmose' event topic from %s: %s %s",
                    device.name,
                    evTopic,
                    event
                );
        }
    }

    function handleOptoInEvent(device, event, evTopic, value) {
        const updateValve = (device, valveNumber, value) => {
            const valve = getValveOfDevice(device, valveNumber);
            if (valve.device === device.name) {
                valve.position = positionCode[value + 1];
                event.object = extendValve(valve);
            }
        };

        switch (evTopic) {
            case "state":
                updateValve(device, 0, value);
                break;
            default:
                console.warn(
                    "Unknown 'OptoIn' event topic from '%s': %s %s",
                    device.name,
                    evTopic,
                    event
                );
        }
    }

    function handleEvent(device, event) {
        const data = event.data;
        if (!data) {
            return Promise.reject({
                message: "Event is missing data",
                event: event,
            });
        }
        const value = data.eData;

        // Override event name from configuration if not present in payload
        if (!data.eName && device.eventName) {
            data.eName = device.eventName;
        }

        let name = data.eName ? data.eName.trim() : "";
        if (name === "Dev1_Vacuum/Lignes") {
            name = "Vacuum/Lignes";
        }

        device.lastUpdatedAt = event.published_at;
        console.log(
            "Event '%s' from device: '%s', value: %s",
            name,
            device.name,
            value
        );

        const [mainTopic, subTopic] = name.split("/");
        switch (mainTopic) {
            case "pump":
                handlePumpEvent(device, event, subTopic, data, value);
                break;
            case "sensor":
                handleSensorEvent(device, event, subTopic, value);
                break;
            case "Vacuum":
                handleVacuumEvent(device, event, subTopic, data);
                break;
            case "output":
                handleOutputEvent(device, event, subTopic, value);
                break;
            case "device":
                handleDeviceEvent(device, event, subTopic);
                break;
            case "Osmose":
                handleOsmoseEvent(device, event, subTopic, data);
                break;
            case "optoIn":
                handleOptoInEvent(device, event, subTopic, value);
                break;
            default:
                console.warn(
                    "Unknown event '%s' from %s: %s",
                    device.name,
                    name,
                    event
                );
        }
        return publishData(event, device);
    }

    function publishData(event, device) {
        return Promise.all(
            listeners.map((listener) => listener(getData(), event, device))
        );
    }

    function handleMessage(message) {
        if (message.name && message.name.startsWith("collector/")) {
            return handleCollectorMessage(message);
        }

        const deviceId = message.coreid;
        message.data = JSON.parse(message.data);
        const { noSerie: serialNo, generation: generationId } = message.data;

        return getDevice(deviceId).then((device) => {
            eventsSinceStore++;
            if (!device) {
                console.log("Device " + deviceId + " is new!");
                // TODO This adds duplicate devices to dashboard.json!
                // return addDevice(new Device(deviceId, "New" + deviceId, generationId, serialNo)).then(handleEvent);
            } else {
                const handleEventFunc = () => handleEvent(device, message);

                if (typeof device.generationId === "undefined") {
                    console.log(
                        "First event received for device %s (%s,%s)",
                        deviceId,
                        generationId,
                        serialNo
                    );
                    device.generationId = generationId;
                    device.lastEventSerial = serialNo;
                    return updateDevice(device).then(handleEventFunc);
                } else if (generationId !== device.generationId) {
                    if (generationId > device.generationId) {
                        console.warn(
                            "Device %s started a new generation of events: %s Accepting provided serial number: %s (was at %s, %s)",
                            deviceId,
                            generationId,
                            serialNo,
                            device.generationId,
                            device.lastEventSerial
                        );
                        device.generationId = generationId;
                        device.lastEventSerial = serialNo;
                        return updateDevice(device).then(handleEventFunc);
                    } else {
                        return Promise.reject({
                            error: util.format(
                                "Received event for old generation (%s) of device %s, which is now at generation %s. Ignored!",
                                generationId,
                                deviceId,
                                device.generationId
                            ),
                            message: message,
                        });
                    }
                } else if (device.lastEventSerial < serialNo) {
                    device.lastEventSerial = serialNo;
                    return updateDevice(device).then(handleEventFunc);
                } else if (device.lastEventSerial === serialNo) {
                    // Ignoring duplicate event
                } else {
                    return Promise.reject({
                        error: util.format(
                            "Received old event for device %s: %d, %s",
                            deviceId,
                            serialNo,
                            generationId
                        ),
                        message: message,
                    });
                }
            }
        });
    }

    function handleCollectorMessage(message) {
        if (message.name === "collector/querycomplete") {
            const deviceId = message.data.command.device;
            delete pendingRequests[deviceId];
            if (Object.keys(pendingRequests).length > 0) {
                console.log(
                    util.format(
                        "Completed query for device %s with %d events; waiting for %d other devices.",
                        deviceId,
                        message.data.command.sent,
                        Object.keys(pendingRequests).length
                    )
                );
            } else {
                console.log(
                    util.format(
                        "Completed query for device %s with %d events; All queries completed.",
                        deviceId,
                        message.data.command.sent
                    )
                );
                store();
                queryCompleteCallbacks.forEach(function (callback) {
                    callback();
                });
            }
        } else {
            console.warn("Unhandled message from collector", message);
        }
        return Promise.resolve(message);
    }

    var client = new WebSocketClient();
    var connection;
    var onConnectSuccess;
    var connectPromise = new Promise(function (complete, reject) {
        onConnectSuccess = complete;
    });
    client.on("connectFailed", function (error) {
        console.log("Connect Error: " + error.toString());
        reconnect();
    });
    client.on("connect", function (con) {
        connection = con;
        connectBackoff = 1;
        console.log("WebSocket Client Connected to: " + uri);
        onConnectSuccess(connection);
        connectCallbacks.forEach(function (callback) {
            callback();
        });
        connection.on("error", function (error) {
            console.log("Connection Error: " + error.toString());
            reconnect();
        });
        connection.on("close", function () {
            console.log("event-stream Connection Closed");
            reconnect();
        });
        connection.on("message", function (message) {
            if (message.type === "utf8") {
                //console.log("Received: '" + message.utf8Data + "'");
                try {
                    return handleMessage(JSON.parse(message.utf8Data)).catch(
                        function (err) {
                            console.error(err);
                        }
                    );
                } catch (exception) {
                    console.error(
                        "Failed to handle message: " + message.utf8Data,
                        exception.stack
                    );
                }
            } else {
                console.warn("Unknown message type: " + message.type);
            }
        });
    });

    async function getDatacerData(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Response status: ${response.status}`);
            }
            const datacerData = await response.json();
            return datacerData;
        } catch (error) {
            console.warn(error.message, url);
            return null;
        }
    }

    function normalizeLabel(label) {
        return label.replace(/([A-Z])0*/, "$1");
    }

    function mergeVacuumData(source, destination, newEntryFlag) {
        const now = new Date();
        const destinationIndex = destination.reduce((acc, destItem) => {
            acc[destItem.code] = destItem;
            return acc;
        }, {});

        source.forEach((item) => {
            if (
                item.label.includes([
                    "Vac3-POMPE 1",
                    "Vac3-POMPE 2",
                    "Vac3-POMPE PUMP HOUSE",
                ])
            ) {
                item.label = item.label.substring(4);
            }
            const normalizedLabel = normalizeLabel(item.label);
            const matchingDest = destinationIndex[normalizedLabel];

            if (matchingDest) {
                // Update existing entry
                matchingDest.rawValue = parseFloat(item.rawValue) || 0;
                matchingDest.temp = parseFloat(item.temp) || 0;
                matchingDest.ref = parseFloat(item.referencialValue) || 0;
                matchingDest.percentCharge =
                    parseFloat(item.percentCharge) || 0;
                matchingDest.offset = item.offset;
                matchingDest.lastUpdatedAt = item.lastUpdatedAt;

                if (["EB-V1", "EB-V2", "EB-V3"].includes(item.device)) {
                    matchingDest.RunTimeSinceMaint = item.RunTimeSinceMaint;
                    matchingDest.NeedMaintenance = item.NeedMaintenance;
                    matchingDest.lastUpdatedAt = item.lastUpdatedAt;
                }
            } else if (newEntryFlag) {
                // Add new entry if not found (optional)
                console.log(`New vacuum entry found: ${normalizedLabel}`);
                let newEntry = {
                    code: normalizedLabel,
                    label: item.label,
                    device: item.device,
                    rawValue: parseFloat(item.rawValue) || 0,
                    temp: parseFloat(item.temp) || 0,
                    ref: parseFloat(item.referencialValue) || 0,
                    percentCharge: parseFloat(item.percentCharge) || 0,
                    offset: item.offset,
                    lastUpdatedAt: now.toISOString(),
                };
                destination.push(newEntry);
            }
        });
    }

    // Fonction générique pour mettre à jour les devices
    // source Datacer vacuum data
    // destination devices array
    function mergeDevicesData(source, destination, newEntryFlag = false) {
        const now = new Date();
        const destinationIndex = destination.reduce((acc, destItem) => {
            acc[destItem.name] = destItem;
            return acc;
        }, {});

        source.forEach((item) => {
            const devName = item.device;
            const matchingDest = destinationIndex[devName];
            if (!matchingDest.retired) {
                if (matchingDest) {
                    // Update existing entry
                    if (item.lastUpdatedAt !== undefined) {
                        matchingDest.lastUpdatedAt = item.lastUpdatedAt;
                    } else if (matchingDest.lastUpdatedAt === undefined) {
                        matchingDest.lastUpdatedAt = now.toISOString();
                    }
                } else if (newEntryFlag) {
                    // Add new entry if not found (optional)
                    console.log(`New devices entry found: ${devName}`);
                    let newEntry = {
                        name: devName,
                        label: item.label,
                        lastUpdatedAt: now.toISOString(),
                    };
                    destination.push(newEntry);
                }
            }
        });
    }

    async function readDatacer() {
        try {
            const dtcVacuumData = await getDatacerData(
                process.env.ENDPOINT_VAC
            );
            if (dtcVacuumData !== null) {
                mergeVacuumData(dtcVacuumData.vacuum, vacuumSensors, true);
                mergeDevicesData(dtcVacuumData.vacuum, devices, true);
                console.log(
                    "Update from Datacer",
                    new Date(Date.now()).toLocaleString()
                );
            } else {
                console.log(
                    "Failed to fetch data from Datacer :(",
                    new Date(Date.now()).toLocaleString()
                );
            }
        } catch (error) {
            console.error(
                "Update from Datacer FAILED:",
                error,
                new Date(Date.now()).toLocaleString()
            );
        }
    }

    function init() {
        console.log("Initializing...");
        var configData = {
            devices: config.devices,
            tanks: config.tanks,
            valves: config.valves,
            vacuums: config.vacuums,
            pumps: config.pumps,
            osmose: config.osmose,
            // "temperatures": config.temperatures
        };
        if (fs.existsSync(filename)) {
            console.log("Data exists");
            console.log("Loading " + filename);
            return readFile(filename, "utf8")
                .then(JSON.parse)
                .then(function (dashData) {
                    return load(configData, dashData);
                });
        } else {
            console.log("Dashboard data not found. Initializing.");
            return load(configData, configData);
        }
    }

    function getData() {
        return {
            devices: devices,
            tanks: tanks.map(extendTank),
            valves: valves.map(extendValve),
            vacuums: vacuumSensors,
            pumps: pumps.map(extendPump),
            osmose: theOsmose,
            token: process.env.PARTICLE_TOKEN,
        };
    }

    function extendTank(tank) {
        tank = _.extend({}, tank);
        tank.capacity = tank.getCapacity();
        tank.fill = tank.getFill();
        return tank;
    }

    function extendPump(pump) {
        pump = _.extend({}, pump);
        // pump.T2ONtime = pump.ONtime;
        // pump.T1OFFtime = pump.OFFtime;
        return pump;
    }

    function extendValve(valve) {
        valve = _.extend({}, valve);
        valve.name = valve.code;
        return valve;
    }

    function extendVacuum(vacuumSensor) {
        vacuumSensor = _.extend({}, vacuumSensor);
        // vacuumSensor.RunTimeSinceMaint =
        return vacuumSensor;
    }

    function extendOsmose(osmose) {
        osmose = _.extend({}, osmose);
        return osmose;
    }

    function load(config, data) {
        devices = config.devices.map(function (dev) {
            var deviceData = data.devices
                .filter(function (devData) {
                    return devData.id === dev.id;
                })
                .shift();
            if (!deviceData) {
                deviceData = {};
            }
            console.log(
                "Loading configured device '%s' - '%s' (%s) at %s,%s",
                dev.name,
                dev.description,
                dev.id,
                deviceData.generationId,
                deviceData.lastEventSerial
            );
            return new Device(
                dev.id,
                dev.name,
                deviceData.generationId,
                deviceData.lastEventSerial,
                dev.maxDelayMinutes,
                dev.eventName,
                dev.retired
            );
        });

        tanks = config.tanks.map(function (tank) {
            var tankData = data.tanks
                .filter(function (tankData) {
                    return tank.code === tankData.code;
                })
                .shift();
            console.log(
                "Loading configured tank '%s' - '%s' with raw level of %s, last updated at %s",
                tank.code,
                tank.name,
                tank.rawValue,
                tank.lastUpdatedAt
            );
            var attrsFromConfig = [
                "name",
                "device",
                "shape",
                "orientation",
                "length",
                "diameter",
                "sensorHeight",
                "totalHeight",
            ];
            return new Tank(_.extend(tank, _.omit(tankData, attrsFromConfig)));
        });

        valves = config.valves.map(function (valve) {
            var valveData = data.valves
                .filter(function (valveData) {
                    return valve.code === valveData.code;
                })
                .shift();
            console.log(
                "Loading configured valve '%s' on device '%s'",
                valve.code,
                valve.device
            );
            return _.extend(valve, _.omit(valveData, "code", "name", "device"));
        });

        vacuumSensors = config.vacuums.map(function (sensor) {
            var sensorData = data.vacuums
                .filter(function (sensorData) {
                    return sensor.code === sensorData.code;
                })
                .shift();
            if (!data.vacuums) {
                return sensor;
            }
            console.log(
                "Loading configured vacuum sensor '%s' on device '%s'",
                sensor.code,
                sensor.device
            );
            return _.extend(sensor, _.omit(sensorData, "code", "device"));
        });

        pumps = config.pumps.map(function (pump) {
            pump = new Pump(pump);
            if (!data.pumps) {
                return pump;
            }
            var pumpData = data.pumps
                .filter(function (pumpData) {
                    return pump.code === pumpData.code;
                })
                .shift();
            pump.load(pumpData);
            return pump;
        });

        theOsmose = config.osmose.map(function (sensor) {
            var sensorData = data.osmose
                .filter(function (sensorData) {
                    return sensor.code === sensorData.code;
                })
                .shift();
            if (!data.osmose) {
                return sensor;
            }
            console.log(
                "Loading configured osmose sensor '%s' on device '%s'",
                sensor.code,
                sensor.device
            );
            return _.extend(sensor, _.omit(sensorData, "code", "device"));
        });

        return Promise.resolve();
    }

    readDatacer();
    setInterval(readDatacer, 1 * 60 * 1000); // Update every minute

    function store() {
        const dataString = JSON.stringify(getData(), null, 2);
        var events = eventsSinceStore;
        // console.log("Writing to %s after %d events.", filename, events);
        return writeFile(filename, dataString, "utf8")
            .then(function () {
                // Counter may be incremented if a message was received while storing.
                eventsSinceStore = eventsSinceStore - events;
                console.log(
                    "Wrote " + filename + " with " + events + " new events."
                );
            })
            .catch(function (err) {
                console.error(err);
            });
    }

    function checkStore() {
        if (eventsSinceStore > 100) {
            stop();
            start();
        }
    }

    var storeInterval;

    function start() {
        storeInterval = setInterval(checkStore, 1000 * 5);
    }

    function stop() {
        clearInterval(storeInterval);
        return store();
    }

    return {
        init: function () {
            return init();
        },
        connect: function (callback) {
            connect();
            if (callback) {
                connectCallbacks.push(callback);
            }
            return connectPromise;
        },
        onConnect: function (callback) {
            // TODO ??
        },
        subscribe: function () {
            subscribe();
        },
        update: function () {
            return getDevices()
                .then(function (devices) {
                    console.log("Updating " + devices.length + " devices");
                    devices.forEach(function (device) {
                        requestEvents(device);
                    });
                })
                .catch(function (err) {
                    console.error(err);
                });
        },
        start: function () {
            return start();
        },
        stop: function () {
            return stop();
        },
        getDevice: getDevice,
        getTank: getTank,
        getValve: getValveByCode,
        getVacuumSensorByCode: getVacuumSensorByCode,
        getVacuumSensorOfLineVacuumDevice: getVacuumSensorOfLineVacuumDevice,
        getData: getData,
        getEventsSinceStore: function () {
            return eventsSinceStore;
        },
        onChange: function (listener) {
            listeners.push(listener);
        },
        onQueryComplete: function (callback) {
            queryCompleteCallbacks.push(callback);
        },
    };
};
