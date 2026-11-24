// Runs before first paint (classic script, not a module) to avoid a theme flash.
// ?theme=light | ?theme=dark overrides prefers-color-scheme.
(function () {
  var t = new URLSearchParams(location.search).get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
})();
