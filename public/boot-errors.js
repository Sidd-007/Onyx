// Loaded as a classic script before the app's modules, so it also catches errors
// thrown while modules load. Prints them in the terminal running `tauri dev`, and
// shows them in the window if the app never rendered, instead of a blank screen.
(function () {
  function report(message) {
    var internals = window.__TAURI_INTERNALS__;
    if (internals) internals.invoke("log_frontend_error", { message: message }).catch(function () {});
    // Cover the window only when the app never rendered; later errors are just logged.
    var root = document.getElementById("root");
    if (root && root.hasChildNodes()) return;
    var el = document.getElementById("boot-error");
    if (!el) {
      el = document.createElement("pre");
      el.id = "boot-error";
      el.style.cssText =
        "position:fixed;inset:0;z-index:99999;margin:0;padding:24px;overflow:auto;white-space:pre-wrap;" +
        "font:12px ui-monospace,monospace;color:#f87171;background:#0f0f11";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent += message + "\n\n";
  }
  window.addEventListener("error", function (e) {
    var where = e.filename ? " (" + e.filename + ":" + e.lineno + ":" + e.colno + ")" : "";
    report((e.error && e.error.stack) || e.message + where);
  });
  // Dev server only: ⌘R reloads, even when the app itself failed to load.
  if (location.origin === "http://localhost:1420") {
    window.addEventListener("keydown", function (e) {
      if (e.metaKey && e.key === "r") {
        e.preventDefault();
        location.reload();
      }
    });
  }
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    report("Unhandled rejection: " + ((r && (r.stack || r.message)) || JSON.stringify(r)));
  });
})();
