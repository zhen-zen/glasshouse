/* Screenshot files and retention. Strict ES5 for Node 0.10 and 0.12. */
var fs = require('fs');
var path = require('path');
var constants = require('constants');
var msg = require('./say').msg;
var FILE_RE = /^capture_[A-Za-z0-9][A-Za-z0-9_.-]*\.png$/;
var DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
var maxBytes = DEFAULT_MAX_BYTES;
// Leave time for the compositor's captures to finish writing.
var WRITE_GRACE_MS = 15000;
var directory = '/tmp';
var cleaning = false;
var nowFn = Date.now;
/*
 * Off until switched on on the Tools tab (screenshots.enabled): while off, no
 * key is offered to take one, the remote-key filter carries none of their
 * code, and nothing here runs. Switching off deletes the saved images, and
 * the remote keys put screenshot keys back as LG has them (onChange).
 */
var enabled = false;
/*
 * Only where the compositor says which device a key came from, without which
 * the filter takes no screenshot: webOS 10, as a webOS 10.3.1 TV does. An
 * OLED65B8SLC (webOS 4.4.3) and an OLED42C24LA (webOS 9.2) give the key
 * filter no device id and have no getDeviceType, so nothing could ever be
 * taken; webOS 11 handles keys natively, where screenshots are not offered.
 */
var supported = false;
var writeSettings = null;
var onChange = function (on, cb) { cb(); };

function init(opts) {
  var bytes = typeof opts.maxMiB === 'number' ? opts.maxMiB * 1024 * 1024 : 0;
  maxBytes = isFinite(bytes) && bytes > 0 ? bytes : DEFAULT_MAX_BYTES;
  directory = opts.directory || '/tmp';
  nowFn = opts.now || Date.now;
  supported = parseInt(String(opts.webos || ''), 10) === 10;
  enabled = opts.enabled === true && supported;
  writeSettings = opts.writeSettings || null;
  if (typeof opts.onChange === 'function') onChange = opts.onChange;
}

function isEnabled() { return enabled; }
function isSupported() { return supported; }

function setEnabled(on, cb) {
  on = on === true;
  if (on && !supported) return cb({ ok: false, error: msg('srv.screenshots.unsupported', 'Screenshots need webOS 10: on this TV a key does not say which remote it came from') });
  if (!writeSettings) return cb({ ok: false, error: 'no writeSettings handler configured' });
  writeSettings({ screenshots: { enabled: on } }, function (err) {
    if (err) return cb({ ok: false, error: msg('srv.saveSettingFailed', 'could not save the setting: {error}', { error: err.message }) });
    var was = enabled;
    enabled = on;
    if (was !== on) console.log('screenshots: switched ' + (on ? 'on' : 'off'));
    onChange(on, function () {
      if (on) return cb({ ok: true, enabled: true });
      clear(function () { cb({ ok: true, enabled: false }); });
    });
  });
}

function filePath(id) {
  return typeof id === 'string' && FILE_RE.test(id) ? path.join(directory, id) : null;
}

function missing() {
  return { ok: false, error: msg('srv.screenshots.missing', 'Screenshot not found') };
}

function list(cb) {
  fs.readdir(directory, function (err, names) {
    if (err) return cb({ ok: false, error: msg('srv.screenshots.listFailed', 'Could not list screenshots') });
    var images = [];
    names.forEach(function (id) {
      var file = filePath(id);
      if (!file) return;
      try {
        var st = fs.lstatSync(file);
        if (st.isFile() && st.size > 0) images.push({ id: id, size: st.size, modified: st.mtime.toISOString() });
      } catch (e) {} // A capture or deletion can finish during the scan.
    });
    images.sort(function (a, b) {
      return a.modified === b.modified ? (a.id < b.id ? 1 : -1) : (a.modified < b.modified ? 1 : -1);
    });
    cb({ ok: true, screenshots: images, maxBytes: maxBytes });
  });
}

// Hold the descriptor through serving so replacing the path cannot expose another file.
function openImage(id, cb) {
  var file = filePath(id);
  if (!file) return cb(missing());
  fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, function (err, fd) {
    if (err) return cb(missing());
    fs.fstat(fd, function (statErr, st) {
      if (statErr || !st.isFile() || !st.size) return fs.close(fd, function () { cb(missing()); });
      cb({ ok: true, fd: fd, path: file, size: st.size });
    });
  });
}

function remove(id, cb) {
  var file = filePath(id);
  if (!file) return cb(missing());
  fs.lstat(file, function (err, st) {
    if (err || !st.isFile() || !st.size) return cb(missing());
    // unlink removes only the directory entry if it becomes a symlink after lstat.
    fs.unlink(file, function (unlinkErr) {
      cb(unlinkErr ? { ok: false, error: msg('srv.screenshots.deleteFailed', 'Could not delete screenshot') } : { ok: true });
    });
  });
}

function clear(cb) {
  list(function (result) {
    if (!result.ok) return cb(result);
    function next() {
      if (!result.screenshots.length) return cb({ ok: true });
      remove(result.screenshots.pop().id, function (removed) {
        if (!removed.ok) return cb(removed);
        next();
      });
    }
    next();
  });
}

function cleanup(cb) {
  cb = cb || function () {};
  if (cleaning || !enabled) return cb({ ok: true });
  cleaning = true;
  function finish(result) {
    cleaning = false;
    if (!result.ok) console.warn('screenshots: cleanup failed: ' + result.error);
    cb(result);
  }
  list(function (result) {
    if (!result.ok) return finish(result);
    var total = result.screenshots.reduce(function (sum, image) { return sum + image.size; }, 0);
    var cutoff = nowFn() - WRITE_GRACE_MS;
    function next() {
      // Keep the newest capture, even if it alone exceeds the budget.
      if (total <= maxBytes || result.screenshots.length < 2) return finish({ ok: true });
      var image = result.screenshots.pop();
      if (new Date(image.modified).getTime() > cutoff) return finish({ ok: true });
      remove(image.id, function (removed) {
        if (!removed.ok) return finish(removed);
        total -= image.size;
        next();
      });
    }
    next();
  });
}

module.exports = { init: init, isEnabled: isEnabled, isSupported: isSupported, setEnabled: setEnabled, list: list, openImage: openImage, remove: remove, clear: clear, cleanup: cleanup };
