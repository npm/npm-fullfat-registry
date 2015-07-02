var test = require('tap').test
var parse = require('parse-json-response')
var FF = require('../fullfat.js')
var url = require('url')
var http = require('http')
var ff

test('put a missing doc in there', function (t) {
  var testPkg = require('./fixtures/test-package-missing.json')

  var body = new Buffer(JSON.stringify(testPkg))
  var u = url.parse('http://admin:admin@localhost:15984/skim/test-package-missing')
  u.method = 'PUT'
  u.headers = {
    'content-type': 'application/json',
    'content-length': body.length,
    connection: 'close'
  }
  http.request(u, function (res) {
    t.equal(res.statusCode, 201)
    var c = ''
    res.setEncoding('utf8')
    res.on('data', function (chunk) {
      c += chunk
    })
    res.on('end', function () {
      c = JSON.parse(c)
      t.has(c, { ok: true, id: 'test-package-missing' })
      t.end()
    })
  }).end(body)
})

test('follower', function (t) {
  var sawStart = false
  var sawPut = false

  ff = new FF({
    fat: 'http://admin:admin@localhost:15984/fat',
    skim: 'http://localhost:15984/skim',
    tmp: __dirname + '/tmp'
  })

  ff.on('start', function () {
    t.notOk(sawStart)
    sawStart = true
    t.notOk(sawPut)
    t.pass('started')
  })

  ff.on('put', function (change, result) {
    if (change.id === 'test-package') {
      return
    }
    t.ok(sawStart)
    t.notOk(sawPut)
    sawPut = true
    t.equal(change.id, 'test-package-missing')
    t.has(result, { ok: true, id: 'test-package-missing' })
  })

  ff.on('error', function (er) {
    console.error('FullFat error', er)
    t.pass('got missing error')
    t.end()
  })

  ff.on('change', function (change) {
    console.error('change', change.id)
  })
})

test('delete problematic record', function (t) {
  var u = 'http://admin:admin@localhost:15984/skim/test-package-missing'
  http.get(u, parse(function (er, data, res) {
    if (er) {
      throw er
    }
    u += '?rev=' + data._rev
    u = url.parse(u)
    u.method = 'DELETE'
    http.request(u, parse(function (er, data, res) {
      if (er) {
        throw er
      }
      t.pass('deleted')
      t.end()
    })).end()
  }))
})

test('close', function (t) {
  ff.destroy()
  t.pass('should end gracefully now.')
  t.end()
})
