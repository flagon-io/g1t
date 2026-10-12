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
    // Which kinds of job are on is changed by their cards' Start and Stop, and kept as it is here.
    if (current && current.runnerCapabilities) settings.runnerCapabilities = current.runnerCapabilities;
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

  // A fix's button. Choosing is done here, in this window; a copy says it was copied.
  function actionButton(action, primary) {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    if (primary) button.className = "primary";
    button.addEventListener("click", function () {
      if (action.id === "choose_workspace") return byId("runnerWorkspace").focus();
      if (action.id === "choose_backend") return byId("runnerBackend").focus();
      invoke("runner_control", { action: action.id }).then(function () {
        if (action.id.indexOf("copy_") !== 0) return;
        button.textContent = "Copied";
        setTimeout(function () {
          button.textContent = action.label;
        }, 2000);
      }, fail);
    });
    return button;
  }

  function element(tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    if (text != null) item.textContent = text;
    return item;
  }

  // The catalogue's sentences name commands in backticks: `wsl --install`.
  // Said here as code, which can be selected and copied.
  function prose(into, text) {
    into.textContent = "";
    String(text || "")
      .split("`")
      .forEach(function (part, at) {
        if (!part) return;
        into.appendChild(at % 2 ? element("code", null, part) : document.createTextNode(part));
      });
    return into;
  }

  // ── Each kind of job, a card of its own ───────────────────────────────
  // Linux jobs and Windows jobs (macOS jobs once they are released): what
  // each is doing, why one isn't running and its fix, and its own Start or
  // Stop, which leaves the other as it is. The words are the app's
  // (CapabilityLine in src/runner/diagnosis.rs); the card only lays them out.
  var SVG = "http://www.w3.org/2000/svg";
  // Plain line icons, 16px on a 24px grid: a terminal for Linux jobs, a
  // window for Windows jobs, a laptop for macOS jobs.
  var ICONS = {
    linux: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M7 10l3 2.5L7 15", "M12.5 15h4"],
    windows: ["M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M3 9h18", "M6.5 6.5h.01", "M9 6.5h.01"],
    macos: ["M5 6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v9H5z", "M2.5 18.5h19", "M3.5 18.5L5 15h14l1.5 3.5"],
  };
  // How each runner keeps a job from this computer, said plainly.
  var ISOLATION = { "nested-container": "A fresh container in the VM", vm: "A VM of its own", container: "A container of its own", host: "None" };
  var BUSY = { busy: true, starting: true, downloading: true, updating: true };
  var cards = {};
  var pending = {};

  // A small arrow: the link goes out to g1t.
  function outward() {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG, "path");
    path.setAttribute("d", "M7 17L17 7M9 7h8v8");
    svg.appendChild(path);
    return svg;
  }

  function icon(id) {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    (ICONS[id] || ICONS.linux).forEach(function (d) {
      var path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });
    return svg;
  }

  // A card's parts, made once and filled in on every status.
  function makeCard(kind) {
    var card = element("article", "kind");
    card.setAttribute("role", "listitem");
    card.setAttribute("aria-labelledby", "kind-" + kind.id + "-title");
    var head = element("header", "kind-head");
    var badge = element("span", "kind-icon");
    badge.appendChild(icon(kind.id));
    var name = element("span", "kind-name");
    var title = element("h3", null, kind.label);
    title.id = "kind-" + kind.id + "-title";
    name.appendChild(title);
    var pill = element("span", "pill");
    // Its state is said when it changes, as "Linux jobs: Waiting for jobs".
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");
    pill.setAttribute("aria-atomic", "true");
    var said = element("span", "visually-hidden", kind.label + ": ");
    pill.appendChild(said);
    pill.appendChild(element("span", "pill-dot"));
    pill.appendChild(element("span", "pill-text"));
    name.appendChild(pill);
    head.appendChild(badge);
    head.appendChild(name);
    card.appendChild(head);
    card.appendChild(element("p", "kind-about"));
    var body = element("div", "kind-body");
    card.appendChild(body);
    var details = element("dl", "kind-details");
    card.appendChild(details);
    var actions = element("div", "kind-actions");
    card.appendChild(actions);
    return { root: card, pill: pill, about: card.querySelector(".kind-about"), body: body, details: details, actions: actions, signature: "" };
  }

  // What it is running, with where to see it on g1t.
  function jobRow(job) {
    var row = element("div", "kind-job");
    row.appendChild(element("span", "kind-job-label", job.kind === "agent" ? "Agent work" : "Running"));
    var what = element("span", "kind-job-what");
    if (job.link) {
      var link = element("a", null, job.name);
      link.href = job.link;
      what.appendChild(link);
    } else {
      what.appendChild(element("strong", null, job.name));
    }
    if (job.repo) what.appendChild(element("span", "muted", " in " + job.repo));
    row.appendChild(what);
    return row;
  }

  function progressRow(kind) {
    var row = element("div", "kind-progress");
    var bar = element("div", "bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(kind.progress));
    bar.setAttribute("aria-label", kind.label + ": the sandbox's image");
    var fill = element("span");
    fill.style.width = Math.max(2, Math.min(100, kind.progress)) + "%";
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(element("span", "muted small", kind.progress + "%"));
    return row;
  }

  function detail(list, term, value, given) {
    if (!value) return;
    var row = element("div");
    row.appendChild(element("dt", null, term));
    var dd = element("dd", null, given ? null : value);
    if (given) dd.appendChild(given);
    row.appendChild(dd);
    list.appendChild(row);
  }

  // Start or Stop for one kind of job, said for which, and what it is doing meanwhile.
  function toggleButton(kind, onFirst) {
    var on = kind.enabled;
    var waiting = pending[kind.id];
    var button = element("button", on ? "quiet" : onFirst ? "primary" : null);
    button.type = "button";
    button.textContent = waiting ? (on ? "Stopping…" : "Starting…") : on ? "Stop" : "Start";
    button.setAttribute("aria-label", (on ? "Stop " : "Start ") + kind.label);
    button.disabled = !!waiting;
    button.addEventListener("click", function () {
      pending[kind.id] = true;
      renderKinds(lastKinds);
      invoke("runner_control", { action: on ? "stop" : "start", capability: kind.id })
        .catch(fail)
        .then(function () {
          // The status that follows says how it is; until then it says what was asked.
          setTimeout(function () {
            delete pending[kind.id];
            renderKinds(lastKinds);
          }, 1500);
        });
    });
    return button;
  }

  function fillCard(card, kind, runner) {
    var root = card.root;
    root.dataset.state = kind.state;
    root.dataset.tone = kind.tone;
    root.classList.toggle("off", !kind.enabled);
    card.pill.dataset.tone = kind.tone;
    card.pill.classList.toggle("live", !!BUSY[kind.state]);
    // Said again only when it changes, so a screen reader hears each change once.
    var text = card.pill.querySelector(".pill-text");
    if (text.textContent !== kind.title) text.textContent = kind.title;
    if (card.about.textContent !== kind.about) card.about.textContent = kind.about;

    // What changes the buttons and the words is drawn again only when it changes,
    // so a button keeps its focus while the status ticks.
    var signature = JSON.stringify([kind, !!pending[kind.id], runner.link]);
    if (signature === card.signature) return;
    card.signature = signature;

    var body = card.body;
    body.textContent = "";
    if (kind.job) body.appendChild(jobRow(kind.job));
    if (kind.state === "downloading" && kind.progress != null) body.appendChild(progressRow(kind));
    if (kind.headline) body.appendChild(element("p", "kind-headline", kind.headline));
    if (kind.cause) body.appendChild(prose(element("p", "kind-cause"), kind.cause));
    if (kind.fix) body.appendChild(prose(element("p", "kind-fix"), kind.fix));
    body.hidden = !body.firstChild;

    var details = card.details;
    details.textContent = "";
    // Its name on g1t opens the workspace's Runners page, where it is listed.
    var named = null;
    if (kind.runner && runner.link) {
      named = element("button", "link", kind.runner);
      named.type = "button";
      named.setAttribute("aria-label", "View " + kind.runner + " on g1t");
      named.appendChild(outward());
      named.addEventListener("click", function () {
        invoke("runner_control", { action: "view_runners" }).catch(fail);
      });
    }
    detail(details, "On g1t", kind.runner, named);
    detail(details, "Version", kind.version ? "g1t-runner " + kind.version : null);
    detail(details, "Isolation", ISOLATION[kind.isolation] || kind.isolation);
    details.hidden = !details.firstChild;

    var actions = card.actions;
    actions.textContent = "";
    // Its first fix stands out when it is the person's to do; while g1t
    // sees to it (waiting for the release's images), none does.
    var urgent = kind.tone === "problem" || kind.tone === "warning";
    kind.actions.forEach(function (action, at) {
      actions.appendChild(actionButton(action, at === 0 && urgent && kind.state !== "waiting"));
    });
    if (kind.can_toggle) {
      var toggle = toggleButton(kind, kind.actions.length === 0);
      toggle.classList.add("end");
      actions.appendChild(toggle);
    }
    actions.hidden = !actions.firstChild;
  }

  var lastKinds = null;

  function renderKinds(runner) {
    lastKinds = runner;
    var list = byId("runner-kinds");
    var kinds = (runner && runner.diagnosis.capabilities) || [];
    list.hidden = kinds.length === 0;
    var seen = {};
    kinds.forEach(function (kind, at) {
      seen[kind.id] = true;
      var card = cards[kind.id] || (cards[kind.id] = makeCard(kind));
      if (list.children[at] !== card.root) list.insertBefore(card.root, list.children[at] || null);
      fillCard(card, kind, runner);
    });
    Object.keys(cards).forEach(function (id) {
      if (seen[id]) return;
      cards[id].root.remove();
      delete cards[id];
    });
    list.classList.toggle("single", kinds.length === 1);
  }

  function renderRunner(runner) {
    if (!runner) return;
    var diagnosis = runner.diagnosis;
    // The whole runner's line, when the cards don't already say it.
    var cardsSayIt = diagnosis.in_capabilities && diagnosis.capabilities && diagnosis.capabilities.length > 0;
    byId("runner-diagnosis").hidden = !!cardsSayIt;
    byId("runner-dot").className = "dot " + diagnosis.tone;
    byId("runner-title").textContent = diagnosis.title;
    prose(byId("runner-cause"), diagnosis.cause);
    prose(byId("runner-fix"), diagnosis.fix);
    var actions = byId("runner-actions");
    actions.textContent = "";
    diagnosis.actions.forEach(function (action, at) {
      actions.appendChild(actionButton(action, at === 0));
    });
    renderKinds(runner);
    byId("runner").checked = !!runner.enabled;

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
        pending = {};
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
