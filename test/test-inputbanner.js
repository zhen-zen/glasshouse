/**
 * test-inputbanner.js - lib/inputbanner.js: Back sent once, a moment after an
 * HDMI input with a SIMPLINK device comes to the front, to close LG's input
 * banner; never for another input, a port with nothing on SIMPLINK, a switch
 * away before it is due, the state at start, or with the switch off.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var inputBanner = require('../server/lib/inputbanner');

// LG's input app as an OLED42C24LA (webOS 9.2) has it, with the gate that
// holds keys back while the banner is up, and as an OLED65B8SLC (webOS 4.4.3)
// has it, with none.
var apps = path.join(os.tmpdir(), 'inputbanner-' + process.pid);
var withGate = path.join(apps, 'gate', 'qml', 'UserInterfaceLayer', 'Containers');
var noGate = path.join(apps, 'nogate', 'qml', 'Model');
[withGate, noGate].forEach(function (d) { d.split(path.sep).reduce(function (at, part) { at = at + path.sep + part; try { fs.mkdirSync(at); } catch (e) {} return at; }); });
fs.writeFileSync(path.join(withGate, 'InputEventLayer.qml'),
  'if (event.isAutoRepeat || inputEventHandler.simplinkEnabled && !isFocusableViewExist) {\n');
fs.writeFileSync(path.join(noGate, 'Simplink.qml'), 'id: simplinkModel\n');
var GATE_DIR = path.join(apps, 'gate', 'qml');
var NO_GATE_DIR = path.join(apps, 'nogate', 'qml');

var sent, config, saved;
var DEVICES = [
  { id: 'HDMI_1', appId: 'com.webos.app.hdmi1', subList: [{ id: 'SIMPLINK', osdName: 'Formuler Z11 P', cecpDevType: 4 }] },
  { id: 'HDMI_2', appId: 'com.webos.app.hdmi2', subList: [] },
  { id: 'HDMI_3', appId: 'com.webos.app.hdmi3', subList: [{ id: 'SIMPLINK', osdName: 'Sonos Beam', cecpDevType: 5 }] }
];

function setup(on, inputAppDir) {
  sent = [];
  saved = [];
  config = { inputs: { closeBanner: on } };
  inputBanner.init({
    config: config,
    luna: function (uri, params, cb) {
      if (uri === 'com.webos.service.eim/getAllInputStatus') return cb({ returnValue: true, devices: DEVICES });
      sent.push([uri, params]);
      cb({ returnValue: true });
    },
    writeSettings: function (patch, cb) { saved.push(patch); cb(null); },
    delayMs: 2,
    inputAppDir: inputAppDir || GATE_DIR
  });
}

function after(ms, fn) { setTimeout(fn, ms); }

var steps = [];
function step(fn) { steps.push(fn); }
function next() {
  var fn = steps.shift();
  if (!fn) return console.log('ALL test-inputbanner.js assertions passed!');
  fn(next);
}

// An HDMI input with a SIMPLINK device: Back once, a moment after it comes to the front.
step(function (done) {
  setup(true);
  inputBanner.onAppChanged('com.webos.app.home');
  inputBanner.onAppChanged('com.webos.app.hdmi1');
  assert.strictEqual(sent.length, 0, 'not at once: the banner is not up yet');
  after(15, function () {
    assert.deepEqual(sent, [['com.webos.service.networkinput/test/sendKeyCode', { keyCode: 412 }]]);
    inputBanner.onAppChanged('com.webos.app.hdmi1');
    after(15, function () {
      assert.strictEqual(sent.length, 1, 'the same input again is no new switch');
      done();
    });
  });
});

// Nothing on SIMPLINK, only a sound bar on it, and other apps.
step(function (done) {
  setup(true);
  inputBanner.onAppChanged('com.webos.app.hdmi2');
  after(15, function () {
    assert.strictEqual(sent.length, 0, 'Back would reach the input app, not a device');
    inputBanner.onAppChanged('youtube.leanback.v4');
    inputBanner.onAppChanged('com.webos.app.acrhdmi1');
    after(15, function () {
      assert.strictEqual(sent.length, 0, 'not an HDMI input app');
      inputBanner.onAppChanged('com.webos.app.hdmi3');
      after(15, function () {
        assert.strictEqual(sent.length, 0, 'a sound bar takes no navigation keys');
        done();
      });
    });
  });
});

// Left before it was due, the state at start, or switched off: nothing.
step(function (done) {
  setup(true);
  inputBanner.onAppChanged('com.webos.app.hdmi1');
  inputBanner.onAppChanged('com.webos.app.home');
  inputBanner.onAppChanged('com.webos.app.hdmi1', true);
  after(15, function () {
    assert.strictEqual(sent.length, 0);
    setup(false);
    inputBanner.onAppChanged('com.webos.app.hdmi1');
    after(15, function () {
      assert.strictEqual(sent.length, 0, 'off by default');
      done();
    });
  });
});

// The switch is saved and shown.
step(function (done) {
  setup(false);
  assert.deepEqual(inputBanner.summary(), { closeBanner: false });
  inputBanner.setEnabled(true, function (r) {
    assert.strictEqual(r.ok, true);
    assert.deepEqual(saved, [{ inputs: { closeBanner: true } }]);
    assert.deepEqual(inputBanner.summary(), { closeBanner: true });
    done();
  });
});

// An input app with no gate (webOS 4): nothing sent, the switch left out, and
// it cannot be switched on.
step(function (done) {
  setup(true, NO_GATE_DIR);
  assert.strictEqual(inputBanner.supported(), false);
  assert.strictEqual(inputBanner.summary(), null, 'the Inputs tab leaves the switch out');
  inputBanner.onAppChanged('com.webos.app.hdmi1', false);
  after(15, function () {
    assert.deepEqual(sent, [], 'no Back where the banner does not hold the keys');
    setup(false, NO_GATE_DIR);
    inputBanner.setEnabled(true, function (r) {
      assert.strictEqual(r.ok, false);
      assert.deepEqual(saved, []);
      setup(false, GATE_DIR);
      assert.strictEqual(inputBanner.supported(), true);
      console.log('  ✓ only offered, and only sent, where the input app holds keys back while the banner is up');
      done();
    });
  });
});

step(function (done) {
  fs.rmSync ? fs.rmSync(apps, { recursive: true, force: true }) : null;
  done();
});

next();
