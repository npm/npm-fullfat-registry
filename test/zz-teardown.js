// kill the couchdb process that's running as a detached child process
// started by the 00-setup.js test

var fs = require('fs')
var test = require('tap').test
var rimraf = require('rimraf')
var path = require('path')
var couchPidfile = path.resolve(__dirname, 'fixtures', 'couch.pid')
var nodePidfile = path.resolve(__dirname, 'fixtures', 'node.pid')
var logfile = path.resolve(__dirname, 'fixtures', 'couch.log')
var _users = path.resolve(__dirname, 'fixtures', '_users.couch')
var fat = path.resolve(__dirname, 'fixtures', 'fat.couch')
var skim = path.resolve(__dirname, 'fixtures', 'skim.couch')
var tmp = path.resolve(__dirname, 'tmp')
var rep = path.resolve(__dirname, 'fixtures', '_replicator.couch')

test('kill file server', function (t) {
  try {
    var pid = fs.readFileSync(nodePidFile)
  } catch (er) {}

  if (pid) {
    try { process.kill(pid) } catch (er) {
      // ok if already killed
      t.equal(er.code, 'ESRCH')
    }
  }

  t.pass('st is no more')
  t.end()
})

test('craigslist (for getting rid of couches)', function (t) {
  try {
    var pid = fs.readFileSync(couchPidfile)
  } catch (er) {}

  if (pid) {
    try { process.kill(pid) } catch (er) {
      // ok if already killed
      t.equal(er.code, 'ESRCH')
    }
  }
  t.pass('relaxation time is over')
  t.end()
})

test('delete all the files', function(t) {
  var del = [nodePidfile, couchPidfile, logfile, _users, fat, skim, tmp, rep]
  del.forEach(function(file) {
    rimraf.sync(file)
    t.pass('deleted ' + path.basename(file))
  })

  t.pass('files gone')
  t.end()
})
