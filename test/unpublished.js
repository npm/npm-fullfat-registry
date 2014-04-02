var test = require('tap').test
var parse = require('parse-json-response')
var FF = require('../fullfat.js')
var url = require('url')
var http = require('http')
var ff

test('create unpublished test record', function(t) {
  var testPkg = require('./fixtures/unpublished.json')

  var body = new Buffer(JSON.stringify(testPkg))
  var u = url.parse('http://admin:admin@localhost:15984/skim/hades')
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
      t.has(c, { ok: true, id: 'hades' })
      t.end()
    })
  }).end(body)
})

test('follower', function(t) {
  var sawStart = false
  var sawPut = false
  var sawError = false

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

  ff.on('error', function(er) {
    // Make sure that it's just an error 
    t.equal(er.message, 'Error fetching attachment: http://localhost:18080/test-package-0.0.1.tgz')
    t.ok('saw error for other package')
  })

  ff.on('put', function(change, result) {
    if (change.id !== 'hades')
      return
    t.ok(sawStart)
    t.notOk(sawPut)
    sawPut = true
    t.equal(change.id, 'hades')
    t.has(result, { ok: true, id: 'hades' })
    t.end()
  })

  ff.on('change', function(change) {
    console.error('change', change.id)
  })
})

test('verify unpublished in fullfat', function(t) {
  var u = 'http://admin:admin@localhost:15984/fat/hades'
  var expect = require('./fixtures/unpublished.json')
  http.get(u, parse(function(er, data, res) {
    if (er)
      throw er
    t.has(data, expect)
    t.end()
  }))
})

test('close', function(t) {
  ff.destroy()
  t.pass('should end gracefully now.')
  t.end()
})
