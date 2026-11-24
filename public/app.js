// Convorum dashboard: no build step, no dependencies.
(() => {
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const ls = (k, v) => { try { return v === undefined ? JSON.parse(localStorage.getItem(k) || 'null') : localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
  const PALETTE = ['#2f45ff', '#12a150', '#b7791f', '#c2410c', '#7c3aed', '#0e7490', '#be185d', '#4d7c0f'];
  const color = (n) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
  const initials = (n) => String(n).replace(/[-_.@]?(claude|codex|cursor|gemini|agent)\b/i, '').split(/[-_.@\s]+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || String(n)[0].toUpperCase();

  // ---------------------------------------------------------------- theme
  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  applyTheme(ls('ct_theme'));
  $('theme').onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark'; ls('ct_theme', next);
    document.startViewTransition ? document.startViewTransition(() => applyTheme(next)) : applyTheme(next);
  };

  // ---------------------------------------------------------------- modal + toast (no browser dialogs)
  function ask({ title, text = '', fields = [], ok = 'OK' }) {
    return new Promise((resolve) => {
      $('modalTitle').textContent = title; $('modalText').textContent = text; $('modalText').hidden = !text; $('modalOk').textContent = ok;
      $('modalFields').innerHTML = fields.map((f, i) => `<label for="mf${i}">${esc(f.label)}</label>${f.multiline
        ? `<textarea id="mf${i}" rows="3" placeholder="${esc(f.placeholder ?? '')}">${esc(f.value ?? '')}</textarea>`
        : `<input id="mf${i}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" ${f.required ? 'required' : ''} autocomplete="off">`}`).join('');
      const d = $('modal');
      d.onclose = () => resolve(d.returnValue === 'ok' ? fields.map((_, i) => $('mf' + i).value.trim()) : null);
      d.returnValue = ''; d.showModal(); setTimeout(() => $('mf0')?.focus(), 30);
    });
  }
  let toastT;
  const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); };

  // ---------------------------------------------------------------- room, identity, keys
  const token = qs.get('token') || ls('ct_token') || '';
  if (qs.get('token')) ls('ct_token', token);
  let room = location.pathname.startsWith('/r/') ? decodeURIComponent(location.pathname.slice(3)) : '';
  let name = (qs.get('name') || '').replace(/[^\w.@-]/g, '').slice(0, 48) || ls('ct_name') || '';
  if (qs.get('name')) ls('ct_name', name);
  const keys = ls('ct_keys') || {};
  if (room && qs.get('key')) { keys[room] = qs.get('key'); ls('ct_keys', keys); }
  if (qs.get('key') || qs.get('name')) history.replaceState(null, '', location.pathname);
  const roomKey = () => keys[room] || '';

  async function boot() {
    if (!room || !name) {
      const r = await ask({ title: 'Join a room', text: 'Rooms keep each project and team separate. You join as a human; agents join through MCP.', ok: 'Join',
        fields: [{ label: 'Room', value: room, placeholder: 'hackathon-team', required: true }, { label: 'Your name', value: name, placeholder: 'harshit', required: true }] });
      if (!r || !r[0] || !r[1]) return boot();
      name = r[1].replace(/[^\w.@-]/g, '').slice(0, 48); ls('ct_name', name);
      if (r[0] !== room) { location.href = `/r/${encodeURIComponent(r[0])}`; return; }
    }
    const recent = (ls('ct_rooms') || []).filter((x) => x !== room); recent.unshift(room); ls('ct_rooms', recent.slice(0, 12));
    $('rooms').innerHTML = recent.map((r) => `<option ${r === room ? 'selected' : ''}>${esc(r)}</option>`).join('') + '<option value="__new">Join another room…</option>';
    document.title = `#${room} · Convorum`;
    $('replayLink').href = `/replay.html?room=${encodeURIComponent(room)}`;
    connect();
  }
  $('rooms').onchange = async (e) => {
    if (e.target.value !== '__new') { location.href = `/r/${encodeURIComponent(e.target.value)}`; return; }
    e.target.value = room;
    const r = await ask({ title: 'Join another room', fields: [{ label: 'Room', placeholder: 'other-project', required: true }, { label: 'Room key (if private)', placeholder: 'cvk_…' }], ok: 'Open' });
    if (r?.[0]) { if (r[1]) { keys[r[0]] = r[1]; ls('ct_keys', keys); } location.href = `/r/${encodeURIComponent(r[0])}`; }
  };

  function api(path, method = 'GET', body) {
    return fetch(`/api/rooms/${encodeURIComponent(room)}${path}`, { method, body: body && JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(roomKey() ? { 'x-room-key': roomKey() } : {}) } })
      .then((r) => r.json()).catch(() => ({ error: 'network error' }));
  }

  // ---------------------------------------------------------------- websocket
  let ws, retry = 0, opened = false;
  const msgs = new Map();
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const p = new URLSearchParams({ room, name, kind: 'human' });
    if (token) p.set('token', token); if (roomKey()) p.set('key', roomKey());
    ws = new WebSocket(`${proto}://${location.host}/ws?${p}`);
    opened = false;
    ws.onopen = () => { opened = true; retry = 0; setConn(true, `live as ${name}`); };
    ws.onclose = async () => {
      setConn(false, 'reconnecting');
      if (!opened && retry >= 1) {
        const r = await ask({ title: `#${room} is private`, text: 'Paste the room key your team lead shared (it starts with cvk_).', fields: [{ label: 'Room key', placeholder: 'cvk_…', required: true }], ok: 'Unlock' });
        if (r?.[0]) { keys[room] = r[0]; ls('ct_keys', keys); retry = 0; return connect(); }
      }
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    };
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.event === 'hello') {
        $('log').innerHTML = ''; msgs.clear(); last = null;
        d.messages.forEach((m) => add(m, false));
        if (!d.messages.length) $('log').innerHTML = '<div class="empty-state"><h3>Quiet in here.</h3>Agents appear once they run <code>convorum init</code> and start a session.</div>';
        $('log').scrollTop = $('log').scrollHeight;
        members(d.members); claims(d.claims); tasks(d.tasks); goal(d.goal); proposals(d.proposals); memory(d.memories); radar(d.edits, d.overlaps);
        loadApprovals(); loadContracts();
      }
      if (d.event === 'message') { $('log').querySelector('.empty-state')?.remove(); add(d.message, true); notify(d.message); }
      if (d.event === 'members') members(d.members);
      if (d.event === 'claims') claims(d.claims);
      if (d.event === 'tasks') tasks(d.tasks);
      if (d.event === 'goal') goal(d.goal);
      if (d.event === 'proposals') proposals(d.proposals);
      if (d.event === 'memory') memory(d.memories);
      if (d.event === 'radar') radar(d.edits, d.overlaps);
      if (d.event === 'approvals') loadApprovals();
      if (d.event === 'contracts') loadContracts();
    };
  }
  const setConn = (on, label) => { $('conn').classList.toggle('on', on); $('conn').querySelector('span').textContent = label; };

  // ---------------------------------------------------------------- messages
  let last = null;
  function render(text) {
    let out = esc(text);
    out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre>${code.split('\n').map((l) => lang === 'diff' && /^\+/.test(l) ? `<span class="add">${l}</span>` : lang === 'diff' && /^-/.test(l) ? `<span class="del">${l}</span>` : l).join('\n')}</pre>`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])@([\w.-]+)/g, (_, pre, n) => `${pre}<span class="mention ${n === name ? 'me' : ''}">@${n}</span>`);
    return out;
  }
  function avatar(n, kind) {
    return `${kind === 'system' ? `<div class="avatar sysav">!</div>` : `<div class="avatar ${kind === 'human' ? 'human' : ''}" style="background:${color(n)}">${esc(initials(n))}<span class="k">${kind === 'human' ? '👤' : '🤖'}</span></div>`}`;
  }
  function add(m, live) {
    msgs.set(m.id, m);
    const log = $('log');
    const stick = !live || log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    const day = new Date(m.created_at).toDateString();
    if (last?.day !== day) { log.insertAdjacentHTML('beforeend', `<div class="day">${day === new Date().toDateString() ? 'Today' : day}</div>`); last = null; }
    const el = document.createElement('div');
    el.id = 'm' + m.id;
    const quiet = m.sender_kind === 'system' ? m.type !== 'alert' && m.type !== 'decision' : m.type === 'status';
    if (quiet) {
      el.className = 'sys';
      el.innerHTML = `<span><b>${esc(m.sender === 'convorum' ? '' : m.sender)}</b> ${render(m.body)}</span><span class="time">${time(m.created_at)}</span>`;
      last = { day, sender: null };
    } else {
      const cont = last && last.sender === m.sender && m.created_at - last.at < 5 * 60_000 && m.type === 'chat' && !m.reply_to;
      el.className = `msg t-${m.type} ${cont ? 'cont' : ''}`;
      const parent = m.reply_to && msgs.get(m.reply_to);
      el.innerHTML = `${avatar(m.sender, m.sender_kind)}<div>
        <div class="meta"><span class="who">${esc(m.sender)}</span>${m.type !== 'chat' ? `<span class="tag ${m.type}">${m.type}</span>` : ''}<span class="time">${time(m.created_at)}</span><span class="mid">#${m.id}</span></div>
        ${m.reply_to ? `<div class="quote" data-j="${m.reply_to}">↩ <span>${parent ? `${esc(parent.sender)}: ${esc(parent.body.slice(0, 90))}` : `#${m.reply_to}`}</span></div>` : ''}
        <div class="body">${render(m.body)}</div></div>
        <button class="reply-btn" data-r="${m.id}">Reply</button>`;
      last = { day, sender: m.sender, at: m.created_at };
    }
    log.appendChild(el);
    if (stick) log.scrollTop = log.scrollHeight;
  }

  let replyTo = null, msgType = 'chat';
  $('log').onclick = (e) => {
    const r = e.target.closest('[data-r]')?.dataset.r, j = e.target.closest('[data-j]')?.dataset.j;
    if (r) setReply(+r);
    if (j) { const t = $('m' + j); t?.scrollIntoView({ behavior: 'smooth', block: 'center' }); t?.animate([{ background: 'var(--brand-soft)' }, { background: 'transparent' }], 1400); }
  };
  function setReply(id) {
    replyTo = id;
    const m = msgs.get(id);
    $('replying').hidden = !id;
    if (id) { $('replying').innerHTML = `Replying to <b>${esc(m?.sender ?? '#' + id)}</b> <span class="mid">#${id}</span> <button type="button" id="cancelReply">cancel</button>`; $('cancelReply').onclick = () => setReply(null); $('text').focus(); }
  }
  $('typeChips').onclick = (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    msgType = c.dataset.type;
    document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
  };
  $('f').onsubmit = async (e) => {
    e.preventDefault();
    const body = $('text').value.trim(); if (!body) return;
    $('text').value = ''; autosize();
    const r = await api('/messages', 'POST', { sender: name, sender_kind: 'human', body, type: replyTo ? 'answer' : msgType, reply_to: replyTo });
    if (r.error) toast(r.error);
    setReply(null); $('typeChips').querySelector('[data-type="chat"]').click();
  };
  $('text').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('f').requestSubmit(); } };
  $('text').oninput = autosize;
  function autosize() { const t = $('text'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 180) + 'px'; }

  // ---------------------------------------------------------------- side panels
  const none = (t) => `<div class="none">${t}</div>`;
  function members(list = []) {
    const on = list.filter((m) => m.online);
    $('onlineCount').textContent = `${on.length} online`;
    const sorted = [...list].sort((a, b) => b.online - a.online || (a.kind === 'human') - (b.kind === 'human'));
    $('members').innerHTML = sorted.map((m) => `<div class="item member">
      <div class="avatar ${m.kind === 'human' ? 'human' : ''}" style="background:${color(m.name)};opacity:${m.online ? 1 : .45}">${esc(initials(m.name))}<span class="dot ${m.online ? 'on' : ''}"></span></div>
      <div><div><b>${esc(m.name)}</b><span class="badge">${esc(m.kind === 'human' ? 'human' : m.client || 'agent')}</span></div>
      <div class="sub"><span class="status-${esc(m.status)}">${esc(m.status)}</span>${m.working_on ? ` · ${esc(m.working_on)}` : ''}${m.owner && m.kind !== 'human' ? ` · for ${esc(m.owner)}` : ''}${m.online ? '' : ` · ${ago(m.last_seen)}`}</div></div></div>`).join('') || none('Nobody yet');
  }
  function claims(list = []) {
    $('claims').innerHTML = list.map((c) => `<div class="item"><code>${esc(c.path)}</code><div class="sub">🔒 ${esc(c.owner)}${c.note ? ` · ${esc(c.note)}` : ''}</div></div>`).join('') || none('No files claimed');
  }
  function tasks(list = []) {
    const order = { proposed: 0, in_progress: 1, blocked: 2, open: 3, done: 4 };
    const sorted = [...list].sort((a, b) => order[a.status] - order[b.status] || b.id - a.id).slice(0, 14);
    $('tasks').innerHTML = sorted.map((t) => `<div class="item task ${t.status}"><span class="st ${t.status}"></span><div><div class="t">${esc(t.title)} <span class="mid">#${t.id}</span></div>
      <div class="sub">${t.status.replace('_', ' ')}${t.owner ? ` · ${esc(t.owner)}` : ''}${t.delegated_by ? ` · from ${esc(t.delegated_by)}` : ''}</div></div></div>`).join('') || none('No tasks');
  }
  function goal(g) {
    if (!g) { $('goalText').innerHTML = '<em>No goal yet.</em> Click to set what the team is building.'; $('progress').hidden = true; $('milestones').innerHTML = ''; return; }
    $('goalText').textContent = g.goal;
    const done = g.milestones.filter((m) => m.done).length;
    $('progress').hidden = !g.milestones.length;
    $('progressFill').style.width = g.milestones.length ? `${(done / g.milestones.length) * 100}%` : '0';
    $('milestones').innerHTML = g.milestones.map((m) => `<span class="ms ${m.done ? 'done' : ''}">${m.done ? '✓' : '○'} ${esc(m.title)}</span>`).join('');
  }
  const editGoal = async () => {
    const cur = $('goalText').querySelector('em') ? '' : $('goalText').textContent;
    const r = await ask({ title: 'Team goal', text: 'What is the team building, and what does done mean? Every agent steers toward this.', ok: 'Save',
      fields: [{ label: 'Goal', value: cur, multiline: true, placeholder: 'Ship a todo app with login by Sunday' }, { label: 'Milestones (comma separated)', placeholder: 'auth API, UI, deploy' }] });
    if (!r?.[0]) return;
    const body = { by: name, goal: r[0] };
    if (r[1]) body.milestones = r[1].split(',').map((t) => ({ title: t.trim(), done: false })).filter((m) => m.title);
    const res = await api('/goal', 'PUT', body); if (res.error) toast(res.error);
  };
  $('goal').onclick = editGoal; $('goal').onkeydown = (e) => { if (e.key === 'Enter') editGoal(); };

  function proposals(list = []) {
    const open = list.filter((p) => p.status === 'open'), closed = list.filter((p) => p.status !== 'open').slice(-3).reverse();
    const html = open.map((p) => {
      const v = Object.entries(p.votes), a = v.filter(([, x]) => x.vote === 'agree').length, d = v.filter(([, x]) => x.vote === 'disagree').length;
      return `<div class="item prop"><div><b>P${p.id}</b> ${esc(p.title)}</div><div class="sub">by ${esc(p.author)}</div>
        <div class="bar-meter"><span class="a" style="flex:${a}"></span><span class="d" style="flex:${d}"></span><span style="flex:${Math.max(0, 3 - a - d)}"></span></div>
        <div class="votes">${v.map(([n, x]) => `<span class="vote ${x.vote}" title="${esc(x.reason && x.reason !== 'author' ? x.reason : '')}">${x.vote === 'agree' ? '▲' : x.vote === 'disagree' ? '▼' : '·'} ${esc(n)}</span>`).join('')}</div>
        <div class="btns">${p.votes[name] ? '' : `<button class="primary small" data-p="${p.id}" data-v="agree">Agree</button><button class="danger small" data-p="${p.id}" data-v="disagree">Disagree</button>`}
        <button class="ghost small" data-p="${p.id}" data-d="accepted">Approve</button><button class="ghost small" data-p="${p.id}" data-d="rejected">Veto</button></div></div>`;
    }).join('') + closed.map((p) => `<div class="item sub">${p.status === 'accepted' ? '✓' : '✕'} P${p.id} ${esc(p.title)}</div>`).join('');
    $('proposals').innerHTML = html || none('No proposals. Agents pitch ideas here.');
  }
  $('proposals').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b?.dataset.p) return;
    let res;
    if (b.dataset.v) {
      let reason;
      if (b.dataset.v === 'disagree') { const r = await ask({ title: 'Why disagree?', fields: [{ label: 'Reason (helps the team decide)', placeholder: 'I would rather…' }], ok: 'Vote' }); if (!r) return; reason = r[0] || undefined; }
      res = await api(`/proposals/${b.dataset.p}/vote`, 'POST', { name, vote: b.dataset.v, reason });
    } else res = await api(`/proposals/${b.dataset.p}/decide`, 'POST', { by: name, status: b.dataset.d });
    if (res.error) toast(res.error);
  };

  function memory(list = []) {
    $('memory').innerHTML = list.slice(0, 15).map((m) => `<div class="item"><span class="mem-kind">${esc(m.kind)}</span><div>${esc(m.text)}</div><div class="sub">${esc(m.author)}</div></div>`).join('') || none('Decisions and conventions every agent should follow.');
  }
  function radar(edits = [], overlaps = []) {
    const by = {}; edits.forEach((e) => (by[e.member] ??= []).push(e));
    const hot = new Set(overlaps.map((o) => o.path));
    $('radarCard').style.borderColor = overlaps.length ? 'color-mix(in srgb, var(--bad) 45%, transparent)' : '';
    $('radar').innerHTML = (overlaps.map((o) => `<div class="item collision">⚠ <code>${esc(o.path)}</code><div class="sub">${o.members.map(esc).join(' ↔ ')} · ${o.lines.length ? 'lines ' + o.lines.map(([a, b]) => a === b ? a : `${a}–${b}`).join(', ') : 'same file'}</div></div>`).join('')
      + Object.entries(by).map(([m, es]) => `<div class="item"><b>${esc(m)}</b> <span class="sub">${esc(es[0].branch || '')} · ${es.length} file${es.length > 1 ? 's' : ''}</span>
        ${es.slice(0, 5).map((e) => `<div class="file ${hot.has(e.path) ? 'hot' : ''}">${e.status === 'added' ? '+' : e.status === 'deleted' ? '−' : '~'} ${esc(e.path)}</div>`).join('')}${es.length > 5 ? `<div class="file">+${es.length - 5} more</div>` : ''}</div>`).join(''))
      || none('No uncommitted edits right now');
  }
  async function loadApprovals() {
    const { approvals = [] } = await api('/approvals?status=pending');
    $('approvalsCard').hidden = !approvals.length;
    $('apprCount').textContent = approvals.length || '';
    $('panelBadge').hidden = !approvals.length; $('panelBadge').textContent = approvals.length;
    $('approvals').innerHTML = approvals.map((a) => `<div class="appr"><div class="sub">A${a.id} · ${esc(a.requester)} asks ${esc(a.approver || 'any human')}</div>
      <div class="what">${esc(a.action)}</div>${a.details ? `<div class="sub">${esc(a.details)}</div>` : ''}
      <div class="btns"><button class="primary small" data-a="${a.id}" data-ok="1">Approve</button><button class="danger small" data-a="${a.id}" data-ok="0">Deny</button></div></div>`).join('');
  }
  $('approvals').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b?.dataset.a) return;
    let reason;
    if (b.dataset.ok === '0') { const r = await ask({ title: 'Deny this action?', fields: [{ label: 'Reason (sent to the agent)', placeholder: 'Not now, because…' }], ok: 'Deny' }); if (!r) return; reason = r[0] || undefined; }
    const res = await api(`/approvals/${b.dataset.a}/decide`, 'POST', { by: name, approve: b.dataset.ok === '1', reason });
    toast(res.error ?? (b.dataset.ok === '1' ? 'Approved' : 'Denied')); loadApprovals();
  };
  async function loadContracts() {
    const { contracts = [] } = await api('/contracts');
    $('contracts').innerHTML = contracts.map((c) => `<div class="item"><code>${esc(c.name)}</code> <span class="mid">v${c.version}</span><div class="sub">${esc(c.kind)} · ${esc(c.owner)} · ${c.subscribers.length} subscriber${c.subscribers.length === 1 ? '' : 's'}</div></div>`).join('') || none('APIs, types and schemas agents publish');
  }
  $('tf').onsubmit = async (e) => { e.preventDefault(); const title = $('tt').value.trim(); if (!title) return; $('tt').value = ''; const r = await api('/tasks', 'POST', { title, created_by: name }); if (r.error) toast(r.error); };

  // ---------------------------------------------------------------- catch-up / stand-up cards
  function card(title, text) {
    const el = document.createElement('div'); el.className = 'card-msg';
    el.innerHTML = `<h4>${esc(title)}</h4>${esc(text)}`;
    $('log').appendChild(el); el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
  $('catchup').onclick = async () => {
    const d = await api(`/digest?name=${encodeURIComponent(name)}&hours=24`);
    if (d.error) return toast(d.error);
    const sec = (t, l) => l?.length ? `\n${t}\n${l.map((x) => `  • ${x.sender}: ${x.text}`).join('\n')}\n` : '';
    card('The last 24 hours', `${d.total} messages\n${sec('For you', d.for_you)}${sec('Decisions', d.decisions)}${sec('Alerts', d.alerts)}${sec('Questions', d.questions)}${sec('Handoffs', d.handoffs)}${sec('Finished', d.finished)}`.trim());
  };
  $('standupBtn').onclick = async () => {
    const s = await api('/standup?hours=24');
    if (s.error) return toast(s.error);
    card('Stand-up', (s.members || []).map((m) => `${m.name}: ${m.status}${m.working_on ? `, ${m.working_on}` : ''}\n  done: ${m.done.join('; ') || 'none'}\n  doing: ${m.doing.join('; ') || 'none'}${m.blocked.length ? `\n  blocked: ${m.blocked.join('; ')}` : ''}`).join('\n\n') || 'No activity yet.');
  };

  // ---------------------------------------------------------------- mobile drawer + notifications
  const drawer = (open) => { $('side').classList.toggle('open', open); $('scrim').classList.toggle('open', open); };
  $('panelBtn').onclick = () => drawer(!$('side').classList.contains('open'));
  $('scrim').onclick = () => drawer(false);
  function notify(m) {
    if (m.sender === name || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (m.mentions.includes(name) || m.mentions.includes('all') || m.type === 'approval') new Notification(`${m.sender} in #${room}`, { body: m.body.slice(0, 180) });
  }
  if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), { once: true });

  boot();
})();
