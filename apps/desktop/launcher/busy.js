// A button at work, in the app's own pages (settings.js, runner.js): from
// the click until what it asked for shows, a spinner before its label
// (settings.css `button.busy`), pressed no more, and said to be busy to a
// screen reader. What it asked for shows when the status that follows
// changes; an error, or 20 seconds with no change, gives the button back,
// so a press is never seen to do nothing and never leaves a button dead.
//
// A page that draws its buttons again on every status asks `pressed` while
// drawing: a button pressed with the status as it still is stays busy.
(function () {
  var LIMIT = 20000;
  var timers = new WeakMap();
  // What was pressed (by a key such as "retry" or "start:linux"), with the
  // status as it was then and when.
  var presses = {};

  function start(button) {
    if (!button || button.classList.contains("busy")) return;
    button.disabled = true;
    button.classList.add("busy");
    button.setAttribute("aria-busy", "true");
    timers.set(
      button,
      setTimeout(function () {
        stop(button);
      }, LIMIT),
    );
  }

  function stop(button) {
    if (!button || !button.classList.contains("busy")) return;
    clearTimeout(timers.get(button));
    timers.delete(button);
    button.disabled = false;
    button.classList.remove("busy");
    button.removeAttribute("aria-busy");
  }

  function press(key, status) {
    presses[key] = { status: status, at: Date.now() };
  }

  function release(key) {
    delete presses[key];
  }

  // Whether a press is still waiting: the status is as it was, and not for long.
  function pressed(key, status) {
    var press = presses[key];
    if (!press) return false;
    if (press.status !== status || Date.now() - press.at >= LIMIT) {
      delete presses[key];
      return false;
    }
    return true;
  }

  // Runs `work` (a function returning a promise) for a button: busy until
  // the status changes when `waits`, or until the work is done. Resolves
  // whether the work went through; `fail` is told why it did not.
  function run(button, key, status, waits, work, fail) {
    press(key, status);
    start(button);
    return work().then(
      function () {
        if (!waits) {
          release(key);
          stop(button);
        }
        return true;
      },
      function (error) {
        release(key);
        stop(button);
        if (fail) fail(error);
        return false;
      },
    );
  }

  window.g1tBusy = Object.freeze({ LIMIT: LIMIT, start: start, stop: stop, press: press, release: release, pressed: pressed, run: run });
})();
