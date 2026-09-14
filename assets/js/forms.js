/* Accessible client-side validation + Web3Forms submission.
 *
 * Any <form data-validate> gets:
 *  - required/format validation with inline aria-live error messages
 *  - honeypot spam check (input[name="botcheck"] must stay empty)
 *  - submission to the Mission Earned service as multipart/form-data, so an
 *    attached resume travels with the answers rather than only its name.
 *    Entered data is never cleared on failure, never logged, never placed in
 *    the URL, and never kept in this browser.
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

  /* Send the application to the Mission Earned service.
   *
   * multipart/form-data rather than JSON, so the resume file itself travels
   * with the answers instead of only its name. No cookies are sent: this is a
   * public, unauthenticated create, and the endpoint must never see one. */
  function submitToApi(form) {
    var base = (window.ME && window.ME.apiBase) || "";
    if (!base) return Promise.resolve({ ok: false, reason: "not_configured" });

    return fetch(base.replace(/\/$/, "") + "/api/v1/applications", {
      method: "POST",
      body: new FormData(form),
      credentials: "omit",
      headers: { "Idempotency-Key": form.dataset.idempotencyKey },
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (res.ok) return { ok: true, reference: body.reference, duplicate: body.duplicate };
          if (res.status === 422) return { ok: false, reason: "validation", errors: body.errors || [] };
          if (res.status === 429) return { ok: false, reason: "rate_limited", message: body.message };
          return { ok: false, reason: "server", message: body.message };
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

  /* Errors the server found that the browser did not: show them on the field
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

      var mode = form.dataset.mode || "api";

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

      function contactFallback() {
        return (
          "please call " + (form.dataset.phone || "(833) 674\u20116387") +
          " or email " + (form.dataset.email || "info@missionearned.org") +
          " and we'll take care of you directly."
        );
      }

      form.dataset.busy = "true";
      setBusy(form, true);

      submitToApi(form).then(function (result) {
        form.dataset.busy = "false";
        setBusy(form, false);

        if (result.ok) {
          resetForm(form);
          showStatus(
            form,
            "success",
            (form.dataset.successMessage ||
              "Thank you for your interest in volunteering with Mission Earned! Your application was received and we'll be in touch soon.") +
              (result.reference ? " Your reference is " + result.reference + "." : ""),
            true
          );
          return;
        }

        /* Everything below keeps every answer on the page. A veteran who has
           just filled in forty fields must never be made to do it again. */
        if (result.reason === "validation" && result.errors.length) {
          if (applyServerErrors(form, result.errors)) {
            showStatus(form, "error", "Please fix the highlighted fields and try again. Your entries have been kept.", false);
            return;
          }
        }
        if (result.reason === "rate_limited") {
          showStatus(form, "error", result.message || ("We've already had a submission for that email today. Your entries are unchanged \u2014 " + contactFallback()), true);
          return;
        }
        if (result.reason === "not_configured") {
          showStatus(form, "error", "Online submission isn't switched on yet. Your entries are unchanged \u2014 " + contactFallback(), true);
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
