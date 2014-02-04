var test = require('tap').test
var FF = require('../fullfat.js')
var url = require('url')
var http = require('http')
var ff

test('follower', function(t) {
  var sawStart = false
  var sawPut = false

  ff = new FF({
    fat: 'http://admin:admin@localhost:15984/fat',
    skim: 'http://localhost:15984/skim',
    tmp: __dirname + '/tmp'
  })

  ff.on('start', function() {
    t.notOk(sawStart)
    sawStart = true
    t.notOk(sawPut)
    t.pass('started')
  })

  ff.on('put', function(change, result) {
    t.ok(sawStart)
    t.notOk(sawPut)
    sawPut = true
    t.equal(change.id, 'test-package')
    t.has(result, { ok: true, id: 'test-package' })
    t.end()
  })

  ff.on('error', function(er) {
    console.error('FullFat error', er)
    throw er
  })

  ff.on('change', function(change) {
    console.error('change', change.id)
  })
})

test('check pkg root doc', function(t) {
  var expect = require('./fixtures/expect.json')
  var u = 'http://localhost:15984/fat/_design/app/_rewrite/test-package'
  var opt = url.parse(u)
  opt.headers = { connection: 'close' }
  var req = http.get(opt, function(res) {
    t.equal(res.statusCode, 200)
    var json = ''
    res.setEncoding('utf8')
    res.on('data', function(c) { json += c })
    res.on('end', function() {
      res.connection.destroy()
      req.connection.destroy()
      req.abort()
      var data = JSON.parse(json)
      // this is always different anyway
      expect._rev = data._rev
      t.same(data, expect)
      t.end()
    })
  })
})

test('close', function(t) {
  ff.destroy()
  t.pass('should end gracefully now.')
  t.end()
})
