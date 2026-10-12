// The settings window's work: show what the app has, and keep each change
// the moment it is made. Everything it asks is a command in
// src/bridge.rs. The settings usually open over the site, which draws
// them (apps/web components/desktop-settings.tsx); this window is for when
// the window shows no page of the site's. The runner has a window of its
// own (runner.html); here it is a line that opens it. A button that asks
// the app for something is busy until it is done (busy.js).
(function () {
  var SWITCHES = ["startHidden", "closeToTray", "notifications", "flash", "badge", "systemTitleBar", "autoUpdate"];
  // The settings the app keeps (src/settings.rs Settings); a save sends them all.
  var KEPT = SWITCHES.concat(["zoom", "developerTools", "runner", "runnerBackend", "runnerWorkspace", "runnerCapabilities"]);
  var current = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function invoke(command, args) {
    var core = window.__TAURI__ && window.__TAURI__.core;
    if (core && typeof core.invoke === "function") return core.invoke(command, args || {});
    return Promise.reject(new Error("This page belongs inside the g1t desktop app."));
  }

  function fail(error) {
    var box = byId("error");
    box.textContent = typeof error === "string" ? error : (error && error.message) || "That could not be changed.";
    box.hidden = false;
  }

  function hostOf(server) {
    try {
      return new URL(server).host;
    } catch (error) {
      return server;
    }
  }

  // What changes between Windows, macOS and Linux.
  function platform(name) {
    byId("flash-label").textContent =
      name === "macos" ? "Bounce the dock icon" : name === "windows" ? "Flash the taskbar icon" : "Ask for attention";
    // macOS keeps its menu bar at the top of the screen, whichever title bar the window has.
    if (name === "macos") byId("system-title-bar-note").textContent = "In place of g1t's own, which sits under the window's buttons.";
    if (name === "macos") byId("zoom-note").textContent = "The View menu changes it too: ⌘+, ⌘− and ⌘0.";
    else byId("zoom-note").textContent = "The View menu changes it too: Ctrl+=, Ctrl+− and Ctrl+0.";
  }

  function render(view) {
    current = view;
    byId("error").hidden = true;
    byId("openAtLogin").checked = !!view.openAtLogin;
    SWITCHES.forEach(function (key) {
      byId(key).checked = !!view[key];
    });
    // Starting in the tray only means something when g1t starts at sign-in.
    byId("startHidden").disabled = !view.openAtLogin;
    byId("startHidden").closest(".setting").classList.toggle("off", !view.openAtLogin);
    // The title bar changes when g1t restarts.
    byId("restart-row").hidden = !view.titleBarChanged;
    var zoom = byId("zoom");
    zoom.value = String(view.zoom);
    if (zoom.value === "") zoom.value = "1";
    byId("version").textContent = "g1t " + view.version;
    if (!checking) updateStatus(view);
    byId("server").textContent = hostOf(view.server);
    renderRunner(view.runnerView);
  }

  // The runner, in a line: what it is doing, and the window that has the rest.
  function renderRunner(runner) {
    if (!runner) return;
    byId("runner-dot").className = "dot " + runner.chip.tone;
    byId("runner-title").textContent = runner.chip.label;
    byId("runner-summary").textContent = runner.diagnosis.title + (runner.version ? " · g1t-runner " + runner.version : "");
  }

  // Every setting, as the app has it now (the Runner window changes the
  // runner's), with this window's own as they are on the page.
  function settingsOf(fresh) {
    var settings = {};
    KEPT.forEach(function (key) {
      if (key in fresh) settings[key] = fresh[key];
    });
    SWITCHES.forEach(function (key) {
      settings[key] = byId(key).checked;
    });
    settings.zoom = Number(byId("zoom").value) || 1;
    return settings;
  }


  function save() {
    invoke("get_settings")
      .then(function (fresh) {
        return invoke("save_settings", { settings: settingsOf(fresh) });
      })
      .then(render, function (error) {
        fail(error);
        if (current) render(current);
      });
  }

  byId("open-runner").addEventListener("click", function () {
    window.g1tBusy.run(byId("open-runner"), "open-runner", "", false, function () {
      return invoke("runner_control", { action: "open_runner" });
    }, fail);
  });

  SWITCHES.forEach(function (key) {
    byId(key).addEventListener("change", save);
  });
  byId("zoom").addEventListener("change", save);
  byId("openAtLogin").addEventListener("change", function (event) {
    invoke("set_open_at_login", { on: event.target.checked }).then(render, function (error) {
      fail(error);
      if (current) render(current);
    });
  });

  // Updates: where this copy stands, said in the window, so a check from
  // the menu or the tray is answered here and cannot be missed.
  var checking = false;

  function when(ms) {
    var date = new Date(ms);
    var today = new Date().toDateString() === date.toDateString();
    var time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return today ? "today at " + time : date.toLocaleDateString([], { month: "short", day: "numeric" }) + " at " + time;
  }

  function ready(version) {
    byId("update-status").textContent = "Version " + version + " is downloaded and installs when g1t restarts.";
    byId("restart").hidden = false;
  }

  function updateStatus(view) {
    if (view.updateReady) return ready(view.updateReady);
    byId("restart").hidden = true;
    byId("update-status").textContent = view.checkedAt
      ? "Up to date. Last checked " + when(view.checkedAt) + "."
      : view.autoUpdate
        ? "Not checked yet since g1t started; it checks on its own shortly."
        : "Checking on its own is off.";
  }

  function check() {
    if (checking) return;
    checking = true;
    var button = byId("check");
    var status = byId("update-status");
    window.g1tBusy.start(button);
    status.textContent = "Checking, and downloading any new version…";
    invoke("check_for_updates")
      .then(function (answer) {
        if (answer.indexOf("ready:") === 0) ready(answer.slice(6));
        else status.textContent = "Up to date. Last checked " + when(Date.now()) + ".";
      })
      .catch(function (error) {
        var text = typeof error === "string" ? error : "";
        status.textContent = /sending request|connect|dns|timed out/i.test(text) || !text
          ? "Could not reach g1t.sh to check. Check your connection and try again."
          : "Could not check: " + text;
      })
      .then(function () {
        checking = false;
        window.g1tBusy.stop(button);
      });
  }

  byId("check").addEventListener("click", check);
  byId("restart").addEventListener("click", function () {
    window.g1tBusy.start(byId("restart"));
    byId("update-status").textContent = "Installing…";
    invoke("restart_to_update").catch(function (error) {
      window.g1tBusy.stop(byId("restart"));
      fail(error);
    });
  });

  // The menu's or tray's "Check for updates…" with this window open, and a
  // download finishing in the background (src/settings.rs).
  var events = window.__TAURI__ && window.__TAURI__.event;
  if (events && typeof events.listen === "function") {
    events.listen("g1t-check-updates", check).catch(function () {});
    events
      .listen("g1t-runner-status", function (event) {
        if (current) current.runnerView = event.payload;
        renderRunner(event.payload);
      })
      .catch(function () {});
    events
      .listen("g1t-update-ready", function (event) {
        if (!checking && typeof event.payload === "string") ready(event.payload);
      })
      .catch(function () {});
  }

  byId("restart-app").addEventListener("click", function () {
    window.g1tBusy.start(byId("restart-app"));
    invoke("restart").catch(function (error) {
      window.g1tBusy.stop(byId("restart-app"));
      fail(error);
    });
  });

  byId("change-server").addEventListener("click", function () {
    window.g1tBusy.run(byId("change-server"), "change-server", "", false, function () {
      return invoke("change_server");
    }, fail);
  });

  // Links out, in the system's browser (src/bridge.js does the same on the site).
  document.addEventListener("click", function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    event.preventDefault();
    invoke("open_url", { url: anchor.href }).catch(function () {});
  });

  // g1t's own title bar, when the window has no system frame.
  function frame(view) {
    if (!view.customFrame) return;
    if (view.platform === "macos") document.documentElement.classList.add("mac");
    var bar = byId("titlebar");
    bar.hidden = false;
    document.body.classList.add("framed");
    bar.addEventListener("mousedown", function (event) {
      if (event.button !== 0 || event.target.closest("button")) return;
      invoke("window_control", { action: "drag" }).catch(function () {});
    });
    byId("close-window").addEventListener("click", function () {
      invoke("window_control", { action: "close" }).catch(function () {});
    });
  }

  invoke("get_settings")
    .then(function (view) {
      frame(view);
      platform(view.platform);
      render(view);
      // Opened by "Check for updates…" in a menu.
      if (new URLSearchParams(location.search).has("check")) {
        byId("updates-row").scrollIntoView({ block: "center" });
        check();
      }
    })
    .catch(fail);
})();
