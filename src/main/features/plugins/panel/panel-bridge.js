/** Isolated panel RPC, theme updates, and intrinsic-height reporting. */
(function () {
  "use strict";
  var PROTOCOL = "firefly-panel/1";
  var nextSequence = 0;
  var pendingReplies = new Map();
  var themeCallbacks = [];

  function post(message) {
    message.protocol = PROTOCOL;
    window.parent.postMessage(message, "*");
  }
  function notifyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    var values = theme.tokens;
    if (values && typeof values === "object") {
      var rootStyle = document.documentElement.style;
      Object.keys(values).forEach(function (token) { rootStyle.setProperty(token, values[token]); });
    }
    var callbacks = themeCallbacks.slice();
    for (var cursor = 0; cursor < callbacks.length; cursor++) {
      try { callbacks[cursor](theme); }
      catch (failure) { /* One subscriber cannot stop the remaining notifications. */ }
    }
  }
  function receiveReply(reply) {
    var pending = pendingReplies.get(reply.seq);
    if (!pending) return;
    pendingReplies.delete(reply.seq);
    if (reply.ok) pending.resolve(reply.data);
    else {
      var description = typeof reply.error === "string" ? reply.error : "插件调用失败";
      pending.reject(new Error(description));
    }
  }
  function receiveParentMessage(event) {
    if (event.source !== window.parent) return;
    var payload = event.data;
    if (!payload || payload.protocol !== PROTOCOL) return;
    if (payload.kind === "invoke-result") receiveReply(payload);
    else if (payload.kind === "init" || payload.kind === "theme-changed") notifyTheme(payload.theme);
  }
  function reportHeight() {
    post({ kind: "height", height: document.documentElement.scrollHeight });
  }
  function watchSize() {
    reportHeight();
    if (typeof ResizeObserver !== "undefined") {
      var sizeWatcher = new ResizeObserver(reportHeight);
      sizeWatcher.observe(document.documentElement);
    }
  }
  function invoke(channel) {
    var argumentsList = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var sequence = ++nextSequence;
      pendingReplies.set(sequence, { resolve: resolve, reject: reject });
      post({ kind: "invoke", seq: sequence, channel: channel, args: argumentsList });
    });
  }
  function subscribeTheme(callback) {
    if (typeof callback !== "function") return function () {};
    themeCallbacks.push(callback);
    return function () {
      var index = themeCallbacks.indexOf(callback);
      if (index >= 0) themeCallbacks.splice(index, 1);
    };
  }
  window.addEventListener("message", receiveParentMessage);
  window.addEventListener("load", watchSize);
  window.FireflyPanel = { invoke: invoke, onTheme: subscribeTheme, ready: function () { reportHeight(); } };
})();