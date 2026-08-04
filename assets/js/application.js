/* Volunteer application extras: signature pad and résumé upload.
 *
 * Both degrade honestly. The signature is drawn on a canvas and stored as a
 * PNG data URL in a hidden field so it travels with the rest of the form.
 * The résumé field reports the chosen file by name; whether the file itself is
 * attached depends on the form backend (see docs/FORM-SETUP.md).
 */
(function () {
  "use strict";

  /* ---------------- Signature pad ---------------- */
  var canvas = document.querySelector("[data-signature]");
  if (canvas) {
    var field = document.querySelector("[data-signature-value]");
    var clearBtn = document.querySelector("[data-signature-clear]");
    var ctx = canvas.getContext("2d");
    var drawing = false;
    var hasInk = false;

    /* Match the backing store to the CSS size so strokes aren't blurry, and
       redraw scale after any resize. */
    function fit() {
      var prev = hasInk ? canvas.toDataURL() : null;
      var rect = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0b1d33";
      if (prev) {
        var img = new Image();
        img.onload = function () {
          ctx.drawImage(img, 0, 0, rect.width, rect.height);
        };
        img.src = prev;
      }
    }
    fit();

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 200);
    });

    function pos(e) {
      var rect = canvas.getBoundingClientRect();
      var p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - rect.left, y: p.clientY - rect.top };
    }

    function start(e) {
      drawing = true;
      var p = pos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      e.preventDefault();
    }

    function move(e) {
      if (!drawing) return;
      var p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      hasInk = true;
      e.preventDefault();
    }

    function end() {
      if (!drawing) return;
      drawing = false;
      if (field) field.value = hasInk ? canvas.toDataURL("image/png") : "";
      /* Let the shared validator re-check the field once something is drawn. */
      if (field) field.dispatchEvent(new Event("change", { bubbles: true }));
    }

    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    document.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end);

    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasInk = false;
        if (field) {
          field.value = "";
          field.dispatchEvent(new Event("change", { bubbles: true }));
        }
        canvas.focus();
      });
    }

    /* Clear the pad when the form resets after a successful send. */
    var form = canvas.closest("form");
    if (form) {
      form.addEventListener("reset", function () {
        setTimeout(function () {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          hasInk = false;
          if (field) field.value = "";
        }, 0);
      });
    }
  }

  /* ---------------- Résumé upload ---------------- */
  var zone = document.querySelector("[data-dropzone]");
  if (zone) {
    var input = zone.querySelector('input[type="file"]');
    var readout = zone.querySelector("[data-dropzone-file]");
    var nameField = document.querySelector("[data-resume-name]");
    var MAX_BYTES = 5 * 1024 * 1024;

    function show(msg, isError) {
      if (!readout) return;
      readout.textContent = msg;
      readout.style.color = isError ? "var(--red)" : "";
    }

    function handle(file) {
      if (!file) return;
      if (file.size > MAX_BYTES) {
        show("That file is larger than 5 MB — please choose a smaller one.", true);
        input.value = "";
        if (nameField) nameField.value = "";
        return;
      }
      show(file.name + " (" + Math.round(file.size / 1024) + " KB)", false);
      if (nameField) nameField.value = file.name;
    }

    input.addEventListener("change", function () {
      handle(input.files && input.files[0]);
    });

    ["dragenter", "dragover"].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.remove("is-dragover");
      });
    });
    zone.addEventListener("drop", function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      } catch (err) {
        /* Older browsers won't let us assign files; the name still records. */
      }
      handle(file);
    });
  }
})();
