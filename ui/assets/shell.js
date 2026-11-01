/* Reference-only helper: wraps each <div class="app" data-nav="..."> with the sidebar and top bar,
   renders Lucide icons and wires the theme toggle. In the product, this is the AppShell layout component. */
(function () {
  var MARK = '<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--cobalt)"/><path d="M9 14.2l4.3 4.3L23 8.8" fill="none" stroke="var(--on-cobalt)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 22.6h14M9 26h14" fill="none" stroke="var(--on-cobalt)" stroke-width="1.8" stroke-linecap="round"/></svg>';

  var NAV = [
    ['work', 'Work', 'inbox', 'work.html#W-01', '23'],
    ['claims', 'Claims', 'file-text', 'claims.html#C-01'],
    ['remits', 'Remittances', 'landmark', 'money.html#R-01'],
    ['denials', 'Denials', 'circle-x', 'money.html#D-01'],
    ['tasks', 'Manual tasks', 'list-checks', 'money.html#M-03', '4'],
    ['clients', 'Clients', 'building-2', 'clients.html#CL-01'],
    ['reports', 'Reports', 'chart-column', 'admin.html#RP-01'],
    ['|', 'Admin'],
    ['integrations', 'Integrations', 'plug-zap', 'clients.html#I-01'],
    ['settings', 'Settings', 'settings', 'admin.html#S-01'],
    ['audit', 'Audit log', 'scroll-text', 'admin.html#S-13']
  ];
  var OP_NAV = [
    ['op-tenants', 'Tenants', 'building-2', 'admin.html#OP-01'],
    ['op-health', 'Integration health', 'activity', 'admin.html#OP-02'],
    ['op-jobs', 'Jobs and webhooks', 'server', 'admin.html#OP-03']
  ];

  function sidebar(app) {
    var active = app.getAttribute('data-nav') || 'work';
    var op = app.getAttribute('data-variant') === 'operator';
    var role = app.getAttribute('data-role') || 'admin';
    var list = op ? OP_NAV : NAV;
    var html = '<nav class="side" aria-label="Main"><div class="side-brand">' + MARK + '<span>cleanpost' + (op ? ' <span class="tag">Operator</span>' : '') + '</span></div>';
    list.forEach(function (n) {
      if (n[0] === '|') { if (role === 'admin') html += '<div class="nav-section overline">' + n[1] + '</div>'; return; }
      if (role !== 'admin' && (n[0] === 'integrations' || n[0] === 'settings' || n[0] === 'audit')) return;
      html += '<a class="nav-item' + (n[0] === active ? ' active' : '') + '" href="' + n[3] + '"' + (n[0] === active ? ' aria-current="page"' : '') + '><i data-lucide="' + n[2] + '"></i><span>' + n[1] + '</span>' + (n[4] ? '<span class="count-badge">' + n[4] + '</span>' : '') + '</a>';
    });
    html += '<div class="side-foot">' + (op ? 'Cleanpost staff<br>No PHI is shown here' : (app.getAttribute('data-tenant') || 'Northwind Billing') + '<br>' + (app.getAttribute('data-user-name') || 'Dana Reyes') + ' · ' + (role === 'admin' ? 'Admin' : 'Biller')) + '</div></nav>';
    return html;
  }

  function topbar(app) {
    var client = app.getAttribute('data-client') || 'All clients';
    var op = app.getAttribute('data-variant') === 'operator';
    return '<header class="top">' +
      (op ? '<span class="tag"><i data-lucide="shield-check"></i>Operator console</span>' :
        '<button type="button" class="switcher"><i data-lucide="building-2"></i>' + client + '<i data-lucide="chevron-down"></i></button>') +
      '<label class="search"><i data-lucide="search"></i><span class="sr-only">Search</span><input type="search" placeholder="Search patients, claims, trace numbers"><span class="kbd">⌘K</span></label>' +
      '<div class="row" style="margin-left:auto">' +
      '<button type="button" class="icon-btn ghost" aria-label="Get help"><i data-lucide="circle-help"></i></button>' +
      '<button type="button" class="icon-btn ghost" aria-label="Notifications, 2 unread"><i data-lucide="bell"></i></button>' +
      '<span class="avatar" aria-label="' + (app.getAttribute('data-user-name') || 'Dana Reyes') + '">' + (app.getAttribute('data-user') || 'DR') + '</span>' +
      '</div></header>';
  }

  function mount() {
    document.querySelectorAll('.app[data-nav]').forEach(function (app) {
      if (app.dataset.mounted) return;
      app.dataset.mounted = '1';
      var main = app.querySelector(':scope > main, :scope > .main');
      var col = document.createElement('div');
      col.className = 'main-col';
      col.innerHTML = topbar(app);
      if (main) { app.insertBefore(col, main); col.appendChild(main); }
      app.insertAdjacentHTML('afterbegin', sidebar(app));
    });
    document.querySelectorAll('[data-mark]').forEach(function (el) { el.innerHTML = MARK; });
    if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.5 } });
    var t = document.getElementById('theme-toggle');
    if (t) t.addEventListener('click', function () {
      var root = document.documentElement;
      var dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
      root.setAttribute('data-theme', dark ? 'light' : 'dark');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
