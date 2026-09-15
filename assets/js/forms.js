/* Accessible client-side validation + Web3Forms submission.
 *
 * Any <form data-validate> gets:
 *  - required/format validation with inline aria-live error messages
 *  - honeypot spam check (input[name="botcheck"] must stay empty)
 *  - submission to Web3Forms when the form (or body) carries a
 *    data-w3f-key; otherwise an honest "temporarily unavailable" failure
 *    state with phone/email fallback. Entered data is never cleared on
 *    failure, never logged, and never placed in the URL.
 *
 * Validation only speaks up once a field has actually been used, or once the
 * applicant has pressed Submit. Tabbing through the form to read it never
 * paints an error, and fixing a field clears its error immediately.
 */
(function () {
  "use strict";

  var PATTERNS = {
    email: /^[^\s@]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/,
    zip: /^\d{5}([\s-]?\d{4})?$/,
    date: /^\d{4}-\d{2}-\d{2}$/,
  };

  /* Built from escapes so the source file stays plain ASCII. */
  var DASHES = new RegExp("[\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]", "g");
  var SPACES = new RegExp("[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]", "g");
  var INVISIBLE = new RegExp("[\\u200B-\\u200F\\u2028\\u2029\\u2060\\uFEFF]", "g");

  /* Dashes, spaces and invisible marks that ride along when a number or
     address is pasted out of a document. Normalised away before validating so
     nobody is rejected over a character they cannot see. */
  function normalise(value) {
    return value
      .replace(DASHES, "-")
      .replace(SPACES, " ")
      .replace(INVISIBLE, "")
      .trim();
  }

  /* A phone number is valid if it carries a plausible count of digits — not
     if it happens to match a punctuation pattern. "(555) 123-4567", "+1 555
     123 4567", "5551234567" and "555-123-4567 ext 22" all pass; "((((-))))"
     does not. */
  function validPhone(value) {
    var cleaned = normalise(value);
    var ext = cleaned.match(/(?:ext|x|ext\.|extension)\s*\.?\s*(\d{1,6})\s*$/i);
    if (ext) cleaned = cleaned.slice(0, ext.index);
    if (/[^\d\s()+.\-]/.test(cleaned)) return false;
    var digits = cleaned.replace(/\D/g, "");
    if (/^1\d{10}$/.test(digits)) return true;
    if (/^\d{10}$/.test(digits)) return true;
    /* Allow international numbers entered with a leading +. */
    return /^\+/.test(cleaned) && digits.length >= 8 && digits.length <= 15;
  }

  var REDUCED_MOTION =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function scrollTo(el) {
    if (!el || !el.scrollIntoView) return;
    el.scrollIntoView({ block: "center", behavior: REDUCED_MOTION ? "auto" : "smooth" });
  }

  function fieldWrap(input) {
    return (
      input.closest(".field") ||
      input.closest("fieldset") ||
      input.closest(".agreements") ||
      input.parentElement
    );
  }

  /* Every control must be able to show an error. If the markup forgot the
     error paragraph, create one rather than swallowing the message — a
     required field with nowhere to complain is an applicant who cannot
     submit and is never told why. */
  var autoId = 0;
  function errorEl(input) {
    var wrap = fieldWrap(input);
    if (!wrap) return null;
    var err = wrap.querySelector(".field__error");
    if (!err) {
      err = document.createElement("p");
      err.className = "field__error";
      err.setAttribute("aria-live", "polite");
      wrap.appendChild(err);
    }
    if (!err.id) err.id = "field-error-" + ++autoId;
    return err;
  }

  function describedBy(input, errId, add) {
    var current = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    var at = current.indexOf(errId);
    if (add && at === -1) current.push(errId);
    if (!add && at !== -1) current.splice(at, 1);
    if (current.length) input.setAttribute("aria-describedby", current.join(" "));
    else input.removeAttribute("aria-describedby");
  }

  function labelText(input) {
    var wrap = fieldWrap(input);
    var label = wrap && (wrap.querySelector(".field__label") || wrap.querySelector("legend"));
    if (!label) return "This field";
    return label.textContent.replace(/\*/g, "").trim();
  }

  /* "Which best describes you? is required." is not a sentence. Fields whose
     label is a question get a sentence that reads properly, and any field can
     override the wording with data-required-message. */
  function requiredMessage(input) {
    if (input.dataset.requiredMessage) return input.dataset.requiredMessage;
    var label = labelText(input);
    if (/\?$/.test(label)) return "Please answer this question.";
    return label + " is required.";
  }

  function setError(input, message) {
    var err = errorEl(input);
    input.setAttribute("aria-invalid", "true");
    if (err) {
      err.textContent = message;
      err.classList.add("is-visible");
      describedBy(input, err.id, true);
    }
  }

  function clearError(input) {
    var err = errorEl(input);
    input.removeAttribute("aria-invalid");
    if (err) {
      err.textContent = "";
      err.classList.remove("is-visible");
      describedBy(input, err.id, false);
    }
  }

  function validateInput(input) {
    var value = input.value.trim();
    var type = input.dataset.type || input.type;
    /* `required` isn't valid on hidden inputs, so those opt in via
       data-required instead (see the signature field). */
    var isRequired = input.required || input.dataset.required === "true";

    if (input.type === "checkbox" && isRequired && !input.checked) {
      setError(input, requiredMessage(input));
      return false;
    }
    if (isRequired && !value && input.type !== "checkbox" && input.type !== "radio") {
      setError(input, requiredMessage(input));
      return false;
    }
    if (value) {
      if (type === "email" && !PATTERNS.email.test(normalise(value))) {
        setError(input, "Enter a valid email address, like name@example.com.");
        return false;
      }
      if (type === "tel" && !validPhone(value)) {
        setError(input, "Enter a phone number with area code, like (555) 123-4567.");
        return false;
      }
      if (input.dataset.type === "zip" && !PATTERNS.zip.test(normalise(value))) {
        setError(input, "Enter a valid ZIP code, like 12345 or 12345-6789.");
        return false;
      }
      if (type === "date") {
        if (!PATTERNS.date.test(value)) {
          setError(input, "Enter a valid date.");
          return false;
        }
        var year = Number(value.slice(0, 4));
        if (year < 1900 || year > 2200) {
          setError(input, "Enter a valid date — that year doesn't look right.");
          return false;
        }
        if (input.min && value < input.min) {
          setError(input, "That date is too far in the past.");
          return false;
        }
        if (input.max && value > input.max) {
          setError(input, "That date can't be in the future.");
          return false;
        }
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

  function radioGroup(form, name) {
    return form.querySelectorAll('input[type="radio"][name="' + name + '"]');
  }

  function validateRadioGroup(form, name) {
    var group = radioGroup(form, name);
    if (!group.length) return true;
    var required = Array.prototype.some.call(group, function (r) {
      return r.required;
    });
    if (!required) return true;
    var checked = Array.prototype.some.call(group, function (r) {
      return r.checked;
    });
    var first = group[0];
    if (!checked) {
      setError(first, labelText(first).replace(/\?$/, "") + " — choose an option.");
      return false;
    }
    clearError(first);
    return true;
  }

  /* One pass in document order, so the control we focus really is the first
     broken one on the page — radio groups included. */
  function validateForm(form) {
    var firstInvalid = null;
    var seenRadio = {};

    form.querySelectorAll("input, select, textarea").forEach(function (input) {
      if (input.name === "botcheck" || input.disabled) return;
      /* Hidden inputs are skipped unless they back a visible control
         (the signature pad), in which case they still must validate. */
      if (input.type === "hidden" && !input.hasAttribute("data-validate-hidden")) return;

      var ok;
      if (input.type === "radio") {
        if (seenRadio[input.name]) return;
        seenRadio[input.name] = true;
        ok = validateRadioGroup(form, input.name);
      } else {
        ok = validateInput(input);
      }
      if (!ok && !firstInvalid) firstInvalid = input;
    });

    if (firstInvalid) {
      if (firstInvalid.type === "hidden" && firstInvalid.dataset.focusTarget) {
        var proxy = document.querySelector(firstInvalid.dataset.focusTarget);
        if (proxy) firstInvalid = proxy;
      }
      firstInvalid.focus({ preventScroll: true });
      scrollTo(firstInvalid);
      return false;
    }

    /* Everything was checked trimmed, so store it trimmed too rather than
       filing a name or address padded with stray spaces. Done here, at
       submit, and never while typing — mid-word spaces must survive. */
    form.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea').forEach(
      function (input) {
        var trimmed = input.value.trim();
        if (input.value !== trimmed) input.value = trimmed;
      }
    );
    return true;
  }

  /* `scroll` is opt-in: when a field-level error already owns the scroll,
     a second scroll to the banner would drag the applicant away from the
     very field they need to fix. */
  function showStatus(form, kind, message, scroll) {
    var status = form.querySelector(".form-status");
    if (!status) return;
    status.textContent = message;
    status.classList.remove("form-status--error", "form-status--success");
    status.classList.add("form-status--" + kind, "is-visible");
    if (scroll) scrollTo(status);
  }

  function setBusy(form, busy) {
    var button = form.querySelector('[type="submit"]');
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = "Submitting…";
      button.setAttribute("aria-disabled", "true");
      button.classList.add("is-busy");
    } else {
      button.removeAttribute("aria-disabled");
      button.classList.remove("is-busy");
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
      signal: timeoutSignal(20000),
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

  /* Never let a stalled network strand the applicant on a dead
     "Submitting…" button. */
  function timeoutSignal(ms) {
    try {
      if (AbortSignal && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(ms);
      }
      var c = new AbortController();
      setTimeout(function () {
        c.abort();
      }, ms);
      return c.signal;
    } catch (e) {
      return undefined;
    }
  }

  /* Append the submission to a Google Sheet via an Apps Script web app.
     Sent as text/plain to avoid a CORS preflight Apps Script won't answer;
     the response is opaque, so a completed request counts as delivered.
     Email remains the primary channel — a sheet failure never blocks it. */
  function submitToSheet(form, url) {
    var payload = collect(form);
    payload._form = form.dataset.sheetName || document.title;
    payload._submitted_at = new Date().toISOString();

    return fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: timeoutSignal(20000),
    })
      .then(function () {
        return { ok: true };
      })
      .catch(function () {
        return { ok: false };
      });
  }

  function collect(form) {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      if (key === "botcheck" || key === "access_key") return;
      /* File objects don't serialise usefully — record the name instead. */
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
    return data;
  }

  /* Keep a copy of each successful submission in this browser so the admin
     portal can show it during a test run. This is local to the device that
     submitted — the Google Sheet is the shared, durable record.
     Returns whether the copy was actually written. */
  function storeLocally(form) {
    try {
      var entry = {
        id: String(Date.now()) + "-" + Math.floor(Math.random() * 100000),
        form: form.dataset.sheetName || document.title,
        submitted_at: new Date().toISOString(),
        status: "new",
        data: collect(form),
      };

      var all = [];
      try {
        all = JSON.parse(localStorage.getItem("me_submissions") || "[]");
      } catch (e) {
        all = [];
      }
      if (!Array.isArray(all)) all = [];
      all.unshift(entry);
      /* Signatures are sizeable; keep the 50 most recent. unshift() puts the
         newest first, so the oldest are the ones at the end. */
      while (all.length > 50) all.pop();
      localStorage.setItem("me_submissions", JSON.stringify(all));
      return true;
    } catch (e) {
      /* Storage unavailable or full. The caller decides what to tell the
         applicant — it must never be reported as a successful filing. */
      return false;
    }
  }

  /* Shared submissions API provided by the preview server. Lets the review
     portal show the same applications on every device, instead of only the
     browser that submitted. Resolves false if no API is present. */
  function postToApi(form) {
    return fetch("../api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        form: form.dataset.sheetName || document.title,
        data: collect(form),
      }),
      signal: timeoutSignal(15000),
    })
      .then(function (r) {
        return r.ok;
      })
      .catch(function () {
        return false;
      });
  }

  /* A signature can't be dated in the future, and a start date can't be in
     the past. Bounds are stamped at load so the native picker enforces them
     too, not just our check. */
  (function () {
    var now = new Date();
    var today =
      now.getFullYear() + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0");
    document.querySelectorAll("[data-max-today]").forEach(function (el) {
      el.max = today;
      if (!el.value) el.value = today;
    });
    document.querySelectorAll("[data-min-today]").forEach(function (el) {
      el.min = today;
    });
  })();

  /* Send the application to the Mission Earned service, when one is named in
   * assets/js/config.js. multipart/form-data so an attached resume travels
   * with the answers instead of only its name; no cookies, because this is a
   * public, unauthenticated create. With no service named, the preview paths
   * further down handle the form instead. */
  function submitToApi(form, base) {
    return fetch(base.replace(/\/$/, "") + "/api/v1/applications", {
      method: "POST",
      body: new FormData(form),
      credentials: "omit",
      headers: { "Idempotency-Key": form.dataset.idempotencyKey },
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (res.ok) return { ok: true, reference: body.reference };
          if (res.status === 422) return { ok: false, reason: "validation", errors: body.errors || [] };
          if (res.status === 429) return { ok: false, reason: "rate_limited", message: body.message };
          return { ok: false, reason: "server" };
        });
      })
      .catch(function () {
        return { ok: false, reason: "network" };
      });
  }

  /* Generated once per page load and reused across retries, so pressing the
     button twice or retrying after a timeout files one application. */
  function idempotencyKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  }

  /* Errors the service found that the browser did not: show them on the field
     they belong to, the same way local validation does. */
  function applyServerErrors(form, errors) {
    var first = null;
    errors.forEach(function (e) {
      var input = form.querySelector('[name="' + e.field + '"]');
      if (!input) return;
      setError(input, e.message);
      if (!first) first = input;
    });
    if (first) {
      if (first.type === "hidden" && first.dataset.focusTarget) {
        var proxy = document.querySelector(first.dataset.focusTarget);
        if (proxy) first = proxy;
      }
      first.focus({ preventScroll: true });
      scrollTo(first);
    }
    return Boolean(first);
  }

  document.querySelectorAll("form[data-validate]").forEach(function (form) {
    form.setAttribute("novalidate", "novalidate");
    form.dataset.idempotencyKey = idempotencyKey();

    function live() {
      return form.dataset.submitted === "true";
    }

    /* A control speaks up only once the applicant has used it, or once they
       have pressed Submit. */
    form.addEventListener(
      "blur",
      function (e) {
        var t = e.target;
        if (!t.matches || !t.matches("input, select, textarea")) return;
        if (t.type === "radio" || t.name === "botcheck") return;
        if (!live() && t.dataset.touched !== "true") return;
        validateInput(t);
      },
      true
    );

    function touch(e) {
      var t = e.target;
      if (!t.matches || !t.matches("input, select, textarea") || t.name === "botcheck") return;
      t.dataset.touched = "true";

      /* Clear a standing error the moment it is fixed. Before the first
         submit we only ever clear, never newly accuse. */
      if (t.type === "radio") {
        if (live() || t.checked) validateRadioGroup(form, t.name);
        return;
      }
      if (live() || t.getAttribute("aria-invalid") === "true") validateInput(t);
    }

    form.addEventListener("input", touch);
    form.addEventListener("change", touch);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (form.dataset.busy === "true") return;

      /* Honeypot: silently drop bot submissions (pretend success to the bot). */
      var hp = form.querySelector('input[name="botcheck"]');
      if (hp && hp.value) {
        showStatus(form, "success", "Thank you.", true);
        return;
      }

      form.dataset.submitted = "true";

      if (!validateForm(form)) {
        showStatus(
          form,
          "error",
          "Please fix the highlighted fields and try again. Your entries have been kept.",
          false
        );
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
            "or call us at " + (form.dataset.phone || "(833) 674‑6387") + " and we'll help you directly.",
          true
        );
        return;
      }

      var key = form.dataset.w3fKey || document.body.dataset.w3fKey || "";
      var sheetUrl = form.dataset.sheetUrl || document.body.dataset.sheetUrl || "";

      function contactFallback() {
        return (
          "please call " + (form.dataset.phone || "(833) 674‑6387") +
          " or email " + (form.dataset.email || "info@missionearned.org") +
          " and we'll take care of you directly."
        );
      }

      function finish(delivered, successMessage) {
        form.dataset.busy = "false";
        setBusy(form, false);
        if (delivered) {
          resetForm(form);
          showStatus(form, "success", successMessage, true);
        } else {
          showStatus(
            form,
            "error",
            "We couldn't record your application just now. Your entries are unchanged — " +
              "please try again, or " + contactFallback(),
            true
          );
        }
      }

      /* A real service is configured: deliver there and nowhere else. */
      var apiBase = (window.ME && window.ME.apiBase) || "";
      if (apiBase) {
        form.dataset.busy = "true";
        setBusy(form, true);
        submitToApi(form, apiBase).then(function (result) {
          form.dataset.busy = "false";
          setBusy(form, false);
          if (result.ok) {
            resetForm(form);
            showStatus(
              form,
              "success",
              (form.dataset.successMessage || "Thank you \u2014 your application was received.") +
                (result.reference ? " Your reference is " + result.reference + "." : ""),
              true
            );
            return;
          }
          /* Every failure keeps every answer on the page. */
          if (result.reason === "validation" && result.errors.length && applyServerErrors(form, result.errors)) {
            showStatus(form, "error", "Please fix the highlighted fields and try again. Your entries have been kept.", false);
            return;
          }
          if (result.reason === "rate_limited") {
            showStatus(form, "error", result.message || ("We've already had a submission for that email today \u2014 " + contactFallback()), true);
            return;
          }
          showStatus(
            form,
            "error",
            "We couldn't send your application just now \u2014 this is our problem, not yours. " +
              "Your answers are all still here, so please press Submit again in a moment, or " + contactFallback(),
            true
          );
        });
        return;
      }

      /* Preview capture: with no email/sheet wired up yet, record the
         submission straight into the review portal on this device. Only
         enabled while the site is in preview mode, and the form says so
         on screen — so this can never masquerade as a live pipeline. */
      var demoCapture = form.hasAttribute("data-demo-capture");
      if (!key && !sheetUrl && demoCapture) {
        form.dataset.busy = "true";
        setBusy(form, true);
        var storedLocally = storeLocally(form);
        postToApi(form).then(function (sentToApi) {
          /* Only claim it was filed if it actually landed somewhere. */
          finish(
            storedLocally || sentToApi,
            form.dataset.demoMessage || "Application received. It's now in the review portal."
          );
        });
        return;
      }

      /* Nowhere to deliver it — say so rather than pretending it sent. */
      if (!key && !sheetUrl) {
        showStatus(
          form,
          "error",
          "Online submission isn't available just yet. Your entries are unchanged — " + contactFallback(),
          true
        );
        return;
      }

      /* Deliver to every configured destination; the submission counts as
         received if any of them accepts it. */
      form.dataset.busy = "true";
      setBusy(form, true);
      Promise.all([
        key ? submitWeb3Forms(form, key) : Promise.resolve({ ok: false }),
        sheetUrl ? submitToSheet(form, sheetUrl) : Promise.resolve({ ok: false }),
      ]).then(function (results) {
        var ok = results.some(function (r) {
          return r && r.ok;
        });
        if (ok) storeLocally(form);
        finish(
          ok,
          form.dataset.successMessage ||
            "Thank you — your submission was received. Our team will follow up with you soon."
        );
      });
    });

    /* A reset after a successful filing puts the form back to genuinely
       untouched, so the empty fields don't immediately turn red. */
    function resetForm(f) {
      f.reset();
      f.dataset.submitted = "false";
      f.querySelectorAll("input, select, textarea").forEach(function (el) {
        delete el.dataset.touched;
        clearError(el);
      });
    }
  });
})();
