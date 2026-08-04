/* Accessible client-side validation + Web3Forms submission.
 *
 * Any <form data-validate> gets:
 *  - required/format validation with inline aria-live error messages
 *  - honeypot spam check (input[name="botcheck"] must stay empty)
 *  - submission to Web3Forms when the form (or body) carries a
 *    data-w3f-key; otherwise an honest "temporarily unavailable" failure
 *    state with phone/email fallback. Entered data is never cleared on
 *    failure, never logged, and never placed in the URL.
 */
(function () {
  "use strict";

  var PATTERNS = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    tel: /^[\d\s()+.-]{7,20}$/,
    zip: /^\d{5}(-\d{4})?$/,
    date: /^\d{4}-\d{2}-\d{2}$/,
  };

  function fieldWrap(input) {
    return input.closest(".field") || input.closest("fieldset") || input.parentElement;
  }

  function errorEl(input) {
    var wrap = fieldWrap(input);
    return wrap ? wrap.querySelector(".field__error") : null;
  }

  function labelText(input) {
    var wrap = fieldWrap(input);
    var label = wrap && (wrap.querySelector(".field__label") || wrap.querySelector("legend"));
    if (!label) return "This field";
    return label.textContent.replace(/\*/g, "").trim();
  }

  function setError(input, message) {
    var err = errorEl(input);
    input.setAttribute("aria-invalid", "true");
    if (err) {
      err.textContent = message;
      err.classList.add("is-visible");
    }
  }

  function clearError(input) {
    var err = errorEl(input);
    input.removeAttribute("aria-invalid");
    if (err) {
      err.textContent = "";
      err.classList.remove("is-visible");
    }
  }

  function validateInput(input) {
    var value = input.value.trim();
    var type = input.dataset.type || input.type;
    /* `required` isn't valid on hidden inputs, so those opt in via
       data-required instead (see the signature field). */
    var isRequired = input.required || input.dataset.required === "true";

    if (input.type === "checkbox" && isRequired && !input.checked) {
      setError(input, labelText(input) + " is required.");
      return false;
    }
    if (isRequired && !value && input.type !== "checkbox" && input.type !== "radio") {
      setError(input, labelText(input) + " is required.");
      return false;
    }
    if (value) {
      if (type === "email" && !PATTERNS.email.test(value)) {
        setError(input, "Enter a valid email address, like name@example.com.");
        return false;
      }
      if (type === "tel" && !PATTERNS.tel.test(value)) {
        setError(input, "Enter a valid phone number, like (555) 123-4567.");
        return false;
      }
      if (input.dataset.type === "zip" && !PATTERNS.zip.test(value)) {
        setError(input, "Enter a valid ZIP code, like 12345.");
        return false;
      }
      if (input.type === "date" && !PATTERNS.date.test(value)) {
        setError(input, "Enter a valid date.");
        return false;
      }
      if (input.dataset.match) {
        var other = input.form.querySelector('[name="' + input.dataset.match + '"]');
        if (other && other.value !== input.value) {
          setError(input, "Passwords do not match.");
          return false;
        }
      }
      if (input.dataset.password === "true" && window.MEPassword && !window.MEPassword.isValid(input.value)) {
        setError(input, "Password does not meet all requirements below.");
        return false;
      }
    }
    clearError(input);
    return true;
  }

  function validateRadioGroup(form, name) {
    var group = form.querySelectorAll('input[type="radio"][name="' + name + '"]');
    var required = Array.prototype.some.call(group, function (r) {
      return r.required;
    });
    if (!required) return true;
    var checked = Array.prototype.some.call(group, function (r) {
      return r.checked;
    });
    var first = group[0];
    if (!checked) {
      setError(first, labelText(first) + " — choose an option.");
      return false;
    }
    clearError(first);
    return true;
  }

  function validateForm(form) {
    var valid = true;
    var firstInvalid = null;
    var inputs = form.querySelectorAll("input, select, textarea");
    var radioNames = {};

    inputs.forEach(function (input) {
      if (input.name === "botcheck" || input.disabled) return;
      /* Hidden inputs are skipped unless they back a visible control
         (the signature pad), in which case they still must validate. */
      if (input.type === "hidden" && !input.hasAttribute("data-validate-hidden")) return;
      if (input.type === "radio") {
        radioNames[input.name] = true;
        return;
      }
      if (!validateInput(input) && valid) {
        valid = false;
        firstInvalid = input;
      } else if (input.getAttribute("aria-invalid") === "true" && valid) {
        valid = false;
        firstInvalid = input;
      }
    });

    Object.keys(radioNames).forEach(function (name) {
      if (!validateRadioGroup(form, name)) {
        if (valid) {
          valid = false;
          firstInvalid = form.querySelector('input[name="' + name + '"]');
        }
      }
    });

    if (firstInvalid) {
      if (firstInvalid.type === "hidden" && firstInvalid.dataset.focusTarget) {
        var proxy = document.querySelector(firstInvalid.dataset.focusTarget);
        if (proxy) firstInvalid = proxy;
      }
      firstInvalid.focus();
      firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    return valid;
  }

  function showStatus(form, kind, message) {
    var status = form.querySelector(".form-status");
    if (!status) return;
    status.textContent = message;
    status.classList.remove("form-status--error", "form-status--success");
    status.classList.add("form-status--" + kind, "is-visible");
    status.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function setBusy(form, busy) {
    var button = form.querySelector('[type="submit"]');
    if (!button) return;
    if (busy) {
      button.disabled = true;
      button.dataset.label = button.textContent;
      button.textContent = "Submitting…";
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  function submitWeb3Forms(form, key) {
    var data = new FormData(form);
    data.append("access_key", key);
    data.append("from_name", "missionearned.org website");

    return fetch("https://api.web3forms.com/submit", {
      method: "POST",
      body: data,
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok && json.success };
        });
      })
      .catch(function () {
        return { ok: false };
      });
  }

  /* Append the submission to a Google Sheet via an Apps Script web app.
     Sent as text/plain to avoid a CORS preflight Apps Script won't answer;
     the response is opaque, so a completed request counts as delivered.
     Email remains the primary channel — a sheet failure never blocks it. */
  function submitToSheet(form, url) {
    var payload = {};
    new FormData(form).forEach(function (value, key) {
      if (key === "botcheck" || key === "access_key") return;
      /* File objects don't serialise usefully — record the name instead. */
      if (typeof File !== "undefined" && value instanceof File) {
        if (!value.name) return;
        value = value.name;
      }
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        payload[key] = [].concat(payload[key], value).join(", ");
      } else {
        payload[key] = value;
      }
    });
    payload._form = form.dataset.sheetName || document.title;
    payload._submitted_at = new Date().toISOString();

    return fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    })
      .then(function () {
        return { ok: true };
      })
      .catch(function () {
        return { ok: false };
      });
  }


  /* Keep a copy of each successful submission in this browser so the admin
     portal can show it during a test run. This is local to the device that
     submitted — the Google Sheet is the shared, durable record. */
  function storeLocally(form) {
    try {
      var data = {};
      new FormData(form).forEach(function (value, key) {
        if (key === "botcheck" || key === "access_key") return;
        if (typeof File !== "undefined" && value instanceof File) {
          if (!value.name) return;
          value = value.name;
        }
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          data[key] = [].concat(data[key], value).join(", ");
        } else {
          data[key] = value;
        }
      });

      var entry = {
        id: String(Date.now()) + "-" + Math.floor(Math.random() * 100000),
        form: form.dataset.sheetName || document.title,
        submitted_at: new Date().toISOString(),
        status: "new",
        data: data
      };

      var all = [];
      try {
        all = JSON.parse(localStorage.getItem("me_submissions") || "[]");
      } catch (e) {
        all = [];
      }
      all.unshift(entry);
      /* Signatures are sizeable; keep the most recent 50 so we never blow
         the storage quota. */
      while (all.length > 50) all.pop();
      localStorage.setItem("me_submissions", JSON.stringify(all));
    } catch (e) {
      /* Storage unavailable or full — submission itself is unaffected. */
    }
  }


  /* Shared submissions API provided by the preview server. Lets the review
     portal show the same applications on every device, instead of only the
     browser that submitted. Returns false if no API is present. */
  function postToApi(form) {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      if (key === "botcheck" || key === "access_key") return;
      if (typeof File !== "undefined" && value instanceof File) {
        if (!value.name) return;
        value = value.name;
      }
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        data[key] = [].concat(data[key], value).join(", ");
      } else {
        data[key] = value;
      }
    });
    return fetch("../api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ form: form.dataset.sheetName || document.title, data: data })
    })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  document.querySelectorAll("form[data-validate]").forEach(function (form) {
    form.setAttribute("novalidate", "novalidate");

    form.addEventListener(
      "blur",
      function (e) {
        var t = e.target;
        if (t.matches && t.matches("input, select, textarea") && t.type !== "radio" && t.name !== "botcheck") {
          validateInput(t);
        }
      },
      true
    );

    form.addEventListener("change", function (e) {
      var t = e.target;
      if (t.type === "radio" || t.type === "checkbox") {
        if (t.type === "radio") validateRadioGroup(form, t.name);
        else validateInput(t);
      } else if (t.type === "hidden" && t.hasAttribute("data-validate-hidden")) {
        /* e.g. the signature pad writing its data URL — clear the error as
           soon as something is actually drawn. */
        validateInput(t);
      }
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      /* Honeypot: silently drop bot submissions (pretend success to the bot). */
      var hp = form.querySelector('input[name="botcheck"]');
      if (hp && hp.value) {
        showStatus(form, "success", "Thank you.");
        return;
      }

      if (!validateForm(form)) {
        showStatus(form, "error", "Please fix the highlighted fields and try again. Your entries have been kept.");
        return;
      }

      var mode = form.dataset.mode || "web3forms";

      if (mode === "account") {
        /* Account creation has no backend yet (open decision — see README).
           Never fake success: state the truth. */
        showStatus(
          form,
          "error",
          "Online account creation isn't live quite yet — we're putting the finishing touches on it. " +
            "Everything you entered checks out, and nothing was sent or stored. Please check back soon, " +
            "or call us at " + (form.dataset.phone || "(833) 674‑6387") + " and we'll help you directly."
        );
        return;
      }

      var key = form.dataset.w3fKey || document.body.dataset.w3fKey || "";
      var sheetUrl = form.dataset.sheetUrl || document.body.dataset.sheetUrl || "";

      /* Preview capture: with no email/sheet wired up yet, record the
         submission straight into the review portal on this device. Only
         enabled while the site is in preview mode, and the form says so
         on screen — so this can never masquerade as a live pipeline. */
      var demoCapture = form.hasAttribute("data-demo-capture");
      if (!key && !sheetUrl && demoCapture) {
        setBusy(form, true);
        storeLocally(form);
        postToApi(form).then(function () {
          setBusy(form, false);
          form.reset();
          showStatus(
            form,
            "success",
            form.dataset.demoMessage ||
              "Application received. It's now in the review portal."
          );
        });
        return;
      }

      /* Nowhere to deliver it — say so rather than pretending it sent. */
      if (!key && !sheetUrl) {
        showStatus(
          form,
          "error",
          "Online submission isn't available just yet. Your entries are unchanged — please call " +
            (form.dataset.phone || "(833) 674‑6387") +
            " or email " + (form.dataset.email || "info@missionearned.org") +
            " and we'll take care of you directly."
        );
        return;
      }

      /* Deliver to every configured destination; the submission counts as
         received if any of them accepts it. */
      setBusy(form, true);
      Promise.all([
        key ? submitWeb3Forms(form, key) : Promise.resolve({ ok: false }),
        sheetUrl ? submitToSheet(form, sheetUrl) : Promise.resolve({ ok: false }),
      ]).then(function (results) {
        setBusy(form, false);
        var result = {
          ok: results.some(function (r) {
            return r && r.ok;
          }),
        };
        if (result.ok) {
          storeLocally(form);
          form.reset();
          if (form.dataset.successMessage) {
            showStatus(form, "success", form.dataset.successMessage);
          } else {
            showStatus(
              form,
              "success",
              "Thank you — your submission was received. Our team will follow up with you soon."
            );
          }
        } else {
          showStatus(
            form,
            "error",
            "Something went wrong sending your submission. Your entries are unchanged — please try again, " +
              "or call " + (form.dataset.phone || "(833) 674‑6387") + "."
          );
        }
      });
    });
  });
})();
