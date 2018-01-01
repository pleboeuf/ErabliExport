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
  var publishDate = event.data.timestamp;
  if (event.data.eName === "pump/state") {
    return new Promise(function(complete, reject) {
      var eventType = (event.data.eData === 1) ? "start" : "stop";
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
  app.get('/pompes.csv', function(req, res) {
      res.setHeader("Content-Type", "text/plain");
      return new Promise(function(complete, reject) {
          db.serialize(function() {
              var sql = "select * from pompes";
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