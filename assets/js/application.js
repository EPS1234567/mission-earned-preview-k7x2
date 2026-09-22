/* Volunteer application extras: signature pad and résumé upload.
 *
 * Both degrade honestly. The signature is drawn on a canvas and stored as a
 * PNG data URL in a hidden field so it travels with the rest of the form.
 * Strokes are kept as points, not just pixels, so a rotation or resize
 * re-draws them at the new size instead of stretching a stale bitmap.
 * Anyone who can't draw — keyboard, screen reader, no pointer — can type
 * their name instead and still sign.
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
    var typed = document.querySelector("[data-signature-typed]");
    var ctx = canvas.getContext("2d");
    var drawing = false;
    var strokes = [];
    var current = null;
    var typedText = "";
    var width = 0;
    var height = 0;

    function hasInk() {
      return strokes.length > 0 || typedText !== "";
    }

    function style() {
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0b1d33";
      ctx.fillStyle = "#0b1d33";
    }

    function redraw() {
      ctx.clearRect(0, 0, width, height);
      style();
      if (typedText) {
        ctx.font = 'italic ' + Math.min(38, Math.max(22, height * 0.42)) + 'px "Georgia", "Times New Roman", serif';
        ctx.textBaseline = "alphabetic";
        ctx.fillText(typedText, 18, height * 0.68, Math.max(10, width - 36));
        return;
      }
      strokes.forEach(function (pts) {
        if (!pts.length) return;
        /* A single press is a real mark — draw it as a dot, not nothing. */
        if (pts.length === 1) {
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
          ctx.fill();
          return;
        }
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      });
    }

    /* Match the backing store to the CSS size so strokes aren't blurry, and
       re-draw the recorded strokes after any resize. */
    function fit() {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }
    fit();

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        fit();
        save();
      }, 200);
    });

    function save() {
      if (!field) return;
      var next = hasInk() ? canvas.toDataURL("image/png") : "";
      if (field.value === next) return;
      field.value = next;
      /* Let the shared validator re-check the field once something is drawn. */
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function pos(e) {
      var rect = canvas.getBoundingClientRect();
      var p = e.touches && e.touches.length ? e.touches[0] : e;
      return { x: p.clientX - rect.left, y: p.clientY - rect.top };
    }

    function start(e) {
      /* Typing and drawing are alternatives — drawing wins once it starts. */
      if (typedText) {
        typedText = "";
        if (typed) typed.value = "";
      }
      drawing = true;
      current = [pos(e)];
      strokes.push(current);
      redraw();
      if (e.cancelable) e.preventDefault();
    }

    function move(e) {
      if (!drawing || !current) return;
      current.push(pos(e));
      redraw();
      if (e.cancelable) e.preventDefault();
    }

    function end() {
      if (!drawing) return;
      drawing = false;
      current = null;
      save();
    }

    /* The browser cancels a gesture either because it claimed it for
       scrolling, or because something interrupted the applicant mid-stroke.
       A stroke long enough to be writing is kept — an interrupted signature
       must never be thrown away. A brief flick is the applicant scrolling
       past the pad, and is dropped rather than saved as their signature. */
    function cancel() {
      if (!drawing) return;
      drawing = false;
      var stroke = current;
      current = null;
      if (stroke && !looksLikeWriting(stroke)) {
        var at = strokes.indexOf(stroke);
        if (at !== -1) strokes.splice(at, 1);
        redraw();
      }
      save();
    }

    function looksLikeWriting(pts) {
      if (pts.length < 5) return false;
      var minX = Infinity, maxX = -Infinity;
      for (var i = 0; i < pts.length; i++) {
        if (pts[i].x < minX) minX = pts[i].x;
        if (pts[i].x > maxX) maxX = pts[i].x;
      }
      return maxX - minX >= 12;
    }

    /* Leaving the pad mid-stroke ends that stroke, so coming back doesn't
       draw a straight line across the signature. */
    function leave() {
      if (!drawing) return;
      current = null;
      drawing = false;
      save();
    }

    if (window.PointerEvent) {
      canvas.addEventListener("pointerdown", function (e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        start(e);
      });
      canvas.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", cancel);
      canvas.addEventListener("pointerleave", leave);
    } else {
      canvas.addEventListener("mousedown", start);
      canvas.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end);
      canvas.addEventListener("mouseleave", leave);
      canvas.addEventListener("touchstart", start, { passive: false });
      canvas.addEventListener("touchmove", move, { passive: false });
      canvas.addEventListener("touchend", end);
      canvas.addEventListener("touchcancel", cancel);
    }

    /* Typed signature: the accessible equivalent of drawing. */
    if (typed) {
      typed.addEventListener("input", function () {
        typedText = typed.value.trim();
        if (typedText) strokes = [];
        redraw();
        save();
      });
    }

    function clearPad() {
      strokes = [];
      current = null;
      drawing = false;
      typedText = "";
      if (typed) typed.value = "";
      redraw();
      save();
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        clearPad();
        canvas.focus();
      });
    }

    /* Clear the pad when the form resets after a successful send. */
    var form = canvas.closest("form");
    if (form) {
      form.addEventListener("reset", function () {
        setTimeout(clearPad, 0);
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
    var ALLOWED = /\.(pdf|doc|docx)$/i;

    function show(msg, isError) {
      if (!readout) return;
      readout.textContent = msg;
      readout.classList.toggle("dropzone__file--error", !!isError);
    }

    function reject(msg) {
      show(msg, true);
      if (input) input.value = "";
      if (nameField) nameField.value = "";
    }

    function handle(file) {
      if (!file) return;
      if (!ALLOWED.test(file.name)) {
        reject("That file type isn't accepted — please choose a PDF, DOC, or DOCX.");
        return;
      }
      if (!file.size) {
        reject("That file appears to be empty — please choose another.");
        return;
      }
      if (file.size > MAX_BYTES) {
        reject("That file is larger than 5 MB — please choose a smaller one.");
        return;
      }
      show(file.name + " (" + Math.max(1, Math.round(file.size / 1024)) + " KB)", false);
      if (nameField) nameField.value = file.name;
    }

    function clearZone() {
      show("", false);
      if (input) input.value = "";
      if (nameField) nameField.value = "";
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

    /* A stale filename must never ride along on the next person's
       application — hidden inputs survive form.reset(). */
    var resumeForm = zone.closest("form");
    if (resumeForm) {
      resumeForm.addEventListener("reset", function () {
        setTimeout(clearZone, 0);
      });
    }
  }
})();
