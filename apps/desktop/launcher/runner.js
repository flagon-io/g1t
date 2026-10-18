// The Runner window's work: the runner on its own, live. What it is
// doing, each kind of job and the job each is running, how jobs run and for
// which workspace, its updates and its log, from the app's status
// (src/runner/mod.rs View, in diagnosis.rs's words), and each change kept
// the moment it is made. Everything it asks is a command in src/bridge.rs.
(function () {
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

  // ── The runner ──────────────────────────────────────────────────────
  // Its diagnosis, from src/runner/diagnosis.rs, as the tray and the
  // site's Runners page show it; its buttons are the fixes.
  function option(value, text) {
    var item = document.createElement("option");
    item.value = value;
    item.textContent = text;
    return item;
  }

  var busy = window.g1tBusy;

  // The whole runner's status, as far as a button waits on it: a press is
  // done when any of this changes (busy.js).
  function runnerStatus(runner) {
    var d = runner.diagnosis;
    var update = d.update || {};
    return JSON.stringify([
      d.code,
      d.tone,
      d.title,
      d.cause,
      runner.chip.label,
      runner.enabled,
      runner.paused,
      update.checking,
      update.checked_at,
      update.ready,
    ]);
  }

  // One kind of job's, with the whole runner's.
  function kindStatus(kind, runner) {
    return JSON.stringify([runnerStatus(runner), kind.state, kind.enabled, kind.tone, kind.title, kind.cause]);
  }

  // A fix's button. Choosing is done here, in this window; a copy says it
  // was copied. One that changes the runner (the catalogue says which:
  // `waits`) stays busy until the status that follows; one the catalogue
  // asks about first (`confirm`) asks.
  function actionButton(action, primary, key, status) {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    if (primary) button.className = "primary";
    key = key + ":" + action.id;
    if (busy.pressed(key, status)) busy.start(button);
    button.addEventListener("click", function () {
      if (action.id === "choose_workspace") return byId("runnerWorkspace").focus();
      if (action.id === "choose_backend") return byId("runnerBackend").focus();
      if (action.confirm && !window.confirm(action.confirm)) return;
      busy
        .run(
          button,
          key,
          status,
          !!action.waits,
          function () {
            return invoke("runner_control", { action: action.id });
          },
          fail,
        )
        .then(function (done) {
          if (!done || action.id.indexOf("copy_") !== 0) return;
          button.textContent = "Copied";
          setTimeout(function () {
            button.textContent = action.label;
          }, 2000);
        });
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
    row.appendChild(element("span", "kind-job-label", "Running"));
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

  // Start or Stop for one kind of job, said for which: busy from the click
  // until the status that follows says it started or stopped.
  function toggleButton(kind, onFirst, runner) {
    var on = kind.enabled;
    var button = element("button", on ? "quiet" : onFirst ? "primary" : null);
    button.type = "button";
    button.textContent = on ? "Stop" : "Start";
    button.setAttribute("aria-label", (on ? "Stop " : "Start ") + kind.label);
    var key = "toggle:" + kind.id;
    var status = kindStatus(kind, runner);
    if (busy.pressed(key, status)) busy.start(button);
    button.addEventListener("click", function () {
      busy.run(
        button,
        key,
        status,
        true,
        function () {
          return invoke("runner_control", { action: on ? "stop" : "start", capability: kind.id });
        },
        fail,
      );
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
    var update = runner.diagnosis.update || null;
    var signature = JSON.stringify([kind, runner.link, update && update.checked]);
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
    // A newer version waiting for this kind of job, and when g1t last looked.
    if (update && (kind.update || kind.version)) {
      var updates = element("span", "kind-update");
      if (kind.update) updates.appendChild(element("span", "kind-update-ready", kind.update));
      updates.appendChild(element("span", "muted", update.checked));
      detail(details, "Updates", true, updates);
    }
    detail(details, "Isolation", ISOLATION[kind.isolation] || kind.isolation);
    details.hidden = !details.firstChild;

    var actions = card.actions;
    actions.textContent = "";
    // Its first fix stands out when it is the person's to do; while g1t
    // sees to it (waiting for the release's images), none does.
    var urgent = kind.tone === "problem" || kind.tone === "warning";
    kind.actions.forEach(function (action, at) {
      actions.appendChild(actionButton(action, at === 0 && urgent && kind.state !== "waiting", kind.id, kindStatus(kind, runner)));
    });
    if (kind.can_toggle) {
      var toggle = toggleButton(kind, kind.actions.length === 0, runner);
      toggle.classList.add("end");
      actions.appendChild(toggle);
    }
    actions.hidden = !actions.firstChild;
  }

  function renderKinds(runner) {
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
    renderEngine(runner);
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
      actions.appendChild(actionButton(action, at === 0, "runner", runnerStatus(runner)));
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
    // The runner's version, when g1t last looked for a newer one, and, with
    // no cards to say it, what becomes of one waiting.
    var update = diagnosis.update;
    var about = [runner.version ? "g1t-runner " + runner.version : null, update ? update.checked : null, update && update.note].filter(Boolean);
    byId("runner-version").textContent = about.length ? about.join(" · ") : " ";
    var check = byId("runner-check");
    check.hidden = !update;
    if (update) {
      check.textContent = update.check.label;
      // Busy while the app looks, whoever asked, and from a click until it says it is looking.
      if (update.checking || busy.pressed("check", runnerStatus(runner))) busy.start(check);
      else busy.stop(check);
    }
    // A Start or Stop pressed is done once the status says so.
    if (!busy.pressed("engine", runnerStatus(runner))) busy.stop(byId("engine-toggle"));
    byId("runner-view").hidden = !runner.link;
    // The log follows along, unless it was scrolled back to read.
    var log = byId("runner-log");
    var following = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.textContent = runner.log.length ? runner.log.join("\n") : "Nothing yet.";
    if (following) log.scrollTop = log.scrollHeight;
  }

  byId("runnerBackend").addEventListener("change", save);
  byId("runnerWorkspace").addEventListener("change", save);
  // A button that asks the runner for something: busy until the status
  // that follows when it `waits`, or until the app has it.
  function control(id, key, action, waits) {
    var button = byId(id);
    button.addEventListener("click", function () {
      var status = current && current.runnerView ? runnerStatus(current.runnerView) : "";
      busy.run(
        button,
        key,
        status,
        waits,
        function () {
          return invoke("runner_control", { action: typeof action === "function" ? action() : action });
        },
        fail,
      );
    });
  }
  control("runner-view", "view", "view_runners", false);
  control("runner-open-log", "log", "view_log", false);
  // Looks now; what it finds installs as each kind of job is idle, and the status that follows says so.
  control("runner-check", "check", "check_updates", true);

  // ── The whole runner, at the top ─────────────────────────────────────
  // As the title bar's chip says it, with what it is doing in a line and
  // its Start or Stop; the cards below say each kind of job.
  function renderEngine(runner) {
    byId("engine-dot").className = "dot " + runner.chip.tone;
    var label = byId("engine-label");
    if (label.textContent !== runner.chip.label) label.textContent = runner.chip.label;
    var about = [runner.diagnosis.title, runner.version ? "g1t-runner " + runner.version : null, runner.workspace ? "for " + runner.workspace : null].filter(
      Boolean,
    );
    byId("engine-sub").textContent = about.join(" · ");
    var toggle = byId("engine-toggle");
    var on = runner.enabled && !runner.paused;
    toggle.hidden = false;
    toggle.textContent = on ? "Stop" : "Start";
    toggle.className = on ? "quiet" : "primary";
    toggle.dataset.action = on ? "stop" : "start";
  }

  control(
    "engine-toggle",
    "engine",
    function () {
      return byId("engine-toggle").dataset.action;
    },
    true,
  );

  // Every setting, as the app has it now (the settings window changes the
  // rest), with the runner's own as they are on the page.
  var KEPT = [
    "startHidden",
    "closeToTray",
    "notifications",
    "flash",
    "badge",
    "systemTitleBar",
    "autoUpdate",
    "zoom",
    "developerTools",
    "runner",
    "runnerBackend",
    "runnerWorkspace",
    "runnerCapabilities",
  ];
  function save() {
    invoke("get_settings")
      .then(function (fresh) {
        var settings = {};
        KEPT.forEach(function (key) {
          if (key in fresh) settings[key] = fresh[key];
        });
        settings.runner = byId("runner").checked;
        settings.runnerBackend = byId("runnerBackend").value || "sandboxed";
        settings.runnerWorkspace = byId("runnerWorkspace").value || null;
        return invoke("save_settings", { settings: settings });
      })
      .then(
        function (view) {
          current = view;
          renderRunner(view.runnerView);
        },
        function (error) {
          fail(error);
          if (current) renderRunner(current.runnerView);
        },
      );
  }
  byId("runner").addEventListener("change", save);

  var events = window.__TAURI__ && window.__TAURI__.event;
  if (events && typeof events.listen === "function") {
    events
      .listen("g1t-runner-status", function (event) {
        if (current) current.runnerView = event.payload;
        renderRunner(event.payload);
      })
      .catch(function () {});
  }

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
      current = view;
      frame(view);
      renderRunner(view.runnerView);
      var log = byId("runner-log");
      log.scrollTop = log.scrollHeight;
    })
    .catch(fail);
})();
