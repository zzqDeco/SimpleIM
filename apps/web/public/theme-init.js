(function () {
  var root = document.documentElement;
  try {
    var mode = localStorage.getItem("simpleim.theme");
    var dark =
      mode === "dark" ||
      (mode !== "light" &&
        (typeof matchMedia !== "function" ||
          matchMedia("(prefers-color-scheme: dark)").matches));
    var resolved = dark ? "dark" : "light";
    root.dataset.theme = resolved;
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      meta.setAttribute("content", resolved);
    }
  } catch (e) {
    root.dataset.theme = "dark";
  }
})();
