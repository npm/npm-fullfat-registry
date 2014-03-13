#!/usr/bin/env node

var FF = require('../fullfat.js')
var dashdash = require('dashdash')

var parser = dashdash.createParser({
  options: [
    { names: [ 'fat', 'f' ],
      type: 'string',
      help: 'The database that has attachments. Required.',
      helpArg: 'URL' },
    { names: [ 'skim', 's' ],
      type: 'string',
      help: 'The database without attachments.  Required.',
      helpArg: 'URL' },
    { names: [ 'registry', 'r' ],
      type: 'string',
      help: 'The registry where attachments can be found.  Optional.',
      helpArg: 'URL' },
    { names: [ 'tmp', 't' ],
      type: 'string',
      default: null,
      help: 'Path to folder where temp files are stored.',
      helpArg: 'PATH' },
    { names: [ 'missing-log', 'm' ],
      type: 'string',
      default: false,
      help: 'Log to write missing tarballs. If not set, then ' +
            'crash on fetch failures' },
    { names: [ 'user-agent', 'ua', 'u' ],
      type: 'string',
      default: null,
      help: 'User-Agent header that npm FullFat sends.',
      helpArg: 'AGENT' },
    { names: [ 'seq-file', 'q' ],
      type: 'string',
      help: 'File to store the sequence id in.',
      helpArg: 'FILE' },
    { names: [ 'inactivity-ms', 'i' ],
      type: 'number',
      help: 'Max ms to wait before assuming disconnection. Default=3600000',
      helpArg: 'MS' },
    { names: [ 'help', 'h' ],
      type: 'bool',
      help: 'Display this help' }
  ]
})

opts = parser.parse(process.argv, process.env)

if (opts.help)
  return usage(true)

function usage(ok) {
  console.log('npm-fullfat-registry - Put attachments back into the couch')
  console.log('Usage: npm-fullfat-registry [args]\n')
  console.log(parser.help())
  process.exit(ok ? 0 : 1)
}

try {
  var ff = new FF(opts)
} catch (er) {
  console.error(er.message)
  usage(false)
}

ff.on('start', function() {
  console.log('START %s pid=%d', ff.ua, process.pid)
}).on('change', function(change) {
  console.log('%d: %s', change.seq, change.id)
}).on('putDesign', function(change, result) {
  console.log('PUT %s', change.id)
}).on('put', function(change, result) {
  console.log('PUT %s', change.id)
}).on('delete', function(change) {
  console.log('DELETE %s', change.id)
}).on('error', function(er) {
  console.log('ERROR', er)
  throw er
}).on('download', function(a) {
  console.log('-> %s', a.name)
}).on('upload', function(a) {
  console.log('<- %s', a.name)
})
