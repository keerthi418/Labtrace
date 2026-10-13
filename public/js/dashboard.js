(function () {
  let selectedId = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(msg, isErr) {
    const el = $('statusMsg');
    el.textContent = msg || '';
    el.className = isErr ? 'err' : 'ok';
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: opts.body && !(opts.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : undefined,
      ...opts,
      body: opts.body && !(opts.body instanceof FormData)
        ? JSON.stringify(opts.body)
        : opts.body,
    });
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // ─── Init ──────────────────────────────────────
  async function init() {
    try {
      const me = await api('/api/me');
      $('userChip').innerHTML = `<strong>${esc(me.displayName || me.username)}</strong> · ${esc(me.role)}`;
    } catch {
      return;
    }

    try {
      const s = await api('/api/settings');
      $('paramN').value = s.n_threshold ?? 3;
      $('paramW').value = s.w_minutes ?? 5;
      $('paramOpen').value = s.open_time || '08:30';
      $('paramClose').value = s.close_time || '17:30';
    } catch (_) {}

    await refreshDashboard();
  }

  async function refreshDashboard() {
    try {
      const data = await api('/api/dashboard');
      const m = data.metrics;
      $('mEvents').textContent = m.events;
      $('mCases').textContent = m.cases;
      $('mReview').textContent = m.toReview;
      $('mRoutine').textContent = m.routine;
      $('queueInfo').textContent = `${data.cases.length} cases`;

      renderTable(data.cases);

      if (selectedId) {
        const still = data.cases.find((c) => c.id === selectedId);
        if (still) await showCase(selectedId);
        else clearEvidence();
      } else if (data.cases.length) {
        const first = data.cases.find((c) => c.priority !== 'ROUTINE') || data.cases[0];
        if (first) await showCase(first.id);
      }
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  function renderTable(cases) {
    const tbody = $('casesBody');
    const table = $('casesTable');
    const empty = $('emptyState');

    if (!cases.length) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    table.classList.remove('hidden');
    tbody.innerHTML = '';

    for (const c of cases) {
      const tr = document.createElement('tr');
      if (c.id === selectedId) tr.classList.add('selected');
      tr.dataset.id = c.id;

      const badge =
        c.priority === 'PRIORITY'
          ? 'badge-priority'
          : c.priority === 'REVIEW'
          ? 'badge-review'
          : 'badge-routine';

      let rules = '';
      if (c.r1) rules += '<span class="rule-tag rule-r1">R1</span>';
      if (c.r2) rules += '<span class="rule-tag rule-r2">R2</span>';
      if (!c.r1 && !c.r2) rules = '<span style="color:var(--text-dim);font-size:0.75rem">—</span>';

      tr.innerHTML = `
        <td><span class="badge ${badge}">${esc(c.priority)}</span></td>
        <td>
          <strong style="color:var(--text-bright)">${esc(c.account)}</strong>
          <span style="color:var(--text-dim)"> · ${esc(c.computer)}</span>
          ${c.department ? `<div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">${esc(c.department)}</div>` : ''}
        </td>
        <td>${rules}</td>
        <td style="max-width:260px;font-size:0.8rem">${esc(c.reason)}</td>
        <td><span class="badge-status">${esc(c.status)}</span></td>
        <td style="font-family:var(--mono);font-size:0.75rem;color:var(--text-dim)">${c.event_count}</td>
      `;
      tr.addEventListener('click', () => showCase(c.id));
      tbody.appendChild(tr);
    }
  }

  function clearEvidence() {
    selectedId = null;
    $('evEmpty').classList.remove('hidden');
    $('evContent').classList.add('hidden');
    $('evContent').innerHTML = '';
  }

  async function showCase(id) {
    selectedId = id;
    document.querySelectorAll('#casesBody tr').forEach((tr) => {
      tr.classList.toggle('selected', Number(tr.dataset.id) === id);
    });

    try {
      const c = await api(`/api/cases/${id}`);
      $('evEmpty').classList.add('hidden');
      const el = $('evContent');
      el.classList.remove('hidden');

      let html = `
        <div class="ev-block">
          <h4>${esc(c.account)} · ${esc(c.computer)}</h4>
          <div class="ev-meta">
            <strong>Priority:</strong> ${esc(c.priority)} · <strong>Status:</strong> ${esc(c.status)}<br/>
            <strong>Department (info only):</strong> ${esc(c.department || '—')}<br/>
            <strong>Events in group:</strong> ${c.event_count}<br/>
            <strong>Matched rules:</strong> ${[c.r1 ? 'R1' : '', c.r2 ? 'R2' : ''].filter(Boolean).join(' + ') || 'None'}
          </div>
        </div>`;

      if (c.r1 && c.r1_detail) {
        const d = c.r1_detail;
        html += `
          <div class="ev-block">
            <h4>R1 — Failure Burst → Success</h4>
            <div class="ev-meta">
              <strong>${d.failCount}</strong> failed login(s) within <strong>${d.windowMin} min</strong><br/>
              <strong>Window:</strong> ${esc(d.from)} → ${esc(d.to)}<br/>
              <strong>Event IDs:</strong> ${(d.eventIds || []).join(', ')}
            </div>
          </div>`;
      }

      if (c.r2 && c.r2_detail) {
        const d = c.r2_detail;
        html += `
          <div class="ev-block">
            <h4>R2 — After-Hours Success</h4>
            <div class="ev-meta">
              Success at <strong>${esc(d.at)}</strong><br/>
              Event ID: ${esc(d.eventId)}
            </div>
          </div>`;
      }

      if (c.priority === 'ROUTINE') {
        html += `
          <div class="ev-block">
            <h4>Why Not Flagged</h4>
            <div class="ev-meta" style="color:var(--text-dim)">${esc(c.reason)}</div>
          </div>`;
      }

      const matched = new Set(c.matched_event_ids || []);
      const show = (c.events || []).slice(-15);
      html += `
        <div class="ev-block">
          <h4>Event Timeline ${(c.events || []).length > 15 ? '(latest 15)' : ''}</h4>
          <ul class="event-list">`;
      for (const e of show) {
        const cls = e.event === 'Failure' ? 'evt-fail' : 'evt-ok';
        const star = matched.has(String(e.event_id)) ? ' ★' : '';
        html += `<li>
          <span style="color:var(--text-dim);min-width:140px">${esc(e.timestamp)}</span>
          <span class="${cls}">${esc(e.event)}${star}</span>
          <span style="color:var(--text-dim)">#${esc(e.event_id)}</span>
        </li>`;
      }
      html += `</ul>
          <div style="font-size:0.68rem;color:var(--text-dim);margin-top:4px">★ = contributed to matched rule</div>
        </div>`;

      if (c.human_check) {
        html += `
          <div class="human-check">
            <strong>Human Check</strong>
            “${esc(c.human_check)}”
          </div>`;
      } else {
        html += `
          <div class="human-check" style="border-color:rgba(0,230,118,0.25);color:var(--accent);background:rgba(0,230,118,0.06)">
            <strong>No Action Required</strong>
            Routine case — no human escalation suggested.
          </div>`;
      }

      if (c.priority !== 'ROUTINE' || c.status === 'open') {
        html += `
          <div class="actions-row">
            <button class="btn btn-primary btn-sm" data-action="confirmed">✓ Confirm (real concern)</button>
            <button class="btn btn-ghost btn-sm" data-action="dismissed">Dismiss (false alarm)</button>
            <button class="btn btn-ghost btn-sm" data-action="open">Re-open</button>
          </div>`;
      }

      el.innerHTML = html;

      el.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api(`/api/cases/${id}/review`, {
              method: 'POST',
              body: { status: btn.dataset.action },
            });
            setStatus(`Case marked ${btn.dataset.action}`);
            await refreshDashboard();
          } catch (e) {
            setStatus(e.message, true);
          }
        });
      });
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // ─── Actions ───────────────────────────────────
  $('btnLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  $('btnDemo').addEventListener('click', async () => {
    try {
      setStatus('Loading demo…');
      const r = await api('/api/demo', { method: 'POST' });
      setStatus(`Demo loaded · ${r.events} events · ${r.cases} cases`);
      selectedId = null;
      await refreshDashboard();
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  $('csvFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('csv', file);
    try {
      setStatus('Uploading…');
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setStatus(`Uploaded · ${data.events} events · ${data.cases} cases`);
      selectedId = null;
      await refreshDashboard();
    } catch (err) {
      setStatus(err.message, true);
    }
    e.target.value = '';
  });

  $('btnReplay').addEventListener('click', async () => {
    try {
      setStatus('Replaying…');
      const r = await api('/api/replay', {
        method: 'POST',
        body: {
          n_threshold: parseInt($('paramN').value, 10),
          w_minutes: parseInt($('paramW').value, 10),
          open_time: $('paramOpen').value,
          close_time: $('paramClose').value,
        },
      });
      setStatus(`Replay done · ${r.cases} cases · N=${r.settings.n_threshold} W=${r.settings.w_minutes}`);
      selectedId = null;
      await refreshDashboard();
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  init();
})();
