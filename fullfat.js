var follow = require('follow')
var fs = require('fs')
var EE = require('events').EventEmitter
var util = require('util')
var url = require('url')
var path = require('path')
var tmp = path.resolve(__dirname, 'tmp')
var mkdirp = require('mkdirp')
var rimraf = require('rimraf')
var assert = require('assert')
var stream = require('stream')
var util = require('util')
var crypto = require('crypto')
var once = require('once')
var parse = require('parse-json-response')
var hh = require('http-https')

var version = require('./package.json').version
var ua = 'npm FullFat/' + version + ' node/' + process.version
var readmeTrim = require('npm-registry-readme-trim')

util.inherits(FullFat, EE)

module.exports = FullFat

function FullFat(conf) {
  if (!conf.skim || !conf.fat) {
    throw new Error('skim and fat database urls required')
  }

  this.skim = url.parse(conf.skim).href
  this.skim = this.skim.replace(/\/+$/, '')

  var f = url.parse(conf.fat)
  this.fat = f.href
  this.fat = this.fat.replace(/\/+$/, '')
  delete f.auth
  this.publicFat = url.format(f)
  this.publicFat = this.publicFat.replace(/\/+$/, '')

  this.registry = null
  if (conf.registry) {
    this.registry = url.parse(conf.registry).href
    this.registry = this.registry.replace(/\/+$/, '')
  }

  this.ua = conf.ua || ua
  this.inactivity_ms = conf.inactivity_ms || 1000 * 60 * 60
  this.seqFile = conf.seq_file
  this.writingSeq = false
  this.error = false
  this.since = 0
  this.follow = null

  // set to true to log missing attachments only.
  // otherwise, emits an error.
  this.missingLog = conf.missing_log || false

  this.whitelist = conf.whitelist || [ /.*/ ]

  this.tmp = conf.tmp
  if (!this.tmp) {
    var rand = crypto.randomBytes(6).toString('hex')
    this.tmp = path.resolve('npm-fullfat-tmp-' + process.pid + '-' + rand)
  }

  this.boundary = 'npmFullFat-' + crypto.randomBytes(6).toString('base64')

  this.readSeq(this.seqFile)
}

FullFat.prototype.readSeq = function(file) {
  if (!this.seqFile)
    process.nextTick(this.start.bind(this))
  else
    fs.readFile(file, 'ascii', this.gotSeq.bind(this))
}

FullFat.prototype.gotSeq = function(er, data) {
  if (er && er.code === 'ENOENT')
    data = '0'
  else if (er)
    return this.emit('error', er)

  data = +data || 0
  this.since = data
  this.start()
}

FullFat.prototype.start = function() {
  if (this.follow)
    return this.emit('error', new Error('already started'))

  this.emit('start')
  this.follow = follow({
    db: this.skim,
    since: this.since,
    inactivity_ms: this.inactivity_ms
  }, this.onchange.bind(this))
  this.follow.on('error', this.emit.bind(this, 'error'))
}

FullFat.prototype._emit = function(ev, arg) {
  // Don't emit errors while writing seq
  if (ev === 'error' && this.writingSeq) {
    this.error = arg
  } else {
    EventEmitter.prototype.emit.apply(this, arguments)
  }
}

FullFat.prototype.writeSeq = function() {
  var seq = +this.since
  if (this.seqFile && !this.writingSeq && seq > 0) {
    var data = seq + '\n'
    var file = this.seqFile + '.' + seq
    this.writingSeq = true
    fs.writeFile(file, data, 'ascii', function(writeEr) {
      var er = this.error
      if (er)
        this.emit('error', er)
      else if (!writeEr) {
        fs.rename(file, this.seqFile, function(mvEr) {
          this.writingSeq = false
          var er = this.error
          if (er)
            this.emit('error', er)
          else if (!mvEr)
            this.emit('sequence', seq)
        }.bind(this))
      }
    }.bind(this))
  }
}

FullFat.prototype.onchange = function(er, change) {
  if (er)
    return this.emit('error', er)

  if (!change.id)
    return

  this.pause()
  this.since = change.seq

  this.emit('change', change)

  if (change.deleted)
    this.delete(change)
  else
    this.getDoc(change)
}

FullFat.prototype.getDoc = function(change) {
  var q = '?revs=true&att_encoding_info=true'
  var opt = url.parse(this.skim + '/' + change.id + q)
  opt.method = 'GET'
  opt.headers = {
    'user-agent': this.ua,
    'connection': 'close'
  }

  var req = hh.get(opt)
  req.on('error', this.emit.bind(this, 'error'))
  req.on('response', parse(this.ongetdoc.bind(this, change)))
}

FullFat.prototype.ongetdoc = function(change, er, data, res) {
  if (er)
    this.emit('error', er)
  else {
    change.doc = data
    if (change.id.match(/^_design\//))
      this.putDesign(change)
    else if (data.time && data.time.unpublished)
      this.unpublish(change)
    else
      this.putDoc(change)
  }
}

FullFat.prototype.unpublish = function(change) {
  change.fat = change.doc
  this.put(change, [])
}

FullFat.prototype.putDoc = function(change) {
  var q = '?revs=true&att_encoding_info=true'
  var opt = url.parse(this.fat + '/' + change.id + q)

  opt.method = 'GET'
  opt.headers = {
    'user-agent': this.ua,
    'connection': 'close'
  }
  var req = hh.get(opt)
  req.on('error', this.emit.bind(this, 'error'))
  req.on('response', parse(this.onfatget.bind(this, change)))
}

FullFat.prototype.putDesign = function(change) {
  var doc = change.doc
  this.pause()
  var opt = url.parse(this.fat + '/' + change.id + '?new_edits=false')
  var b = new Buffer(JSON.stringify(doc), 'utf8')
  opt.method = 'PUT'
  opt.headers = {
    'user-agent': this.ua,
    'content-type': 'application/json',
    'content-length': b.length,
    'connection': 'close'
  }

  var req = hh.request(opt)
  req.on('response', parse(this.onputdesign.bind(this, change)))
  req.on('error', this.emit.bind(this, 'error'))
  req.end(b)
}

FullFat.prototype.onputdesign = function(change, er, data, res) {
  if (er)
    return this.emit('error', er)
  this.emit('putDesign', change, data)
  this.resume()
}

FullFat.prototype.delete = function(change) {
  var name = change.id

  var opt = url.parse(this.fat + '/' + name)
  opt.headers = {
    'user-agent': this.ua,
    'connection': 'close'
  }
  opt.method = 'HEAD'

  var req = hh.request(opt)
  req.on('response', this.ondeletehead.bind(this, change))
  req.on('error', this.emit.bind(this, 'error'))
  req.end()
}

FullFat.prototype.ondeletehead = function(change, res) {
  // already gone?  totally fine.  move on, nothing to delete here.
  if (res.statusCode === 404)
    return this.afterDelete(change)

  var rev = res.headers.etag.replace(/^"|"$/g, '')
  opt = url.parse(this.fat + '/' + change.id + '?rev=' + rev)
  opt.headers = {
    'user-agent': this.ua,
    'connection': 'close'
  }
  opt.method = 'DELETE'
  var req = hh.request(opt)
  req.on('response', parse(this.ondelete.bind(this, change)))
  req.on('error', this.emit.bind(this, 'error'))
  req.end()
}

FullFat.prototype.ondelete = function(change, er, data, res) {
  if (er && er.statusCode === 404)
    this.afterDelete(change)
  else if (er)
    this.emit('error', er)
  else
    // scorch the earth! remove fully! repeat until 404!
    this.delete(change)
}

FullFat.prototype.afterDelete = function(change) {
  this.emit('delete', change)
  this.resume()
}

FullFat.prototype.onfatget = function(change, er, f, res) {
  if (er && er.statusCode !== 404)
    return this.emit('error', er)

  if (er)
    f = JSON.parse(JSON.stringify(change.doc))

  f._attachments = f._attachments || {}
  change.fat = f
  this.merge(change)
}


FullFat.prototype.merge = function(change) {
  var s = change.doc
  var f = change.fat

  // if no versions in the skim record, then nothing to fetch
  if (!s.versions)
    return this.resume()

  // Only fetch attachments if it's on the list.
  var pass = true
  if (this.whitelist.length) {
    pass = false
    for (var i = 0; !pass && i < this.whitelist.length; i++) {
      var w = this.whitelist[i]
      if (typeof w === 'string')
        pass = w === change.id
      else
        pass = w.exec(change.id)
    }
    if (!pass) {
      f._attachments = {}
      return this.fetchAll(change, [], [])
    }
  }

  var need = []
  var changed = false
  for (var v in s.versions) {
    var tgz = s.versions[v].dist.tarball
    var att = path.basename(url.parse(tgz).pathname)
    var ver = s.versions[v]
    f.versions = f.versions || {}

    if (!f.versions[v] || f.versions[v].dist.shasum !== ver.dist.shasum) {
      f.versions[v] = s.versions[v]
      need.push(v)
      changed = true
    } else if (!f._attachments[att]) {
      need.push(v)
      changed = true
    }
  }

  // remove any versions that s removes, or which lack attachments
  for (var v in f.versions) {
    if (!s.versions[v])
      delete f.versions[v]
  }


  for (var a in f._attachments) {
    var found = false
    for (var v in f.versions) {
      var tgz = f.versions[v].dist.tarball
      var b = path.basename(url.parse(tgz).pathname)
      if (b === a) {
        found = true
        break
      }
    }
    if (!found) {
      delete f._attachments[a]
      changed = true
    }
  }

  for (var k in s) {
    if (k !== '_attachments' && k !== 'versions') {
      if (changed)
        f[k] = s[k]
      else if (JSON.stringify(f[k]) !== JSON.stringify(s[k])) {
        f[k] = s[k]
        changed = true
      }
    }
  }

  changed = readmeTrim(f) || changed

  if (!changed)
    this.resume()
  else
    this.fetchAll(change, need, [])
}

FullFat.prototype.put = function(change, did) {
  var f = change.fat
  change.did = did
  // at this point, all the attachments have been fetched into
  // {this.tmp}/{change.id}-{change.seq}/{attachment basename}
  // make a multipart PUT with all of the missing ones set to
  // follows:true
  var boundaries = []
  var boundary = this.boundary
  var bSize = 0

  var attSize = 0
  var atts = f._attachments = f._attachments || {}

  // It's important that we do everything in enumeration order,
  // because couchdb is a jerk, and ignores disposition headers.
  // Still include the filenames, though, so at least we dtrt.
  did.forEach(function(att) {
    atts[att.name] = {
      length: att.length,
      follows: true
    }

    if (att.type)
      atts[att.name].type = att.type
  })

  var send = []
  Object.keys(atts).forEach(function (name) {
    var att = atts[name]

    if (att.follows !== true)
      return

    send.push([name, att])
    attSize += att.length

    var b = '\r\n--' + boundary + '\r\n' +
            'content-length: ' + att.length + '\r\n' +
            'content-disposition: attachment; filename=' +
            JSON.stringify(name) + '\r\n'

    if (att.type)
      b += 'content-type: ' + att.type + '\r\n'

    b += '\r\n'

    boundaries.push(b)
    bSize += b.length
  })

  // one last boundary at the end
  var b = '\r\n--' + boundary + '--'
  bSize += b.length
  boundaries.push(b)

  // put with new_edits=false to retain the same rev
  // this assumes that NOTHING else is writing to this database!
  var p = url.parse(this.fat + '/' + f.name + '?new_edits=false')
  p.method = 'PUT'
  p.headers = {
    'user-agent': this.ua,
    'content-type': 'multipart/related;boundary="' + boundary + '"',
    'connection': 'close'
  }

  var doc = new Buffer(JSON.stringify(f), 'utf8')
  var len = 0

  // now, for the document
  var b = '--' + boundary + '\r\n' +
          'content-type: application/json\r\n' +
          'content-length: ' + doc.length + '\r\n\r\n'
  bSize += b.length

  p.headers['content-length'] = attSize + bSize + doc.length

  var req = hh.request(p)
  req.on('error', this.emit.bind(this, 'error'))
  req.write(b, 'ascii')
  req.write(doc)
  this.putAttachments(req, change, boundaries, send)
  req.on('response', parse(this.onputres.bind(this, change)))
}

FullFat.prototype.putAttachments = function(req, change, boundaries, send) {
  // send is the ordered list of [[name, attachment object],...]
  var b = boundaries.shift()
  var ns = send.shift()

  // last one!
  if (!ns) {
    req.write(b, 'ascii')
    return req.end()
  }

  var name = ns[0]
  req.write(b, 'ascii')
  var file = path.join(this.tmp, change.id + '-' + change.seq, name)
  var fstr = fs.createReadStream(file)

  fstr.on('end', function() {
    this.emit('upload', {
      change: change,
      name: name
    })
    this.putAttachments(req, change, boundaries, send)
  }.bind(this))

  fstr.on('error', this.emit.bind(this, 'error'))
  fstr.pipe(req, { end: false })
}

FullFat.prototype.onputres = function(change, er, data, res) {

  if (!change.id)
    throw new Error('wtf?')

  // In some oddball cases, it looks like CouchDB will report stubs that
  // it doesn't in fact have.  It's possible that this is due to old bad
  // data in a past FullfatDB implementation, but whatever the case, we
  // ought to catch such errors and DTRT.  In this case, the "right thing"
  // is to re-try the PUT as if it had NO attachments, so that it no-ops
  // the attachments that ARE there, and fills in the blanks.
  // We do that by faking the onfatget callback with a 404 error.
  if (er && er.statusCode === 412 &&
      0 === er.message.indexOf('{"error":"missing_stub"') &&
      !change.didFake404){
    change.didFake404 = true
    this.onfatget(change, { statusCode: 404 }, {}, {})
  } else if (er)
    this.emit('error', er)
  else {
    this.emit('put', change, data)
    // Just a best-effort cleanup.  No big deal, really.
    rimraf(this.tmp + '/' + change.id + '-' + change.seq, function() {})
    this.resume()
  }
}

FullFat.prototype.fetchAll = function(change, need, did) {
  var f = change.fat
  var tmp = path.resolve(this.tmp, change.id + '-' + change.seq)
  var len = need.length
  if (!len)
    return this.put(change, did)

  var errState = null

  mkdirp(tmp, function(er) {
    if (er)
      return this.emit('error', er)
    need.forEach(this.fetchOne.bind(this, change, need, did))
  }.bind(this))
}

FullFat.prototype.fetchOne = function(change, need, did, v) {
  var f = change.fat
  var r = url.parse(change.doc.versions[v].dist.tarball)
  if (this.registry) {
    var p = '/' + change.id + '/-/' + path.basename(r.pathname)
    r = url.parse(this.registry + p)
  }

  r.method = 'GET'
  r.headers = {
    'user-agent': this.ua,
    'connection': 'close'
  }

  var req = hh.request(r)
  req.on('error', this.emit.bind(this, 'error'))
  req.on('response', this.onattres.bind(this, change, need, did, v, r))
  req.end()
}

FullFat.prototype.onattres = function(change, need, did, v, r, res) {
  var f = change.fat
  var att = r.href
  var sum = f.versions[v].dist.shasum
  var filename = f.name + '-' + v + '.tgz'
  var file = path.join(this.tmp, change.id + '-' + change.seq, filename)

  // TODO: If the file already exists, get its size.
  // If the size matches content-length, get the md5
  // If the md5 matches content-md5, then don't bother downloading!

  function skip() {
    rimraf(file, function() {})
    delete f.versions[v]
    if (f._attachments)
      delete f._attachments[file]
    need.splice(need.indexOf(v), 1)
    maybeDone(null)
  }

  var maybeDone = function maybeDone(a) {
    if (a)
      this.emit('download', a)
    if (need.length === did.length)
      this.put(change, did)
  }.bind(this)

  // if the attachment can't be found, then skip that version
  // it's uninstallable as of right now, and may or may not get
  // fixed in a future update
  if (res.statusCode !== 200) {
    var er = new Error('Error fetching attachment: ' + att)
    er.statusCode = res.statusCode
    er.code = 'attachment-fetch-fail'
    if (this.missingLog)
      return fs.appendFile(this.missingLog, att + '\n', skip)
    else
      return this.emit('error', er)
  }

  var fstr = fs.createWriteStream(file)

  // check the shasum while we're at it
  var sha = crypto.createHash('sha1')
  var shaOk = false
  var errState = null

  sha.on('data', function(c) {
    c = c.toString('hex')
    if (c === sum)
      shaOk = true
  }.bind(this))

  if (!res.headers['content-length']) {
    var counter = new Counter()
    res.pipe(counter)
  }

  res.pipe(sha)
  res.pipe(fstr)

  fstr.on('error', function(er) {
    er.change = change
    er.version = v
    er.path = file
    er.url = att
    this.emit('error', errState = errState || er)
  }.bind(this))

  fstr.on('close', function() {
    if (errState || !shaOk) {
      // something didn't work, but the error was squashed
      // take that as a signal to just delete this version
      return skip()
    }
    // it worked!  change the dist.tarball url to point to the
    // registry where this is being stored.  It'll be rewritten by
    // the _show/pkg function when going through the rewrites, anyway,
    // but this url will work if the couch itself is accessible.
    var newatt = this.publicFat + '/' + change.id +
                 '/' + change.id + '-' + v + '.tgz'
    f.versions[v].dist.tarball = newatt

    if (res.headers['content-length'])
      var cl = +res.headers['content-length']
    else
      var cl = counter.count

    var a = {
      change: change,
      version: v,
      name: path.basename(file),
      length: cl,
      type: res.headers['content-type']
    }
    did.push(a)
    maybeDone(a)

  }.bind(this))
}

FullFat.prototype.destroy = function() {
  if (this.follow)
    this.follow.die()
}

FullFat.prototype.pause = function() {
  if (this.follow)
    this.follow.pause()
}

FullFat.prototype.resume = function() {
  this.writeSeq()
  if (this.follow)
    this.follow.resume()
}

util.inherits(Counter, stream.Writable)
function Counter(options) {
  stream.Writable.call(this, options)
  this.count = 0
}
Counter.prototype._write = function(chunk, encoding, cb) {
  this.count += chunk.length
  cb()
}
