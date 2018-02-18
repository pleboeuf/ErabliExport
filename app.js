var fs = require('fs');
var moment = require('moment');
var Promise = require('promise');
var readFile = Promise.denodeify(fs.readFile);
var WebSocketClient = require('websocket').client;
var config = require('./config.json');
var sqlite3 = require('sqlite3').verbose();
var chalk = require('chalk');
var dbFile = config.database || 'data.sqlite3';

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

var dashboard = require('./dashboard.js').Dashboard(config, WebSocketClient);
dashboard.init().then(function() {
  return dashboard.connect().then(function() {
    dashboard.start();
    return dashboard.update();
  });
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
  console.log("got event", event.data.eName);
  var deviceId = event.coreid;
  var deviceName = device.name;
  var timerMs = event.data.timer / 1000;
  var t_frac = timerMs - parseInt(timerMs);
  var publishDate = event.data.timestamp + t_frac;
  // Handle pump start/stop events
  if (event.data.eName === "pump/T1" || event.data.eName === "pump/T2") {
    return new Promise(function(complete, reject) {
      var eventType = (event.data.eData === 0) ? "start" : "stop";
      var sql = "INSERT INTO pumps (device_id, device_name, published_at, event_type) VALUES (?, ?, ?, ?)";
      var params = [deviceId, deviceName, publishDate, eventType];
      db.serialize(function() {
        db.run(sql, params, function(result) {
          if (result == null) {
            complete();
          } else {
            reject(result);
          }
        });
      });
    }).catch(function(err) {
      console.log("Error inserting data", err);
      throw err;
    });
  // Handle fin de cycle events
  } else if (event.data.eName === "pump/endCycle") {
    return new Promise(function(complete, reject) {
        //event.data.eData;
        var dutycycle = event.data.eData /1000;
        var rate = event.object.capacity_gph * event.object.duty;
        var ONtime = event.object.T2ONtime;
        var volume_gal = event.object.ONtime * event.object.capacity_gph / 3600;
        var sql = "INSERT INTO cycles (device_id, device_name, end_time, pump_on_time, volume, dutycycle, rate) VALUES (?, ?, ?, ?, ?, ?, ?)";
        var params = [deviceId, deviceName, publishDate, ONtime, volume_gal, dutycycle, rate];
        db.serialize(function() {
            db.run(sql, params, function(result) {
                if (result == null) {
                    complete();
                } else {
                    reject(result);
                }
            });
        });
    }).catch(function(err) {
        console.log("Error inserting data", err);
        throw err;
    });
  // Handle "pump/debutDeCoulee" and "pump/finDeCoulee" events
} else if (event.data.eName === "pump/debutDeCoulee" || event.data.eName === "pump/finDeCoulee") {
    return new Promise(function(complete, reject) {
        var volume_gal = event.object.volume;
        var eventType = (event.data.eData === 1) ? "start" : "stop";
        var sql = "INSERT INTO coulee (device_id, device_name, start_stop_time ,event_type, volume) VALUES (?, ?, ?, ?, ?)";
        var params = [deviceId, deviceName, publishDate, eventType, volume_gal];
        db.serialize(function() {
            db.run(sql, params, function(result) {
                if (result == null) {
                    complete();
                } else {
                    reject(result);
                }
            });
        });
    }).catch(function(err) {
        console.log("Error inserting data", err);
        throw err;
    });
  // Handle "sensor/level" events
  } else if (event.data.eName === "sensor/level") {
    return new Promise(function(complete, reject) {
        //event.data.eData;
        var fill_gallons = event.object.fill * 4.28;
        var fill_percent = event.object.fill / event.object.capacity;
        var sql = "INSERT INTO tanks (device_id, device_name, published_at, fill_gallons, fill_percent) VALUES (?, ?, ?, ?, ?)";
        var params = [deviceId, deviceName, publishDate, fill_gallons, fill_percent];
        db.serialize(function() {
            db.run(sql, params, function(result) {
                if (result == null) {
                    complete();
                } else {
                    reject(result);
                }
            });
        });
    }).catch(function(err) {
        console.log("Error inserting data", err);
        throw err;
    });
  }
}

function startApp(db) {
  var http = require('http');
  var port = config.port || '3000';
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
                  res.write(moment(row.published_at * 1000).format("YYYY-MM-DD HH:mm:ss") + '\t');
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
                  res.write(moment(row.published_at * 1000).format("YYYY-MM-DD HH:mm:ss") + '\t');
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
                  res.write(moment(row.end_time * 1000).format("YYYY-MM-DD HH:mm:ss") + '\t');
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
                  res.write(moment(row.start_stop_time * 1000).format("YYYY-MM-DD HH:mm:ss") + '\t');
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
