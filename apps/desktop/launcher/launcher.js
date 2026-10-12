// The launcher's work: ask the app for its server, check that it answers,
// go there, as the desktop app (`?app=desktop`, which takes someone signed
// out to the sign-in page rather than the site's landing page). `?change` opens the choice of server instead. Everything it
// asks is a command in src/bridge.rs, answered only to this page.
(function () {
  var sections = { connecting: byId("connecting"), offline: byId("offline"), choose: byId("choose") };
  var info = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function invoke(command, args) {
    var core = window.__TAURI__ && window.__TAURI__.core;
    if (core && typeof core.invoke === "function") return core.invoke(command, args || {});
    return Promise.reject(new Error("the launcher cannot reach the app"));
  }

  function show(name) {
    Object.keys(sections).forEach(function (key) {
      sections[key].hidden = key !== name;
    });
  }

  function hostOf(server) {
    try {
      return new URL(server).host;
    } catch (error) {
      return server;
    }
  }

  function appUrl(server) {
    try {
      var url = new URL(server);
      url.searchParams.set("app", "desktop");
      return url.href;
    } catch (error) {
      return server;
    }
  }

  function connect(server) {
    show("connecting");
    byId("connecting-text").textContent = "Connecting to " + hostOf(server) + "…";
    invoke("reachable", { url: server })
      .then(function (ok) {
        if (ok) location.replace(appUrl(server));
        else offline(server);
      })
      .catch(function () {
        offline(server);
      });
  }

  function offline(server) {
    byId("offline-title").textContent = "Can't reach " + hostOf(server);
    var status = byId("status-link");
    var isDefault = hostOf(server) === "g1t.sh";
    status.parentElement.hidden = !isDefault;
    show("offline");
    byId("retry").onclick = function () {
      connect(server);
    };
  }

  function choose(server) {
    show("choose");
    var input = byId("server");
    input.value = hostOf(server) === "g1t.sh" ? "" : server;
    byId("server-error").hidden = true;
    input.focus();
  }

  function fail(message) {
    var error = byId("server-error");
    error.textContent = message;
    error.hidden = false;
  }

  byId("change").onclick = function () {
    choose(info ? info.server : "https://g1t.sh/");
  };
  byId("use-default").onclick = function () {
    invoke("set_server", { url: "https://g1t.sh" }).then(connect, fail);
  };
  byId("server-form").onsubmit = function (event) {
    event.preventDefault();
    var typed = byId("server").value.trim();
    if (!typed) return fail("Enter your g1t's address, or use g1t.sh.");
    invoke("set_server", { url: typed }).then(connect, function (error) {
      fail(typeof error === "string" ? error : "That address could not be kept.");
    });
  };
  // Links out, in the system's browser (src/bridge.js handles the rest).
  document.addEventListener("click", function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    event.preventDefault();
    invoke("open_url", { url: anchor.href }).catch(function () {});
  });

  invoke("desktop_info")
    .then(function (found) {
      info = found;
      byId("version").textContent = "g1t " + found.version;
      if (new URLSearchParams(location.search).has("change")) choose(found.server);
      else connect(found.server);
    })
    .catch(function () {
      // No app behind the page: a browser opened the file. Nothing to do.
      show("offline");
      byId("offline-title").textContent = "This page belongs inside the g1t desktop app";
      byId("retry").hidden = true;
      byId("change").hidden = true;
    });
})();
