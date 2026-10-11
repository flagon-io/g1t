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
  };
  Object.defineProperty(window, "g1tDesktop", { value: Object.freeze(bridge), writable: false, configurable: false });

  // Links out. A link to another site opens in the system's browser, and
  // the window stays on g1t; a link that asks for a new tab, or a click
  // with Ctrl or Cmd held, goes on in this window, which has no tabs.
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
      if (url.origin !== location.origin) {
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
      if (url.origin === location.origin) location.assign(url.href);
      else bridge.openUrl(url.href);
      return null;
    }
    return typeof open === "function" ? open.call(window, href, target, features) : null;
  };
})();
