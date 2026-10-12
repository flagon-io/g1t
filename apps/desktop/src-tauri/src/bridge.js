// The desktop bridge: what the site finds at `window.g1tDesktop`, run at
// the start of every page the window loads (bridge.rs puts it there). The
// site's lib/notify-client.ts describes the contract from its side; when
// the bridge is there, notifications go to the system, the badge to the
// icon, links out to the browser, and g1t:// links arrive as `onNavigate`.
// Each call is a command in bridge.rs, which only answers the server's
// pages; on any other page the calls fail quietly.
(function () {
  if (window.g1tDesktop) return;
  var VERSION = "__VERSION__";
  var PLATFORM = "__PLATFORM__";
  // Which window this is ("main" or "settings"), whether it draws g1t's
  // own title bar ("custom") or has the system's, and the bar's height.
  var WINDOW = "__WINDOW__";
  var FRAME = "__FRAME__";
  var HEIGHT = "__HEIGHT__";
  // The site's pages for reading about g1t, not using it, which open in
  // the browser (navigation.rs); one ending in "/" is every page under it.
  var OUTSIDE = "__OUTSIDE__";

  function invoke(command, args) {
    var core = window.__TAURI__ && window.__TAURI__.core;
    if (core && typeof core.invoke === "function") return core.invoke(command, args || {});
    var internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === "function") return internals.invoke(command, args || {});
    return Promise.reject(new Error("g1t desktop: this page cannot reach the app"));
  }

  function quietly(promise) {
    promise.catch(function (error) {
      console.warn("g1t desktop:", error && error.message ? error.message : error);
    });
  }

  var listeners = [];
  var listening = false;
  function listen() {
    if (listening) return;
    listening = true;
    var events = window.__TAURI__ && window.__TAURI__.event;
    if (!events || typeof events.listen !== "function") return;
    events
      .listen("g1t-navigate", function (event) {
        var href = event && event.payload;
        if (typeof href !== "string") return;
        listeners.slice().forEach(function (listener) {
          try {
            listener(href);
          } catch (error) {
            console.warn("g1t desktop: a navigate listener failed", error);
          }
        });
      })
      .catch(function () {});
  }

  var bridge = {
    version: VERSION,
    platform: PLATFORM,
    // A native notification, for a message to the person while the window is behind another.
    notify: function (notification) {
      quietly(invoke("notify", { title: String(notification.title || "g1t"), body: String(notification.body || "") }));
    },
    // What needs the person, on the icon and the tray; 0 clears it.
    setBadge: function (count) {
      quietly(invoke("set_badge", { count: Math.max(0, Math.floor(Number(count) || 0)) }));
    },
    // A link to somewhere else, in the browser the system uses.
    openUrl: function (url) {
      quietly(invoke("open_url", { url: String(url) }));
    },
    // g1t:// links, as site paths such as "/acme/-/chat/dm/chn_1".
    onNavigate: function (listener) {
      listeners.push(listener);
      listen();
      return function () {
        var at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    // Looks for an update now: "current", "ready:<version>", or rejects with why.
    checkForUpdates: function () {
      return invoke("check_for_updates");
    },
    // The app's own settings, in a window of their own.
    openSettings: function () {
      quietly(invoke("open_settings"));
    },
    // The title bar's search, in its middle: the site hands it a label
    // ("Search Flagon") and what opens its search. Returns what takes it away.
    setSearch: function (label, open) {
      var mine = typeof open === "function" ? { label: String(label || "Search"), open: open } : null;
      search = mine;
      drawSearch();
      return function () {
        if (search === mine) {
          search = null;
          drawSearch();
        }
      };
    },
    // Whether g1t draws the title bar, and how tall it is: 0 under the system's.
    titleBarHeight: FRAME === "custom" ? HEIGHT : 0,
  };
  Object.defineProperty(window, "g1tDesktop", { value: Object.freeze(bridge), writable: false, configurable: false });

  // Links out. A link to another site, or to one of the site's pages for
  // reading about g1t, opens in the system's browser, and the window stays
  // where it is; a link that asks for a new tab, or a click
  // with Ctrl or Cmd held, goes on in this window, which has no tabs.
  function outside(url) {
    var path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return OUTSIDE.some(function (page) {
      return page.charAt(page.length - 1) === "/" ? path.indexOf(page) === 0 : path === page;
    });
  }
  function destination(href) {
    try {
      var url = new URL(href, location.href);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch (error) {
      return null;
    }
  }
  document.addEventListener(
    "click",
    function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download")) return;
      var url = destination(anchor.getAttribute("href"));
      if (!url) return;
      if (url.origin !== location.origin || outside(url)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        bridge.openUrl(url.href);
      } else if (anchor.target === "_blank" || event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        location.assign(url.href);
      }
    },
    true,
  );
  var open = window.open;
  window.open = function (href, target, features) {
    var url = destination(href);
    if (url) {
      if (url.origin === location.origin && !outside(url)) location.assign(url.href);
      else bridge.openUrl(url.href);
      return null;
    }
    return typeof open === "function" ? open.call(window, href, target, features) : null;
  };

  // ── The title bar ─────────────────────────────────────────────────────
  // g1t's own, in place of the system's (src/frame.rs), on every page the
  // window shows: the menu button, back and forward, search in the middle,
  // and the window's buttons; on macOS the system's traffic lights sit at
  // its left. It is drawn in a closed shadow root, so no page's styles
  // reach it, in the colours of the site's rail where the page has them.
  // `data-titlebar` on <html> tells the page to make room: the site does
  // (`--frame-top`, apps/web/app/app.css); any other page is pushed down.
  var search = null;
  var drawSearch = function () {};
  if (FRAME !== "custom") return;
  var MAC = PLATFORM === "macos";
  var MAIN = WINDOW === "main";

  function whenThere(test, then) {
    if (test()) return then();
    var watch = new MutationObserver(function () {
      if (!test()) return;
      watch.disconnect();
      then();
    });
    watch.observe(document, { childList: true, subtree: true });
  }

  // Room for the bar, before the page paints. With no specificity of its
  // own, any rule of the page's for the same thing wins.
  var ROOM = ":where(html[data-titlebar]) { padding-top: " + HEIGHT + "px; }";
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(ROOM);
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(sheet);
  } catch (error) {
    whenThere(
      function () {
        return document.head;
      },
      function () {
        var style = document.createElement("style");
        style.textContent = ROOM;
        document.head.appendChild(style);
      },
    );
  }
  whenThere(
    function () {
      return document.documentElement;
    },
    function () {
      document.documentElement.setAttribute("data-titlebar", PLATFORM);
    },
  );

  function svg(body) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }
  // Drawn here, from lines and boxes, as each system draws its own.
  var ICONS = {
    menu: svg('<line x1="3" y1="4.5" x2="13" y2="4.5"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="11.5" x2="13" y2="11.5"/>'),
    back: svg('<polyline points="9.5,3.5 5,8 9.5,12.5"/><line x1="5" y1="8" x2="13" y2="8"/>'),
    forward: svg('<polyline points="6.5,3.5 11,8 6.5,12.5"/><line x1="3" y1="8" x2="11" y2="8"/>'),
    search: svg('<circle cx="7" cy="7" r="4"/><line x1="10" y1="10" x2="13" y2="13"/>'),
    minimize: svg('<line x1="3.5" y1="8" x2="12.5" y2="8"/>'),
    maximize: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>'),
    restore: svg('<rect x="3.5" y="5.5" width="7" height="7" rx="1"/><path d="M5.5 5.5V4.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/>'),
    close: svg('<line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>'),
  };

  var STYLE =
    ":host{position:fixed;top:0;left:0;right:0;height:" + HEIGHT + "px;z-index:2147483646;display:block;}" +
    ".bar{box-sizing:border-box;height:100%;display:flex;align-items:center;gap:2px;padding:0 0 0 6px;" +
    "background:var(--color-rail,#050507);color:var(--color-muted,#a0a0a8);" +
    "font:500 12px/1 system-ui,'Segoe UI',-apple-system,Roboto,sans-serif;user-select:none;-webkit-user-select:none;cursor:default;}" +
    ".mac .bar{padding-left:78px;}" +
    ".side{display:flex;align-items:center;gap:2px;flex:1 1 0;min-width:0;}" +
    ".end{justify-content:flex-end;}" +
    ".middle{flex:0 1 560px;min-width:0;display:flex;justify-content:center;}" +
    "button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;color:inherit;}" +
    ".icon{width:28px;height:26px;border-radius:6px;}" +
    ".icon:hover{background:color-mix(in srgb,var(--color-fg,#ededef) 10%,transparent);color:var(--color-fg,#ededef);}" +
    ".icon:disabled{opacity:.35;background:none;color:inherit;}" +
    ".search{width:100%;height:24px;gap:8px;padding:0 10px;justify-content:flex-start;border-radius:6px;" +
    "background:color-mix(in srgb,var(--color-fg,#ededef) 9%,transparent);" +
    "box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-fg,#ededef) 8%,transparent);}" +
    ".search:hover{background:color-mix(in srgb,var(--color-fg,#ededef) 14%,transparent);color:var(--color-fg,#ededef);}" +
    ".search span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px;}" +
    ".caption{width:46px;height:" + HEIGHT + "px;}" +
    ".caption:hover{background:color-mix(in srgb,var(--color-fg,#ededef) 10%,transparent);color:var(--color-fg,#ededef);}" +
    ".caption.close:hover{background:#c42b1c;color:#fff;}" +
    "button:focus-visible{outline:2px solid var(--color-accent,#b6a8ff);outline-offset:-2px;}";

  function button(kind, label, onClick, extra) {
    var b = document.createElement("button");
    b.type = "button";
    b.tabIndex = -1;
    b.className = kind + (extra ? " " + extra : "");
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", function (event) {
      event.stopPropagation();
      onClick(event, b);
    });
    return b;
  }

  function control(action) {
    return invoke("window_control", { action: action });
  }

  var host = document.createElement("g1t-titlebar");
  var shadow = host.attachShadow({ mode: "closed" });
  var frame = document.createElement("div");
  frame.className = MAC ? "mac" : "";
  frame.style.height = "100%";
  var styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  var bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Window");
  var left = document.createElement("div");
  left.className = "side";
  var middle = document.createElement("div");
  middle.className = "middle";
  var right = document.createElement("div");
  right.className = "side end";
  bar.append(left, middle, right);
  frame.append(styleEl, bar);
  shadow.append(frame);

  var back = null;
  var forward = null;
  if (MAIN) {
    if (!MAC) {
      left.append(
        button("icon", "Menu", function (event, b) {
          var box = b.getBoundingClientRect();
          quietly(invoke("window_menu", { x: box.left, y: box.bottom }));
        }),
      );
    }
    back = button("icon", "Back", function () {
      history.back();
    });
    forward = button("icon", "Forward", function () {
      history.forward();
    });
    back.innerHTML = ICONS.back;
    forward.innerHTML = ICONS.forward;
    left.append(back, forward);
    if (!MAC) left.firstChild.innerHTML = ICONS.menu;
  }

  // Back and forward, greyed when there is nowhere to go, where the web view can tell.
  function drawHistory() {
    if (!back) return;
    var nav = window.navigation;
    if (!nav || typeof nav.canGoBack !== "boolean") return;
    back.disabled = !nav.canGoBack;
    forward.disabled = !nav.canGoForward;
  }
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("currententrychange", drawHistory);
  }
  drawHistory();

  // The middle: the site's search when it has handed one over, otherwise the page's title.
  var title = document.createElement("span");
  title.className = "title";
  drawSearch = function () {
    middle.textContent = "";
    if (search) {
      var pill = button("search", search.label, function () {
        search.open();
      });
      pill.innerHTML = ICONS.search;
      var text = document.createElement("span");
      text.textContent = search.label;
      pill.append(text);
      middle.append(pill);
    } else {
      title.textContent = document.title || "g1t";
      middle.append(title);
    }
  };
  drawSearch();
  {
    var retitle = function () {
      if (!search) title.textContent = document.title || "g1t";
    };
    document.addEventListener("DOMContentLoaded", retitle);
    whenThere(
      function () {
        return document.head;
      },
      function () {
        retitle();
        new MutationObserver(retitle).observe(document.head, { subtree: true, childList: true, characterData: true });
      },
    );
  }

  // The window's buttons, at the right as Windows and Linux put them; macOS has its own.
  if (!MAC) {
    if (MAIN) {
      var minimize = button("caption", "Minimize", function () {
        quietly(control("minimize"));
      });
      minimize.innerHTML = ICONS.minimize;
      var maximize = button("caption", "Maximize", function () {
        control("maximize").then(drawMaximized, function () {});
      });
      maximize.innerHTML = ICONS.maximize;
      right.append(minimize, maximize);
      var drawMaximized = function (maximized) {
        maximize.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
        maximize.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
        maximize.title = maximized ? "Restore" : "Maximize";
      };
      var resizing = 0;
      window.addEventListener("resize", function () {
        clearTimeout(resizing);
        resizing = setTimeout(function () {
          control("maximized").then(drawMaximized, function () {});
        }, 120);
      });
      control("maximized").then(drawMaximized, function () {});
    }
    var close = button("caption", "Close", function () {
      quietly(control("close"));
    }, "close");
    close.innerHTML = ICONS.close;
    right.append(close);
  }

  // Dragging the bar moves the window; a double click maximizes it, as a system's title bar does.
  bar.addEventListener("mousedown", function (event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    if (event.detail === 2) {
      if (MAIN) control("maximize").then(drawMaximized || function () {}, function () {});
      return;
    }
    quietly(control("drag"));
  });

  // In the page from as early as there is a page, and back if a page's script takes it out.
  function attach() {
    if (host.parentNode !== document.documentElement) document.documentElement.appendChild(host);
  }
  whenThere(
    function () {
      return document.body;
    },
    function () {
      attach();
      new MutationObserver(attach).observe(document.documentElement, { childList: true });
    },
  );
})();
