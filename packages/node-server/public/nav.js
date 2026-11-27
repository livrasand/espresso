/* nav.js — shared top navigation component.
 *
 * Pages include a placeholder and let this script render the top bar so the
 * markup lives in one place:
 *   <div id="site-nav" data-account="dashboard" data-page="dashboard"></div>
 *   <script src="/nav.js" defer></script>
 *
 * data-account  → "dashboard" (interactive account menu), "profile" (account
 *                 slot filled by profile.js) or "none" (no account area).
 * data-page     → current page id, used to mark the active nav link.
 *
 * Must be loaded before dashboard.js / profile.js (defer order) so the account
 * elements exist when those scripts query them.
 */
(function () {
  'use strict';

  var mount = document.getElementById('site-nav');
  if (!mount) return;

  var account = mount.getAttribute('data-account') || 'none';
  var page = mount.getAttribute('data-page') || '';
  var prefix = account === 'profile' ? 'profile' : 'dash';

  var ICONS = {
    chevron: '<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path></svg>',
    key: '<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M10.5 0a5.499 5.499 0 1 1-1.288 10.848l-.932.932a.749.749 0 0 1-.53.22H7v.75a.749.749 0 0 1-.22.53l-.5.5a.749.749 0 0 1-.53.22H5v.75a.749.749 0 0 1-.22.53l-.5.5a.749.749 0 0 1-.53.22h-2A1.75 1.75 0 0 1 0 14.25v-2c0-.199.079-.389.22-.53l4.932-4.932A5.5 5.5 0 0 1 10.5 0Zm-4 5.5c-.001.431.069.86.205 1.269a.75.75 0 0 1-.181.768L1.5 12.56v1.69c0 .138.112.25.25.25h1.69l.06-.06v-1.19a.75.75 0 0 1 .75-.75h1.19l.06-.06v-1.19a.75.75 0 0 1 .75-.75h1.19l1.023-1.025a.75.75 0 0 1 .768-.18A4 4 0 1 0 6.5 5.5ZM11 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>',
    repo: '<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"></path></svg>',
    signout: '<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 0 1 0 1.5h-2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 2 13.25Zm10.44 4.5-1.97-1.97a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.97-1.97H6.75a.75.75 0 0 1 0-1.5Z"></path></svg>',
  };

  function navLink(href, label, active) {
    return (
      '<a class="' + prefix + '-topnav-link' + (active ? ' is-active' : '') +
      '" href="' + href + '">' + label + '</a>'
    );
  }

  var nav =
    '<nav class="' + prefix + '-topnav" aria-label="Primary">' +
      navLink('/dashboard', 'Repositories', page === 'dashboard') +
      navLink('/profile', 'Profile', page === 'profile') +
      navLink('/docs', 'API docs', page === 'docs') +
    '</nav>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function sessionAccount() {
    var s = (window.EspressoAuth && window.EspressoAuth.session()) || {};
    if (s.token && s.account) {
      return (
        '<div class="dash-account-wrap" id="dash-account-wrap">' +
          '<button type="button" id="dash-account-trigger" class="dash-account-trigger" aria-haspopup="true" aria-expanded="false">' +
            '<span id="dash-account-value">' + esc(s.account) + '</span>' +
            '<span class="dash-account-arrow">' + ICONS.chevron + '</span>' +
          '</button>' +
          '<div id="dash-account-menu" class="dash-account-menu" hidden>' +
            '<a href="/login" data-action="logout" class="dash-account-item">' + ICONS.signout + '<span>Sign out</span></a>' +
          '</div>' +
        '</div>'
      );
    }
    return (
      '<div class="dash-account-wrap">' +
        '<a href="/login" class="dash-account-trigger">' + ICONS.key + '<span>Sign in</span></a>' +
      '</div>'
    );
  }

  var accountHtml = '';
  var wireSession = false;
  if (account === 'dashboard') {
    accountHtml =
      '<div class="dash-account-wrap" id="dash-account-wrap">' +
        '<button type="button" id="dash-account-trigger" class="dash-account-trigger" aria-haspopup="true" aria-expanded="false">' +
          '<span id="dash-account-value">—</span>' +
          '<span class="dash-account-arrow">' + ICONS.chevron + '</span>' +
        '</button>' +
        '<div id="dash-account-menu" class="dash-account-menu" hidden>' +
          '<button id="dash-token-open" type="button" class="dash-account-item" title="Generate or copy a session token">' + ICONS.key + '<span>Token</span></button>' +
          '<button id="dash-create-repo" type="button" class="dash-account-item" title="Create a new repository on the selected node">' + ICONS.repo + '<span>New repository</span></button>' +
          '<a href="/login" data-action="logout" class="dash-account-item">' + ICONS.signout + '<span>Sign out</span></a>' +
        '</div>' +
      '</div>';
  } else if (account === 'profile') {
    accountHtml = '<div class="profile-account" id="profile-account"></div>';
  } else if (account === 'session') {
    accountHtml = sessionAccount();
    wireSession = true;
  }

  mount.innerHTML =
    '<header class="' + prefix + '-topbar">' +
      '<a class="' + prefix + '-brand" href="/" aria-label="Espresso home">' +
        '<img src="/openbin-mark.svg" alt="" class="' + prefix + '-brand-mark">' +
        '<span class="' + prefix + '-brand-name">Espresso</span>' +
      '</a>' +
      nav +
      accountHtml +
    '</header>';

  if (wireSession) {
    var wrap = document.getElementById('dash-account-wrap');
    var trigger = document.getElementById('dash-account-trigger');
    var menu = document.getElementById('dash-account-menu');
    if (trigger && menu) {
      trigger.addEventListener('click', function () {
        var open = trigger.getAttribute('aria-expanded') === 'true';
        trigger.setAttribute('aria-expanded', String(!open));
        menu.hidden = open;
      });
      document.addEventListener('click', function (ev) {
        if (wrap && !wrap.contains(ev.target)) {
          trigger.setAttribute('aria-expanded', 'false');
          menu.hidden = true;
        }
      });
      menu.addEventListener('click', function (ev) {
        var link = ev.target.closest('[data-action="logout"]');
        if (!link) return;
        ev.preventDefault();
        if (window.EspressoAuth) window.EspressoAuth.clearSession();
        window.location.href = '/login';
      });
    }
  }
})();
