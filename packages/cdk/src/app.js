// Copy-to-clipboard for the docs page. Loaded as a same-origin script so it
// complies with the site CSP (default-src 'self'; no inline script allowed).
(function () {
  'use strict';

  var toast = document.getElementById('toast');
  var toastTimer = null;

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    // force reflow so the transition runs when we add .show
    void toast.offsetWidth;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove('show');
    }, 1600);
  }

  function flash(btn, ok) {
    var original = btn.getAttribute('data-label') || btn.textContent;
    if (!btn.getAttribute('data-label')) btn.setAttribute('data-label', original);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    btn.classList.toggle('copied', ok);
    setTimeout(function () {
      btn.textContent = btn.getAttribute('data-label');
      btn.classList.remove('copied');
    }, 1400);
  }

  function copyText(text, btn) {
    function done(ok) {
      flash(btn, ok);
      if (ok) showToast('Copied to clipboard');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(true);
        },
        function () {
          done(fallbackCopy(text));
        }
      );
    } else {
      done(fallbackCopy(text));
    }
  }

  // Fallback for browsers/contexts without the async clipboard API.
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_e) {
      return false;
    }
  }

  function resolveText(btn) {
    var literal = btn.getAttribute('data-copy');
    if (literal !== null) return literal;
    var targetId = btn.getAttribute('data-copy-target');
    if (targetId) {
      var el = document.getElementById(targetId);
      if (el) return el.textContent;
    }
    return null;
  }

  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('.copy-btn') : null;
    if (!btn) return;
    var text = resolveText(btn);
    if (text === null) return;
    copyText(text, btn);
  });
})();
