/* ============================================================
   FLOW BOARD v2 — App Logic
   Features: CRUD, drag-drop with placeholder, undo, autosync,
             today view, repeat tasks, custom tags, markdown notes,
             import/export, keyboard shortcuts, PWA-ready
   ============================================================ */

(() => {
  'use strict';

  // ============ KEYS & STATE ============
  const STORAGE_KEY  = 'flowboard.items.v2';
  const SETTINGS_KEY = 'flowboard.settings.v2';
  const THEME_KEY    = 'flowboard.theme';
  const TAGS_KEY     = 'flowboard.tags.v2';
  const COLLAPSE_KEY = 'flowboard.done_collapsed';

  const DEFAULT_TAGS = [
    { name: '工作', emoji: '💼' },
    { name: '学习', emoji: '📚' },
    { name: '生活', emoji: '🌿' },
    { name: '项目', emoji: '🚀' }
  ];

  let items = [];           // includes tombstones (deleted: true)
  let tags = [];
  let settings = { token: '', repo: '', autosync: false };
  let filter = { tag: '', priority: '', search: '' };
  let editingId = null;
  let undoStack = [];       // last operations for undo

  // ============ AI CLASSIFIER (Yunwu / DeepSeek) ============
  const AI_CONFIG = {
    endpoint: 'https://yunwu.ai/v1/chat/completions',
    apiKey:   'sk-NQ9p5vJPaw7MQDDxYbtRglNVw1jSotR9Dhj6ObAnT2JZKII6',
    model:    'deepseek-v4-flash',
    timeoutMs: 12000
  };
  const AI_SYSTEM_PROMPT = '你是一个分类器。判断用户输入是 todo（待办）还是 idea（想法/灵感）。todo 是具体可执行的行动（买东西、约会、回邮件、修 bug 等）；idea 是需要思考、探索、未成型的点子或愿望（"做一个 XX"、"如果 XX 会怎样"、"研究一下 XX"）。只输出严格 JSON：{"type":"todo"|"idea","confidence":0-1,"reason":"简短中文理由(不超过20字)"}';

  /**
   * Classify a free-form text input as 'todo' or 'idea' via the Yunwu LLM API.
   * Falls back to a tiny local heuristic when network/parse fails.
   * @returns {Promise<{type:'todo'|'idea', confidence:number, reason:string, source:'ai'|'fallback'}>}
   */
  async function classifyWithAI(text) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_CONFIG.timeoutMs);
    try {
      const res = await fetch(AI_CONFIG.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + AI_CONFIG.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: AI_CONFIG.model,
          messages: [
            { role: 'system', content: AI_SYSTEM_PROMPT },
            { role: 'user',   content: text }
          ],
          max_tokens: 300,
          response_format: { type: 'json_object' }
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(content);
      const type = parsed.type === 'todo' ? 'todo' : 'idea';
      const conf = typeof parsed.confidence === 'number' ? parsed.confidence : 0.7;
      return { type, confidence: conf, reason: parsed.reason || '', source: 'ai' };
    } catch (err) {
      clearTimeout(timer);
      console.warn('[AI classify failed, using local fallback]', err);
      return { ...localHeuristicClassify(text), source: 'fallback' };
    }
  }

  /** Tiny rule-based fallback so the app always works offline / on API failure. */
  function localHeuristicClassify(text) {
    const t = (text || '').trim().toLowerCase();
    const todoHints = /(买|打|发|写|交|提交|回复|约|预约|联系|开会|开始|完成|修复|修一下|修复|订|订票|订机票|报名|续|续费|续约|读完|看完|提交|提交一下|安排|安排一下|today|tomorrow|明天|今天|后天|本周|下周|周一|周二|周三|周四|周五|周六|周日|截止|deadline|due)/i;
    const ideaHints = /(也许|或许|如果|要是|想做|想搞|想写|做一个|搞一个|研究|探索|思考|考虑|灵感|点子|idea|maybe|可以做|可以试|是否)/i;
    if (ideaHints.test(t)) return { type: 'idea', confidence: 0.7, reason: '本地规则：含探索性词汇' };
    if (todoHints.test(t)) return { type: 'todo', confidence: 0.7, reason: '本地规则：含具体行动/时间' };
    if (t.length <= 12) return { type: 'todo', confidence: 0.55, reason: '本地规则：短句默认待办' };
    return { type: 'idea', confidence: 0.55, reason: '本地规则：默认归为想法' };
  }
  let autosyncTimer = null;
  let lastSyncAt = 0;
  let doneCollapsed = false;

  // ============ UTIL ============
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const uid = () => 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = () => new Date().toISOString();
  const todayStr = () => new Date().toISOString().slice(0, 10);

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Tiny markdown renderer (links, bold, code, lists)
  function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    // links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // auto-links: bare http(s)://...
    html = html.replace(/(?:^|\s)(https?:\/\/[^\s<]+)/g,
      m => m.replace(/(https?:\/\/[^\s<]+)/, '<a href="$1" target="_blank" rel="noopener">$1</a>'));
    // bold: **x**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // bullets: lines starting with - or *
    const lines = html.split('\n');
    const out = [];
    let inList = false;
    lines.forEach(ln => {
      if (/^\s*[-*]\s+/.test(ln)) {
        if (!inList) { out.push('<ul style="margin:4px 0;padding-left:18px">'); inList = true; }
        out.push('<li>' + ln.replace(/^\s*[-*]\s+/, '') + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(ln);
      }
    });
    if (inList) out.push('</ul>');
    return out.join('\n');
  }

  function toast(msg, ms = 1800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function showUndoToast(text, undoFn, ms = 5000) {
    const el = $('#undo-toast');
    $('#undo-text').textContent = text;
    el.classList.remove('hidden');
    clearTimeout(showUndoToast._t);
    const close = () => el.classList.add('hidden');
    $('#undo-btn').onclick = () => { undoFn(); close(); };
    showUndoToast._t = setTimeout(close, ms);
  }

  // ============ STORAGE ============
  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      items = raw ? JSON.parse(raw) : [];
    } catch { items = []; }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) settings = { ...settings, ...JSON.parse(raw) };
    } catch {}
    try {
      const raw = localStorage.getItem(TAGS_KEY);
      tags = raw ? JSON.parse(raw) : DEFAULT_TAGS.slice();
    } catch { tags = DEFAULT_TAGS.slice(); }
    if (!Array.isArray(tags) || tags.length === 0) tags = DEFAULT_TAGS.slice();
    doneCollapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
  }
  function saveItems() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    scheduleAutosync();
  }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  function saveTags()     { localStorage.setItem(TAGS_KEY, JSON.stringify(tags)); }

  // visible items (no tombstones)
  function alive() { return items.filter(x => !x.deleted); }

  // ============ CRUD ============
  function addItem({ title, status = 'idea', tag = '', priority = '', due = '', repeat = '' }) {
    if (!title || !title.trim()) return null;
    const item = {
      id: uid(),
      title: title.trim(),
      note: '',
      status,
      tag, priority, due, repeat,
      createdAt: now(),
      updatedAt: now(),
      completedAt: status === 'done' ? now() : '',
      deleted: false
    };
    items.unshift(item);
    saveItems();
    render();
    return item;
  }

  function updateItem(id, patch, opts = {}) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    const before = { ...it };
    const wasDone = it.status === 'done';
    Object.assign(it, patch, { updatedAt: now() });
    const isDone = it.status === 'done';
    if (!wasDone && isDone) {
      it.completedAt = now();
      // handle repeat: spawn next occurrence
      if (it.repeat) spawnRepeat(before);
    }
    if (wasDone && !isDone) it.completedAt = '';

    if (!opts.silent) {
      undoStack.push({ type: 'update', before });
      if (undoStack.length > 30) undoStack.shift();
    }
    saveItems();
    render();
  }

  function spawnRepeat(prev) {
    const nextDue = computeNextDue(prev.due, prev.repeat);
    const clone = {
      ...prev,
      id: uid(),
      status: 'todo',
      due: nextDue,
      createdAt: now(),
      updatedAt: now(),
      completedAt: '',
      deleted: false
    };
    items.unshift(clone);
    toast(`🔁 已生成下一个 ${prev.repeat === 'daily' ? '每日' : prev.repeat === 'weekly' ? '每周' : '每月'}任务`);
  }

  function computeNextDue(currentDue, repeat) {
    const base = currentDue ? new Date(currentDue) : new Date();
    if (repeat === 'daily')   base.setDate(base.getDate() + 1);
    else if (repeat === 'weekly')  base.setDate(base.getDate() + 7);
    else if (repeat === 'monthly') base.setMonth(base.getMonth() + 1);
    return base.toISOString().slice(0, 10);
  }

  function deleteItem(id) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    const before = { ...it };
    it.deleted = true;
    it.updatedAt = now();
    undoStack.push({ type: 'delete', before });
    if (undoStack.length > 30) undoStack.shift();
    saveItems();
    render();
    showUndoToast(`🗑️ 已删除 "${it.title.slice(0, 24)}${it.title.length > 24 ? '…' : ''}"`,
      () => undoLast());
  }

  function undoLast() {
    const op = undoStack.pop();
    if (!op) { toast('没有可撤销的操作'); return; }
    const idx = items.findIndex(x => x.id === op.before.id);
    if (idx >= 0) items[idx] = op.before;
    else items.unshift(op.before);
    saveItems();
    render();
    toast('↶ 已撤销');
  }

  function clearOldDone() {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    let count = 0;
    items.forEach(it => {
      if (!it.deleted && it.status === 'done' && it.completedAt && it.completedAt < weekAgo) {
        it.deleted = true; it.updatedAt = now(); count++;
      }
    });
    if (count > 0) {
      saveItems(); render();
      toast(`🧹 已清理 ${count} 个 7 天前的已完成项`);
    } else toast('没有 7 天前的已完成项');
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
    const all = alive();
    ['idea', 'todo', 'done'].forEach(status => {
      const col = document.querySelector(`.col-body[data-drop="${status}"]`);
      let list = all.filter(it => it.status === status && passesFilter(it));
      const prioRank = { high: 3, mid: 2, low: 1, '': 0 };
      list.sort((a, b) => {
        const pa = prioRank[a.priority] || 0, pb = prioRank[b.priority] || 0;
        if (pa !== pb) return pb - pa;
        if (a.due && b.due) return a.due.localeCompare(b.due);
        if (a.due) return -1;
        if (b.due) return 1;
        const at = status === 'done' ? (a.completedAt || a.createdAt) : a.createdAt;
        const bt = status === 'done' ? (b.completedAt || b.createdAt) : b.createdAt;
        return bt.localeCompare(at);
      });

      col.innerHTML = '';
      if (list.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'empty-hint';
        hint.innerHTML = status === 'idea'
          ? '<span class="empty-emoji">🌱</span><div class="empty-title">还没有灵感</div><div class="empty-sub">输入框里写下任何想法 (Enter)</div>'
          : status === 'todo'
          ? '<span class="empty-emoji">🎯</span><div class="empty-title">没有待办</div><div class="empty-sub">把灵感拖到这里，或 Shift+Enter 直接添加</div>'
          : '<span class="empty-emoji">🏁</span><div class="empty-title">尚未完成任何任务</div><div class="empty-sub">坚持就是胜利</div>';
        col.appendChild(hint);
      } else {
        list.forEach(it => col.appendChild(renderCard(it)));
      }
      const cnt = document.querySelector(`[data-count="${status}"]`);
      if (cnt) cnt.textContent = list.length;
    });

    // Done collapse state
    $('#col-done').classList.toggle('collapsed', doneCollapsed);
    $('#done-toggle').textContent = doneCollapsed ? '▶' : '▼';

    renderTodayFocus();
    updateGreeting();
    refreshTagUI();
  }

  function renderCard(it) {
    const card = document.createElement('div');
    card.className = 'card' + (it.status === 'done' ? ' done' : '')
                   + (it.priority ? ' priority-' + it.priority : '');
    card.draggable = true;
    card.dataset.id = it.id;

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
    actions.appendChild(makeAction('🗑️', '删除', () => deleteItem(it.id)));
    card.appendChild(actions);

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = it.title;
    card.appendChild(title);

    if (it.note) {
      const note = document.createElement('div');
      note.className = 'card-note';
      note.innerHTML = renderMarkdown(it.note);
      // toggle expand on click (if has content beyond 3 lines)
      note.addEventListener('click', e => {
        if (e.target.tagName === 'A') return;
        e.stopPropagation();
        note.classList.toggle('expanded');
      });
      card.appendChild(note);
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    if (it.tag) {
      const t = tags.find(x => x.name === it.tag);
      const tag = document.createElement('span');
      tag.className = 'card-tag';
      tag.textContent = (t ? t.emoji : '🏷️') + ' ' + it.tag;
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
    if (it.repeat) {
      const r = document.createElement('span');
      r.className = 'card-repeat';
      r.textContent = '🔁 ' + (it.repeat === 'daily' ? '每天' : it.repeat === 'weekly' ? '每周' : '每月');
      meta.appendChild(r);
    }
    if (meta.children.length > 0) card.appendChild(meta);

    card.addEventListener('dblclick', () => openEdit(it.id));
    card.addEventListener('dragstart', e => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', it.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('.drop-indicator').forEach(el => el.remove());
    });
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

  // ============ TODAY FOCUS ============
  function renderTodayFocus() {
    const today = todayStr();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const items_ = alive().filter(x =>
      (x.status === 'todo' || x.status === 'idea') &&
      (
        (x.due && x.due <= today) ||  // overdue or today
        x.priority === 'high'
      )
    );
    const focus = $('#today-focus');
    if (items_.length === 0) {
      focus.classList.add('empty');
      focus.innerHTML = '🌟 今日无紧急任务，享受当下！';
      return;
    }
    focus.classList.remove('empty');
    items_.sort((a, b) => {
      const ar = (a.due && a.due < today) ? 0 : (a.due === today ? 1 : 2);
      const br = (b.due && b.due < today) ? 0 : (b.due === today ? 1 : 2);
      return ar - br;
    });
    const list = items_.slice(0, 6).map(it => {
      let badge = '';
      if (it.due && it.due < today) badge = '<span class="badge overdue">超期</span>';
      else if (it.due === today) badge = '<span class="badge today">今天</span>';
      else if (it.priority === 'high') badge = '<span class="badge high">🔴</span>';
      return `<li class="today-item" data-id="${it.id}">${badge}${escapeHtml(it.title.slice(0, 30))}${it.title.length > 30 ? '…' : ''}</li>`;
    }).join('');
    focus.innerHTML = `
      <div class="today-icon">🎯</div>
      <div class="today-content">
        <div class="today-title">今日聚焦 · ${items_.length} 项</div>
        <ul class="today-list">${list}</ul>
      </div>
    `;
    focus.querySelectorAll('.today-item').forEach(li => {
      li.addEventListener('click', () => openEdit(li.dataset.id));
    });
  }

  function updateGreeting() {
    const h = new Date().getHours();
    let emoji, greet;
    if (h < 6)       { emoji = '🌙'; greet = '深夜好'; }
    else if (h < 11) { emoji = '☀️'; greet = '早上好'; }
    else if (h < 14) { emoji = '🌤️'; greet = '中午好'; }
    else if (h < 18) { emoji = '⛅'; greet = '下午好'; }
    else if (h < 22) { emoji = '🌆'; greet = '晚上好'; }
    else             { emoji = '🌃'; greet = '夜深了'; }
    $('#greeting-text').textContent = `${emoji} ${greet}`;
    const all = alive();
    const todoCount = all.filter(x => x.status === 'todo').length;
    const doneToday = all.filter(x => x.completedAt && x.completedAt.slice(0, 10) === todayStr()).length;
    $('#greeting-sub').innerHTML = todoCount === 0
      ? `今天还没有待办，添加一个开始 ✨`
      : `${todoCount} 个待办${doneToday > 0 ? ` · 今日已完成 <b>${doneToday}</b> 项` : ''}`;
  }

  // ============ TAG UI ============
  function refreshTagUI() {
    const filterBar = $('#filter-tags');
    const existing = filterBar.querySelectorAll('.chip');
    existing.forEach((c, i) => { if (i > 0) c.remove(); });
    tags.forEach(t => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.value = t.name;
      b.textContent = `${t.emoji} ${t.name}`;
      if (filter.tag === t.name) b.classList.add('active');
      filterBar.appendChild(b);
    });

    const fillSelect = (sel, includeEmpty = true) => {
      const cur = sel.value;
      sel.innerHTML = includeEmpty ? '<option value="">无</option>' : '';
      if (sel.id === 'quick-tag') sel.innerHTML = '<option value="">🏷️ 标签</option>';
      tags.forEach(t => {
        const o = document.createElement('option');
        o.value = t.name;
        o.textContent = `${t.emoji} ${t.name}`;
        sel.appendChild(o);
      });
      sel.value = cur;
    };
    fillSelect($('#quick-tag'));
    fillSelect($('#edit-tag'));

    // tag manager in settings
    const mgr = $('#tag-manager');
    if (mgr) {
      mgr.innerHTML = '';
      tags.forEach((t, i) => {
        const pill = document.createElement('div');
        pill.className = 'tag-pill';
        pill.innerHTML = `<span>${t.emoji} ${escapeHtml(t.name)}</span><button title="删除">×</button>`;
        pill.querySelector('button').addEventListener('click', () => {
          if (confirm(`删除标签 "${t.name}"？已使用此标签的项不会被影响，但需要重新分类。`)) {
            tags.splice(i, 1);
            saveTags(); refreshTagUI();
          }
        });
        mgr.appendChild(pill);
      });
    }
  }

  // ============ DRAG & DROP (with placeholder) ============
  function setupDnD() {
    $$('.col-body').forEach(col => {
      col.addEventListener('dragover', e => {
        e.preventDefault();
        col.classList.add('drag-over');
        e.dataTransfer.dropEffect = 'move';
        // show drop indicator
        const cards = Array.from(col.querySelectorAll('.card:not(.dragging)'));
        $$('.drop-indicator').forEach(el => el.remove());
        const indicator = document.createElement('div');
        indicator.className = 'drop-indicator';
        let placed = false;
        for (const c of cards) {
          const r = c.getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) {
            col.insertBefore(indicator, c); placed = true; break;
          }
        }
        if (!placed) col.appendChild(indicator);
      });
      col.addEventListener('dragleave', e => {
        if (e.target === col) col.classList.remove('drag-over');
      });
      col.addEventListener('drop', e => {
        e.preventDefault();
        col.classList.remove('drag-over');
        $$('.drop-indicator').forEach(el => el.remove());
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
    const rep = $('#quick-repeat');

    let busy = false;

    input.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (busy) return;

      const title = input.value.trim();
      if (!title) return;

      // Escape hatches: shift = force todo, ctrl/cmd = force idea
      const forced = e.shiftKey ? 'todo' : (e.metaKey || e.ctrlKey) ? 'idea' : null;
      const meta = {
        tag: tag.value, priority: prio.value, due: due.value, repeat: rep.value
      };

      if (forced) {
        const ok = addItem({ title, status: forced, ...meta });
        if (ok) {
          resetQuickAdd();
          toast(forced === 'idea' ? '💡 灵感已记录' : '✅ 任务已添加');
        }
        return;
      }

      // AI auto-classify path
      busy = true;
      input.classList.add('ai-thinking');
      const originalPlaceholder = input.placeholder;
      input.placeholder = '🤖 AI 正在判断…';
      input.disabled = true;
      try {
        const result = await classifyWithAI(title);
        const ok = addItem({ title, status: result.type, ...meta });
        if (ok) {
          resetQuickAdd();
          showClassifyToast(result, title, meta);
        }
      } finally {
        busy = false;
        input.classList.remove('ai-thinking');
        input.placeholder = originalPlaceholder;
        input.disabled = false;
        setTimeout(() => input.focus(), 0);
      }
    });

    function resetQuickAdd() {
      input.value = ''; tag.value = ''; prio.value = ''; due.value = ''; rep.value = '';
    }
  }

  /**
   * Show a classification toast with the AI verdict + an "改判" action that
   * moves the most-recently-added item to the opposite column. Falls back to
   * a plain toast if #toast-action infrastructure isn't present.
   */
  function showClassifyToast(result, title, meta) {
    const icon = result.type === 'idea' ? '💡' : '✅';
    const label = result.type === 'idea' ? 'Idea' : 'Todo';
    const tag = result.source === 'ai' ? '🤖' : '📐';
    const conf = Math.round((result.confidence || 0) * 100);
    const reason = result.reason ? ` · ${result.reason}` : '';
    const msg = `${icon} 已归为 ${label} ${tag}${conf ? ` ${conf}%` : ''}${reason}　点这里改判 →`;

    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.add('clickable');
    // capture last added item id (most recent non-deleted)
    const lastId = items.filter(x => !x.deleted).slice(-1)[0]?.id;
    const onClick = () => {
      if (!lastId) return;
      const it = items.find(x => x.id === lastId);
      if (!it) return;
      it.status = it.status === 'idea' ? 'todo' : 'idea';
      it.updatedAt = Date.now();
      saveItems(); render();
      toast(it.status === 'idea' ? '↩️ 已改判为 Idea' : '↩️ 已改判为 Todo');
    };
    el.onclick = onClick;
    clearTimeout(showClassifyToast._t);
    showClassifyToast._t = setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('clickable');
      el.onclick = null;
    }, 4500);
  }

  // ============ FILTERS & SEARCH ============
  function setupFilters() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('.filter-group .chip');
      if (!btn) return;
      const group = btn.closest('.filter-group');
      const key = group.dataset.key;
      group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      filter[key] = btn.dataset.value;
      render();
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
    $('#edit-repeat').value = it.repeat || '';
    $('#edit-modal').classList.remove('hidden');
    setTimeout(() => $('#edit-title').focus(), 50);
  }
  function closeEdit() { editingId = null; $('#edit-modal').classList.add('hidden'); }

  function setupEditModal() {
    $('#edit-save').addEventListener('click', saveEdit);
    $('#edit-modal').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
    });
    $('#edit-delete').addEventListener('click', () => {
      if (!editingId) return;
      const id = editingId; closeEdit();
      deleteItem(id);
    });
    function saveEdit() {
      if (!editingId) return;
      const title = $('#edit-title').value.trim();
      if (!title) { toast('标题不能为空'); return; }
      updateItem(editingId, {
        title,
        note: $('#edit-note').value,
        tag: $('#edit-tag').value,
        priority: $('#edit-priority').value,
        due: $('#edit-due').value,
        repeat: $('#edit-repeat').value
      });
      closeEdit();
      toast('✅ 已保存');
    }
  }

  // ============ MODAL UTILS ============
  function setupModals() {
    $$('[data-close]').forEach(b => {
      b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden'));
    });
    $$('.modal').forEach(m => {
      m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
    });
    $('#help-btn').addEventListener('click', () => $('#help-modal').classList.remove('hidden'));
    $('#footer-help').addEventListener('click', e => {
      e.preventDefault(); $('#help-modal').classList.remove('hidden');
    });
  }

  // ============ STATS ============
  function openStats() {
    const all = alive();
    const ideas = all.filter(x => x.status === 'idea').length;
    const todos = all.filter(x => x.status === 'todo').length;
    const done  = all.filter(x => x.status === 'done').length;
    const total = ideas + todos + done;
    const rate  = total === 0 ? 0 : Math.round(done / total * 100);
    $('#s-ideas').textContent = ideas;
    $('#s-todos').textContent = todos;
    $('#s-done').textContent  = done;
    $('#s-rate').textContent  = rate + '%';

    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    $('#s-week-new').textContent  = all.filter(x => x.createdAt > weekAgo).length;
    $('#s-week-done').textContent = all.filter(x => x.completedAt && x.completedAt > weekAgo).length;

    const chart = $('#activity-chart');
    chart.innerHTML = '';
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const ds = d.toISOString().slice(0, 10);
      const cnt = all.filter(x =>
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
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, cur);
    applyTheme(cur);
  }
  function setupTheme() {
    const saved = localStorage.getItem(THEME_KEY)
              || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(saved);
    $('#theme-btn').addEventListener('click', toggleTheme);
  }

  // ============ GITHUB SYNC (Issues as DB, with tombstone merge) ============
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

  function setSyncIcon(state) {
    const btn = $('#sync-btn');
    const icon = $('#sync-icon');
    btn.classList.remove('spin');
    if (state === 'syncing') { btn.classList.add('spin'); icon.textContent = '🔄'; }
    else if (state === 'ok')   icon.textContent = '☁️';
    else if (state === 'err')  icon.textContent = '⚠️';
    else if (state === 'off')  icon.textContent = '☁️';
  }

  async function pushToCloud(silent = false) {
    if (!settings.token || !settings.repo) {
      if (!silent) toast('请先在 ⚙️ 设置中配置');
      return;
    }
    try {
      setSyncIcon('syncing');
      const payload = { items, tags, version: 2, syncedAt: now() };
      const body = '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
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
      lastSyncAt = Date.now();
      setSyncIcon('ok');
      if (!silent) toast('☁️ 已推送到云端');
    } catch (e) {
      setSyncIcon('err');
      if (!silent) toast('❌ ' + e.message, 3500);
    }
  }

  async function pullFromCloud(silent = false) {
    if (!settings.token || !settings.repo) {
      if (!silent) toast('请先在 ⚙️ 设置中配置');
      return;
    }
    try {
      setSyncIcon('syncing');
      const issue = await findSyncIssue();
      if (!issue) {
        setSyncIcon('ok');
        if (!silent) toast('☁️ 云端无数据');
        return;
      }
      const m = (issue.body || '').match(/```json\n([\s\S]*?)\n```/);
      if (!m) {
        setSyncIcon('err');
        if (!silent) toast('☁️ 云端数据格式异常');
        return;
      }
      const cloud = JSON.parse(m[1]);
      // backwards compat: v1 was bare array
      const cloudItems = Array.isArray(cloud) ? cloud : (cloud.items || []);
      const cloudTags  = Array.isArray(cloud) ? null   : cloud.tags;

      // merge by updatedAt; tombstones win if newer
      const map = new Map(items.map(x => [x.id, x]));
      cloudItems.forEach(c => {
        const local = map.get(c.id);
        if (!local || (c.updatedAt || '') > (local.updatedAt || '')) {
          map.set(c.id, c);
        }
      });
      items = Array.from(map.values());
      if (cloudTags && Array.isArray(cloudTags) && cloudTags.length > 0) {
        tags = cloudTags;
        saveTags();
      }
      saveItems();
      render();
      lastSyncAt = Date.now();
      setSyncIcon('ok');
      if (!silent) toast(`☁️ 已从云端同步 ${cloudItems.length} 项`);
    } catch (e) {
      setSyncIcon('err');
      if (!silent) toast('❌ ' + e.message, 3500);
    }
  }

  function scheduleAutosync() {
    if (!settings.autosync || !settings.token || !settings.repo) return;
    clearTimeout(autosyncTimer);
    autosyncTimer = setTimeout(() => pushToCloud(true), 30000);
  }

  function setupSettings() {
    $('#settings-btn').addEventListener('click', () => {
      $('#cfg-token').value = settings.token || '';
      $('#cfg-repo').value  = settings.repo  || 'Maekfei/todo-ideas';
      $('#cfg-autosync').checked = !!settings.autosync;
      $('#cfg-status').textContent = settings.token ? '✅ 已配置' : '尚未配置';
      $('#settings-modal').classList.remove('hidden');
    });
    $('#cfg-save').addEventListener('click', () => {
      settings.token = $('#cfg-token').value.trim();
      settings.repo  = $('#cfg-repo').value.trim();
      settings.autosync = $('#cfg-autosync').checked;
      saveSettings();
      $('#cfg-status').textContent = '✅ 已保存';
      toast('设置已保存');
      if (settings.autosync) scheduleAutosync();
    });
    $('#cfg-pull').addEventListener('click', () => pullFromCloud());
    $('#cfg-push').addEventListener('click', () => pushToCloud());
    $('#sync-btn').addEventListener('click', async () => {
      if (!settings.token) { $('#settings-btn').click(); return; }
      await pullFromCloud();
      await pushToCloud();
    });

    // Tag add
    $('#add-tag').addEventListener('click', () => {
      const name = $('#new-tag').value.trim();
      const emoji = $('#new-tag-emoji').value.trim() || '🏷️';
      if (!name) return;
      if (tags.find(t => t.name === name)) { toast('标签已存在'); return; }
      tags.push({ name, emoji });
      saveTags(); refreshTagUI();
      $('#new-tag').value = ''; $('#new-tag-emoji').value = '';
      toast('🏷️ 标签已添加');
    });

    // Import / Export
    $('#export-json').addEventListener('click', () => {
      const data = { items, tags, exportedAt: now(), version: 2 };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flowboard-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('📤 已导出');
    });
    $('#import-json').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const newItems = Array.isArray(data) ? data : data.items;
        if (!Array.isArray(newItems)) throw new Error('文件格式不正确');
        if (!confirm(`导入 ${newItems.length} 项？将与现有数据合并（按更新时间）。`)) return;
        const map = new Map(items.map(x => [x.id, x]));
        newItems.forEach(c => {
          const local = map.get(c.id);
          if (!local || (c.updatedAt || '') > (local.updatedAt || '')) map.set(c.id, c);
        });
        items = Array.from(map.values());
        if (data.tags && Array.isArray(data.tags) && data.tags.length > 0) {
          tags = data.tags; saveTags();
        }
        saveItems(); render();
        toast(`📥 已导入 ${newItems.length} 项`);
      } catch (err) { toast('❌ ' + err.message); }
      e.target.value = '';
    });
    $('#clear-all').addEventListener('click', () => {
      if (!confirm('确认清空所有数据？此操作不可撤销！')) return;
      if (!confirm('真的吗？所有 idea 和 todo 都会消失！')) return;
      items = []; saveItems(); render();
      toast('🗑️ 已清空');
    });
  }

  // ============ DONE COLUMN CONTROLS ============
  function setupDoneCol() {
    $('#done-toggle').addEventListener('click', () => {
      doneCollapsed = !doneCollapsed;
      localStorage.setItem(COLLAPSE_KEY, doneCollapsed ? '1' : '0');
      render();
    });
    $('#done-clear').addEventListener('click', clearOldDone);
  }

  // ============ KEYBOARD SHORTCUTS ============
  function setupShortcuts() {
    document.addEventListener('keydown', e => {
      // Esc closes modals
      if (e.key === 'Escape') {
        $$('.modal').forEach(m => m.classList.add('hidden'));
        return;
      }
      // Cmd/Ctrl+Z undo
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        const target = e.target;
        if (target.matches('input, textarea, select')) return;
        e.preventDefault(); undoLast(); return;
      }
      // Don't trigger single-letter shortcuts in inputs
      if (e.target.matches('input, textarea, select')) return;

      switch (e.key) {
        case 'n': case 'N':
          e.preventDefault(); $('#quick-input').focus(); break;
        case '/':
          e.preventDefault(); $('#search').focus(); break;
        case '?':
          e.preventDefault(); $('#help-modal').classList.remove('hidden'); break;
        case 't': case 'T':
          toggleTheme(); break;
        case 's': case 'S':
          if (settings.token) { pullFromCloud().then(() => pushToCloud()); }
          break;
      }
    });
  }

  // ============ INIT ============
  function seedIfEmpty() {
    if (alive().length > 0) return;
    items = [
      mkSeed('👋 欢迎使用 Flow Board v2！',
        '试试这些新功能：\n- 拖拽卡片在三列流转\n- 双击编辑 / **markdown** 备注 / 重复任务\n- 按 `?` 查看快捷键\n- 删除有 5 秒撤销窗口',
        'idea', '项目', 'high', '', ''),
      mkSeed('🎯 把这张卡片拖到 Todos 列试试',
        '拖拽过程会显示蓝色插入指示线 ✨',
        'idea', '', 'mid', '', ''),
      mkSeed('☁️ 在 ⚙️ 中配置 GitHub Token，开启自动同步',
        '勾选「自动同步」后，修改后 30 秒会自动推送。',
        'todo', '工作', 'high', '', ''),
      mkSeed('📚 每周阅读 1 篇论文', '试试重复任务功能 🔁',
        'todo', '学习', 'mid', todayStr(), 'weekly')
    ];
    saveItems();
  }
  function mkSeed(title, note, status, tag, priority, due, repeat) {
    return {
      id: uid(), title, note, status, tag, priority, due: due || '', repeat: repeat || '',
      createdAt: now(), updatedAt: now(),
      completedAt: status === 'done' ? now() : '',
      deleted: false
    };
  }

  async function init() {
    loadAll();
    seedIfEmpty();
    setupTheme();
    setupQuickAdd();
    setupFilters();
    setupDnD();
    setupEditModal();
    setupModals();
    setupSettings();
    setupDoneCol();
    setupShortcuts();
    $('#stats-btn').addEventListener('click', openStats);
    render();

    // Auto-pull on startup if configured
    if (settings.autosync && settings.token && settings.repo) {
      setTimeout(() => pullFromCloud(true), 500);
    } else {
      setSyncIcon(settings.token ? 'ok' : 'off');
    }

    // Register service worker for PWA (best-effort)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* fine */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
