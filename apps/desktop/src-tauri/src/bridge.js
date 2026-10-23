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
  // Whether g1t's own title bar is above this page ("custom"), or the
  // system's ("system"). The bar is a page of its own (src/frame.rs); this
  // page only tells it what to show (`report`), and is never under it.
  var FRAME = "__FRAME__";
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

  // An app event, to a listener; returns what stops listening.
  function on(name, listener) {
    var events = window.__TAURI__ && window.__TAURI__.event;
    if (!events || typeof events.listen !== "function") return function () {};
    var stop = null;
    var stopped = false;
    events
      .listen(name, function (event) {
        try {
          listener(event && event.payload);
        } catch (error) {
          console.warn("g1t desktop: a " + name + " listener failed", error);
        }
      })
      .then(function (unlisten) {
        if (stopped) unlisten();
        else stop = unlisten;
      })
      .catch(function () {});
    return function () {
      stopped = true;
      if (stop) stop();
    };
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
    // The app's own settings: the dialog this page draws (`settings.onOpen`),
    // or their own window when the page can't.
    openSettings: function () {
      quietly(invoke("open_settings"));
    },
    // The app's settings, for the dialog the site draws over itself, and
    // the runner's menu under the title bar's dot (src/settings.rs). The
    // page says it draws them with `ready`; until then they open in windows
    // of their own.
    settings: Object.freeze({
      ready: function (ready) {
        return invoke("site_ready", { ready: ready !== false });
      },
      get: function () {
        return invoke("get_settings");
      },
      // Every setting but opening at sign-in, as `get` has them (camelCase).
      save: function (settings) {
        return invoke("save_settings", { settings: settings });
      },
      setOpenAtLogin: function (on) {
        return invoke("set_open_at_login", { on: !!on });
      },
      // "current", "ready:<version>", or rejects with why; the dialog says it, so no notification.
      checkForUpdates: function () {
        return invoke("check_for_updates", { shown: true });
      },
      restart: function () {
        return invoke("restart");
      },
      restartToUpdate: function () {
        return invoke("restart_to_update");
      },
      changeServer: function () {
        return invoke("change_server");
      },
      // Open the dialog: { section: "runner" | "updates" | null, check: boolean }.
      onOpen: function (listener) {
        return on("g1t-open-settings", listener);
      },
      // The runner menu: { action: "toggle" | "open", at: share of the bar's width | null }.
      onRunnerMenu: function (listener) {
        return on("g1t-runner-menu", listener);
      },
      // An update finished downloading, with its version.
      onUpdateReady: function (listener) {
        return on("g1t-update-ready", listener);
      },
      // Whether the runner menu is open, which the title bar's dot shows.
      setRunnerMenuOpen: function (open) {
        runnerMenu = !!open;
        report();
      },
    }),
    // The web inspector for this page, while Developer tools is on in the
    // app's settings (src/devtools.rs); rejects with where to turn it on
    // while it is off.
    devtools: Object.freeze({
      open: function () {
        return invoke("open_devtools");
      },
    }),
    // The title bar's search, in its middle: the site hands it a label
    // ("Search Flagon") and what opens its search. Returns what takes it away.
    setSearch: function (label, open) {
      var mine = typeof open === "function" ? { label: String(label || "Search"), open: open } : null;
      search = mine;
      report();
      return function () {
        if (search === mine) {
          search = null;
          report();
        }
      };
    },
    // Whether g1t draws the title bar, and how tall it is: 0 under the system's.
    // The page is below it, never under it: this says only that the bar is there.
    titleBarHeight: FRAME === "custom" ? 36 : 0,
    // The runner the app keeps on this computer (src/runner/mod.rs).
    runner: Object.freeze({
      // What it is doing: its diagnosis (why it isn't running, and the
      // fix), the workspace, how jobs run, and its last log lines.
      status: function () {
        return invoke("runner_status");
      },
      // Who is signed in, the workspaces they own, and the one they are in;
      // resolves to the workspace a registration token is wanted for, or null.
      offer: function (offer) {
        return invoke("runner_offer", {
          signedIn: !!offer.signedIn,
          workspaces: (offer.workspaces || []).map(function (w) {
            return { slug: String(w.slug), name: w.name == null ? null : String(w.name) };
          }),
          current: offer.current == null ? null : String(offer.current),
        });
      },
      // A registration token for the workspace the app asked for, or why there is none.
      register: function (answer) {
        return invoke("runner_register", {
          workspace: String(answer.workspace),
          token: answer.token == null ? null : String(answer.token),
          allowed: answer.allowed !== false,
          error: answer.error == null ? null : String(answer.error),
        });
      },
      // Start, stop, or a diagnosis's fix, by its id; Start and Stop of one
      // kind of job alone (`linux`, `windows`) with its id as `capability`.
      act: function (action, capability) {
        var args = { action: String(action) };
        if (capability != null) args.capability = String(capability);
        return invoke("runner_control", args);
      },
      // The sizes of g1t's machines Linux jobs are taken for: `1-core,2-core:4:16g`
      // (empty for none), or null to have one picked again.
      setSizes: function (sizes) {
        return invoke("runner_sizes", { sizes: sizes == null ? null : String(sizes) });
      },
      // The Linux sandbox's share of this computer: whole CPUs, and memory in MiB.
      setShare: function (cpus, memoryMib) {
        return invoke("runner_share", { cpus: Number(cpus), memoryMib: Number(memoryMib) });
      },
      // The app wants a registration token for a workspace.
      onWanted: function (listener) {
        return on("g1t-runner-wanted", listener);
      },
      // The runner's status changed.
      onStatus: function (listener) {
        return on("g1t-runner-status", listener);
      },
    }),
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

  // F12 opens the web inspector, or closes it, while Developer tools is on;
  // the View menu's row has Ctrl+Shift+I (⌥⌘I on macOS). With it off, or
  // on a page that isn't the site's, the app says no and the key is the
  // page's as ever.
  document.addEventListener(
    "keydown",
    function (event) {
      if (event.key !== "F12" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      invoke("open_devtools", { toggle: true }).catch(function () {});
    },
    true,
  );

  // ── The title bar ─────────────────────────────────────────────────────
  // What the bar above the page shows of it: the title, the search the
  // site handed over (`setSearch`), whether there is a page to go back or
  // forward to, the page's colours, so the bar is the colour of g1t's
  // rail, light or dark, or of whatever page is showing, and whether the
  // runner menu is open under the bar's dot. Sent whenever any of it
  // changes; the bar's search comes back as an event.
  var search = null;
  var runnerMenu = false;
  var report = function () {};
  if (FRAME !== "custom") return;

  // A colour the page names, resolved: `var(--color-rail)` is light-dark(…) until it is drawn.
  var probe = null;
  function resolve(value) {
    if (!document.body) return "";
    if (!probe) {
      probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
    }
    if (probe.parentNode !== document.body) document.body.appendChild(probe);
    probe.style.color = "";
    probe.style.color = value;
    var color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }
  function opaque(color) {
    return !!color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color);
  }
  function luminance(color) {
    var parts = (color.match(/[\d.]+/g) || []).map(Number);
    return parts.length < 3 ? 0 : (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
  }
  // g1t's pages name their colours (apps/web/app/app.css); any other page has its own background and text.
  function colors() {
    if (!document.body) return null;
    var root = getComputedStyle(document.documentElement);
    var ours = root.getPropertyValue("--color-rail").trim() !== "";
    var body = getComputedStyle(document.body);
    var background = ours ? resolve("var(--color-rail)") : body.backgroundColor;
    if (!opaque(background)) background = root.backgroundColor;
    if (!opaque(background)) return null;
    var foreground = ours ? resolve("var(--color-fg)") : body.color;
    return {
      background: background,
      foreground: foreground,
      muted: ours ? resolve("var(--color-muted)") : foreground,
      accent: ours ? resolve("var(--color-accent)") : foreground,
      dark: luminance(background) < 0.5,
    };
  }

  var sent = "";
  var waiting = 0;
  report = function () {
    clearTimeout(waiting);
    waiting = setTimeout(function () {
      var nav = window.navigation;
      var page = {
        title: document.title || "g1t",
        search: search ? search.label : null,
        canGoBack: nav && typeof nav.canGoBack === "boolean" ? nav.canGoBack : null,
        canGoForward: nav && typeof nav.canGoForward === "boolean" ? nav.canGoForward : null,
        colors: colors(),
        runnerMenu: runnerMenu,
      };
      var text = JSON.stringify(page);
      if (text === sent) return;
      sent = text;
      invoke("title_bar_page", { page: page }).catch(function () {});
    }, 30);
  };

  document.addEventListener("DOMContentLoaded", function () {
    report();
    if (document.head) new MutationObserver(report).observe(document.head, { subtree: true, childList: true, characterData: true });
    // The site's Light, Dark or Auto (data-theme on <html>), and the system's own.
    new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  });
  window.addEventListener("load", report);
  window.addEventListener("pageshow", report);
  window.addEventListener("popstate", report);
  if (window.matchMedia) {
    var scheme = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof scheme.addEventListener === "function") scheme.addEventListener("change", report);
  }
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("currententrychange", report);
  }

  // The bar's search was clicked: the site's search opens.
  var events = window.__TAURI__ && window.__TAURI__.event;
  if (events && typeof events.listen === "function") {
    events
      .listen("g1t-search", function () {
        if (search) search.open();
      })
      .catch(function () {});
  }
})();
