
var crypto = require('crypto')
var ssbKeys = require('ssb-keys')
var toAddress = require('../lib/util').toAddress
var cont = require('cont')
var explain = require('explain-error')
var ip = require('ip')
//okay this plugin adds a method
//invite(seal({code, public})


function isFunction (f) {
  return 'function' === typeof f
}

function isString (s) {
  return 'string' === typeof s
}

module.exports = {
  name: 'invite',
  version: '1.0.0',
  manifest: {
    create: 'async',
    use: 'async',
    addMe: 'async',
    accept: 'async'
  },
  permissions: {
    master: {allow: ['create']},
    //temp: {allow: ['use']}
  },
  init: function (server, config) {
    var codes = {}
    var codesDB = server.sublevel('codes')

    var createClient = this.createClient

    //add an auth hook.
    server.auth.hook(function (fn, args) {
      var pub = args[0], cb = args[1]
      fn(pub, function (err, auth) {
        if(err || auth) return cb(err, auth)
        codesDB.get(pub, function (_, code) {
          console.log(pub, code, _)
          return cb(null, code && code.permissions)
        })
      })
    })

    return {
      create: function (n, cb) {
        if(isFunction(n) || n == null || isNaN(n))
          return cb(new Error('invite.create must get number of uses.'))

        var addr = server.getAddress()
        var host = addr.split(':')[0]
        if(!config.allowPrivate && (
          ip.isPrivate(host) || 'localhost' === host)
        )
          return cb(new Error('Server has no public ip address,'
                            + 'cannot create useable invitation'))

        //this stuff is SECURITY CRITICAL
        //so it should be moved into the main app.
        //there should be something that restricts what
        //permissions the plugin can create also:
        //it should be able to diminish it's own permissions.
        var seed = crypto.randomBytes(32)
        var keyCap = ssbKeys.generate('ed25519', seed)

        var owner = server.id
        codesDB.put(keyCap.id,  {
          id: keyCap.id, total: +n, used: 0,
          permissions: {allow: ['invite.use'], deny: null}
        }, function (err) {
          if(err) cb(err)
          else cb(null, addr + '~' + seed.toString('base64'))
        })

      },
      use: function (req, cb) {
        var rpc = this


        codesDB.get(rpc.id, function(err, invite) {
          if(err) return cb(err)

          server.friends.all('follow', function(err, follows) {
            if (follows && follows[server.id] && follows[server.id][req.feed])
              return cb(new Error('already following'))

            // although we already know the current feed
            // it's included so that request cannot be replayed.
            if(!req.feed)
              return cb(new Error('feed to follow is missing'))

            if(invite.used >= invite.total)
              return cb(new Error('invite has expired'))

            invite.used ++

            //never allow this to be used again
            if(invite.used >= invite.total)
              invite.permissions = {allow: [], deny: true}

            //okay so there is a small race condition here
            //if people use a code massively in parallel
            //then it may not be counted correctly...
            //this is not a big enough deal to fix though.

            codesDB.put(req.keyId, invite, function (err) {
              server.emit('log:info', ['invite', rpc._sessid, 'use', req])

              server.publish({
                type: 'contact',
                contact: req.feed,
                following: true,
                autofollow: true
              }, cb)
            })
          })
        })
      },
      addMe: function (invite, cb) {
        return this.accept(invite, cb)
      },
      accept: function (invite, cb) {
        var parts = invite.split('~')
        createClient({seed: parts[1]})
        (parts[0], function (err, rpc) {
          rpc.invite.use({feed: server.id}, function (err, msg) {
            if(err) return cb(explain(err, 'invite not accepted'))
            cont.para([
              server.publish({
                type: 'contact',
                following: true,
                autofollow: true,
                contact: rpc.id
              }),
              server.publish({
                type: 'pub',
                address: rpc.address,
              })
            ])(function (err, results) {
              rpc.close()
              cb(err, results)
            })
          })
        })
      }
    }
  }
}

