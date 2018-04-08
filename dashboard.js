const fs = require('fs');
const path = require('path');
const util = require('util');
const Promise = require('promise');
const _ = require('underscore');
var readFile = Promise.denodeify(fs.readFile);
var writeFile = Promise.denodeify(fs.writeFile);

exports.Device = function (id, name, generationId, lastEventSerial, maxDelayMinutes, eventName, retired) {
    this.id = id;
    this.name = name;
    this.generationId = generationId;
    this.lastEventSerial = lastEventSerial;
    this.maxDelayMinutes = maxDelayMinutes;
    this.eventName = eventName;
    this.retired = retired;
    this.updateFrom = function (dev) {
        this.generationId = dev.generationId;
        this.lastEventSerial = dev.lastEventSerial;
        this.name = dev.name;
        return this;
    }
};

var HorizontalCylindricTank = function (self) {
    self.getCapacity = function () {
        return Math.PI * Math.pow(self.diameter / 2000, 2) * self.length;
    };
    self.getFill = function () {
        var h = self.sensorHeight - self.rawValue;
        return HorizontalCylindricTank.getFill(h, self.diameter, self.length);
    }
};

HorizontalCylindricTank.getFill = function (level, diameter, length) {
    // All measures in millimeters
    var h = level / 1000;
    var d = diameter / 1000;
    var r = d / 2;
    return (Math.pow(r, 2) * Math.acos((r - h) / r) - (r - h) * Math.sqrt(d * h - Math.pow(h, 2))) * length;
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
        return getBottomFill(level) + getTopFill(level);
    }

    function getBottomFill(level) {
        level = Math.min(level, self.diameter / 2);
        return HorizontalCylindricTank.getFill(level, self.diameter, self.length);
    }

    function getTopFill(level) {
        level = Math.max(0, level - self.diameter / 2);
        return self.diameter / 100 * self.length / 100 * level / 100;
    }
};

exports.Tank = function (attrs) {
    var self = this;
    _.extend(self, attrs);
    if (self.shape === 'cylinder' && self.orientation === 'horizontal') {
        HorizontalCylindricTank(self);
    } else if (self.shape === 'u') {
        UShapedTank(self);
    } else {
        throw 'Unsupported tank (shape: ' + self.shape + ', ' + self.orientation + ')';
    }
};

exports.VacuumSensor = function (attrs) {
    var self = this;
    _.extend(self, attrs);
    self.getValue = function () {
        return self.value;
    }
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

var Pump = exports.Pump = function (pumpConfig) {
    var self = this;
    _.extend(self, pumpConfig);
    var events = [];
    self.load = function (pumpData) {
        console.log("Loading configured pump '%s' on device '%s'", self.code, self.device);
        return _.extend(self, _.omit(pumpData, 'code', 'device'));
    };
    self.update = function (event) {
        self.state = event.data.eData === 0;
        var pumpEvent = new PumpEvent(event.generationId, event.serialNo, {
            "timer": event.data.timer,
            "state": self.state
        });
        events.push(pumpEvent);
        while (events.length > 3) {
            events.shift();
        }
        if (events.length === 3 && !events[0].state && events[1].state && !events[2].state) {
            self.cycleEnded(events[0], events[1], events[2]);
        }
    };
    self.cycleEnded = function (t0Event, t1Event, t2Event) {
        self.duty = (t2Event.timer - t1Event.timer) / (t2Event.timer - t0Event.timer);
        // console.log("Pump cycle ended: " + (t1Event.timer - t0Event.timer) + " ms off, then " + (t2Event.timer - t1Event.timer) + " ms on (" + (self.duty * 100).toFixed(0) + "% duty)");
    }
};

exports.Dashboard = function (config, WebSocketClient) {
    var Device = exports.Device;
    var Tank = exports.Tank;

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
    const pendingRequests = {};

    var dir = path.dirname(filename);
    fs.exists(dir, function (exists) {
        if (!exists) {
            fs.mkdir(dir, new function (err) {
                console.error(err);
            });
        }
    });

    function getTank(name) {
        return tanks.filter(function (tank) {
            return tank.name === name;
        }).shift();
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
            return devs.filter(function (dev) {
                return dev.id === deviceId;
            }).shift();
        });
    }

    function updateDevice(device) {
        return getDevice(device.id).then(function (dev) {
            return dev.updateFrom(device);
        });
    }

    function requestEvents(device) {
        if (connection.connected) {
            console.log("Requesting events from device %s (%s) at %s,%s", device.name, device.id, device.generationId, device.lastEventSerial);
            pendingRequests[device.id] = true;
            connection.sendUTF(JSON.stringify({
                "command": "query",
                "device": device.id,
                "generation": device.generationId,
                "after": device.lastEventSerial
            }));
        }
    }

    function subscribe() {
        if (connection.connected) {
            console.log("Subscribing to events from collector");
            connection.sendUTF(JSON.stringify({
                "command": "subscribe"
            }));
        }
    }

    function connect() {
        client.connect(uri, 'event-stream');
    }

    var connectBackoff = 500;

    function reconnect() {
        connectBackoff = Math.min(connectBackoff * 2, 1000 * 60);
        setTimeout(connect, connectBackoff);
    }

    function getValveOfDevice(device, identifier) {
        var valve = valves.filter(function (valve) {
            return valve.device === device.name && valve.identifier === identifier;
        }).shift();
        if (valve === undefined) {
            throw util.format("Device %s has no valve with identifier %d at %d,%d", device.name, identifier, device.generationId, device.lastEventSerial);
        }
        return valve;
    }

    function getValveByCode(code) {
        var valve = valves.filter(function (valve) {
            return valve.code === code;
        }).shift();
        if (valve === undefined) {
            throw "No valve with code " + code + " is defined";
        }
        return valve;
    }

    function getVacuumSensorOfDevice(device) {
        var sensor = vacuumSensors.filter(function (sensor) {
            return sensor.device === device.name;
        }).shift();
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
            throw "Device " + device.name + " has no vacuum sensor on input: " + input;
        }
        return sensor[input];
    }

    function getVacuumSensorByCode(code) {
        var sensor = vacuumSensors.filter(function (sensor) {
            return sensor.code === code;
        }).shift();
        if (sensor === undefined) {
            throw "Dashboard has no vacuum sensor with code " + code;
        }
        return sensor;
    }

    function getPumpOfDevice(device) {
        var pump = pumps.filter(function (pump) {
            return pump.device === device.name;
        }).shift();
        if (pump === undefined) {
            throw "Device " + device.name + " has no pump";
        }
        return pump;
    }

    var positionCode = ["Erreur", "Ouverte", "Fermé", "Partiel"];

    function handleEvent(device, event) {
        const data = event.data;
        if (!data) {
            return Promise.reject({
                message: "Event is missing data",
                event: event
            });
        }
        const value = data.eData;
        // Some events do not have their name in the payload.
        // For those, we override the event name from configuration.
        if (!data.eName && device.eventName) {
            // console.log(util.format("Overriding event name to %s for device %s", device.eventName, device.id));
            data.eName = device.eventName;
        }
        var name = data.eName;
        // Some names are wrong...
        if (name === "Dev1_Vacuum/Lignes") {
            name = "Vacuum/Lignes";
        }
        if (name) {
            name = name.trim();
        }
        device.lastUpdatedAt = event.published_at;
        if (name === "sensor/ambientTemp") {
            device.ambientTemp = value;
        } else if (name === "sensor/US100sensorTemp") {
            device.sensorTemp = value;
        } else if (name === "sensor/enclosureTemp") {
            device.enclosureTemp = value;
        } else if (name === "output/enclosureHeating") {
            device.enclosureHeating = value;
        } else if (name === "sensor/vacuum") {
            const sensor = getVacuumSensorOfDevice(device);
            sensor.rawValue = value;
            sensor.lastUpdatedAt = event.published_at;
        } else if (name === "Vacuum/Lignes") {
            for (var i = 0; i < 4; i++) {
                var sensor = getVacuumSensorOfLineVacuumDevice(device, i);
                if (sensor !== undefined) {
                    sensor.rawValue = data[sensor.inputName] * 100;
                    sensor.lastUpdatedAt = event.published_at;
                    sensor.temp = data["temp"];
                    sensor.lightIntensity = data["li"];
                    sensor.percentCharge = data["soc"];
                    sensor.batteryVolt = data["volt"];
                } else {
                    break;
                }
            }
        } else if (name === "pump/T1") {
            getPumpOfDevice(device).update(event, value);
        } else if (name === "pump/T2") {
            const pump = getPumpOfDevice(device);
            pump.update(event, value);
            pump.run2long = false;
        } else if (name === "pump/state") {
            getPumpOfDevice(device).update(event, value);
        } else if (name === "pump/T2_ONtime") {
            getPumpOfDevice(device).ONtime = Math.abs(value / 1000);
        } else if (name === "pump/CurrentDutyCycle") {
            getPumpOfDevice(device).duty = value / 1000;
        } else if (name === "pump/endCycle") {
            const pump = getPumpOfDevice(device);
            pump.volume += pump.ONtime * pump.capacity_gph / 3600;
            pumps.forEach(function (pump) {
                if (pump.device === device.name) {
                    pump.duty = value / 1000;
                    pump.lastUpdatedAt = event.published_at;
                    event.object = extendPump(pump);
                }
            });
        } else if (name === "pump/warningRunTooLong") {
            getPumpOfDevice(device).run2long = true;
        } else if (name === "pump/debutDeCoulee") {
            const pump = getPumpOfDevice(device);
            pump.couleeEnCour = true;
            pump.debutDeCouleeTS = data.timestamp;
            if (pump.device === device.name) {
                pump.duty = value / 1000;
                pump.lastUpdatedAt = event.published_at;
                event.object = extendPump(pump);
            }
        } else if (name === "pump/finDeCoulee") {
            const pump = getPumpOfDevice(device);
            pump.couleeEnCour = false;
            if (pump.device === device.name) {
                pump.duty = value / 1000;
                pump.lastUpdatedAt = event.published_at;
                event.object = extendPump(pump);
            }
            pump.duty = 0;
            pump.volume = 0;

        } else if (name === "sensor/Valve1Pos") {
            const valve = getValveOfDevice(device, 1);
            if (valve.device === device.name) {
                valve.position = positionCode[value];
                event.object = extendValve(valve);
            }
        } else if (name === "sensor/Valve2Pos") {
            const valve = getValveOfDevice(device, 2);
            if (valve.device === device.name) {
                valve.position = positionCode[value];
                event.object = extendValve(valve);
            }
        } else if (name === "sensor/level") {
            tanks.forEach(function (tank) {
                if (tank.device === device.name) {
                    tank.rawValue = value;
                    tank.lastUpdatedAt = event.published_at;
                    event.object = extendTank(tank);
                }
            });
        } else if (name === "device/boot") {
            // TODO Ignored
        } else if (name === "device/NewGenSN") {
            // TODO Ignored
        } else if (name === "sensor/openSensorV1") {
            // TODO Ignored
        } else if (name === "sensor/closeSensorV1") {
            // TODO Ignored
        } else if (name === "sensor/openSensorV2") {
            // TODO Ignored
        } else if (name === "sensor/closeSensorV2") {
            // TODO Ignored
        } else if (name === "sensor/outOfRange") {
            // TODO Ignored
        } else if (name === "sensor/sensorTemp") {
            // TODO Ignored
        } else {
            console.warn("Unknown event name from %s: %s", device.name, name, event);
        }
        publishData(event, device);
        return Promise.resolve(null);
    }

    function publishData(event, device) {
        listeners.forEach(function (listener) {
            listener(getData(), event, device);
        });
    }

    function handleMessage(message) {
        if (message.name && message.name.startsWith("collector/")) {
            return handleCollectorMessage(message);
        }
        var deviceId = message.coreid;
        message.data = JSON.parse(message.data);
        var serialNo = message.data.noSerie;
        var generationId = message.data.generation;
        return getDevice(deviceId).then(function (device) {
            eventsSinceStore++;
            if (device === undefined) {
                console.log("Device " + deviceId + " is new!");
                // TODO This adds duplicate devices to dashboard.json!
                // return addDevice(new Device(deviceId, "New" + deviceId, generationId, serialNo)).then(handleEvent);
            } else {
                var handleEventFunc = function () {
                    handleEvent(device, message)
                };
                if (typeof device.generationId === 'undefined') {
                    console.log("First event received for device %s (%s,%s)", deviceId, generationId, serialNo);
                    device.generationId = generationId;
                    device.lastEventSerial = serialNo;
                    return updateDevice(device).then(handleEventFunc);
                } else if (generationId !== device.generationId) {
                    if (generationId > device.generationId) {
                        console.warn("Device %s started a new generation of events: %s Accepting provided serial number: %s (was at %s, %s)", deviceId, generationId, serialNo, device.generationId, device.lastEventSerial);
                        device.generationId = generationId;
                        device.lastEventSerial = serialNo;
                        return updateDevice(device).then(handleEventFunc);
                    } else {
                        return Promise.reject({
                            error: util.format("Received event for old generation (%s) of device %s, which is now at generation %s. Ignored!", generationId, deviceId, device.generationId),
                            message: message
                        });
                    }
                } else if (device.lastEventSerial < serialNo) {
                    device.lastEventSerial = serialNo;
                    return updateDevice(device).then(handleEventFunc);
                } else if (device.lastEventSerial === serialNo) {
                    // Ignoring duplicate event
                } else {
                    // console.log(util.format("Old event from device %s in current generation %d: received %d but currently at %d", deviceId, device.generationId, serialNo, device.lastEventSerial), message);
                    return Promise.reject({
                        error: util.format("Received old event for device %s: %d, %s", deviceId, serialNo, generationId),
                        message: message
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
                console.log(util.format("Completed query for device %s; waiting for %d other devices.",
                    deviceId, Object.keys(pendingRequests).length));
            } else {
                console.log(util.format("Completed query for device %s; All queries completed.", deviceId));
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
    client.on('connectFailed', function (error) {
        console.log('Connect Error: ' + error.toString());
        reconnect();
    });
    client.on('connect', function (con) {
        connection = con;
        connectBackoff = 1;
        console.log('WebSocket Client Connected to: ' + uri);
        onConnectSuccess(connection);
        connectCallbacks.forEach(function (callback) {
            callback();
        });
        connection.on('error', function (error) {
            console.log("Connection Error: " + error.toString());
            reconnect();
        });
        connection.on('close', function () {
            console.log('event-stream Connection Closed');
            reconnect();
        });
        connection.on('message', function (message) {
            if (message.type === 'utf8') {
                //console.log("Received: '" + message.utf8Data + "'");
                try {
                    return handleMessage(JSON.parse(message.utf8Data)).catch(function (err) {
                        console.error(err);
                    });
                } catch (exception) {
                    console.error("Failed to handle message: " + message.utf8Data, exception.stack);
                }
            } else {
                console.warn("Unknown message type: " + message.type);
            }
        });
    });

    function init() {
        console.log("Initializing...");
        var configData = {
            "devices": config.devices,
            "tanks": config.tanks,
            "valves": config.valves,
            "vacuum": config.vacuum,
            "pumps": config.pumps
            // "temperatures": config.temperatures
        };
        if (fs.existsSync(filename)) {
            console.log("Data exists");
            console.log("Loading " + filename);
            return readFile(filename, 'utf8').then(JSON.parse).then(function (dashData) {
                return load(configData, dashData);
            });
        } else {
            console.log("Dashboard data not found. Initializing.");
            return load(configData, configData);
        }
    }

    function getData() {
        return {
            "devices": devices,
            "tanks": tanks.map(extendTank),
            "valves": valves,
            "vacuum": vacuumSensors,
            "pumps": pumps.map(extendPump)
            // "temperatures": temperatures
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
        pump.T2ONtime = pump.ONtime;
        return pump;
    }

    function extendValve(valve) {
        valve = _.extend({}, valve);
        valve_name = valve.code;
        valve_position = valve.position;
        return valve;
    }

    function load(config, data) {
        console.log("Configuration:", data);
        devices = config.devices.map(function (dev) {
            var deviceData = data.devices.filter(function (devData) {
                return devData.id === dev.id;
            }).shift();
            if (!deviceData) {
                deviceData = {};
            }
            console.log("Loading configured device '%s' - '%s' (%s) at %s,%s", dev.name, dev.description, dev.id, deviceData.generationId, deviceData.lastEventSerial);
            return new Device(dev.id, dev.name, deviceData.generationId, deviceData.lastEventSerial, dev.maxDelayMinutes, dev.eventName, dev.retired);
        });

        tanks = config.tanks.map(function (tank) {
            var tankData = data.tanks.filter(function (tankData) {
                return tank.code === tankData.code;
            }).shift();
            console.log("Loading configured tank '%s' - '%s' with raw level of %s, last updated at %s", tank.code, tank.name, tank.rawValue, tank.lastUpdatedAt);
            var attrsFromConfig = ['name', 'device', 'shape', 'orientation', 'length', 'diameter', 'sensorHeight', 'totalHeight'];
            return new Tank(_.extend(tank, _.omit(tankData, attrsFromConfig)));
        });

        valves = config.valves.map(function (valve) {
            var valveData = data.valves.filter(function (valveData) {
                return valve.code === valveData.code;
            }).shift();
            console.log("Loading configured valve '%s' on device '%s'", valve.code, valve.device);
            return _.extend(valve, _.omit(valveData, 'code', 'name', 'device'));
        });

        vacuumSensors = config.vacuum.map(function (sensor) {
            var sensorData = data.vacuum.filter(function (sensorData) {
                return sensor.code === sensorData.code;
            }).shift();
            if (!data.vacuum) {
                return sensor;
            }
            console.log("Loading configured vacuum sensor '%s' on device '%s'", sensor.code, sensor.device);
            return _.extend(sensor, _.omit(sensorData, 'code', 'device'));
        });

        pumps = config.pumps.map(function (pump) {
            pump = new Pump(pump);
            if (!data.pumps) {
                return pump;
            }
            var pumpData = data.pumps.filter(function (pumpData) {
                return pump.code === pumpData.code;
            }).shift();
            pump.load(pumpData);
            return pump;
        });
    }

    function store() {
        const dataString = JSON.stringify(getData(), null, 2);
        var events = eventsSinceStore;
        // console.log("Writing to %s after %d events.", filename, events);
        return writeFile(filename, dataString, "utf8").then(function () {
            // Counter may be incremented if a message was received while storing.
            eventsSinceStore = eventsSinceStore - events;
            console.log("Wrote " + filename + " with " + events + " new events.");
        }).catch(function (err) {
            console.error(err);
        });
    }

    function checkStore() {
        if (eventsSinceStore > 100) {
            stop();
            store();
            start();
        }
    }

    var storeInterval;

    function start() {
        storeInterval = setInterval(checkStore, 1000 * 5);
    }

    function stop() {
        clearInterval(storeInterval);
    }

    return {
        "init": function () {
            return init();
        },
        "connect": function (callback) {
            connect();
            if (callback) {
                connectCallbacks.push(callback);
            }
            return connectPromise;
        },
        "onConnect": function (callback) {
            // TODO ??
        },
        "subscribe": function () {
            subscribe();
        },
        "update": function () {
            return getDevices().then(function (devices) {
                console.log("Updating " + devices.length + " devices");
                devices.forEach(function (device) {
                    requestEvents(device);
                });
            }).catch(function (err) {
                console.error(err);
            });
        },
        "start": function () {
            return start();
        },
        "getDevice": getDevice,
        "getTank": getTank,
        "getValve": getValveByCode,
        "getVacuumSensorByCode": getVacuumSensorByCode,
        "getVacuumSensorOfLineVacuumDevice": getVacuumSensorOfLineVacuumDevice,
        "getData": getData,
        "getEventsSinceStore": function () {
            return eventsSinceStore;
        },
        "onChange": function (listener) {
            listeners.push(listener);
        },
        "onQueryComplete": function (callback) {
            queryCompleteCallbacks.push(callback);
        }
    }
};
