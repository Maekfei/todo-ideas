/* ============================================================
   FLOW BOARD — App Logic
   - State: items[] = { id, title, note, status, tag, priority, due, createdAt, updatedAt, completedAt }
   - Storage: localStorage (always) + optional GitHub Issues sync
   - Drag & Drop, Search, Filter, Stats, Theme
   ============================================================ */

(() => {
  'use strict';

  // ============ STATE ============
  const STORAGE_KEY  = 'flowboard.items.v1';
  const SETTINGS_KEY = 'flowboard.settings.v1';
  const THEME_KEY    = 'flowboard.theme';

  let items = [];
  let settings = { token: '', repo: '' };
  let filter = { tag: '', priority: '', search: '' };
  let editingId = null;

  // ============ UTIL ============
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const uid = () => 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = () => new Date().toISOString();
  const todayStr = () => new Date().toISOString().slice(0, 10);

  const tagClassMap = { '工作': 't-work', '学习': 't-learn', '生活': 't-life', '项目': 't-project' };
  const tagEmojiMap = { '工作': '💼', '学习': '📚', '生活': '🌿', '项目': '🚀' };

  function toast(msg, ms = 1800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ============ STORAGE ============
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      items = raw ? JSON.parse(raw) : [];
    } catch { items = []; }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) settings = { ...settings, ...JSON.parse(raw) };
    } catch {}
  }
  function saveLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }
  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  // ============ CRUD ============
  function addItem({ title, status = 'idea', tag = '', priority = '', due = '' }) {
    if (!title || !title.trim()) return null;
    const item = {
      id: uid(),
      title: title.trim(),
      note: '',
      status,
      tag, priority, due,
      createdAt: now(),
      updatedAt: now(),
      completedAt: status === 'done' ? now() : ''
    };
    items.unshift(item);
    saveLocal();
    render();
    return item;
  }

  function updateItem(id, patch) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    const wasDone = it.status === 'done';
    Object.assign(it, patch, { updatedAt: now() });
    const isDone = it.status === 'done';
    if (!wasDone && isDone) it.completedAt = now();
    if (wasDone && !isDone) it.completedAt = '';
    saveLocal();
    render();
  }

  function deleteItem(id) {
    items = items.filter(x => x.id !== id);
    saveLocal();
    render();
  }

  // ============ FILTER & RENDER ============
  function passesFilter(it) {
    if (filter.tag && it.tag !== filter.tag) return false;
    if (filter.priority && it.priority !== filter.priority) return false;
    if (filter.search) {
      const q = filter.search.toLowerCase();
      if (!(it.title.toLowerCase().includes(q) ||
            (it.note || '').toLowerCase().includes(q) ||
            (it.tag || '').toLowerCase().includes(q))) return false;
    }
    return true;
  }

  function render() {
    ['idea', 'todo', 'done'].forEach(status => {
      const col = document.querySelector(`.col-body[data-drop="${status}"]`);
      const list = items.filter(it => it.status === status && passesFilter(it));
      // sort: priority desc, then due date asc, then createdAt desc
      const prioRank = { high: 3, mid: 2, low: 1, '': 0 };
      list.sort((a, b) => {
        const pa = prioRank[a.priority] || 0, pb = prioRank[b.priority] || 0;
        if (pa !== pb) return pb - pa;
        if (a.due && b.due) return a.due.localeCompare(b.due);
        if (a.due) return -1;
        if (b.due) return 1;
        return b.createdAt.localeCompare(a.createdAt);
      });

      col.innerHTML = '';
      if (list.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'empty-hint';
        hint.textContent = status === 'idea' ? '✨ 添加第一个灵感'
                         : status === 'todo' ? '🎯 把灵感拖到这里'
                         : '🏁 完成的任务会出现在这里';
        col.appendChild(hint);
      } else {
        list.forEach(it => col.appendChild(renderCard(it)));
      }

      const cnt = document.querySelector(`[data-count="${status}"]`);
      if (cnt) cnt.textContent = list.length;
    });
  }

  function renderCard(it) {
    const card = document.createElement('div');
    card.className = 'card' + (it.status === 'done' ? ' done' : '');
    card.draggable = true;
    card.dataset.id = it.id;

    if (it.priority) {
      const bar = document.createElement('div');
      bar.className = 'card-priority-bar ' + it.priority;
      card.appendChild(bar);
    }

    // actions
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    if (it.status === 'idea') {
      actions.appendChild(makeAction('⬆️', '提升为 Todo', () => updateItem(it.id, { status: 'todo' })));
    }
    if (it.status === 'todo') {
      actions.appendChild(makeAction('✓', '标记完成', () => updateItem(it.id, { status: 'done' })));
    }
    if (it.status === 'done') {
      actions.appendChild(makeAction('↩️', '退回 Todo', () => updateItem(it.id, { status: 'todo' })));
    }
    actions.appendChild(makeAction('✏️', '编辑', () => openEdit(it.id)));
    actions.appendChild(makeAction('🗑️', '删除', () => {
      if (confirm('确定删除？')) deleteItem(it.id);
    }));
    card.appendChild(actions);

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = it.title;
    card.appendChild(title);

    if (it.note) {
      const note = document.createElement('p');
      note.className = 'card-note';
      note.textContent = it.note.length > 140 ? it.note.slice(0, 140) + '…' : it.note;
      card.appendChild(note);
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    if (it.tag) {
      const tag = document.createElement('span');
      tag.className = 'card-tag ' + (tagClassMap[it.tag] || '');
      tag.textContent = (tagEmojiMap[it.tag] || '🏷️') + ' ' + it.tag;
      meta.appendChild(tag);
    }
    if (it.due) {
      const due = document.createElement('span');
      due.className = 'card-due';
      const today = todayStr();
      if (it.status !== 'done') {
        if (it.due < today) due.classList.add('overdue');
        else if (it.due === today) due.classList.add('today');
      }
      due.textContent = '📅 ' + it.due;
      meta.appendChild(due);
    }
    if (meta.children.length > 0) card.appendChild(meta);

    // double click to edit
    card.addEventListener('dblclick', () => openEdit(it.id));

    // drag handlers
    card.addEventListener('dragstart', e => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', it.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    return card;
  }

  function makeAction(emoji, title, onClick) {
    const b = document.createElement('button');
    b.className = 'card-action';
    b.title = title;
    b.textContent = emoji;
    b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    return b;
  }

  // ============ DRAG & DROP ============
  function setupDnD() {
    $$('.col-body').forEach(col => {
      col.addEventListener('dragover', e => {
        e.preventDefault();
        col.classList.add('drag-over');
        e.dataTransfer.dropEffect = 'move';
      });
      col.addEventListener('dragleave', e => {
        if (e.target === col) col.classList.remove('drag-over');
      });
      col.addEventListener('drop', e => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        const newStatus = col.dataset.drop;
        const it = items.find(x => x.id === id);
        if (it && it.status !== newStatus) {
          updateItem(id, { status: newStatus });
          toast(`移动到 ${newStatus === 'idea' ? '💡 Ideas' : newStatus === 'todo' ? '✅ Todos' : '🎉 Done'}`);
        }
      });
    });
  }

  // ============ QUICK ADD ============
  function setupQuickAdd() {
    const input = $('#quick-input');
    const tag = $('#quick-tag');
    const prio = $('#quick-priority');
    const due = $('#quick-due');

    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const status = e.shiftKey ? 'todo' : 'idea';
      const ok = addItem({
        title: input.value, status,
        tag: tag.value, priority: prio.value, due: due.value
      });
      if (ok) {
        input.value = ''; tag.value = ''; prio.value = ''; due.value = '';
        toast(status === 'idea' ? '💡 灵感已记录' : '✅ 任务已添加');
      }
    });
  }

  // ============ FILTERS & SEARCH ============
  function setupFilters() {
    $$('.filter-group').forEach(group => {
      const key = group.dataset.key;
      group.addEventListener('click', e => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        filter[key] = btn.dataset.value;
        render();
      });
    });

    let st;
    $('#search').addEventListener('input', e => {
      clearTimeout(st);
      st = setTimeout(() => {
        filter.search = e.target.value.trim();
        render();
      }, 120);
    });
  }

  // ============ EDIT MODAL ============
  function openEdit(id) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    editingId = id;
    $('#edit-title').value = it.title;
    $('#edit-note').value = it.note || '';
    $('#edit-tag').value = it.tag || '';
    $('#edit-priority').value = it.priority || '';
    $('#edit-due').value = it.due || '';
    $('#edit-modal').classList.remove('hidden');
    setTimeout(() => $('#edit-title').focus(), 50);
  }
  function closeEdit() {
    editingId = null;
    $('#edit-modal').classList.add('hidden');
  }
  function setupEditModal() {
    $('#edit-save').addEventListener('click', () => {
      if (!editingId) return;
      const title = $('#edit-title').value.trim();
      if (!title) { toast('标题不能为空'); return; }
      updateItem(editingId, {
        title,
        note: $('#edit-note').value,
        tag: $('#edit-tag').value,
        priority: $('#edit-priority').value,
        due: $('#edit-due').value
      });
      closeEdit();
      toast('✅ 已保存');
    });
    $('#edit-delete').addEventListener('click', () => {
      if (!editingId) return;
      if (confirm('确定删除？')) { deleteItem(editingId); closeEdit(); toast('🗑️ 已删除'); }
    });
  }

  // ============ MODAL UTILS ============
  function setupModals() {
    $$('[data-close]').forEach(b => {
      b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden'));
    });
    $$('.modal').forEach(m => {
      m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') $$('.modal').forEach(m => m.classList.add('hidden'));
    });
  }

  // ============ STATS ============
  function openStats() {
    const ideas = items.filter(x => x.status === 'idea').length;
    const todos = items.filter(x => x.status === 'todo').length;
    const done  = items.filter(x => x.status === 'done').length;
    const total = ideas + todos + done;
    const rate  = total === 0 ? 0 : Math.round(done / total * 100);
    $('#s-ideas').textContent = ideas;
    $('#s-todos').textContent = todos;
    $('#s-done').textContent  = done;
    $('#s-rate').textContent  = rate + '%';

    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    $('#s-week-new').textContent  = items.filter(x => x.createdAt > weekAgo).length;
    $('#s-week-done').textContent = items.filter(x => x.completedAt && x.completedAt > weekAgo).length;

    // 14-day activity heat
    const chart = $('#activity-chart');
    chart.innerHTML = '';
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const ds = d.toISOString().slice(0, 10);
      const cnt = items.filter(x =>
        (x.createdAt || '').slice(0, 10) === ds ||
        (x.completedAt || '').slice(0, 10) === ds
      ).length;
      const lvl = cnt === 0 ? 0 : cnt < 2 ? 1 : cnt < 4 ? 2 : cnt < 7 ? 3 : 4;
      const cell = document.createElement('div');
      cell.className = 'activity-day';
      cell.dataset.level = lvl;
      cell.title = `${ds}: ${cnt} 项活动`;
      chart.appendChild(cell);
    }
    $('#stats-modal').classList.remove('hidden');
  }

  // ============ THEME ============
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('#theme-btn').textContent = t === 'dark' ? '☀️' : '🌙';
  }
  function setupTheme() {
    const saved = localStorage.getItem(THEME_KEY)
              || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(saved);
    $('#theme-btn').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, cur);
      applyTheme(cur);
    });
  }

  // ============ GITHUB SYNC (Issues as DB) ============
  // Strategy: a single Issue with title "flowboard:data" stores all items as JSON in body.
  const SYNC_TITLE = 'flowboard:data';

  async function ghReq(path, opts = {}) {
    if (!settings.token) throw new Error('未配置 GitHub Token');
    const res = await fetch('https://api.github.com' + path, {
      ...opts,
      headers: {
        'Authorization': 'token ' + settings.token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub API ${res.status}: ${txt.slice(0, 200)}`);
    }
    return res.json();
  }

  async function findSyncIssue() {
    const issues = await ghReq(`/repos/${settings.repo}/issues?state=all&per_page=100`);
    return issues.find(i => i.title === SYNC_TITLE);
  }

  async function pushToCloud() {
    if (!settings.token || !settings.repo) { toast('请先在 ⚙️ 设置中配置'); return; }
    try {
      toast('☁️ 推送中...');
      const body = '```json\n' + JSON.stringify(items, null, 2) + '\n```';
      let issue = await findSyncIssue();
      if (issue) {
        await ghReq(`/repos/${settings.repo}/issues/${issue.number}`, {
          method: 'PATCH', body: JSON.stringify({ body })
        });
      } else {
        await ghReq(`/repos/${settings.repo}/issues`, {
          method: 'POST', body: JSON.stringify({ title: SYNC_TITLE, body })
        });
      }
      toast('☁️ 已推送到云端');
    } catch (e) { toast('❌ ' + e.message, 3500); }
  }

  async function pullFromCloud() {
    if (!settings.token || !settings.repo) { toast('请先在 ⚙️ 设置中配置'); return; }
    try {
      toast('☁️ 拉取中...');
      const issue = await findSyncIssue();
      if (!issue) { toast('☁️ 云端无数据'); return; }
      const m = (issue.body || '').match(/```json\n([\s\S]*?)\n```/);
      if (!m) { toast('☁️ 云端数据格式异常'); return; }
      const cloud = JSON.parse(m[1]);
      if (!Array.isArray(cloud)) throw new Error('数据非数组');
      // merge: cloud wins by updatedAt
      const map = new Map(items.map(x => [x.id, x]));
      cloud.forEach(c => {
        const local = map.get(c.id);
        if (!local || (c.updatedAt || '') >= (local.updatedAt || '')) {
          map.set(c.id, c);
        }
      });
      items = Array.from(map.values());
      saveLocal();
      render();
      toast('☁️ 已从云端同步 ' + cloud.length + ' 项');
    } catch (e) { toast('❌ ' + e.message, 3500); }
  }

  function setupSettings() {
    $('#settings-btn').addEventListener('click', () => {
      $('#cfg-token').value = settings.token || '';
      $('#cfg-repo').value  = settings.repo  || 'Maekfei/todo-ideas';
      $('#cfg-status').textContent = settings.token ? '✅ 已配置' : '尚未配置';
      $('#settings-modal').classList.remove('hidden');
    });
    $('#cfg-save').addEventListener('click', () => {
      settings.token = $('#cfg-token').value.trim();
      settings.repo  = $('#cfg-repo').value.trim();
      saveSettings();
      $('#cfg-status').textContent = '✅ 已保存';
      toast('设置已保存');
    });
    $('#cfg-pull').addEventListener('click', pullFromCloud);
    $('#cfg-push').addEventListener('click', pushToCloud);
    $('#sync-btn').addEventListener('click', async () => {
      if (!settings.token) { $('#settings-btn').click(); return; }
      // sync: pull then push
      await pullFromCloud();
      await pushToCloud();
    });
  }

  // ============ STATS BUTTON ============
  function setupStatsBtn() {
    $('#stats-btn').addEventListener('click', openStats);
  }

  // ============ INIT ============
  function seedIfEmpty() {
    if (items.length > 0) return;
    items = [
      { id: uid(), title: '👋 欢迎使用 Flow Board！', note: '在顶部输入框写下任何想法。Enter = 灵感，Shift+Enter = 直接成为 todo。',
        status: 'idea', tag: '', priority: '', due: '',
        createdAt: now(), updatedAt: now(), completedAt: '' },
      { id: uid(), title: '🎯 试试拖拽这张卡片到 Todos 列', note: '拖拽是最快的工作流。',
        status: 'idea', tag: '项目', priority: 'mid', due: '',
        createdAt: now(), updatedAt: now(), completedAt: '' },
      { id: uid(), title: '☁️ 在 ⚙️ 设置里配置 GitHub Token，开启多设备同步',
        note: '数据存到 GitHub Issue，私有仓库最佳。',
        status: 'todo', tag: '工作', priority: 'high', due: '',
        createdAt: now(), updatedAt: now(), completedAt: '' }
    ];
    saveLocal();
  }

  function init() {
    loadLocal();
    seedIfEmpty();
    setupTheme();
    setupQuickAdd();
    setupFilters();
    setupDnD();
    setupEditModal();
    setupModals();
    setupSettings();
    setupStatsBtn();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
