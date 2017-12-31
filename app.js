var WebSocketClient = require('websocket').client;
var config = require('./config.json');
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
