var follow = require('follow')
var http = require('http')
var https = require('https')
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
    inactivity_ms: this.inactivity_ms,
    include_docs: true
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
    this.writingSeq = true
    fs.writeFile(this.seqFile, seq + '\n', 'ascii', function(writeEr) {
      this.writingSeq = false
      var er = this.error
      if (er)
        this.emit('error', er)
      else if (!writeEr)
        this.emit('sequence', seq)
    }.bind(this))
  }
}

FullFat.prototype.onchange = function(er, change) {
  if (er)
    return this.emit('error', er)

  this.pause()
  this.since = change.seq

  this.emit('change', change)

  if (change.deleted)
    this.delete(change.id)

  else if (change.id.match(/^_design\//))
    this.putDesign(change.doc)

  else
    this.putDoc(change)
}

FullFat.prototype.putDoc = function(change) {
  var s = change.doc
  var opt = url.parse(this.fat + '/' + s.name)
  opt.method = 'GET'
  opt.headers = {
    'user-agent': this.ua,
    'connection': 'close'
  }
  var httpModule = opt.protocol === 'https:' ? https : http
  var req = httpModule.get(opt)
  req.on('error', this.emit.bind(this, 'error'))
  req.on('response', this.onfatget.bind(this, s))
}

FullFat.prototype.putDesign = function(doc) {
  this.pause()
  var opt = url.parse(this.fat + '/' + doc._id + '?new_edits=false')
  var b = new Buffer(JSON.stringify(doc), 'utf8')
  opt.method = 'PUT'
  opt.headers = {
    'user-agent': this.ua,
    'content-type': 'application/json',
    'content-length': b.length,
    'connection': 'close'
  }

  var httpModule = opt.protocol === 'https:' ? https : http
  var req = httpModule.request(opt)
  req.on('response', this.onputdesign.bind(this, doc))
  req.on('error', this.emit.bind(this, 'error'))
  req.end(b)
}

FullFat.prototype.onputdesign = function(doc, res) {
  parse(res, function(er, data) {
    if (er)
      return this.emit('error', er)
    this.emit('putDesign', doc, data)
    this.resume()
  }.bind(this))
}

FullFat.prototype.delete = function(name) {
  this.pause()

  var opt = url.parse(this.fat + '/' + name)
  opt.headers = {
    'user-agent': this.ua,
    'connection': 'close'
  }
  var httpModule = opt.protocol === 'https:' ? https : http
  opt.method = 'HEAD'

  var req = httpModule.request(opt, function(res) {
    // already gone?  totally fine.  move on, nothing to delete here.
    if (res.statusCode === 404) {
      req.abort()
      return this.resume()
    }

    var rev = res.headers.etag.replace(/^"|"$/g, '')
    opt = url.parse(this.fat + '/' + name + '?rev=' + rev)
    opt.headers = {
      'user-agent': this.ua,
      'connection': 'close'
    }
    opt.method = 'DELETE'
    req = httpModule.request(opt, function(res) {
      parse(res, function(er, data) {
        if (er)
          return this.emit('error', er)
        data.name = name
        this.emit('delete', data)
        this.resume()
      }.bind(this))
    }.bind(this))
    req.on('error', this.emit.bind(this, 'error'))
    req.end()
  }.bind(this))

  req.on('error', this.emit.bind(this, 'error'))
  req.end()
}

FullFat.prototype.onfatget = function(s, res) {
  if (res.statusCode !== 200) {
    // means it's not in the database yet
    var f = JSON.parse(JSON.stringify(s))
    f._attachments = {}
    return this.merge(s, f)
  }

  parse(res, function(er, f) {
    if (er)
      this.emit('error', er)
    else
      this.merge(s, f)
  }.bind(this))
}


FullFat.prototype.merge = function(s, f) {
  // if no versions in the skim record, then nothing to fetch
  if (!s.versions)
    return this.resume()

  f._attachments = f._attachments || {}

  // Only fetch attachments if it's on the list.
  var pass = true
  if (this.whitelist.length) {
    pass = false
    for (var i = 0; !pass && i < this.whitelist.length; i++) {
      var w = this.whitelist[i]
      if (typeof w === 'string')
        pass = w === s.name
      else
        pass = w.exec(s.name)
    }
    if (!pass) {
      f._attachments = {}
      return this.fetchAll(f, [], [])
    }
  }

  var need = []
  var changed = false
  for (var v in s.versions) {
    var att = s.name + '-' + v + '.tgz'
    var ver = s.versions[v]

    if (!f.versions[v] || f.versions[v].dist.shasum !== ver.dist.shasum) {
      f.versions[v] = s.versions[v]
      if (pass)
        need.push(v)
      changed = true
    } else if (pass && !f._attachments[att]) {
      need.push(v)
      changed = true
    }
  }

  for (var a in f._attachments) {
    var v = a.substr(f.name + 1).replace(/\.tgz$/, '')
    if (!pass || !f.versions[v]) {
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
    this.fetchAll(f, need, [])
}

FullFat.prototype.put = function(f, did) {
  // at this point, all the attachments have been fetched into
  // {this.tmp}/{f.name}/{attachment basename}
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

  var httpModule = p.protocol === 'https:' ? https : http
  var req = httpModule.request(p)
  req.on('error', this.emit.bind(this, 'error'))
  req.write(b, 'ascii')
  req.write(doc)
  this.putAttachments(req, f, boundaries, send)
  req.on('response', this.onputres.bind(this, f, req))
}

FullFat.prototype.putAttachments = function(req, f, boundaries, send) {
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
  var file = path.join(this.tmp, f.name, name)
  var fstr = fs.createReadStream(file)

  fstr.on('end', this.putAttachments.bind(this, req, f, boundaries, send))
  fstr.on('error', this.emit.bind(this, 'error'))
  fstr.pipe(req, { end: false })
}

FullFat.prototype.onputres = function(f, req, res) {
  parse(res, function (er, data) {
    if (er)
      return this.emit('error', er)
    this.emit('put', f, data)
    rimraf(this.tmp + '/' + f.name, function() {
      this.resume()
    }.bind(this))
  }.bind(this))
}

FullFat.prototype.fetchAll = function(f, need, did) {
  var tmp = path.resolve(this.tmp, f.name)
  var len = need.length
  var did = []
  if (!len)
    return this.put(f, did)

  var errState = null

  mkdirp(tmp, function(er) {
    if (er)
      return this.emit('error', er)
    need.forEach(this.fetchOne.bind(this, f, need, did))
  }.bind(this))
}

FullFat.prototype.fetchOne = function(f, need, did, v) {
  var r = url.parse(f.versions[v].dist.tarball)
  if (this.registry) {
    var p = '/' + f.name + '/-/' + path.basename(r.pathname)
    r = url.parse(this.registry + p)
  }

  var httpModule = r.protocol === 'https:' ? https : http
  r.method = 'GET'
  r.headers = {
    'user-agent': this.ua,
    'connection': 'close'
  }

  var req = httpModule.request(r)
  req.on('error', this.emit.bind(this, 'error'))
  req.on('response', this.onattres.bind(this, f, need, did, v))
  req.end()
}

FullFat.prototype.onattres = function(f, need, did, v, res) {
  var att = f.versions[v].dist.tarball
  var sum = f.versions[v].dist.shasum
  var filename = f.name + '-' + v + '.tgz'
  var file = path.join(this.tmp, f.name, filename)

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
      this.put(f, did)
  }.bind(this)

  // if the attachment can't be found, then skip that version
  // it's uninstallable as of right now, and may or may not get
  // fixed in a future update
  if (res.statusCode !== 200) {
    return skip()
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
    er.doc = f
    er.version = v
    er.path = file
    er.url = att
    this.emit('error', errState = errState || er)
  }.bind(this))

  fstr.on('close', function() {
    if (errState || !shaOk) {
      // something didn't work, but the error was squashed
      // take that as a signal to just delete this version,
      return skip()
    } else {
      // it worked!  change the dist.tarball url to point to the
      // registry where this is being stored.  It'll be rewritten by
      // the _show/pkg function when going through the rewrites, anyway,
      // but this url will work if the couch itself is accessible.
      var newatt = this.publicFat + '/' + f.name + '/' + f.name + '-' + v + '.tgz'
      f.versions[v].dist.tarball = newatt
    }

    if (res.headers['content-length']) {
      var cl = +res.headers['content-length']
    } else {
      var cl = counter.count
    }

    var a = {
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
