// start the couchdb spinning as a detached child process.
// the zz-teardown.js test kills it.

var spawn = require('child_process').spawn
var test = require('tap').test
var path = require('path')
var fs = require('fs')
var http = require('http')
var url = require('url')

// just in case it was still alive from a previous run, kill it.
require('./zz-teardown.js')

// run with the cwd of the main program.
var cwd = path.dirname(__dirname)

var conf = path.resolve(__dirname, 'fixtures', 'couch.ini')
var couchPidfile = path.resolve(__dirname, 'fixtures', 'couch.pid')
var stPidfile = path.resolve(__dirname, 'fixtures', 'node.pid')
var logfile = path.resolve(__dirname, 'fixtures', 'couch.log')
var started = /Apache CouchDB has started on http:\/\/127\.0\.0\.1:15984\/\n$/

var _users = path.resolve(__dirname, 'fixtures', '_users.couch')
var db = path.resolve(__dirname, 'fixtures', 'registry.couch')

test('start couch as a zombie child', function (t) {
  var fd = fs.openSync(couchPidfile, 'wx')

  try { fs.unlinkSync(logfile) } catch (er) {}

  var child = spawn('couchdb', ['-a', conf], {
    detached: true,
    stdio: 'ignore',
    cwd: cwd
  })
  child.unref()
  t.ok(child.pid)
  fs.writeSync(fd, child.pid + '\n')
  fs.closeSync(fd)

  // wait for it to create a log, give it 5 seconds
  var start = Date.now()
  fs.readFile(logfile, function R (er, log) {
    log = log ? log.toString() : ''
    if (!er && !log.match(started))
      er = new Error('not started yet')
    if (er) {
      if (Date.now() - start < 5000)
        return setTimeout(function () {
          fs.readFile(logfile, R)
        }, 100)
      else
        throw er
    }
    t.pass('relax')
    t.end()
  })
})

test('start file server as zombie child', function (t) {
  var fd = fs.openSync(stPidfile, 'wx')

  var cwd = path.resolve(__dirname, 'fixtures')
  var child = spawn('st', [ '-p', '18080' ], {
    detached: true,
    stdio: 'ignore',
    cwd: cwd
  })
  child.unref()
  t.ok(child.pid)
  fs.writeSync(fd, child.pid + '\n')

  // no need to wait.  by the time we've PUT the dbs,
  // it'll be ready to go.
  t.pass('files serving')
  t.end()
})

test('create fat db', function(t) {
  var u = url.parse('http://localhost:15984/fat')
  var u = url.parse('http://admin:admin@localhost:15984/fat')
  u.method = 'PUT'
  http.request(u, function(res) {
    t.equal(res.statusCode, 201)
    var c = ''
    res.setEncoding('utf8')
    res.on('data', function(chunk) {
      c += chunk
    })
    res.on('end', function() {
      c = JSON.parse(c)
      t.same(c, { ok: true })
      t.end()
    })
  }).end()
})

test('create skim db', function(t) {
  var u = url.parse('http://admin:admin@localhost:15984/skim')
  u.method = 'PUT'
  http.request(u, function(res) {
    t.equal(res.statusCode, 201)
    var c = ''
    res.setEncoding('utf8')
    res.on('data', function(chunk) {
      c += chunk
    })
    res.on('end', function() {
      c = JSON.parse(c)
      t.same(c, { ok: true })
      t.end()
    })
  }).end()
})

test('create skim db design doc', function(t) {
  var u = url.parse('http://admin:admin@localhost:15984/skim/_design/app')
  u.method = 'PUT'
  var d = fs.readFileSync(__dirname + '/fixtures/design.json')
  u.headers = {
    'content-type': 'application/json',
    'content-length': d.length,
    'connection': 'close'
  }
  http.request(u, function (res) {
    t.equal(res.statusCode, 201)
    var c = ''
    res.setEncoding('utf8')
    res.on('data', function(chunk) {
      c += chunk
    })
    res.on('end', function() {
      c = JSON.parse(c)
      t.has(c, { ok: true, id: "_design/app" })
      t.end()
    })
  }).end(d)
})

test('create test record', function(t) {
  var testPkg = require('./fixtures/test-package.json')

  var body = new Buffer(JSON.stringify(testPkg))
  var u = url.parse('http://admin:admin@localhost:15984/skim/test-package')
  u.method = 'PUT'
  u.headers = {
    'content-type': 'application/json',
    'content-length': body.length,
    connection: 'close'
  }
  http.request(u, function(res) {
    t.equal(res.statusCode, 201)
    var c = ''
    res.setEncoding('utf8')
    res.on('data', function(chunk) {
      c += chunk
    })
    res.on('end', function() {
      c = JSON.parse(c)
      t.has(c, { ok: true, id: 'test-package' })
      t.end()
    })
  }).end(body)
})
