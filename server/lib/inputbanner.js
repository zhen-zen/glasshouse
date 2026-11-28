/*
 * lib/inputbanner.js - closes LG's input banner when an HDMI input with a
 * SIMPLINK device comes to the front
 *
 * Switching to an HDMI input shows LG's banner, "HDMI 1 / Formuler Z11 P",
 * for 5 seconds (10 with audio guidance). While it is up the remote's keys
 * stay with the input app instead of going to the device over HDMI-CEC:
 * com.webos.app.inputcommon passes a key to its SIMPLINK handler only
 * `simplinkEnabled && !isFocusableViewExist`, and the banner is a focusable
 * view. Back closes it. With **Close the input banner** switched on on the
 * Inputs tab, Glasshouse sends that Back itself, so the remote works on the
 * device at once.
 *
 * Back is sent 2 seconds after the input comes to the front, while the banner
 * is still up, and only to an HDMI input that has a SIMPLINK device; without
 * one, or with only a sound bar on it, Back would go to the input app and
 * could leave it. A Back that came
 * after the banner had gone would go to the device as one step back, which is
 * why it is sent once and never later.
 *
 * Not every input app holds the keys back. An OLED42C24LA (webOS 9.2) has
 * the same gate in InputEventLayer.qml; an OLED65B8SLC (webOS 4.4.3) has none,
 * and there the Back would go to the device on every switch. So the switch is
 * offered only where the input app has the gate.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var msg = require('./say').msg;

// LG's input app, and the check in it that keeps keys from SIMPLINK while a
// focusable view such as the banner is up.
var INPUT_APP_QML = '/usr/palm/applications/com.webos.app.inputcommon/qml';
var GATE_FILE = 'InputEventLayer.qml';
var GATE = /simplinkEnabled\s*&&\s*!\s*isFocusableViewExist/;

// After the input comes to the front: its banner is up by then.
var DELAY_MS = 2000;
// LG's Back as the network input service takes it (see RCU_KEYS in controls).
var BACK_KEYCODE = 412;
var HDMI_APP = /^com\.webos\.app\.hdmi(\d)$/;

var config = {};
var lunaFn = null;
var writeSettings = null;
var delayMs = DELAY_MS;
var front = '';
var timer = null;
var inputAppDir = INPUT_APP_QML;
var gate = null;

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.luna) lunaFn = opts.luna;
  if (opts.writeSettings) writeSettings = opts.writeSettings;
  delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : DELAY_MS;
  inputAppDir = opts.inputAppDir || INPUT_APP_QML;
  gate = null;
  front = '';
  clearTimeout(timer);
  timer = null;
}

// Whether InputEventLayer.qml, wherever this TV's input app keeps it, has
// the gate. Looked for once: the input app only changes with the firmware.
function findGate(dir, depth) {
  var names;
  try { names = fs.readdirSync(dir); } catch (e) { return false; }
  for (var i = 0; i < names.length; i++) {
    var full = path.join(dir, names[i]);
    if (names[i] === GATE_FILE) {
      try { if (GATE.test(fs.readFileSync(full, 'utf8'))) return true; } catch (e) {}
      continue;
    }
    if (depth >= 6 || /\.(qml|js|json|png)$/.test(names[i])) continue;
    var st = null;
    try { st = fs.statSync(full); } catch (e) {}
    if (st && st.isDirectory() && findGate(full, depth + 1)) return true;
  }
  return false;
}

function supported() {
  if (gate === null) gate = findGate(inputAppDir, 0);
  return gate;
}

function enabled() {
  return !!(config.inputs && config.inputs.closeBanner);
}

/*
 * Whether eim lists a SIMPLINK device on the input appId opens that takes the
 * remote's keys: a player or set-top box, not an audio system (CEC device
 * type 5), such as a sound bar on the ARC port.
 */
function hasSimplinkDevice(appId, cb) {
  lunaFn('com.webos.service.eim/getAllInputStatus', {}, function (r) {
    var list = r && Object.prototype.toString.call(r.devices) === '[object Array]' ? r.devices : [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i] || {};
      if (d.appId !== appId) continue;
      var subs = Object.prototype.toString.call(d.subList) === '[object Array]' ? d.subList : [];
      for (var k = 0; k < subs.length; k++) {
        if (subs[k] && subs[k].id === 'SIMPLINK' && subs[k].cecpDevType !== 5) return cb(true);
      }
      return cb(false);
    }
    cb(false);
  });
}

function closeBanner(appId) {
  hasSimplinkDevice(appId, function (yes) {
    // Gone from the front while eim answered, or nothing on it to control.
    if (!yes || front !== appId || !enabled()) return;
    lunaFn('com.webos.service.networkinput/test/sendKeyCode', { keyCode: BACK_KEYCODE }, function (r) {
      if (r && r.returnValue) console.log('inputs: closed the input banner on ' + appId);
      else console.error('inputs: could not close the input banner on ' + appId);
    });
  });
}

/*
 * The app in front changed. snapshot: the state as it was when the server
 * started, not a switch someone made.
 */
function onAppChanged(appId, snapshot) {
  var was = front;
  front = String(appId || '');
  if (front === was) return;
  clearTimeout(timer);
  timer = null;
  if (snapshot || !enabled() || !lunaFn || !HDMI_APP.test(front) || !supported()) return;
  var opened = front;
  timer = setTimeout(function () {
    timer = null;
    if (front === opened) closeBanner(opened);
  }, delayMs);
  if (timer.unref) timer.unref();
}

function setEnabled(on, cb) {
  if (!writeSettings) return cb({ ok: false, error: 'no writeSettings handler configured' });
  if (on && !supported()) {
    return cb({ ok: false, error: msg('srv.inputs.bannerNotHeld', 'this TV\'s input banner does not hold the remote\'s keys back, so there is nothing to close') });
  }
  writeSettings({ inputs: { closeBanner: on } }, function (err) {
    if (err) return cb({ ok: false, error: msg('srv.saveSettingFailed', 'could not save the setting: {error}', { error: err.message }) });
    config.inputs = config.inputs || {};
    config.inputs.closeBanner = on;
    console.log('inputs: closing the input banner switched ' + (on ? 'on' : 'off'));
    cb({ ok: true });
  });
}

// null where the input app has no gate: the Inputs tab then leaves the switch out.
function summary() {
  return supported() ? { closeBanner: enabled() } : null;
}

module.exports = {
  DELAY_MS: DELAY_MS,
  BACK_KEYCODE: BACK_KEYCODE,
  init: init,
  enabled: enabled,
  supported: supported,
  onAppChanged: onAppChanged,
  setEnabled: setEnabled,
  summary: summary
};
