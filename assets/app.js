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
  let settings = {
    token: '', repo: '', autosync: false,
    aiEndpoint: 'https://yunwu.ai/v1/chat/completions',
    aiKey: '',
    aiModel: 'deepseek-chat'
  };
  let filter = { tag: '', priority: '', search: '', quickfilter: '' };
  let editingId = null;
  let undoStack = [];       // last operations for undo
  let selectedCardId = null; // keyboard-selected card

  // ============ AI CLASSIFIER (configurable, OpenAI-compatible) ============
  const AI_TIMEOUT_MS = 15000;

  function buildAIPrompt() {
    const tagList = tags.map(t => t.name).join('、') || '工作、学习、生活、项目';
    return `你是个人任务管家。分析用户的一句话输入，输出严格 JSON：
{"type":"todo"|"idea","priority":"high"|"mid"|"low"|"","due":"YYYY-MM-DD"|"","tags":["标签1"],"subtasks":["子任务1","子任务2"],"confidence":0-1,"reason":"≤20字理由"}

判定规则：
- todo = 具体可执行的行动（买/写/交/约/修/订/完成等，或带具体时间）
- idea = 探索性、未成型的想法（"做一个XX"、"研究一下"、"如果XX会怎样"）
- priority: 含"紧急/重要/!/截止/明天前"=high；含具体时间或行动=mid；探索性/无时间=low/""
- due: 当前日期 ${todayStr()}。识别相对时间："今天/明天/后天/本周三/下周二/3号前/月底"等转 ISO YYYY-MM-DD；无则 ""
- tags: 从这些里选（可多选，最多2个）：${tagList}。识别 #标签 显式标记。无明显类别则 []
- subtasks: 仅当输入像"做一个XX网站/搭建XX/开发XX/写一份XX报告"这种复杂目标时，拆 3-5 个具体小步骤；否则 []
- confidence: 你的置信度 0-1
- reason: 中文，简短，≤20字`;
  }

  /**
   * Classify free-form text via configured LLM API. Returns rich object:
   * { type, priority, due, tags, subtasks, confidence, reason, source }
   * Falls back to local heuristic when no key configured / API fails.
   */
  async function classifyWithAI(text) {
    if (!settings.aiKey) {
      return { ...localHeuristicClassify(text), source: 'fallback' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      const res = await fetch(settings.aiEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + settings.aiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: settings.aiModel,
          messages: [
            { role: 'system', content: buildAIPrompt() },
            { role: 'user',   content: text }
          ],
          max_tokens: 600,
          response_format: { type: 'json_object' }
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(content);
      return {
        type: parsed.type === 'todo' ? 'todo' : 'idea',
        priority: ['high', 'mid', 'low'].includes(parsed.priority) ? parsed.priority : '',
        due: typeof parsed.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due) ? parsed.due : '',
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter(t => typeof t === 'string').slice(0, 2) : [],
        subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks.filter(s => typeof s === 'string' && s.trim()).slice(0, 5) : [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        reason: parsed.reason || '',
        source: 'ai'
      };
    } catch (err) {
      clearTimeout(timer);
      console.warn('[AI classify failed, using local fallback]', err);
      return { ...localHeuristicClassify(text), source: 'fallback' };
    }
  }

  /** Tiny rule-based fallback. Now also extracts priority/due/tags from common patterns. */
  function localHeuristicClassify(text) {
    const raw = (text || '').trim();
    const t = raw.toLowerCase();
    const out = { type: 'idea', priority: '', due: '', tags: [], subtasks: [], confidence: 0.55, reason: '本地规则' };

    // tags: #xxx
    const tagMatches = raw.match(/#([\u4e00-\u9fa5\w]+)/g);
    if (tagMatches) {
      const found = tagMatches.map(m => m.slice(1));
      out.tags = found.filter(name => tags.find(t => t.name === name)).slice(0, 2);
    }

    // priority
    if (/(紧急|重要|!{1,3}|高优|asap)/i.test(raw)) out.priority = 'high';
    else if (/(顺手|有空|低优)/i.test(raw)) out.priority = 'low';

    // due — relative dates
    const today = new Date();
    const setDue = d => { out.due = d.toISOString().slice(0, 10); };
    if (/今天|today/i.test(raw)) setDue(today);
    else if (/明天|tomorrow/i.test(raw)) { const d = new Date(today); d.setDate(d.getDate() + 1); setDue(d); }
    else if (/后天/.test(raw)) { const d = new Date(today); d.setDate(d.getDate() + 2); setDue(d); }
    else {
      const wkMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
      const m = raw.match(/(本|下)?周([一二三四五六日天])/);
      if (m) {
        const target = wkMap[m[2]];
        const cur = today.getDay();
        let add = (target - cur + 7) % 7;
        if (m[1] === '下' || add === 0) add += 7;
        const d = new Date(today); d.setDate(d.getDate() + add); setDue(d);
      }
    }

    // type
    const todoHints = /(买|打|发|写|交|提交|回复|约|预约|联系|开会|开始|完成|修复|修一下|订|订票|订机票|报名|续|续费|续约|读完|看完|安排|today|tomorrow|明天|今天|后天|本周|下周|周一|周二|周三|周四|周五|周六|周日|截止|deadline|due|前交|交开题|报告)/i;
    const ideaHints = /(也许|或许|如果|要是|想做|想搞|想写|做一个|搞一个|研究|探索|思考|考虑|灵感|点子|idea|maybe|可以做|可以试|是否)/i;
    if (out.due || out.priority === 'high') { out.type = 'todo'; out.confidence = 0.75; out.reason = '本地规则：识别到时间/优先级'; }
    else if (ideaHints.test(t)) { out.type = 'idea'; out.confidence = 0.7; out.reason = '本地规则：含探索性词汇'; }
    else if (todoHints.test(t)) { out.type = 'todo'; out.confidence = 0.7; out.reason = '本地规则：含具体行动'; }
    else if (t.length <= 12) { out.type = 'todo'; out.confidence = 0.55; out.reason = '本地规则：短句默认待办'; }
    else { out.type = 'idea'; out.confidence = 0.55; out.reason = '本地规则：默认归为想法'; }

    return out;
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
  function addItem({ title, status = 'idea', tag = '', priority = '', due = '', repeat = '', note = '', aiClassified = false, parentId = '' }) {
    if (!title || !title.trim()) return null;
    const item = {
      id: uid(),
      title: title.trim(),
      note,
      status,
      tag, priority, due, repeat,
      createdAt: now(),
      updatedAt: now(),
      completedAt: status === 'done' ? now() : '',
      deleted: false,
      aiClassified: !!aiClassified,
      parentId: parentId || ''
    };
    items.unshift(item);
    saveItems();
    render();
    return item;
  }

  /**
   * Apply an AI classification result to an existing card (status + priority + due + tag).
   * Marks aiClassified=true so the badge stays until user manually edits.
   * Subtasks are NOT auto-spawned here — caller decides via toast/UI.
   */
  function applyAIResult(id, result) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    const patch = { status: result.type, aiClassified: true };
    if (result.priority) patch.priority = result.priority;
    if (result.due) patch.due = result.due;
    if (result.tags && result.tags.length > 0 && tags.find(t => t.name === result.tags[0])) {
      patch.tag = result.tags[0]; // single-select for now; multi-tag would need schema bump
    }
    updateItem(id, patch, { silent: true });
  }

  /** Reclassify a single card. Returns the AI result for caller to react. */
  async function reclassifyCard(id) {
    const it = items.find(x => x.id === id);
    if (!it) return null;
    toast('🤖 AI 思考中…', 1200);
    const result = await classifyWithAI(it.title + (it.note ? '\n' + it.note : ''));
    applyAIResult(id, result);
    const tag = result.source === 'ai' ? '🤖 AI' : '📐 规则';
    toast(`${tag} 已重判为 ${result.type === 'idea' ? '💡 Idea' : '✅ Todo'}${result.reason ? ' · ' + result.reason : ''}`, 3000);
    return result;
  }

  /** Reclassify every alive idea/todo card in series with progress feedback. */
  async function reclassifyAll() {
    const targets = alive().filter(x => x.status !== 'done');
    if (targets.length === 0) { toast('没有需要重判的卡片'); return; }
    if (targets.length > 20 && !confirm(`将对 ${targets.length} 张卡片调用 AI 重判，确认继续？`)) return;
    const btn = $('#reclassify-all-btn');
    if (btn) btn.classList.add('spin');
    let ok = 0, fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const it = targets[i];
      toast(`🤖 重判中 ${i + 1}/${targets.length} · ${it.title.slice(0, 18)}…`, 60000);
      try {
        const result = await classifyWithAI(it.title + (it.note ? '\n' + it.note : ''));
        applyAIResult(it.id, result);
        if (result.source === 'ai') ok++; else fail++;
      } catch { fail++; }
      // gentle pacing to avoid rate limits
      if (settings.aiKey) await new Promise(r => setTimeout(r, 250));
    }
    if (btn) btn.classList.remove('spin');
    render();
    toast(`✅ 重判完成 · AI: ${ok} · 本地规则: ${fail}`, 4000);
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
    if (filter.quickfilter) {
      const today = todayStr();
      if (filter.quickfilter === 'today') {
        if (it.due !== today || it.status === 'done') return false;
      } else if (filter.quickfilter === 'overdue') {
        if (!it.due || it.due >= today || it.status === 'done') return false;
      } else if (filter.quickfilter === 'high') {
        if (it.priority !== 'high' || it.status === 'done') return false;
      }
    }
    return true;
  }

  /** Bucket a todo card by due date for time-grouped rendering. */
  function todoBucket(it) {
    if (!it.due) return { key: 'noDate', label: '❓ 无日期', order: 99 };
    const today = todayStr();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    if (it.due < today)    return { key: 'overdue',  label: '🔥 已逾期',  order: 0 };
    if (it.due === today)  return { key: 'today',    label: '📍 今天',    order: 1 };
    if (it.due === tomorrow) return { key: 'tomorrow', label: '⏭️ 明天', order: 2 };
    if (it.due <= weekEnd) return { key: 'thisweek', label: '📅 本周内', order: 3 };
    return                    { key: 'later',    label: '🗓️ 之后',    order: 4 };
  }

  /** Bucket a done card by completion date. */
  function doneBucket(it) {
    if (!it.completedAt) return { key: 'older', label: '🗂️ 更早', order: 9 };
    const completed = it.completedAt.slice(0, 10);
    const today = todayStr();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (completed === today)     return { key: 'today',     label: '🎉 今天完成', order: 0 };
    if (completed === yesterday) return { key: 'yesterday', label: '✨ 昨天完成', order: 1 };
    return { key: 'older', label: '🗂️ 更早', order: 9 };
  }

  function render() {
    const all = alive();
    const prioRank = { high: 3, mid: 2, low: 1, '': 0 };
    const sortFn = (status) => (a, b) => {
      const pa = prioRank[a.priority] || 0, pb = prioRank[b.priority] || 0;
      if (pa !== pb) return pb - pa;
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      const at = status === 'done' ? (a.completedAt || a.createdAt) : a.createdAt;
      const bt = status === 'done' ? (b.completedAt || b.createdAt) : b.createdAt;
      return bt.localeCompare(at);
    };

    ['idea', 'todo', 'done'].forEach(status => {
      const col = document.querySelector(`.col-body[data-drop="${status}"]`);
      let list = all.filter(it => it.status === status && passesFilter(it));
      list.sort(sortFn(status));
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
      } else if (status === 'todo' && !filter.quickfilter && list.length >= 4) {
        // Time-grouped rendering for Todos column
        const groups = {};
        list.forEach(it => {
          const b = todoBucket(it);
          if (!groups[b.key]) groups[b.key] = { ...b, items: [] };
          groups[b.key].items.push(it);
        });
        Object.values(groups).sort((a, b) => a.order - b.order).forEach(g => {
          const wrap = document.createElement('div');
          wrap.className = 'card-group group-' + g.key;
          const head = document.createElement('div');
          head.className = 'card-group-header';
          head.innerHTML = `${g.label} <span class="group-count">${g.items.length}</span>`;
          wrap.appendChild(head);
          g.items.forEach(it => wrap.appendChild(renderCard(it)));
          col.appendChild(wrap);
        });
      } else if (status === 'done' && list.length >= 3) {
        // Time-grouped rendering for Done column
        const groups = {};
        list.forEach(it => {
          const b = doneBucket(it);
          if (!groups[b.key]) groups[b.key] = { ...b, items: [] };
          groups[b.key].items.push(it);
        });
        Object.values(groups).sort((a, b) => a.order - b.order).forEach(g => {
          const wrap = document.createElement('div');
          wrap.className = 'card-group group-done-' + g.key;
          const head = document.createElement('div');
          head.className = 'card-group-header';
          head.innerHTML = `${g.label} <span class="group-count">${g.items.length}</span>`;
          wrap.appendChild(head);
          g.items.forEach(it => wrap.appendChild(renderCard(it)));
          col.appendChild(wrap);
        });
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

    // Re-apply selected highlight after re-render
    if (selectedCardId) {
      const sel = document.querySelector(`.card[data-id="${selectedCardId}"]`);
      if (sel) sel.classList.add('selected');
      else selectedCardId = null;
    }
  }

  function renderCard(it) {
    const card = document.createElement('div');
    card.className = 'card' + (it.status === 'done' ? ' done' : '')
                   + (it.priority ? ' priority-' + it.priority : '')
                   + (it.aiClassified ? ' ai-classified' : '');
    card.draggable = true;
    card.dataset.id = it.id;

    // 🤖 AI badge (top-right)
    if (it.aiClassified) {
      const badge = document.createElement('span');
      badge.className = 'card-ai-badge';
      badge.textContent = '🤖 AI';
      badge.title = 'AI 自动判断（编辑后消失）';
      card.appendChild(badge);
    }

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
    actions.appendChild(makeAction('🤖', 'AI 重判', () => reclassifyCard(it.id)));
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

    card.addEventListener('click', e => {
      // 忽略点击在按钮/链接上的事件
      if (e.target.closest('.card-action') || e.target.closest('a')) return;
      selectedCardId = it.id;
      $$('.card.selected').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
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

  // ============ TODAY HERO (3 buckets) ============
  function renderTodayFocus() {
    const today = todayStr();
    const all = alive().filter(x => x.status === 'todo' || x.status === 'idea');
    const todayItems   = all.filter(x => x.due === today);
    const overdueItems = all.filter(x => x.due && x.due < today);
    const highItems    = all.filter(x => x.priority === 'high');

    const hero = $('#today-hero') || $('#today-focus'); // 兼容旧 ID
    if (!hero) return;
    hero.classList.remove('empty');

    if (todayItems.length === 0 && overdueItems.length === 0 && highItems.length === 0) {
      hero.classList.add('empty');
      hero.innerHTML = '<div class="today-hero-empty">🌟 今日无紧急任务，享受当下！</div>';
      return;
    }

    const bucket = (key, icon, label, items) => {
      const cnt = items.length;
      const has = cnt > 0;
      const preview = items.slice(0, 3).map(it =>
        `<li data-id="${it.id}">${escapeHtml(it.title.slice(0, 22))}${it.title.length > 22 ? '…' : ''}</li>`
      ).join('');
      const isActive = filter.quickfilter === key;
      return `
        <div class="today-bucket bucket-${key} ${has ? 'has-items' : 'empty'} ${isActive ? 'active' : ''}" data-bucket="${key}" role="button" tabindex="0">
          <div class="today-bucket-head">
            <span class="today-bucket-num">${cnt}</span>
            <span class="today-bucket-label"><span class="icon">${icon}</span>${label}</span>
          </div>
          ${has ? `<ul class="today-bucket-list">${preview}</ul>` : ''}
        </div>`;
    };

    hero.innerHTML =
      bucket('today',   '📍', '今天',  todayItems) +
      bucket('overdue', '⚠️', '逾期',  overdueItems) +
      bucket('high',    '🔴', '高优',  highItems);

    // bucket click → toggle quickfilter
    hero.querySelectorAll('.today-bucket').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.tagName === 'LI' && e.target.dataset.id) {
          openEdit(e.target.dataset.id);
          return;
        }
        const key = el.dataset.bucket;
        const newVal = filter.quickfilter === key ? '' : key;
        filter.quickfilter = newVal;
        // sync chip state
        const grp = $('#filter-quick');
        if (grp) {
          grp.querySelectorAll('.chip').forEach(c => {
            c.classList.toggle('active', c.dataset.value === newVal);
          });
        }
        render();
      });
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
        // AI 返回的元数据用 result，表单里手动填的优先（手动 > AI）
        const aiMeta = {
          tag: meta.tag || (result.tags && result.tags[0] && tags.find(t => t.name === result.tags[0]) ? result.tags[0] : ''),
          priority: meta.priority || result.priority || '',
          due: meta.due || result.due || '',
          repeat: meta.repeat
        };
        const newItem = addItem({ title, status: result.type, ...aiMeta, aiClassified: true });
        if (newItem) {
          resetQuickAdd();
          showClassifyToast(result, title, aiMeta, newItem.id);
          // 如果 AI 拆出了子任务，弹一个二级 toast 询问是否生成
          if (result.subtasks && result.subtasks.length > 0) {
            offerSubtasks(newItem.id, result.subtasks);
          }
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

  /** Offer to spawn AI-suggested subtasks as child todo cards. */
  function offerSubtasks(parentId, subs) {
    const parent = items.find(x => x.id === parentId);
    if (!parent || subs.length === 0) return;
    setTimeout(() => {
      const el = $('#toast');
      el.textContent = `📋 AI 拆出 ${subs.length} 个子任务，点这里生成 →`;
      el.classList.remove('hidden');
      el.classList.add('clickable');
      el.onclick = () => {
        // insert each subtask as a sibling todo (kept simple; no deep tree UI)
        subs.forEach(s => {
          addItem({
            title: s,
            status: 'todo',
            tag: parent.tag,
            priority: parent.priority,
            aiClassified: true,
            parentId: parent.id
          });
        });
        toast(`✅ 已生成 ${subs.length} 个子任务`);
      };
      clearTimeout(el._t);
      el._t = setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('clickable');
        el.onclick = null;
      }, 8000);
    }, 1200); // 等主 toast 先显示一会
  }

  /**
   * Show a classification toast with the AI verdict + an "改判" action that
   * moves the most-recently-added item to the opposite column. Falls back to
   * a plain toast if #toast-action infrastructure isn't present.
   */
  function showClassifyToast(result, title, meta, newId) {
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
        repeat: $('#edit-repeat').value,
        aiClassified: false   // 用户编辑过 → 移除 AI 角标
      });
      closeEdit();
      toast('✅ 已保存');
    }
    // 编辑面板里的 🤖 重判按钮
    const editReclass = $('#edit-reclassify');
    if (editReclass) {
      editReclass.addEventListener('click', async () => {
        if (!editingId) return;
        const id = editingId;
        closeEdit();
        await reclassifyCard(id);
      });
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
      const aiEp = $('#cfg-ai-endpoint'); if (aiEp) aiEp.value = settings.aiEndpoint || '';
      const aiKey = $('#cfg-ai-key');     if (aiKey) aiKey.value = settings.aiKey || '';
      const aiModel = $('#cfg-ai-model'); if (aiModel) aiModel.value = settings.aiModel || '';
      $('#cfg-status').textContent = settings.token ? '✅ 已配置' : '尚未配置';
      $('#settings-modal').classList.remove('hidden');
    });
    $('#cfg-save').addEventListener('click', () => {
      settings.token = $('#cfg-token').value.trim();
      settings.repo  = $('#cfg-repo').value.trim();
      settings.autosync = $('#cfg-autosync').checked;
      const aiEp = $('#cfg-ai-endpoint'); if (aiEp) settings.aiEndpoint = aiEp.value.trim() || 'https://yunwu.ai/v1/chat/completions';
      const aiKey = $('#cfg-ai-key');     if (aiKey) settings.aiKey = aiKey.value.trim();
      const aiModel = $('#cfg-ai-model'); if (aiModel) settings.aiModel = aiModel.value.trim() || 'deepseek-chat';
      saveSettings();
      $('#cfg-status').textContent = '✅ 已保存';
      toast('设置已保存' + (settings.aiKey ? ' · 🤖 AI 已启用' : ''));
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
  /** 在指定方向上选择下一张卡片。dir: +1 (下/J) or -1 (上/K). */
  function moveSelection(dir) {
    const cards = $$('.col-body .card');
    if (cards.length === 0) return;
    let idx = cards.findIndex(c => c.dataset.id === selectedCardId);
    if (idx < 0) idx = dir > 0 ? -1 : cards.length;
    let next = idx + dir;
    if (next < 0) next = cards.length - 1;
    if (next >= cards.length) next = 0;
    selectedCardId = cards[next].dataset.id;
    $$('.card.selected').forEach(c => c.classList.remove('selected'));
    cards[next].classList.add('selected');
    cards[next].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** 把焦点选中跳到指定列首张卡片。 */
  function focusColumn(status) {
    const col = document.querySelector(`.col-body[data-drop="${status}"]`);
    if (!col) return;
    const first = col.querySelector('.card');
    if (first) {
      selectedCardId = first.dataset.id;
      $$('.card.selected').forEach(c => c.classList.remove('selected'));
      first.classList.add('selected');
      first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function setupShortcuts() {
    document.addEventListener('keydown', e => {
      // Esc closes modals + clears selection
      if (e.key === 'Escape') {
        $$('.modal').forEach(m => m.classList.add('hidden'));
        if (selectedCardId) {
          selectedCardId = null;
          $$('.card.selected').forEach(c => c.classList.remove('selected'));
        }
        return;
      }
      // Cmd/Ctrl+Z undo
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        if (e.target.matches('input, textarea, select')) return;
        e.preventDefault(); undoLast(); return;
      }
      // Don't trigger single-letter shortcuts in inputs
      if (e.target.matches('input, textarea, select')) return;

      const sel = selectedCardId ? items.find(x => x.id === selectedCardId && !x.deleted) : null;

      // ---- Card navigation (works without selection too) ----
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveSelection(+1); return; }
      if (e.key === 'k' || e.key === 'ArrowUp')   { e.preventDefault(); moveSelection(-1); return; }

      // ---- Card actions (require selection) ----
      if (sel) {
        // Status: 1/2/3 → idea/todo/done
        if (e.key === '1') { e.preventDefault(); updateItem(sel.id, { status: 'idea' }); return; }
        if (e.key === '2') { e.preventDefault(); updateItem(sel.id, { status: 'todo' }); return; }
        if (e.key === '3') { e.preventDefault(); updateItem(sel.id, { status: 'done' }); return; }
        // Priority: ! @ # → high / mid / low
        if (e.key === '!') { e.preventDefault(); updateItem(sel.id, { priority: 'high' }); toast('🔴 高优'); return; }
        if (e.key === '@') { e.preventDefault(); updateItem(sel.id, { priority: 'mid'  }); toast('🟡 中优'); return; }
        if (e.key === '#') { e.preventDefault(); updateItem(sel.id, { priority: 'low'  }); toast('🟢 低优'); return; }
        // T → set due to today
        if (e.key === 't') { e.preventDefault(); updateItem(sel.id, { due: todayStr() }); toast('📅 今天到期'); return; }
        // E / Enter → edit
        if (e.key === 'e' || e.key === 'Enter') { e.preventDefault(); openEdit(sel.id); return; }
        // D / Backspace → delete
        if (e.key === 'd' || e.key === 'Backspace') { e.preventDefault(); deleteItem(sel.id); selectedCardId = null; return; }
        // R → reclassify with AI
        if (e.key === 'r') { e.preventDefault(); reclassifyCard(sel.id); return; }
      }

      // ---- Global shortcuts (with modifier or special chars) ----
      switch (e.key) {
        case 'n': case 'N':
          e.preventDefault(); $('#quick-input').focus(); break;
        case '/':
          e.preventDefault(); $('#search').focus(); break;
        case '?':
          e.preventDefault(); $('#help-modal').classList.remove('hidden'); break;
        case 'T':  // Shift+T → 主题切换（避免和单 T 设今天冲突）
          if (e.shiftKey) { toggleTheme(); }
          break;
        case 'S':  // Shift+S → 同步
          if (e.shiftKey && settings.token) { pullFromCloud().then(() => pushToCloud()); }
          break;
      }
    });

    // 点击空白处取消选中
    document.addEventListener('click', e => {
      if (!e.target.closest('.card') && !e.target.closest('.today-bucket') && !e.target.closest('button')) {
        if (selectedCardId) {
          selectedCardId = null;
          $$('.card.selected').forEach(c => c.classList.remove('selected'));
        }
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

    // 🪄 全部重判按钮
    const reclassBtn = $('#reclassify-all-btn');
    if (reclassBtn) reclassBtn.addEventListener('click', reclassifyAll);

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
