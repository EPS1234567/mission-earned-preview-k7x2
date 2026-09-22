/* The one place the application service is named.
 *
 * Left empty, the form runs in preview mode: submissions are recorded in this
 * browser and shown in the preview review portal, and the page says so.
 * Name the service here (or with <meta name="me-api-base" content="...">) and
 * the form delivers there instead. */
(function () {
  var meta = document.querySelector('meta[name="me-api-base"]');
  window.ME = {
    apiBase: (meta && meta.content) || "",
    phone: "(833) 674‑6387",
    email: "info@missionearned.org",
  };
})();
