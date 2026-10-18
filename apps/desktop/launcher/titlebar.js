// The title bar's work: draw what the page under it reports, and send its
// buttons to the app (src/bridge.rs: title_bar_current, title_bar_act,
// window_control, window_menu). A click here hands the keyboard back to
// the page, so typing goes on where it was.
(function () {
  var core = window.__TAURI__ && window.__TAURI__.core;
  var events = window.__TAURI__ && window.__TAURI__.event;
  function invoke(command, args) {
    if (core && typeof core.invoke === "function") return core.invoke(command, args || {});
    return Promise.reject(new Error("the title bar cannot reach the app"));
  }
  function quietly(promise) {
    promise.catch(function () {});
  }
  function act(action) {
    quietly(invoke("title_bar_act", { action: action }));
  }
  function control(action) {
    return invoke("window_control", { action: action });
  }

  var ua = navigator.userAgent;
  var MAC = /Macintosh|Mac OS X/.test(ua) && !/Windows/.test(ua);
  if (MAC) document.documentElement.classList.add("mac");

  function svg(body) {
    return (
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body +
      "</svg>"
    );
  }
  // Drawn here, from lines and boxes, as each system draws its own.
  var ICONS = {
    menu: svg('<line x1="3" y1="4.5" x2="13" y2="4.5"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="11.5" x2="13" y2="11.5"/>'),
    back: svg('<polyline points="9.5,3.5 5,8 9.5,12.5"/><line x1="5" y1="8" x2="13" y2="8"/>'),
    forward: svg('<polyline points="6.5,3.5 11,8 6.5,12.5"/><line x1="3" y1="8" x2="11" y2="8"/>'),
    search: svg('<circle cx="7" cy="7" r="4"/><line x1="10" y1="10" x2="13" y2="13"/>'),
    settings: svg(
      '<line x1="2.5" y1="4.5" x2="13.5" y2="4.5"/><line x1="2.5" y1="11.5" x2="13.5" y2="11.5"/><circle cx="10" cy="4.5" r="1.75" fill="var(--bg)"/><circle cx="6" cy="11.5" r="1.75" fill="var(--bg)"/>',
    ),
    minimize: svg('<line x1="3.5" y1="8" x2="12.5" y2="8"/>'),
    maximize: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>'),
    restore: svg('<rect x="3.5" y="5.5" width="7" height="7" rx="1"/><path d="M5.5 5.5V4.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/>'),
    close: svg('<line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>'),
  };

  function button(kind, label, icon, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.tabIndex = -1;
    b.className = kind;
    b.setAttribute("aria-label", label);
    b.title = label;
    if (icon) b.innerHTML = ICONS[icon];
    b.addEventListener("click", function (event) {
      event.stopPropagation();
      onClick(b);
    });
    return b;
  }

  var bar = document.getElementById("bar");
  var left = document.getElementById("left");
  var middle = document.getElementById("middle");
  var right = document.getElementById("right");

  if (!MAC) {
    left.append(
      button("icon", "Menu", "menu", function (b) {
        var box = b.getBoundingClientRect();
        quietly(invoke("window_menu", { x: box.left, y: box.bottom }));
      }),
    );
  }
  var back = button("icon", "Back", "back", function () {
    act("back");
  });
  var forward = button("icon", "Forward", "forward", function () {
    act("forward");
  });
  left.append(back, forward);

  // The runner, as a dot right beside the settings: its colour says what
  // it is doing, live, and a wide window says it in words too. A click
  // opens its menu, which the site draws under the dot (or, with no page
  // of the site's to draw it, the Runner window). The words are the app's
  // (diagnosis.rs chip).
  var chip = button("chip", "Runner", null, function (b) {
    var box = b.getBoundingClientRect();
    var width = document.documentElement.clientWidth || window.innerWidth || 1;
    // Where the dot's right edge is, as a share of the bar, so the menu
    // lines up under it whatever the site's zoom.
    quietly(invoke("title_bar_act", { action: "runner", at: box.right / width }));
  });
  chip.hidden = true;
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");
  var chipDot = document.createElement("span");
  chipDot.className = "chip-dot";
  var chipText = document.createElement("span");
  chipText.className = "chip-text";
  chip.append(chipDot, chipText);
  function drawChip(said) {
    if (!said || !said.label) return;
    chip.hidden = false;
    chip.dataset.tone = said.tone;
    chipText.textContent = said.label;
    chip.setAttribute("aria-label", /runner/i.test(said.label) ? said.label : "Runner: " + said.label);
    chip.title = said.label;
  }
  // The app's settings, at the right of the bar, before the window's
  // buttons: where they are found without the menu.
  right.append(
    chip,
    button("icon", "Settings", "settings", function () {
      act("settings");
    }),
  );

  var maximize = null;
  function drawMaximized(maximized) {
    if (!maximize) return;
    maximize.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
    maximize.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
    maximize.title = maximized ? "Restore" : "Maximize";
  }
  // The window's buttons, at the right as Windows and Linux put them; macOS has its own.
  if (!MAC) {
    maximize = button("caption", "Maximize", "maximize", function () {
      control("maximize").then(drawMaximized, function () {});
    });
    right.append(
      button("caption", "Minimize", "minimize", function () {
        quietly(control("minimize"));
      }),
      maximize,
      button("caption close", "Close", "close", function () {
        quietly(control("close"));
      }),
    );
    var resizing = 0;
    window.addEventListener("resize", function () {
      clearTimeout(resizing);
      resizing = setTimeout(function () {
        control("maximized").then(drawMaximized, function () {});
      }, 120);
    });
    control("maximized").then(drawMaximized, function () {});
  }

  // Dragging the bar moves the window; a double click maximizes it, as a system's title bar does.
  bar.addEventListener("mousedown", function (event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    if (event.detail === 2) {
      control("maximize").then(drawMaximized, function () {});
      return;
    }
    quietly(control("drag"));
  });
  // The keyboard belongs to the page: a click here gives it back.
  window.addEventListener("mouseup", function () {
    act("focus");
  });

  var title = document.createElement("span");
  title.className = "title";
  var pill = button("search", "Search", "search", function () {
    act("search");
  });
  var pillText = document.createElement("span");
  pill.append(pillText);

  function setColors(colors) {
    var root = document.documentElement.style;
    if (!colors) return;
    var shade = colors.dark ? "237, 237, 239" : "15, 15, 17";
    root.setProperty("--bg", colors.background);
    root.setProperty("--fg", colors.foreground);
    root.setProperty("--muted", colors.muted);
    root.setProperty("--accent", colors.accent);
    root.setProperty("--hover", "rgba(" + shade + ", " + (colors.dark ? 0.1 : 0.07) + ")");
    root.setProperty("--pill", "rgba(" + shade + ", " + (colors.dark ? 0.09 : 0.05) + ")");
    root.setProperty("--pill-hover", "rgba(" + shade + ", " + (colors.dark ? 0.14 : 0.09) + ")");
    root.setProperty("--pill-edge", "rgba(" + shade + ", " + (colors.dark ? 0.08 : 0.1) + ")");
    document.documentElement.style.colorScheme = colors.dark ? "dark" : "light";
  }

  function draw(page) {
    if (!page) return;
    middle.textContent = "";
    if (page.search) {
      pillText.textContent = page.search;
      pill.setAttribute("aria-label", page.search);
      pill.removeAttribute("title");
      middle.append(pill);
    } else {
      title.textContent = page.title || "g1t";
      middle.append(title);
    }
    chip.setAttribute("aria-expanded", page.runnerMenu ? "true" : "false");
    back.disabled = page.canGoBack === false;
    forward.disabled = page.canGoForward === false;
    setColors(page.colors);
  }

  if (events && typeof events.listen === "function") {
    events
      .listen("g1t-title-bar", function (event) {
        draw(event.payload);
      })
      .catch(function () {});
  }
  invoke("title_bar_current").then(draw, function () {});
  if (events && typeof events.listen === "function") {
    events
      .listen("g1t-runner-status", function (event) {
        drawChip(event.payload);
      })
      .catch(function () {});
  }
  invoke("runner_status").then(
    function (view) {
      drawChip(view && view.chip);
    },
    function () {},
  );
})();
