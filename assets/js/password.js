/* Password show/hide toggles + live requirements checklist. */
(function () {
  "use strict";

  var RULES = [
    { key: "length", test: function (v) { return v.length >= 8; } },
    { key: "upper", test: function (v) { return /[A-Z]/.test(v); } },
    { key: "lower", test: function (v) { return /[a-z]/.test(v); } },
    { key: "number", test: function (v) { return /\d/.test(v); } },
    { key: "special", test: function (v) { return /[^A-Za-z0-9]/.test(v); } },
  ];

  window.MEPassword = {
    isValid: function (value) {
      return RULES.every(function (r) {
        return r.test(value);
      });
    },
  };

  /* Show/hide toggles */
  document.querySelectorAll("[data-password-toggle]").forEach(function (btn) {
    var input = document.getElementById(btn.getAttribute("data-password-toggle"));
    if (!input) return;
    btn.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", String(show));
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      btn.querySelector(".pw-eye").hidden = show;
      btn.querySelector(".pw-eye-off").hidden = !show;
    });
  });

  /* Live checklist */
  var pw = document.querySelector('[data-password="true"]');
  var checklist = document.querySelector("[data-pw-checklist]");
  if (pw && checklist) {
    pw.addEventListener("input", function () {
      RULES.forEach(function (rule) {
        var item = checklist.querySelector('[data-rule="' + rule.key + '"]');
        if (item) item.classList.toggle("is-met", rule.test(pw.value));
      });
    });
  }
})();
