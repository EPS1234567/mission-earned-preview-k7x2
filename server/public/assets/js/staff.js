/* Staff review portal.
 *
 * Vanilla, no build step, matching the rest of the site. The CSRF token is
 * read from its cookie and echoed in a header on every write. */
(function () {
  "use strict";

  var state = { user: null, csrf: null, statuses: [], staff: [], caseId: null };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function show(name) {
    document.querySelectorAll("[data-view]").forEach(function (el) {
      el.hidden = el.getAttribute("data-view") !== name;
    });
  }
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function cookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )(?:__Host-)?" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }
  function label(s) {
    return String(s || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    state.csrf = cookie("me_csrf") || state.csrf;
    if (state.csrf) headers["X-CSRF-Token"] = state.csrf;
    if (opts.json) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    opts.headers = headers;
    opts.credentials = "same-origin";
    return fetch("/api/staff" + path, opts).then(function (res) {
      /* A 401 from a signed-in call means the session went away, so return to
         sign-in. A 401 from the sign-in call itself is just a wrong password
         and must keep its own message. */
      if (res.status === 401 && path !== "/login") { show("login"); throw new Error("Your session has ended. Please sign in again."); }
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw Object.assign(new Error(body.message || body.error || "Request failed"), { body: body, status: res.status });
        return body;
      });
    });
  }

  function status(el, kind, message) {
    el.textContent = message;
    el.className = "form-status form-status--" + kind + " is-visible";
  }

  /* ------------------------------------------------------------ sign in -- */

  $("[data-login]").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var out = $("[data-login-status]");
    out.className = "form-status";
    api("/login", { method: "POST", json: { email: form.email.value, password: form.password.value } })
      .then(function (res) {
        state.user = res.user;
        form.reset();
        if (res.totp && res.totp.next !== "none") return startTotp(res.totp.next);
        afterSignIn();
      })
      .catch(function (err) { status(out, "error", err.message || "Sign in failed."); });
  });

  function startTotp(next) {
    show("totp");
    if (next === "enrol") {
      return api("/totp/enrol", { method: "POST" }).then(function (res) {
        $("[data-totp-enrol]").hidden = false;
        $("[data-totp-secret]").textContent = res.secret;
      });
    }
    $("[data-totp-enrol]").hidden = true;
  }

  $("[data-totp]").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = e.target.code.value;
    var out = $("[data-totp-status]");
    var enrolling = !$("[data-totp-enrol]").hidden;
    api(enrolling ? "/totp/confirm" : "/totp/verify", { method: "POST", json: { code: code } })
      .then(function () { e.target.reset(); afterSignIn(); })
      .catch(function (err) { status(out, "error", err.message || "That code isn't right."); });
  });

  $("[data-signout]").addEventListener("click", function () {
    api("/logout", { method: "POST" }).catch(function () {}).then(function () { location.reload(); });
  });

  function afterSignIn() {
    $("[data-who]").hidden = false;
    $("[data-who]").textContent = state.user.name + " · " + label(state.user.role);
    $("[data-signout]").hidden = false;
    if (state.user.role === "admin") $("[data-export]").hidden = false;
    api("/staff").then(function (res) { state.staff = res.staff; }).catch(function () {});
    route();
  }

  /* -------------------------------------------------------------- list --- */

  function loadList() {
    var params = new URLSearchParams();
    if ($("[data-q]").value.trim()) params.set("q", $("[data-q]").value.trim());
    if ($("[data-status]").value) params.set("status", $("[data-status]").value);
    return api("/applications?" + params).then(renderList);
  }

  function renderList(res) {
    show("list");
    var rows = res.applications || [];
    var counts = res.counts || {};

    $("[data-stats]").innerHTML =
      tile("stat-tile--red", counts.received || 0, "Needs review") +
      tile("", rows.length, "Shown") +
      tile("stat-tile--gold", (counts.in_review || 0) + (counts.interview_scheduled || 0), "In progress") +
      tile("", counts.active || 0, "Active volunteers");

    var select = $("[data-status]");
    if (!select.options.length) {
      select.innerHTML = '<option value="">All statuses</option>' +
        ["received","in_review","interview_scheduled","interviewed","onboarding","active","on_hold","withdrawn","declined"]
          .map(function (s) { return '<option value="' + s + '">' + esc(label(s)) + "</option>"; }).join("");
    }

    $("[data-rows]").innerHTML = rows.map(function (a) {
      var unread = Number(a.unread) > 0
        ? ' <span class="badge-unread" title="Unread messages">' + a.unread + "</span>" : "";
      return "<tr>" +
        '<td class="app-table__name">' + esc([a.first_name, a.last_name].join(" ")) + unread + "</td>" +
        "<td>" + esc(a.reference) + "</td>" +
        "<td>" + esc(a.military_connection || "") + "</td>" +
        "<td>" + esc(when(a.received_at)) + "</td>" +
        '<td><span class="pill pill--' + esc(a.status) + '">' + esc(label(a.status)) + "</span></td>" +
        "<td>" + esc(a.documents) + " doc" + (Number(a.documents) === 1 ? "" : "s") + "</td>" +
        '<td><a class="btn btn--outline btn--xs" href="#/case/' + esc(a.id) + '">Open</a></td>' +
        "</tr>";
    }).join("");
    $("[data-empty]").hidden = rows.length > 0;
  }

  function tile(cls, num, text) {
    return '<div class="stat-tile ' + cls + '"><div class="stat-tile__num">' + esc(num) +
      '</div><div class="stat-tile__label">' + esc(text) + "</div></div>";
  }

  $("[data-q]").addEventListener("input", debounce(loadList, 250));
  $("[data-status]").addEventListener("change", loadList);
  $("[data-refresh]").addEventListener("click", loadList);

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  /* -------------------------------------------------------------- case --- */

  var FIELD_GROUPS = [
    { title: "Contact", keys: ["title","first_name","last_name","email","phone","address","city","state","zip","contact_method"] },
    { title: "Military & background", keys: ["military_connection","branch","occupation","education"] },
    { title: "Interests & availability", keys: ["interests","interests_other","availability","volunteer_setting","willing_to_travel","start_date"] },
    { title: "Experience", keys: ["has_experience","experience_detail","speaks_languages","languages_detail"] },
    { title: "About", keys: ["motivation","anything_else"] },
    { title: "Agreements", keys: ["agree_age","agree_review","agree_screening","agree_assignment","agree_accurate"] },
  ];

  function loadCase(id) {
    return api("/applications/" + encodeURIComponent(id)).then(function (d) { renderCase(id, d); });
  }

  function renderCase(id, d) {
    show("case");
    state.caseId = id;
    var a = d.application;
    var name = [a.first_name, a.last_name].filter(Boolean).join(" ");

    var details = FIELD_GROUPS.map(function (g) {
      var items = g.keys.filter(function (k) {
        var v = a[k];
        return v !== null && v !== undefined && String(v).trim() !== "" && !(Array.isArray(v) && !v.length);
      }).map(function (k) {
        var v = a[k];
        if (Array.isArray(v)) v = v.join(", ");
        if (v === true) v = "Yes"; if (v === false) v = "No";
        return "<dt>" + esc(label(k)) + "</dt><dd>" + esc(v) + "</dd>";
      }).join("");
      return items ? '<div class="detail-card"><h3>' + esc(g.title) + '</h3><dl class="detail-list">' + items + "</dl></div>" : "";
    }).join("");

    var signature = a.signature_png
      ? '<div class="detail-card"><h3>Signature</h3><img class="sig-view" alt="Signature of ' + esc(name) +
        '" src="' + esc(a.signature_png) + '"><p class="fine-print mt-sm">Signed by ' +
        esc(a.signature_name || name) + (a.signature_date ? " on " + esc(a.signature_date) : "") + "</p></div>"
      : "";

    $("[data-case]").innerHTML =
      '<p><a class="btn btn--outline btn--xs" href="#/">&larr; All applications</a></p>' +
      "<h2>" + esc(name) + '</h2>' +
      '<p class="fine-print">' + esc(a.reference) + " · received " + esc(when(a.received_at)) +
        ' · <span class="pill pill--' + esc(a.status) + '">' + esc(label(a.status)) + "</span></p>" +

      '<div class="case-grid">' +
        '<div class="case-main">' +
          section("Messages", messagesHtml(d.messages) + composer("message", "Write a message to " + esc(a.first_name || "the applicant"), "Send message")) +
          section("Documents", documentsHtml(d.documents, d.requests) + docForms()) +
          section("Forms for signature", signaturesHtml(d.signatures) + signatureForm()) +
          section("Internal notes", notesHtml(d.notes) + composer("note", "Add an internal note (the applicant never sees these)", "Add note")) +
        "</div>" +
        '<aside class="case-side">' +
          '<div class="card"><h3>Stage</h3>' +
            '<label class="visually-hidden" for="case-status">Status</label>' +
            '<select id="case-status" data-case-status>' +
              d.statuses.map(function (s) {
                return '<option value="' + esc(s) + '"' + (s === a.status ? " selected" : "") + ">" + esc(label(s)) + "</option>";
              }).join("") +
            "</select>" +
            '<p class="fine-print mt-sm">Changing this is recorded with your name.</p>' +
            '<button class="btn btn--outline btn--xs mt-sm" type="button" data-resend>Resend their access link</button>' +
          "</div>" +
          '<div class="card"><h3>History</h3><ol class="case-history">' +
            d.events.map(function (e) {
              return "<li>" + esc(label(e.to_status)) + '<span class="fine-print"> · ' + esc(when(e.created_at)) +
                (e.staff_name ? " · " + esc(e.staff_name) : "") + "</span></li>";
            }).join("") + "</ol></div>" +
        "</aside>" +
      "</div>" +
      '<div class="detail-grid mt-md">' + details + signature + "</div>";

    wireCase(id);
    $("[data-case]").focus();
  }

  function section(title, inner) {
    return '<section class="case-section"><h3>' + esc(title) + "</h3>" + inner + "</section>";
  }

  function messagesHtml(messages) {
    if (!messages.length) return '<p class="fine-print">No messages yet.</p>';
    return '<ol class="case-thread">' + messages.map(function (m) {
      return '<li class="case-msg case-msg--' + (m.author === "staff" ? "us" : "them") + '">' +
        '<p class="case-msg__who">' + esc(m.author === "staff" ? (m.staff_name || "Staff") : "Applicant") +
        '<span class="fine-print"> · ' + esc(when(m.created_at)) +
        (m.author === "staff" && m.read_by_candidate_at ? " · read" : "") + "</span></p>" +
        '<p class="case-msg__body">' + esc(m.body) + "</p></li>";
    }).join("") + "</ol>";
  }

  function notesHtml(notes) {
    if (!notes.length) return '<p class="fine-print">No notes yet.</p>';
    return '<ol class="case-notes">' + notes.map(function (n) {
      return "<li><p class=\"case-msg__who\">" + esc(n.staff_name || "Staff") +
        '<span class="fine-print"> · ' + esc(when(n.created_at)) + "</span></p>" +
        '<p class="case-msg__body">' + esc(n.body) + "</p></li>";
    }).join("") + "</ol>";
  }

  function documentsHtml(documents, requests) {
    var outstanding = requests.filter(function (r) { return !r.fulfilled_at && !r.cancelled_at; });
    var out = "";
    if (outstanding.length) {
      out += '<p class="fine-print">Waiting on: ' + outstanding.map(function (r) { return esc(r.kind); }).join(", ") + "</p>";
    }
    if (!documents.length) return out + '<p class="fine-print">No documents yet.</p>';
    return out + '<ul class="case-docs">' + documents.map(function (d) {
      return "<li>" +
        '<a href="/api/staff/documents/' + esc(d.id) + '">' + esc(d.filename) + "</a>" +
        '<span class="fine-print"> · ' + (d.direction === "inbound" ? "from applicant" : "sent to applicant") +
        " · " + Math.max(1, Math.round(d.size_bytes / 1024)) + " KB · " + esc(when(d.created_at)) + "</span></li>";
    }).join("") + "</ul>";
  }

  function docForms() {
    return '<div class="case-actions">' +
      '<form data-doc-request class="card">' +
        "<h4>Ask the applicant for a document</h4>" +
        '<div class="field"><label class="field__label" for="req-kind">What do you need?</label>' +
          '<input type="text" id="req-kind" name="kind" required placeholder="DD-214"></div>' +
        '<div class="field"><label class="field__label" for="req-note">Instructions (optional)</label>' +
          '<textarea id="req-note" name="instructions" rows="2"></textarea></div>' +
        '<button class="btn btn--navy btn--xs" type="submit">Request it</button>' +
      "</form>" +
      '<form data-doc-send class="card" enctype="multipart/form-data">' +
        "<h4>Send a document to the applicant</h4>" +
        '<div class="field"><label class="field__label" for="send-kind">What is it?</label>' +
          '<input type="text" id="send-kind" name="kind" placeholder="Onboarding packet"></div>' +
        '<div class="field"><label class="field__label" for="send-file">File</label>' +
          '<input type="file" id="send-file" name="file" required accept=".pdf,.docx,.jpg,.jpeg,.png,.tif,.tiff,.heic"></div>' +
        '<button class="btn btn--navy btn--xs" type="submit">Send it</button>' +
      "</form></div>";
  }

  function signaturesHtml(signatures) {
    if (!signatures.length) return '<p class="fine-print">Nothing sent for signature yet.</p>';
    return '<ul class="case-docs">' + signatures.map(function (s) {
      return "<li><strong>" + esc(s.title) + "</strong>" +
        '<span class="fine-print"> · ' + (s.signed_at
          ? "signed by " + esc(s.signed_name) + " on " + esc(when(s.signed_at))
          : "waiting for signature") + "</span></li>";
    }).join("") + "</ul>";
  }

  function signatureForm() {
    return '<form data-sig-request class="card">' +
      "<h4>Send a form for signature</h4>" +
      '<div class="field"><label class="field__label" for="sig-title">Title</label>' +
        '<input type="text" id="sig-title" name="title" required placeholder="Volunteer Agreement"></div>' +
      '<div class="field"><label class="field__label" for="sig-body">What they are agreeing to</label>' +
        '<textarea id="sig-body" name="body" rows="5" required></textarea>' +
        '<p class="field__hint">Plain text. The applicant reads this and types their name to sign.</p></div>' +
      '<button class="btn btn--navy btn--xs" type="submit">Send for signature</button></form>';
  }

  function composer(kind, labelText, button) {
    return '<form data-composer="' + kind + '" class="case-composer">' +
      '<label class="field__label" for="composer-' + kind + '">' + labelText + "</label>" +
      '<textarea id="composer-' + kind + '" name="body" rows="3" required></textarea>' +
      '<button class="btn btn--navy btn--xs" type="submit">' + button + "</button>" +
      '<span class="form-status" role="status" aria-live="polite"></span></form>';
  }

  function wireCase(id) {
    var root = $("[data-case]");
    var base = "/applications/" + encodeURIComponent(id);

    root.querySelectorAll("[data-composer]").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var kind = form.getAttribute("data-composer");
        var out = form.querySelector(".form-status");
        var body = form.body.value.trim();
        if (!body) return;
        api(base + (kind === "message" ? "/messages" : "/notes"), { method: "POST", json: { body: body } })
          .then(function () { form.reset(); loadCase(id); })
          .catch(function (err) { status(out, "error", err.message); });
      });
    });

    $("[data-case-status]").addEventListener("change", function (e) {
      api(base + "/status", { method: "POST", json: { status: e.target.value } })
        .then(function () { loadCase(id); })
        .catch(function (err) { alert(err.message); });
    });

    $("[data-resend]").addEventListener("click", function (e) {
      api(base + "/resend-link", { method: "POST" }).then(function (res) {
        e.target.textContent = res.notified ? "Link sent" : "Email not configured — see logs";
      }).catch(function (err) { alert(err.message); });
    });

    root.querySelector("[data-doc-request]").addEventListener("submit", function (e) {
      e.preventDefault();
      api(base + "/document-requests", {
        method: "POST", json: { kind: e.target.kind.value, instructions: e.target.instructions.value },
      }).then(function () { loadCase(id); }).catch(function (err) { alert(err.message); });
    });

    root.querySelector("[data-sig-request]").addEventListener("submit", function (e) {
      e.preventDefault();
      api(base + "/signature-requests", {
        method: "POST", json: { title: e.target.title.value, body: e.target.body.value },
      }).then(function () { loadCase(id); }).catch(function (err) { alert(err.message); });
    });

    root.querySelector("[data-doc-send]").addEventListener("submit", function (e) {
      e.preventDefault();
      var data = new FormData(e.target);
      api(base + "/documents", { method: "POST", body: data })
        .then(function () { loadCase(id); })
        .catch(function (err) { alert(err.message); });
    });
  }

  /* ------------------------------------------------------------- routing -- */

  function route() {
    var match = location.hash.match(/^#\/case\/([0-9a-f-]{36})$/i);
    if (match) return loadCase(match[1]).catch(function () { location.hash = "#/"; });
    loadList().catch(function () {});
  }

  window.addEventListener("hashchange", function () { if (state.user) route(); });

  api("/me").then(function (res) {
    state.user = res.user;
    state.csrf = res.csrfToken;
    if (res.totp.required && !res.totp.verified) return startTotp(res.totp.enrolled ? "verify" : "enrol");
    afterSignIn();
  }).catch(function () { show("login"); });
})();
