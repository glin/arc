/* The one script a mockup page carries.

   It moves the page between the themes panel-snapshot.css was built with. `html.theme-<id>`
   picks that theme's variable table. `body.vscode-dark` or `body.vscode-light` is the class
   the editor itself puts on a webview, and panel.css keys its own per-kind rules on it. Both
   have to move together, or the page draws one theme's tones over another theme's grounds.

   The list of themes comes from panel-snapshot.css, which writes it into a custom property
   rather than repeating it here, so a theme added to the skill reaches every page that was
   generated after it.

   `?theme=<id>` in the address picks a theme at load, which is how render-boards.cjs
   captures every theme without driving the control. */
(function () {
  function themes() {
    var raw = getComputedStyle(document.documentElement).getPropertyValue('--mock-themes');
    return raw.replace(/^\s*"|"\s*$/g, '').split('|').filter(Boolean).map(function (entry) {
      var parts = entry.split(':');
      return { id: parts[0], kind: parts[1], label: parts.slice(2).join(':') };
    });
  }

  function apply(list, id) {
    var picked = list.filter(function (t) { return t.id === id; })[0] || list[0];
    list.forEach(function (t) {
      document.documentElement.classList.toggle('theme-' + t.id, t === picked);
    });
    document.body.classList.toggle('vscode-light', picked.kind === 'light');
    document.body.classList.toggle('vscode-dark', picked.kind !== 'light');
    var control = document.querySelector('.mockthemepick');
    if (control && control.value !== picked.id) { control.value = picked.id; }
    return picked;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var list = themes();
    if (!list.length) { return; }
    var bar = document.querySelector('.mocktheme');
    if (bar) {
      var label = document.createElement('label');
      label.className = 'mockthemelabel';
      label.textContent = 'Theme';
      var pick = document.createElement('select');
      pick.className = 'mockthemepick';
      list.forEach(function (t) {
        var option = document.createElement('option');
        option.value = t.id;
        option.textContent = t.label;
        pick.appendChild(option);
      });
      pick.addEventListener('change', function () { apply(list, pick.value); });
      label.appendChild(pick);
      bar.appendChild(label);
    }
    var asked = /[?&]theme=([\w-]+)/.exec(location.search);
    window.setMockTheme = function (id) { return apply(list, id); };
    apply(list, asked ? asked[1] : list[0].id);
  });
})();
