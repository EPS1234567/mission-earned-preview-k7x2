/* Minimal server-side rendering.
 *
 * The candidate portal is plain HTML with real form posts because the people
 * using it are veterans on old phones, library machines and screen readers.
 * JavaScript may enhance it; nothing depends on it. */
import config from "../config.js";

export function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* Tagged template that escapes every interpolation by default. Wrap a value in
   raw() only where the markup is ours, never where it came from a user. */
export function html(strings, ...values) {
  return strings.reduce((out, chunk, i) => {
    if (i === 0) return chunk;
    const v = values[i - 1];
    const rendered = v && v.__raw ? v.value : Array.isArray(v) ? v.map((x) => (x && x.__raw ? x.value : esc(x))).join("") : esc(v);
    return out + rendered + chunk;
  }, "");
}

export function raw(value) {
  return { __raw: true, value };
}

export function page({ title, body, heading, subheading = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} | ${esc(config.org.shortName)}</title>
<link rel="stylesheet" href="/assets/css/main.css">
<link rel="stylesheet" href="/assets/css/portal.css">
<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="portal-bar">
  <div class="container portal-bar__inner">
    <span class="portal-bar__brand">${esc(config.org.shortName)}</span>
    <span class="portal-bar__meta">Volunteer application</span>
  </div>
</header>
<main id="main" class="section">
  <div class="container measure-wide">
    <h1>${esc(heading)}</h1>
    ${subheading ? `<p class="portal-sub">${esc(subheading)}</p>` : ""}
    ${body}
  </div>
</main>
<footer class="portal-foot">
  <div class="container">
    <p>Need help? Call <a href="tel:${esc(config.org.phone.replace(/[^\d+]/g, ""))}">${esc(config.org.phone)}</a>
       or email <a href="mailto:${esc(config.org.email)}">${esc(config.org.email)}</a>.</p>
    <p class="fine-print">This page is private to you. Messages here are protected in transit and at rest,
       but they are not end-to-end encrypted — our staff can read them, as they need to in order to help you.
       Please don't send Social Security numbers.</p>
  </div>
</footer>
</body>
</html>`;
}

export function notice(kind, message) {
  return `<p class="form-status form-status--${kind} is-visible" role="status">${esc(message)}</p>`;
}
