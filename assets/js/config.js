/* The one place the API location is named.
 *
 * A <meta name="me-api-base" content="..."> in the page wins, which is how the
 * preview deployment points at a staging service without a rebuild. */
(function () {
  var meta = document.querySelector('meta[name="me-api-base"]');
  window.ME = {
    apiBase: (meta && meta.content) || "https://app.missionearned.org",
    phone: "(833) 674‑6387",
    email: "info@missionearned.org",
  };
})();
