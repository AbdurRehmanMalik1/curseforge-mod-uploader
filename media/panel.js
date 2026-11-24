// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @type {any} */
  let state = null;
  /** path -> {state, message, fileId, tags, missing} */
  /** @type {Record<string, any>} */
  let rows = {};
  let busy = false;

  /** Bulk editor values; '' means "leave unchanged". */
  const bulk = { loader: '', mc: '', java: '', env: '' };

  /** @param {string} tag @param {Record<string, any>} [attrs] @param {...any} children */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') /** @type {any} */ (el).value = v;
      else if (k === 'checked') /** @type {any} */ (el).checked = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function size(n) {
    return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function loaderLabel(id) {
    const l = state.loaders.find((x) => x.id === id);
    return l ? l.label : id;
  }

  /** Display name from the template, using the values picked for this file. */
  function templateName(jar) {
    const p = jar.parsed;
    const m = jar.meta;
    const mod = state.mods[p.mod];
    const values = {
      name: (mod && mod.name.trim()) || p.mod,
      mod: p.mod,
      version: p.version,
      loader: m.loader,
      Loader: loaderLabel(m.loader),
      mc: m.mc,
      java: m.java ? String(m.java) : '',
      filename: jar.filename,
    };
    return state.template
      .replace(/\{(\w+)\}/g, (all, k) => (k in values ? values[k] : all))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function displayName(jar) {
    return jar.meta.override || templateName(jar);
  }

  function form() {
    const selected = state.jars.filter((j) => j.selected);
    return {
      mods: Object.fromEntries(Object.entries(state.mods).map(([k, v]) => [k, { projectId: v.projectId, name: v.name }])),
      releaseType: state.releaseType,
      manualRelease: state.manualRelease,
      changelog: state.changelog,
      changelogType: state.changelogType,
      template: state.template,
      deps: state.deps,
      selected: selected.map((j) => j.path),
      files: Object.fromEntries(
        selected.map((j) => [
          j.path,
          { loader: j.meta.loader, mc: j.meta.mc.trim(), java: j.meta.java, environments: j.meta.environments, displayName: j.meta.override },
        ]),
      ),
    };
  }

  let draftTimer = 0;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = /** @type {any} */ (setTimeout(() => vscode.postMessage({ type: 'draft', form: form() }), 600));
  }

  function setStatus(message, level) {
    state.status = { message, level };
    const el = document.getElementById('status');
    if (el) {
      el.textContent = message || '';
      el.className = 'status ' + (level || '');
    }
  }

  function selectedCount() {
    return state.jars.filter((j) => j.selected).length;
  }

  function updateButtons() {
    const n = selectedCount();
    const up = /** @type {HTMLButtonElement|null} */ (document.getElementById('upload'));
    const ck = /** @type {HTMLButtonElement|null} */ (document.getElementById('check'));
    const ap = /** @type {HTMLButtonElement|null} */ (document.getElementById('apply'));
    if (up) {
      up.textContent = busy ? 'Uploading...' : `Upload ${n} file${n === 1 ? '' : 's'}`;
      up.disabled = busy || n === 0;
    }
    if (ck) ck.disabled = busy || n === 0;
    if (ap) ap.disabled = busy || n === 0;
  }

  function cell(jar, key) {
    return document.querySelector(`[data-${key}="${CSS.escape(jar.path)}"]`);
  }

  /** Display names follow the template until the user types their own. */
  function refreshNames() {
    for (const jar of state.jars) {
      if (!jar.parsed || jar.meta.override) continue;
      const el = /** @type {HTMLInputElement|null} */ (cell(jar, 'name'));
      if (el && document.activeElement !== el) el.value = templateName(jar);
    }
  }

  /** A changed file loses its last check result, since its tags may differ now. */
  function changed(jar) {
    if (rows[jar.path]) {
      delete rows[jar.path].tags;
      delete rows[jar.path].missing;
    }
    const el = cell(jar, 'status');
    if (el) el.replaceChildren(statusCell(jar));
    refreshNames();
  }

  function statusCell(jar) {
    if (jar.problem) return h('span', { class: 'bad' }, jar.problem);
    const r = rows[jar.path] || {};
    if (r.state === 'uploading') return h('span', { class: 'busy' }, 'Uploading...');
    if (r.state === 'done') return h('span', { class: 'good' }, `Uploaded, file ${r.fileId}`);
    if (r.state === 'failed') return h('span', { class: 'bad' }, r.message);
    if (r.state === 'queued') return h('span', { class: 'muted' }, 'Waiting');
    const parts = [];
    if (jar.guessed && (!jar.meta.loader || !jar.meta.mc))
      parts.push(h('span', { class: 'warn' }, 'Name not recognised: pick the loader and Minecraft version'));
    if (r.missing && r.missing.length) parts.push(h('span', { class: 'bad' }, 'Unknown on CurseForge: ' + r.missing.join(', ')));
    if (r.tags && r.tags.length) parts.push(h('span', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag' }, t))));
    if (jar.uploaded)
      parts.push(h('span', { class: 'warn' }, `Already uploaded ${jar.uploaded.date.slice(0, 10)} (file ${jar.uploaded.fileId})`));
    return parts.length ? h('span', { class: 'stack' }, parts) : h('span', { class: 'muted' }, 'Not checked yet');
  }

  function javaOptions(current, extra) {
    const list = [...new Set([...(current ? [current] : []), ...state.javaVersions])].sort((a, b) => b - a);
    return [
      ...extra,
      ...list.map((v) => h('option', { value: String(v), selected: current === v }, 'Java ' + v)),
    ];
  }

  function loaderSelect(jar) {
    return h(
      'select',
      {
        class: 'small' + (jar.meta.loader ? '' : ' needs'),
        disabled: busy,
        onchange: (e) => {
          jar.meta.loader = e.target.value;
          e.target.classList.toggle('needs', !jar.meta.loader);
          render();
        },
      },
      jar.meta.loader ? null : h('option', { value: '', selected: true }, 'Pick...'),
      state.loaders.map((l) => h('option', { value: l.id, selected: jar.meta.loader === l.id }, l.label)),
    );
  }

  function mcInput(jar) {
    return h('input', {
      type: 'text',
      list: 'mc-list',
      size: 8,
      class: jar.meta.mc ? '' : 'needs',
      placeholder: 'e.g. 1.21.1',
      value: jar.meta.mc,
      disabled: busy,
      oninput: (e) => {
        jar.meta.mc = e.target.value.trim();
        e.target.classList.toggle('needs', !jar.meta.mc);
        changed(jar);
      },
    });
  }

  function javaSelect(jar) {
    return h(
      'select',
      {
        class: 'small',
        'data-java': jar.path,
        disabled: busy,
        onchange: (e) => {
          jar.meta.java = e.target.value ? Number(e.target.value) : null;
          changed(jar);
        },
      },
      javaOptions(jar.meta.java, [h('option', { value: '', selected: !jar.meta.java }, 'None')]),
    );
  }

  function envBoxes(jar) {
    return h(
      'span',
      { class: 'envs' },
      state.environmentNames.map((env) =>
        h(
          'label',
          { class: 'inline' },
          h('input', {
            type: 'checkbox',
            checked: jar.meta.environments.includes(env),
            disabled: busy,
            onchange: (e) => {
              const set = new Set(jar.meta.environments);
              if (e.target.checked) set.add(env);
              else set.delete(env);
              jar.meta.environments = state.environmentNames.filter((x) => set.has(x));
              changed(jar);
              render(); // keeps "Environment (all files)" in step
            },
          }),
          env,
        ),
      ),
    );
  }

  /** One environment choice for every file of the mod. Ticked only when every file has it. */
  function allEnvBoxes(usable) {
    return h(
      'div',
      { class: 'radios' },
      h('span', { class: 'label' }, 'Environment (all files)'),
      state.environmentNames.map((env) => {
        const count = usable.filter((j) => j.meta.environments.includes(env)).length;
        const box = h('input', {
          type: 'checkbox',
          checked: count === usable.length,
          disabled: busy,
          onchange: (e) => {
            for (const jar of usable) {
              const set = new Set(jar.meta.environments);
              if (e.target.checked) set.add(env);
              else set.delete(env);
              jar.meta.environments = state.environmentNames.filter((x) => set.has(x));
              if (rows[jar.path]) {
                delete rows[jar.path].tags;
                delete rows[jar.path].missing;
              }
            }
            render();
          },
        });
        /** @type {any} */ (box).indeterminate = count > 0 && count < usable.length;
        return h('label', { class: 'inline' }, box, env);
      }),
    );
  }

  function nameInput(jar) {
    return h('input', {
      type: 'text',
      class: 'name',
      'data-name': jar.path,
      value: displayName(jar),
      title: 'Edit to set this file\'s display name by hand. Clear it to go back to the template.',
      disabled: busy,
      oninput: (e) => {
        const v = e.target.value;
        jar.meta.override = v.trim() && v.trim() !== templateName(jar) ? v : '';
      },
      onblur: (e) => {
        if (!jar.meta.override) e.target.value = templateName(jar);
      },
    });
  }

  function applyBulk() {
    const targets = state.jars.filter((j) => j.selected);
    for (const jar of targets) {
      if (bulk.loader) jar.meta.loader = bulk.loader;
      if (bulk.mc.trim()) jar.meta.mc = bulk.mc.trim();
      if (bulk.java === 'none') jar.meta.java = null;
      else if (bulk.java) jar.meta.java = Number(bulk.java);
      if (bulk.env) jar.meta.environments = bulk.env === 'none' ? [] : bulk.env.split('+');
      if (rows[jar.path]) {
        delete rows[jar.path].tags;
        delete rows[jar.path].missing;
      }
    }
    render();
    setStatus(`Applied to ${targets.length} selected file(s).`);
  }

  function bulkBar() {
    const envChoices = [
      ['', 'Unchanged'],
      ['Client+Server', 'Client + Server'],
      ['Client', 'Client'],
      ['Server', 'Server'],
      ['none', 'None'],
    ];
    return h(
      'section',
      {},
      h('h2', {}, 'Set on selected files'),
      h(
        'div',
        { class: 'grid bulk' },
        h(
          'label',
          {},
          'Mod loader',
          h(
            'select',
            { onchange: (e) => (bulk.loader = e.target.value) },
            h('option', { value: '', selected: !bulk.loader }, 'Unchanged'),
            state.loaders.map((l) => h('option', { value: l.id, selected: bulk.loader === l.id }, l.label)),
          ),
        ),
        h(
          'label',
          {},
          'Minecraft',
          h('input', { type: 'text', list: 'mc-list', placeholder: 'Unchanged', value: bulk.mc, oninput: (e) => (bulk.mc = e.target.value) }),
        ),
        h(
          'label',
          {},
          'Java',
          h(
            'select',
            { 'data-java': '__bulk', onchange: (e) => (bulk.java = e.target.value) },
            javaOptions(bulk.java && bulk.java !== 'none' ? Number(bulk.java) : null, [
              h('option', { value: '', selected: !bulk.java }, 'Unchanged'),
              h('option', { value: 'none', selected: bulk.java === 'none' }, 'None'),
            ]),
          ),
        ),
        h(
          'label',
          {},
          'Environment',
          h(
            'select',
            { onchange: (e) => (bulk.env = e.target.value) },
            envChoices.map(([v, t]) => h('option', { value: v, selected: bulk.env === v }, t)),
          ),
        ),
        h('div', { class: 'apply' }, h('button', { id: 'apply', class: 'secondary', onclick: applyBulk }, 'Apply to selected')),
      ),
    );
  }

  function render() {
    if (!state) return;
    const jars = state.jars;
    const mods = Object.keys(state.mods);
    const loaders = [...new Set(jars.filter((j) => j.meta && j.meta.loader).map((j) => j.meta.loader))];
    const usable = jars.filter((j) => j.parsed && !j.problem);

    const projectRows = mods.map((mod) => {
      const m = state.mods[mod];
      return h(
        'div',
        { class: 'project' },
        h('div', { class: 'mod-id' }, h('code', {}, mod), m.versions.filter(Boolean).length ? h('span', { class: 'muted' }, ' version ' + m.versions.filter(Boolean).join(', ')) : null),
        h(
          'label',
          {},
          'Project ID',
          h('input', {
            type: 'text',
            inputmode: 'numeric',
            placeholder: 'e.g. 1234567',
            value: m.projectId,
            class: m.projectId ? '' : 'needs',
            oninput: (e) => {
              m.projectId = e.target.value.replace(/\D/g, '');
              e.target.value = m.projectId;
              e.target.classList.toggle('needs', !m.projectId);
            },
          }),
        ),
        h(
          'label',
          { class: 'grow' },
          'Mod name',
          h('input', {
            type: 'text',
            value: m.name,
            oninput: (e) => {
              m.name = e.target.value;
              refreshNames();
            },
          }),
        ),
      );
    });

    const allChecked = usable.length > 0 && usable.every((j) => j.selected);

    const table = h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h(
            'th',
            { class: 'cb' },
            h('input', {
              type: 'checkbox',
              title: 'Select all',
              checked: allChecked,
              disabled: busy,
              onchange: (e) => {
                for (const j of usable) j.selected = e.target.checked;
                render();
              },
            }),
          ),
          h('th', {}, 'File'),
          h('th', {}, 'Mod loader'),
          h('th', {}, 'Minecraft'),
          h('th', {}, 'Java'),
          h('th', {}, 'Environment'),
          h('th', {}, 'Display name'),
          h('th', {}, 'Status'),
        ),
      ),
      h(
        'tbody',
        {},
        jars.map((jar) => {
          const ok = jar.parsed && !jar.problem;
          return h(
            'tr',
            { class: ok ? '' : 'disabled' },
            h(
              'td',
              { class: 'cb' },
              h('input', {
                type: 'checkbox',
                checked: jar.selected,
                disabled: busy || !ok,
                onchange: (e) => {
                  jar.selected = e.target.checked;
                  updateButtons();
                },
              }),
            ),
            h(
              'td',
              { class: 'file' },
              h('a', { href: '#', title: 'Show in file explorer', onclick: (e) => { e.preventDefault(); vscode.postMessage({ type: 'reveal', path: jar.path }); } }, jar.rel),
              h('span', { class: 'muted' }, ' ' + size(jar.size)),
            ),
            h('td', {}, ok ? loaderSelect(jar) : ''),
            h('td', {}, ok ? mcInput(jar) : ''),
            h('td', {}, ok ? javaSelect(jar) : ''),
            h('td', {}, ok ? envBoxes(jar) : ''),
            h('td', {}, ok ? nameInput(jar) : ''),
            h('td', { 'data-status': jar.path }, statusCell(jar)),
          );
        }),
      ),
    );

    app.replaceChildren(
      h('datalist', { id: 'mc-list' }, state.mcVersions.map((v) => h('option', { value: v }))),
      h(
        'header',
        {},
        h('div', {}, h('h1', {}, 'Upload to CurseForge'), h('div', { class: 'muted path' }, state.root)),
        h(
          'div',
          { class: 'actions' },
          h('span', { class: state.hasToken ? 'good' : 'warn' }, state.hasToken ? 'API token saved' : 'No API token yet'),
          h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'setToken' }) }, state.hasToken ? 'Change token' : 'Set token'),
          h('button', { class: 'secondary', disabled: busy, onclick: () => vscode.postMessage({ type: 'rescan' }) }, 'Rescan folder'),
          h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'showLog' }) }, 'Show log'),
        ),
      ),
      mods.length
        ? h('section', {}, h('h2', {}, 'Project'), projectRows)
        : h('p', { class: 'bad' }, 'No mod jars were found here.'),
      h(
        'section',
        { class: 'grid' },
        h(
          'label',
          {},
          'Release type',
          h(
            'select',
            { onchange: (e) => (state.releaseType = e.target.value) },
            ['release', 'beta', 'alpha'].map((t) => h('option', { value: t, selected: state.releaseType === t }, t[0].toUpperCase() + t.slice(1))),
          ),
        ),
        usable.length ? allEnvBoxes(usable) : null,
        h(
          'div',
          { class: 'radios' },
          h('span', { class: 'label' }, 'Release options'),
          h(
            'label',
            { class: 'inline' },
            h('input', { type: 'radio', name: 'publish', checked: !state.manualRelease, onchange: () => (state.manualRelease = false) }),
            'Publish automatically once approved',
          ),
          h(
            'label',
            { class: 'inline' },
            h('input', { type: 'radio', name: 'publish', checked: state.manualRelease, onchange: () => (state.manualRelease = true) }),
            'I will publish manually once approved',
          ),
        ),
        h(
          'label',
          { class: 'grow' },
          'Display name template',
          h('input', {
            type: 'text',
            value: state.template,
            title: 'Placeholders: {name} {mod} {version} {loader} {Loader} {mc} {java} {filename}',
            oninput: (e) => {
              state.template = e.target.value;
              refreshNames();
            },
          }),
        ),
      ),
      h(
        'section',
        {},
        h(
          'div',
          { class: 'row' },
          h('h2', {}, 'Changelog'),
          h(
            'select',
            { class: 'small', onchange: (e) => (state.changelogType = e.target.value) },
            ['markdown', 'text', 'html'].map((t) => h('option', { value: t, selected: state.changelogType === t }, t)),
          ),
        ),
        h('textarea', {
          rows: 7,
          placeholder: 'What changed in this version. A CHANGELOG.md in the release folder is loaded here automatically.',
          oninput: (e) => {
            state.changelog = e.target.value;
            saveDraft();
          },
        }, state.changelog),
      ),
      loaders.length
        ? h(
            'section',
            {},
            h('h2', {}, 'Required dependencies'),
            h('p', { class: 'muted' }, 'CurseForge project slugs, separated by commas. Added to every file of that loader.'),
            h(
              'div',
              { class: 'grid' },
              loaders.map((l) =>
                h(
                  'label',
                  {},
                  loaderLabel(l),
                  h('input', { type: 'text', value: state.deps[l] || '', placeholder: 'none', oninput: (e) => (state.deps[l] = e.target.value) }),
                ),
              ),
            ),
          )
        : null,
      usable.length ? bulkBar() : null,
      h('section', {}, h('h2', {}, `Files (${jars.length})`), h('div', { class: 'table-wrap' }, table)),
      h(
        'footer',
        {},
        h('div', { id: 'status', class: 'status ' + ((state.status && state.status.level) || '') }, (state.status && state.status.message) || ''),
        h(
          'div',
          { class: 'actions' },
          h('button', { id: 'check', class: 'secondary', onclick: () => { setStatus('Checking...'); vscode.postMessage({ type: 'check', form: form() }); } }, 'Check versions'),
          h('button', { id: 'upload', onclick: () => { busy = true; updateButtons(); setStatus('Preparing upload...'); vscode.postMessage({ type: 'upload', form: form() }); } }, 'Upload'),
        ),
      ),
    );
    updateButtons();
  }

  /** New version lists from CurseForge: update the pickers in place so nothing being typed is lost. */
  function applyCatalog(mcVersions, javaVersions) {
    if (mcVersions.length) state.mcVersions = mcVersions;
    if (javaVersions.length) state.javaVersions = javaVersions;
    const list = document.getElementById('mc-list');
    if (list) list.replaceChildren(...state.mcVersions.map((v) => h('option', { value: v })));
    for (const jar of state.jars) {
      const sel = cell(jar, 'java');
      if (sel) sel.replaceChildren(...javaOptions(jar.meta.java, [h('option', { value: '', selected: !jar.meta.java }, 'None')]));
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        rows = {};
        busy = false;
        state = { ...msg, status: null };
        for (const j of state.jars) {
          j.selected = !!j.parsed && !j.problem && !j.guessed && !j.uploaded;
          if (j.meta) j.meta = { ...j.meta, environments: [...j.meta.environments], override: '' };
        }
        render();
        break;
      case 'catalog':
        if (state) applyCatalog(msg.mcVersions, msg.javaVersions);
        break;
      case 'token':
        if (state) {
          state.hasToken = msg.hasToken;
          render();
        }
        break;
      case 'checked':
        for (const r of msg.rows) rows[r.path] = { ...(rows[r.path] || {}), tags: r.tags, missing: r.missing, state: undefined };
        render();
        break;
      case 'uploading':
        busy = true;
        for (const p of msg.paths) rows[p] = { ...(rows[p] || {}), state: 'queued' };
        render();
        break;
      case 'progress': {
        rows[msg.path] = { ...(rows[msg.path] || {}), state: msg.state, message: msg.message, fileId: msg.fileId };
        const jar = state.jars.find((j) => j.path === msg.path);
        if (jar && msg.state === 'done') {
          jar.selected = false;
          jar.uploaded = { fileId: msg.fileId, date: new Date().toISOString() };
        }
        render();
        break;
      }
      case 'status':
        setStatus(msg.message, msg.level);
        break;
      case 'error':
        busy = false;
        render();
        setStatus(msg.message, 'error');
        break;
      case 'idle':
        busy = false;
        render();
        break;
    }
  });
})();
