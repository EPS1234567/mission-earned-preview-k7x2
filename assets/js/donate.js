/* Donation amount picker.
 *
 * Drives the preset/custom amount tiles, the one-time vs monthly toggle, and
 * the live impact line, keeping hidden `amount` / `frequency` fields in sync.
 *
 * When a processor URL is configured (site.donateUrl), the give button becomes
 * a link carrying the chosen amount and frequency as query params — the shape
 * Zeffy, Donorbox, and Stripe payment links all accept. Until then the button
 * says plainly that online giving isn't live and points at the phone/email.
 * No payment is processed here and none is simulated.
 */
(function () {
  "use strict";

  var form = document.querySelector("[data-give]");
  if (!form) return;

  var presets = form.querySelectorAll("[data-amount]");
  var custom = form.querySelector("[data-amount-custom]");
  var freqInputs = form.querySelectorAll("[data-frequency]");
  var noteEl = form.querySelector("[data-impact] span");
  var amountField = form.querySelector("[data-amount-value]");
  var freqField = form.querySelector("[data-frequency-value]");
  var cta = form.querySelector("[data-give-cta]");
  var pending = form.querySelector("#give-pending");
  var giveUrl = cta && cta.getAttribute("data-give-url");

  /* Impact copy per giving level. Draft language — swap for the organization's
     real program costs once they're confirmed. */
  var IMPACT = [
    { min: 500, text: "Underwrites outreach to an entire community of veterans who don't yet know what they've earned." },
    { min: 250, text: "Supports a veteran through a full benefits claim, start to finish." },
    { min: 100, text: "Funds two one-on-one benefits navigation sessions for veterans and their families." },
    { min: 50, text: "Covers a one-on-one benefits navigation session with a trained navigator." },
    { min: 25, text: "Helps a veteran gather and file the records needed to start a claim." },
    { min: 1, text: "Every dollar goes toward connecting veterans with the benefits they've earned." }
  ];

  function money(n) {
    return "$" + Number(n).toLocaleString("en-US");
  }

  function impactFor(amount) {
    if (!amount || amount <= 0) {
      return "Choose an amount to see what your gift makes possible.";
    }
    for (var i = 0; i < IMPACT.length; i++) {
      if (amount >= IMPACT[i].min) return IMPACT[i].text;
    }
    return IMPACT[IMPACT.length - 1].text;
  }

  function currentAmount() {
    var checked = form.querySelector("[data-amount]:checked");
    if (checked) return parseFloat(checked.value) || 0;
    return parseFloat(custom && custom.value) || 0;
  }

  function currentFrequency() {
    var f = form.querySelector("[data-frequency]:checked");
    return f ? f.value : "once";
  }

  function sync() {
    var amount = currentAmount();
    var freq = currentFrequency();

    if (amountField) amountField.value = amount > 0 ? amount.toFixed(2) : "";
    if (freqField) freqField.value = freq;
    if (noteEl) noteEl.textContent = impactFor(amount);

    if (!cta) return;

    if (amount > 0) {
      cta.textContent =
        freq === "monthly" ? "Give " + money(amount) + " Monthly" : "Give " + money(amount);
    } else {
      cta.textContent = "Choose an Amount";
    }

    /* Carry the selection through to the processor when one is configured. */
    if (giveUrl) {
      var sep = giveUrl.indexOf("?") === -1 ? "?" : "&";
      cta.href =
        amount > 0
          ? giveUrl + sep + "amount=" + encodeURIComponent(amount) + "&frequency=" + encodeURIComponent(freq)
          : giveUrl;
    }
  }

  /* Presets and the custom box are mutually exclusive. */
  Array.prototype.forEach.call(presets, function (input) {
    input.addEventListener("change", function () {
      if (custom) custom.value = "";
      sync();
    });
  });

  if (custom) {
    custom.addEventListener("input", function () {
      var checked = form.querySelector("[data-amount]:checked");
      if (checked) checked.checked = false;
      sync();
    });
  }

  Array.prototype.forEach.call(freqInputs, function (input) {
    input.addEventListener("change", sync);
  });

  /* With no processor connected, send focus to the honest notice rather than
     pretending a checkout exists. */
  if (cta && !giveUrl && pending) {
    cta.addEventListener("click", function () {
      pending.focus();
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
  });

  sync();
})();
