# npm-fullfat-registry

Listen on the vacuumed attachment-free "skim" registry, and copy docs
over, re-fetching and attachment if the attachment is missing.

## Caveat/Warning

This follower script assumes that *nothing* else is writing to the
full-fat database.  If you are updating docs on the side, then those
changes may be in conflict with the updates coming from this script.

## USAGE

This will start the follower script and replicate away.  It's best to
run this in some sort of service architecture like SMF, since it'll
happily crash hard on any kind of error.  Since it uses a sequence
file by default, it'll pick right up where it left off every time it
crashes.

```bash
npm-fullfat-registry \
  --fat=http://my-local-registry.example.com:5984/registry \
  --skim=http://couch.npmjs.org/registry \
  --seq-file=registry.seq \
  --missing-log=missing.log
```

Or, in your own program:

```javascript
var Fullfat = require('npm-fullfat-registry')
var ff = new Fullfat({
  skim: 'http://couch.npmjs.org/registry',
  fat: 'http://my-local-registry.example.com:5984/registry',
  seq_file: '/tmp/file.seq'
})

ff.on('start', function() {
  console.log('Fullfat has started')
})

ff.on('put', function(doc, response) {
  console.log('Fullfat put %s %j', doc.name, response)
})

ff.on('delete', function(data) {
  console.log('Deleted from fat db', data)
})

// not recommended to soldier on, or else data corruption!
ff.on('error', function(er) {
  console.error('ohnoes! errorz!', er)
  process.exit(1)
})
```

## Options

* `fat` The database that gets attachments put into it. Required.
* `skim` The database that has attachments pulled out to somewhere
  else. Required.
* `ua` The User-Agent header sent with all requests. Defaults to
  `npm FullFat/{version} node/{node version}`
* `tmp` The path for temp files.  Defaults to
  `{cwd}/npm-fullfat-tmp-{pid}-{rand}`

## Algorithm

```
on each change from SKIM as d
  pause
  if d.deleted
    delete doc from FULLFAT

  set s = d.doc
  set f = fetch doc from FULLFAT
  set changed = merge from s to f
  if changed
  put f to FULLFAT with ?new_edits=false
  resume

to MERGE from s to f
  set changed = false

  if s is null
    error wtf

  if f is null
    f = clone(s)
    empty f._attachments

  for each version in s.versions
    if version not in f.versions
      if version tgz in s._attachments
        f._attachments[version tgz] = fetch s._attachments[version tgz]
      else
        version tgz data = fetch s.versions[version].dist.tarball
        f._attachments[version tgz] = version tgz
      if f._attachments[version tgz]
        f.versions[version] = s.versions[version]
        set changed = true

  for each att in f._attachments
    if att version not in f.versions
      delete f._attachments[att]
      set changed = true

  for key in s other than versions, _attachments
    if s[key] !== f[key]
      set f[key] = s[key]
      set changed = true

  return changed
```

