var fs = require('fs');
var moment = require('moment');
var Promise = require('promise');
var readFile = Promise.denodeify(fs.readFile);
var WebSocketClient = require('websocket').client;
var ExportConfig = require('./config.json');
var config = require(ExportConfig.dashboardConfig.filename);
var sqlite3 = require('sqlite3').verbose();
var chalk = require('chalk');
var dbFile = ExportConfig.database || 'data.sqlite3';
const util = require('util');

function ensureDatabase() {
	return new Promise(function(resolve, reject) {
		fs.open(dbFile, 'r', function(err, fd) {
			if (err) {
				console.log(chalk.gray("Creating database: %s"), dbFile);
				readFile('schema.sql', 'utf8').then(createDatabase).then(resolve, reject);
			} else {
				console.log(chalk.gray("Using existing database: %s"), dbFile);
				resolve(new sqlite3.Database(dbFile, sqlite3.OPEN_READWRITE));
			}
		});
	});
}

function createDatabase(schema) {
	return new Promise(function(resolve, reject) {
		var db = new sqlite3.Database(dbFile);
		db.serialize(function() {
			db.exec(schema, function(err) {
				if (err != null) {
					reject(err);
				} else {
					resolve(db);
				}
			});
		});
	});
}

function liters2gallons(liters) {
	return Math.ceil(liters / 4.54609188);
}

var dashboard = require('./dashboard.js').Dashboard(config, WebSocketClient);
dashboard.init().then(function() {
	return dashboard.connect(function() {
	  // Connect & reconnect callback
    // TODO: Don't update from last state from dashboard.json, but instead from DATABASE
    // (or commit transaction only after writing dashboard.json)
    return dashboard.update();
  });
  dashboard.start();
}).catch(function(err) {
	console.error("Error starting dashboard: ", err.stack);
});
var express = require('express');
var path = require('path');
var app = express();
app.use(app.router);
app.use(express.logger());
app.use(express.static(path.join(__dirname, 'public')));

function insertData(db, event, device) {
	var deviceId = event.coreid;
	var deviceName = device.name;
  const eventName = event.data.eName;
	// console.log("got event " + eventName + " from device: " + deviceName, event);

	if (eventName === "Vacuum/Lignes") {
		var publishDate = new Date(event.published_at).getTime();
	} else {
		var publishDate = 1000 * event.data.timestamp;
	}

  function runSql(sql, params, complete, reject) {
    console.log(sql, params);
    db.serialize(function() {
      db.run(sql, params, function(result) {
        if (result == null) {
          complete();
        } else {
          reject(result);
        }
      });
    });
  }

  // Handle pump start/stop events
	if (event.data.eName === "pump/T1" || event.data.eName === "pump/T2") {
		return new Promise(function(complete, reject) {
			var eventType = (event.data.eData === 0) ? "start" : "stop";
			var sql = "INSERT INTO pumps (device_id, device_name, published_at, temps_mesure, event_type) VALUES (?, ?, ?, ?, ?)";
			var params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), eventType];
      runSql(sql, params, complete, reject);
		}).catch(function(err) {
			console.log("Error inserting data", err);
			throw err;
		});
		// Handle fin de cycle events
	} else if (eventName === "pump/endCycle") {
		return new Promise(function(complete, reject) {
			//event.data.eData;
			var dutycycle = event.data.eData / 1000;
			var rate = event.object.capacity_gph * event.object.duty;
			var ONtime = Math.abs(event.object.T2ONtime);
			var volume_gal = ONtime * event.object.capacity_gph / 3600;
			var volume_total = event.object.volume;
			var sql = "INSERT INTO cycles (device_id, device_name, end_time, fin_cycle, pump_on_time, volume, volume_total, dutycycle, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
			var params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), ONtime, volume_gal, volume_total, dutycycle, rate];
      runSql(sql, params, complete, reject);
		}).catch(function(err) {
			console.log("Error inserting data", err);
			throw err;
		});
		// Handle "pump/debutDeCoulee" and "pump/finDeCoulee" events
	} else if (eventName === "pump/debutDeCoulee" || eventName === "pump/finDeCoulee") {
		return new Promise(function(complete, reject) {
			var volume_gal = event.object.volume;
			var eventType = (event.data.eData === 1) ? "start" : "stop";
			var sql = "INSERT INTO coulee (device_id, device_name, start_stop_time, temps_debut_fin ,event_type, volume) VALUES (?, ?, ?, ?, ?, ?)";
			var params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), eventType, volume_gal];
      runSql(sql, params, complete, reject);
		}).catch(function(err) {
			console.log("Error inserting data", err);
			throw err;
		});
		// Handle "sensor/level" events
	} else if (eventName === "sensor/level") {
		return new Promise(function(complete, reject) {
			if (event.object) {
        var fill_gallons = liters2gallons(event.object.fill);
        var fill_percent = event.object.fill / event.object.capacity;
        var sql = "INSERT INTO tanks (device_id, device_name, published_at, temps_mesure, fill_gallons, fill_percent) VALUES (?, ?, ?, ?, ?, ?)";
        var params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), fill_gallons, fill_percent];
        runSql(sql, params, complete, reject);
      } else {
				console.warn(util.format("Got sensor/level from device %s, but tank is undefined", event.coreid), event);
			}
		}).catch(function(err) {
			console.log("Error inserting data", err);
			throw err;
		});
	} else if (eventName === "sensor/vacuum") {
		return new Promise(function(complete, reject) {
			var mm_hg = event.data.eData / 100;
			var sql = "INSERT INTO vacuum (device_id, device_name, published_at, temps_mesure, mm_hg ) VALUES (?, ?, ?, ?, ?)";
			var params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), mm_hg];
      runSql(sql, params, complete, reject);
		}).catch(function(err) {
			console.log("Error inserting data", err);
			throw err;
		});
	} else if (eventName === "Vacuum/Lignes") {
		return new Promise(function(complete, reject) {
			var data = event.data;
			for (var i = 0; i < 4; i++) {
				try {
					var sensor = dashboard.getVacuumSensorOfLineVacuumDevice(device, i);
          if (sensor !== undefined){
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
			var sql = "INSERT INTO linevacuum (device_id, device_name, published_at, temps_mesure, line_name, mm_hg, Vin, light, soc, volt, temp, rssi, qual ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
			var params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), line_name, mm_hg, Vin, light, soc, volt, temp, rssi, qual];
      runSql(sql, params, complete, reject);
		}).catch(function(err) {
			console.log("Error inserting data", err);
			throw err;
		});
	} else if (eventName === "sensor/Valve1Pos" || eventName === "sensor/Valve2Pos") {
		return new Promise(function(complete, reject) {
			//event.data.eData;
			var valve_name = event.object.code;
			var position = event.object.position;
			var posToCode = {"Fermé": 0, "Ouvert": 1, "Partiel": 2, "Erreur": 3};
			var position_code = posToCode.position;
			var sql = "INSERT INTO valves (device_id, device_name, published_at, temps_mesure, valve_name, position ) VALUES (?, ?, ?, ?, ?,?)";
			var params = [deviceId, deviceName, publishDate, moment(publishDate).format("YYYY-MM-DD HH:mm:ss"), valve_name, position];
      runSql(sql, params, complete, reject);
		}).catch(function(err) {
			console.log("Error inserting data", err);
			throw err;
		});
	}
}

function startApp(db) {
	var http = require('http');
	var port = ExportConfig.port || '3003';
	app.set('port', port);
	app.get('/pumps.csv', function(req, res) {
		res.setHeader("Content-Type", "text/plain");
		return new Promise(function(complete, reject) {
			db.serialize(function() {
				res.write("device_id \tdevice_name \tpublished_at \tevent_type" + '\n');
				var sql = "select * from pumps";
				db.each(sql, function(err, row) {
					res.write(row.device_id + '\t');
					res.write(row.device_name + '\t');
					res.write(moment(row.published_at).format("YYYY-MM-DD HH:mm:ss") + '\t');
					res.write(row.event_type + '\t');
					res.write('\n');
				}, function() {
					res.end();
				});

			});
		});
	});
	app.get('/tanks.csv', function(req, res) {
		res.setHeader("Content-Type", "text/plain");
		return new Promise(function(complete, reject) {
			db.serialize(function() {
				res.write("device_id \tdevice_name \tpublished_at \fill_gallons \tfill_percent" + '\n');
				var sql = "select * from tanks";
				db.each(sql, function(err, row) {
					res.write(row.device_id + '\t');
					res.write(row.device_name + '\t');
					res.write(moment(row.published_at).format("YYYY-MM-DD HH:mm:ss") + '\t');
					res.write(row.fill_gallons + '\t');
					res.write(row.fill_percent + '\t');
					res.write('\n');
				}, function() {
					res.end();
				});

			});
		});
	});
	app.get('/cycles.csv', function(req, res) {
		res.setHeader("Content-Type", "text/plain");
		return new Promise(function(complete, reject) {
			db.serialize(function() {
				res.write("device_id \tdevice_name \tend_time \tpump_on_time(sec) \tvolume \tdutycycle \trate" + '\n');
				var sql = "select * from cycles";
				db.each(sql, function(err, row) {
					res.write(row.device_id + '\t');
					res.write(row.device_name + '\t');
					res.write(moment(row.end_time).format("YYYY-MM-DD HH:mm:ss") + '\t');
					res.write(row.pump_on_time + '\t');
					res.write(row.volume + '\t');
					res.write(row.dutycycle + '\t');
					res.write(row.rate + '\t');
					res.write('\n');
				}, function() {
					res.end();
				});

			});
		});
	});
	app.get('/coulee.csv', function(req, res) {
		res.setHeader("Content-Type", "text/plain");
		return new Promise(function(complete, reject) {
			db.serialize(function() {
				res.write("device_id \tdevice_name \tstart_stop_time \tevent_type \tvolume" + '\n');
				var sql = "select * from coulee";
				db.each(sql, function(err, row) {
					res.write(row.device_id + '\t');
					res.write(row.device_name + '\t');
					res.write(moment(row.start_stop_time).format("YYYY-MM-DD HH:mm:ss") + '\t');
					res.write(row.event_type + '\t');
					res.write(row.volume + '\t');
					res.write('\n');
				}, function() {
					res.end();
				});

			});
		});
	});
	app.get('/data.json', function(req, res) {
		res.setHeader("Content-Type", "text/plain");
		res.send(JSON.stringify(dashboard.getData(), null, 2));
	});

	var server = http.createServer(app);
	dashboard.onChange(function(data, event, device) {
		insertData(db, event, device);
	});
	server.listen(port);
	console.log('HTTP Server started: http://localhost:' + port);
}
ensureDatabase().then(startApp).catch(function(err) {
	console.error(chalk.red(err));
});
