/* footer.js — shared status bar footer.
 *
 * Pages include a placeholder and let this script render the footer so the
 * markup lives in one place:
 *   <div id="site-footer" data-page="home"></div>
 *   <script src="/footer.js" defer></script>
 *
 * Shows the current page label and the shared session state (guest vs signed
 * in) read from window.EspressoAuth.
 */
(function () {
  'use strict';

  var mount = document.getElementById('site-footer');
  if (!mount) return;

  var page = mount.getAttribute('data-page') || 'home';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var s = (window.EspressoAuth && window.EspressoAuth.session()) || {};
  var auth =
    s.token && s.account
      ? '<span class="status-authenticated">signed in as <code>' + esc(s.account) +
        '</code> <a href="/dashboard">(dashboard)</a></span>'
      : '<span class="status-guest">browsing as guest <a href="/login">(login)</a></span>';

  mount.innerHTML =
    '<footer class="status-bar">' +
      '<span class="status-prompt">' + esc(page) + ' <span aria-hidden="true">_</span></span>' +
      auth +
    '</footer>';
})();