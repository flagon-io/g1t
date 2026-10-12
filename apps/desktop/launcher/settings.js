// The settings window's work: show what the app has, and keep each change
// the moment it is made. Everything it asks is a command in
// src/bridge.rs, answered only to this window.
(function () {
  var SWITCHES = ["startHidden", "closeToTray", "notifications", "flash", "badge", "systemTitleBar", "autoUpdate", "runner"];
  // What each way of running jobs can reach, said plainly (src/runner/backend.rs).
  var BACKENDS = {
    sandboxed: { text: "The runner and every job run in a sandbox of their own. Nothing a job does reaches this computer.", warn: false },
    docker: {
      text: "Each job runs in a container of its own, but the runner controls this computer's Docker, which can reach your files. Not a sandbox.",
      warn: true,
    },
    host: {
      text: "Jobs run directly on this computer, as you: they can read, change and delete anything your account can. For jobs that need this system itself, such as building a Windows installer.",
      warn: true,
    },
  };
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

  function settingsOf() {
    var settings = {};
    SWITCHES.forEach(function (key) {
      settings[key] = byId(key).checked;
    });
    settings.zoom = Number(byId("zoom").value) || 1;
    settings.runnerBackend = byId("runnerBackend").value || "sandboxed";
    settings.runnerWorkspace = byId("runnerWorkspace").value || null;
    return settings;
  }

  // ── The runner ──────────────────────────────────────────────────────
  // Its diagnosis, from src/runner/diagnosis.rs, as the tray and the
  // site's Runners page show it; its buttons are the fixes.
  function option(value, text) {
    var item = document.createElement("option");
    item.value = value;
    item.textContent = text;
    return item;
  }

  function renderRunner(runner) {
    if (!runner) return;
    var diagnosis = runner.diagnosis;
    byId("runner-dot").className = "dot " + diagnosis.tone;
    byId("runner-title").textContent = diagnosis.title;
    byId("runner-cause").textContent = diagnosis.cause || "";
    byId("runner-fix").textContent = diagnosis.fix || "";
    var actions = byId("runner-actions");
    actions.textContent = "";
    diagnosis.actions.forEach(function (action, at) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      if (at === 0) button.className = "primary";
      button.addEventListener("click", function () {
        // Choosing is done here, in this window.
        if (action.id === "choose_workspace") return byId("runnerWorkspace").focus();
        if (action.id === "choose_backend") return byId("runnerBackend").focus();
        invoke("runner_control", { action: action.id }).catch(fail);
      });
      actions.appendChild(button);
    });
    byId("runner").checked = !!runner.enabled;
    var on = runner.enabled && !runner.paused;
    byId("runner-toggle").textContent = on ? "Stop" : "Start";
    byId("runner-toggle").dataset.action = on ? "stop" : "start";

    var backend = byId("runnerBackend");
    backend.value = runner.backend;
    var about = BACKENDS[runner.backend] || BACKENDS.sandboxed;
    byId("runner-backend-note").textContent = about.text;
    byId("runner-backend-note").className = about.warn ? "warning-note" : "muted";

    var workspaces = byId("runnerWorkspace");
    workspaces.textContent = "";
    var known = runner.workspaces.slice();
    var listed = known.some(function (w) {
      return w.slug === runner.workspace;
    });
    if (runner.workspace && !listed) known.unshift({ slug: runner.workspace, name: null });
    known.forEach(function (w) {
      workspaces.appendChild(option(w.slug, w.name ? w.name + " (" + w.slug + ")" : w.slug));
    });
    if (known.length === 0) workspaces.appendChild(option("", "Open g1t, signed in, to choose"));
    workspaces.value = runner.workspace || "";
    workspaces.disabled = known.length === 0;

    byId("runner-machine").textContent = "This computer: " + runner.machine;
    byId("runner-version").textContent = runner.version ? "g1t-runner " + runner.version : " ";
    byId("runner-view").hidden = !runner.link;
    byId("runner-log").textContent = runner.log.length ? runner.log.join("\n") : "Nothing yet.";
  }

  byId("runnerBackend").addEventListener("change", save);
  byId("runnerWorkspace").addEventListener("change", save);
  byId("runner-toggle").addEventListener("click", function (event) {
    invoke("runner_control", { action: event.target.dataset.action || "start" }).catch(fail);
  });
  byId("runner-view").addEventListener("click", function () {
    invoke("runner_control", { action: "view_runners" }).catch(fail);
  });
  byId("runner-open-log").addEventListener("click", function () {
    invoke("runner_control", { action: "view_log" }).catch(fail);
  });

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
    button.disabled = true;
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
        button.disabled = false;
      });
  }

  byId("check").addEventListener("click", check);
  byId("restart").addEventListener("click", function () {
    byId("restart").disabled = true;
    byId("update-status").textContent = "Installing…";
    invoke("restart_to_update").catch(function (error) {
      byId("restart").disabled = false;
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
    byId("restart-app").disabled = true;
    invoke("restart").catch(function (error) {
      byId("restart-app").disabled = false;
      fail(error);
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
