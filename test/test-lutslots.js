/**
 * test/test-lutslots.js - The stored picture calibration files, by size and checksum
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var lutslots = require('../server/lib/lutslots');

console.log('Running test-lutslots.js ...');

var c = lutslots.classify('hdr_filmMaker_profile0_BT2020_3D_LUT_DATA');
assert.strictEqual(c.mode, 'hdr_filmMaker');
assert.strictEqual(c.profile, 'profile0');
assert.strictEqual(c.kind, '3d-lut');
assert.strictEqual(lutslots.classify('cinema_profile0_1D_DPG_DATA').kind, '1d-lut');
assert.strictEqual(lutslots.classify('cinema_profile0_1D_2_2_EN').kind, 'enable-flag');
assert.strictEqual(lutslots.classify('cinema_profile0_BT709_3BY3_GAMUT_DATA').kind, 'gamut-matrix');
assert.strictEqual(lutslots.classify('notes.txt'), null);

var tmp = path.join(os.tmpdir(), 'lutslots-' + process.pid);
fs.mkdirSync(tmp);
var lut = new Buffer(6144);
lut.fill(1);
fs.writeFileSync(path.join(tmp, 'cinema_profile0_1D_DPG_DATA'), lut);
fs.writeFileSync(path.join(tmp, 'cinema_profile0_1D_DPG_EN'), 'x');
fs.writeFileSync(path.join(tmp, 'readme'), 'ignored');

lutslots.init({ dir: tmp });
lutslots.readSlots(function (r) {
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.slots.length, 2);
  assert.strictEqual(r.slots[0].file, 'cinema_profile0_1D_DPG_DATA');
  assert.strictEqual(r.slots[0].bytes, 6144);
  assert.strictEqual(r.slots[0].sizeMatches, true);
  assert.strictEqual(r.slots[0].sha256.length, 64);
  assert.strictEqual(r.slots[1].sizeMatches, false);
  assert.ok(!r.slots[0].hasOwnProperty('data'));
  finish();
  function finish() {
    // The hash is cached by size and mtime: same mtime keeps it, a new mtime re-reads.
    var file = path.join(tmp, 'cinema_profile0_1D_DPG_DATA');
    // Whole-second times only: older Node rounds a Date to a float of seconds, so a
    // sub-second mtime does not survive utimesSync unchanged.
    var base = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
    fs.utimesSync(file, base, base);
    lutslots.init({ dir: tmp });
    lutslots.readSlots(function (first) {
      var before = first.slots[0].sha256;
      var st = fs.statSync(file);
      var other = new Buffer(6144);
      other.fill(2);
      fs.writeFileSync(file, other);
      fs.utimesSync(file, st.atime, st.mtime);
      lutslots.readSlots(function (cached) {
        assert.strictEqual(cached.slots[0].sha256, before);
        fs.utimesSync(file, st.atime, new Date(st.mtime.getTime() + 5000));
        lutslots.readSlots(function (fresh) {
          assert.notStrictEqual(fresh.slots[0].sha256, before);
          absent();
        });
      });
    });
  }
  function absent() {
    lutslots.init({ dir: path.join(tmp, 'absent') });
    lutslots.readSlots(function (none) {
      assert.strictEqual(none.available, false);
      fs.readdirSync(tmp).forEach(function (n) { fs.unlinkSync(path.join(tmp, n)); });
      fs.rmdirSync(tmp);
      console.log('  PASS test-lutslots.js');
    });
  }
});
