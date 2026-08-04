/* Admin portal for reviewing submitted applications.
 *
 * Source of data, in order:
 *   1. This browser's own record of submissions (localStorage), written by
 *      forms.js whenever a submission succeeds.
 *   2. The Google Sheet, when a read endpoint is configured — that copy is
 *      shared across devices. See docs/FORM-SETUP.md.
 *
 * The passcode here gates the screen, not the data: it is client-side and
 * anyone who reads the page source can see it. That is fine for a preview
 * behind the password-protected demo link, and is stated plainly in the UI.
 * It is not a production access-control system.
 */
(function () {
  "use strict";

  var root = document.querySelector("[data-admin]");
  if (!root) return;

  var PASSCODE = root.dataset.passcode || "missionearned";
  var SHEET_READ = root.dataset.sheetRead || "";

  var gate = root.querySelector("[data-admin-gate]");
  var app = root.querySelector("[data-admin-app]");
  var gateForm = root.querySelector("[data-admin-gate-form]");
  var gateInput = root.querySelector("[data-admin-passcode]");
  var gateError = root.querySelector("[data-admin-gate-error]");

  var listView = root.querySelector("[data-admin-list]");
  var detailView = root.querySelector("[data-admin-detail]");
  var tbody = root.querySelector("[data-admin-rows]");
  var empty = root.querySelector("[data-admin-empty]");
  var search = root.querySelector("[data-admin-search]");
  var filter = root.querySelector("[data-admin-filter]");
  var countEl = root.querySelector("[data-admin-count]");
  var statNew = root.querySelector("[data-stat-new]");
  var statTotal = root.querySelector("[data-stat-total]");
  var statToday = root.querySelector("[data-stat-today]");
  var sourceNote = root.querySelector("[data-admin-source]");

  var submissions = [];
  var apiBacked = false;

  /* ---------------- storage ---------------- */

  function load() {
    try {
      return JSON.parse(localStorage.getItem("me_submissions") || "[]");
    } catch (e) {
      return [];
    }
  }

  function save(list) {
    try {
      localStorage.setItem("me_submissions", JSON.stringify(list));
    } catch (e) {
      /* nothing we can do; the view still reflects the in-memory list */
    }
  }

  /* ---------------- helpers ---------------- */

  var LABELS = {
    title: "Title", first_name: "First name", last_name: "Last name",
    email: "Email", phone: "Phone", address: "Address", city: "City",
    state: "State", zip: "ZIP", contact_method: "Preferred contact",
    military_connection: "Military connection", branch: "Branch of service",
    occupation: "Occupation", resume_filename: "Résumé file",
    interests: "Areas of interest", interests_other: "Other interest",
    volunteer_setting: "Preferred setting", willing_to_travel: "Willing to travel",
    availability: "Availability", start_date: "Preferred start date",
    has_experience: "Previous experience", experience_detail: "Experience detail",
    speaks_languages: "Other languages", languages_detail: "Language detail",
    motivation: "Why volunteer", anything_else: "Anything else",
    education: "Education", signature_name: "Signed name",
    signature_date: "Signed date", agree_age: "Age confirmed",
    agree_review: "Review understood", agree_screening: "Screening agreed",
    agree_assignment: "Assignment understood", agree_accurate: "Accuracy confirmed"
  };

  var GROUPS = [
    { title: "Contact", keys: ["title", "first_name", "last_name", "email", "phone", "address", "city", "state", "zip", "contact_method"] },
    { title: "Military & Background", keys: ["military_connection", "branch", "occupation", "education", "resume_filename"] },
    { title: "Interests & Availability", keys: ["interests", "interests_other", "volunteer_setting", "willing_to_travel", "availability", "start_date"] },
    { title: "Experience", keys: ["has_experience", "experience_detail", "speaks_languages", "languages_detail"] },
    { title: "About", keys: ["motivation", "anything_else"] },
    { title: "Agreements", keys: ["agree_age", "agree_review", "agree_screening", "agree_assignment", "agree_accurate"] }
  ];

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function nameOf(s) {
    var d = s.data || {};
    var n = [d.first_name, d.last_name].filter(Boolean).join(" ").trim();
    return n || d.signature_name || d.email || "(no name)";
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso || "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function isToday(iso) {
    var d = new Date(iso), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }

  /* ---------------- rendering ---------------- */

  function visible() {
    var q = (search.value || "").toLowerCase().trim();
    var f = filter.value;
    return submissions.filter(function (s) {
      if (f !== "all" && s.status !== f) return false;
      if (!q) return true;
      return JSON.stringify(s.data).toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderStats() {
    statTotal.textContent = submissions.length;
    statNew.textContent = submissions.filter(function (s) { return s.status === "new"; }).length;
    statToday.textContent = submissions.filter(function (s) { return isToday(s.submitted_at); }).length;
  }

  function renderList() {
    var rows = visible();
    countEl.textContent = rows.length + (rows.length === 1 ? " application" : " applications");
    tbody.innerHTML = rows.map(function (s) {
      var d = s.data || {};
      return '<tr>' +
        '<td class="app-table__name">' + esc(nameOf(s)) + '</td>' +
        '<td>' + esc(d.email || "") + '</td>' +
        '<td>' + esc(d.military_connection || "") + '</td>' +
        '<td>' + esc(when(s.submitted_at)) + '</td>' +
        '<td><span class="pill pill--' + esc(s.status) + '">' + esc(s.status) + '</span></td>' +
        '<td><button class="btn btn--outline btn--xs" type="button" data-view="' + esc(s.id) + '">View</button></td>' +
        '</tr>';
    }).join("");

    empty.classList.toggle("admin-hidden", rows.length > 0);
    renderStats();
  }

  function renderDetail(id) {
    var s = submissions.find(function (x) { return x.id === id; });
    if (!s) return;
    var d = s.data || {};

    var cards = GROUPS.map(function (g) {
      var items = g.keys.filter(function (k) {
        return d[k] !== undefined && String(d[k]).trim() !== "";
      }).map(function (k) {
        return "<dt>" + esc(LABELS[k] || k) + "</dt><dd>" + esc(d[k]) + "</dd>";
      }).join("");
      if (!items) return "";
      return '<div class="detail-card"><h3>' + esc(g.title) + '</h3><dl class="detail-list">' + items + "</dl></div>";
    }).join("");

    var sig = d.signature
      ? '<div class="detail-card"><h3>Signature</h3>' +
        '<img class="sig-view" src="' + esc(d.signature) + '" alt="Signature of ' + esc(nameOf(s)) + '">' +
        '<p class="fine-print mt-sm">Signed by ' + esc(d.signature_name || nameOf(s)) +
        (d.signature_date ? " on " + esc(d.signature_date) : "") + "</p></div>"
      : "";

    detailView.innerHTML =
      '<div class="admin-toolbar">' +
        '<button class="btn btn--outline btn--xs" type="button" data-back>&larr; Back to all</button>' +
        '<span class="admin-toolbar__spacer"></span>' +
        '<button class="btn btn--navy btn--xs" type="button" data-toggle-status="' + esc(s.id) + '">' +
          (s.status === "new" ? "Mark reviewed" : "Mark as new") + "</button>" +
        '<button class="btn btn--outline-red btn--xs" type="button" data-delete="' + esc(s.id) + '">Delete</button>' +
      "</div>" +
      "<h2>" + esc(nameOf(s)) + "</h2>" +
      '<p class="fine-print">' + esc(s.form) + " · received " + esc(when(s.submitted_at)) +
        ' · <span class="pill pill--' + esc(s.status) + '">' + esc(s.status) + "</span></p>" +
      '<div class="detail-grid mt-md">' + cards + sig + "</div>";

    listView.classList.add("admin-hidden");
    detailView.classList.remove("admin-hidden");
    detailView.focus();
  }

  function showList() {
    detailView.classList.add("admin-hidden");
    listView.classList.remove("admin-hidden");
    renderList();
  }

  /* ---------------- CSV export ---------------- */

  function exportCsv() {
    var rows = visible();
    if (!rows.length) return;
    var keys = [];
    rows.forEach(function (s) {
      Object.keys(s.data || {}).forEach(function (k) {
        if (k !== "signature" && keys.indexOf(k) === -1) keys.push(k);
      });
    });
    var header = ["received", "status"].concat(keys);
    var lines = [header.join(",")];
    rows.forEach(function (s) {
      var vals = [s.submitted_at, s.status].concat(keys.map(function (k) {
        return (s.data || {})[k] || "";
      }));
      lines.push(vals.map(function (v) {
        return '"' + String(v).replace(/"/g, '""') + '"';
      }).join(","));
    });
    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mission-earned-applications.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ---------------- shared source (Google Sheet) ---------------- */

  function mergeSheet(rows) {
    var seen = {};
    submissions.forEach(function (s) { seen[s.submitted_at + "|" + (s.data || {}).email] = true; });
    rows.forEach(function (r) {
      var key = (r._submitted_at || "") + "|" + (r.email || "");
      if (seen[key]) return;
      submissions.push({
        id: "sheet-" + key,
        form: r._form || "Applications",
        submitted_at: r._submitted_at || "",
        status: "new",
        data: r
      });
    });
    submissions.sort(function (a, b) {
      return String(b.submitted_at).localeCompare(String(a.submitted_at));
    });
  }

  function loadShared() {
    if (!SHEET_READ) return Promise.resolve(false);
    return fetch(SHEET_READ, { method: "GET" })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var rows = Array.isArray(json) ? json : json.rows;
        if (!Array.isArray(rows)) return false;
        mergeSheet(rows);
        return true;
      })
      .catch(function () { return false; });
  }

  /* ---------------- events ---------------- */

  root.addEventListener("click", function (e) {
    var view = e.target.closest("[data-view]");
    if (view) return renderDetail(view.getAttribute("data-view"));

    if (e.target.closest("[data-back]")) return showList();

    var toggle = e.target.closest("[data-toggle-status]");
    if (toggle) {
      var id = toggle.getAttribute("data-toggle-status");
      var s = submissions.find(function (x) { return x.id === id; });
      if (s) {
        s.status = s.status === "new" ? "reviewed" : "new";
        save(submissions.filter(function (x) { return String(x.id).indexOf("sheet-") !== 0; }));
        if (apiBacked) {
          fetch("../api/submissions/" + encodeURIComponent(id), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ status: s.status })
          }).catch(function () {});
        }
        renderDetail(id);
      }
      return;
    }

    var del = e.target.closest("[data-delete]");
    if (del) {
      var did = del.getAttribute("data-delete");
      if (!window.confirm("Delete this application? This cannot be undone.")) return;
      submissions = submissions.filter(function (x) { return x.id !== did; });
      save(submissions.filter(function (x) { return String(x.id).indexOf("sheet-") !== 0; }));
      if (apiBacked) {
        fetch("../api/submissions/" + encodeURIComponent(did), {
          method: "DELETE",
          credentials: "same-origin"
        }).catch(function () {});
      }
      showList();
      return;
    }

    if (e.target.closest("[data-export]")) exportCsv();
  });

  if (search) search.addEventListener("input", renderList);
  if (filter) filter.addEventListener("change", renderList);

  /* ---------------- start ---------------- */

  function loadApi() {
    return fetch("../api/submissions", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /* Sample applications shipped with the build. They keep the portal
     demonstrable anywhere — including a plain static host with no server —
     and are labelled as samples in the UI so they are never mistaken for
     real applicants. Delete removes them from view like any other record. */
  function loadSamples() {
    return fetch("../assets/data/sample-applications.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function mergeById(base, extra) {
    var seen = {};
    base.forEach(function (x) { seen[x.id] = true; });
    extra.forEach(function (x) { if (!seen[x.id]) base.push(x); });
    return base.sort(function (a, b) {
      return String(b.submitted_at).localeCompare(String(a.submitted_at));
    });
  }

  function start() {
    gate.classList.add("admin-hidden");
    app.classList.remove("admin-hidden");
    submissions = load();
    renderList();

    /* Fall back to the bundled samples when no server-side store answers. */
    loadApi().then(function (rows) {
      if (!Array.isArray(rows)) {
        return loadSamples().then(function (samples) {
          if (!Array.isArray(samples)) return;
          submissions = mergeById(samples.slice(), submissions);
          renderList();
          if (sourceNote) {
            sourceNote.textContent =
              "sample applications bundled with this preview, plus anything submitted in this browser";
          }
        });
      }
      var localOnly = submissions.filter(function (l) {
        return !rows.some(function (r) {
          return r.submitted_at === l.submitted_at &&
            (r.data || {}).email === (l.data || {}).email;
        });
      });
      submissions = rows.concat(localOnly).sort(function (a, b) {
        return String(b.submitted_at).localeCompare(String(a.submitted_at));
      });
      apiBacked = true;
      renderList();
      if (sourceNote) sourceNote.textContent = "the shared preview store — visible on every device";
    });
    loadShared().then(function (got) {
      if (got) {
        renderList();
        if (sourceNote) sourceNote.textContent = "This browser + the shared Google Sheet.";
      }
    });
  }

  gateForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (gateInput.value === PASSCODE) {
      try { sessionStorage.setItem("me_admin", "1"); } catch (err) {}
      gateError.textContent = "";
      start();
    } else {
      gateError.textContent = "That passcode isn't right. Try again.";
      gateInput.select();
    }
  });

  try {
    if (sessionStorage.getItem("me_admin") === "1") start();
  } catch (e) {}
})();
