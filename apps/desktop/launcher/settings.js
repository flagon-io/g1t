// The settings window's work: show what the app has, and keep each change
// the moment it is made. Everything it asks is a command in
// src/bridge.rs, answered only to this window.
(function () {
  var SWITCHES = ["startHidden", "closeToTray", "notifications", "flash", "badge", "menuBar", "autoUpdate"];
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
    // macOS keeps its menu bar at the top of the screen, always there.
    byId("menu-bar-row").hidden = name === "macos";
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
    var zoom = byId("zoom");
    zoom.value = String(view.zoom);
    if (zoom.value === "") zoom.value = "1";
    byId("version").textContent = "g1t " + view.version;
    if (view.updateReady) byId("update-status").textContent = "Version " + view.updateReady + " is downloaded. Restart g1t to use it.";
    byId("server").textContent = hostOf(view.server);
  }

  function settingsOf() {
    var settings = {};
    SWITCHES.forEach(function (key) {
      settings[key] = byId(key).checked;
    });
    settings.zoom = Number(byId("zoom").value) || 1;
    return settings;
  }

  function save() {
    invoke("save_settings", { settings: settingsOf() }).then(render, function (error) {
      fail(error);
      if (current) render(current);
    });
  }

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

  byId("check").addEventListener("click", function () {
    var button = byId("check");
    var status = byId("update-status");
    button.disabled = true;
    status.textContent = "Checking…";
    invoke("check_for_updates")
      .then(function (answer) {
        if (answer === "current") status.textContent = "You have the newest version.";
        else if (answer.indexOf("ready:") === 0) status.textContent = "Version " + answer.slice(6) + " is downloaded. Restart g1t to use it.";
        else status.textContent = answer;
      })
      .catch(function (error) {
        status.textContent = "Could not check: " + (typeof error === "string" ? error : "try again later.");
      })
      .then(function () {
        button.disabled = false;
      });
  });

  byId("change-server").addEventListener("click", function () {
    invoke("change_server").catch(fail);
  });

  // Links out, in the system's browser (src/bridge.js does the same on the site).
  document.addEventListener("click", function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    event.preventDefault();
    invoke("open_url", { url: anchor.href }).catch(function () {});
  });

  invoke("get_settings")
    .then(function (view) {
      platform(view.platform);
      render(view);
    })
    .catch(fail);
})();
