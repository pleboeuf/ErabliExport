var fs = require('fs');
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
  console.error("Error stating dashboard: ", err.stack);
});
var express = require('express');
var path = require('path');
var app = express();
app.use(app.router);
app.use(express.logger());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/data.csv', function(req, res) {
  res.setHeader("Content-Type", "text/plain");
  res.send("C,S,V");
});
function publishData(event) {
  console.log("got event", event);
}
var http = require('http');
var port = config.port || '3000';
app.set('port', port);
var server = http.createServer(app);
dashboard.onChange(function(data, event) {
  publishData(event);
});
server.listen(port);
console.log('HTTP Server started: http://localhost:' + port);

ensureDatabase().catch(function(err) {
  console.error(chalk.red(err));
});