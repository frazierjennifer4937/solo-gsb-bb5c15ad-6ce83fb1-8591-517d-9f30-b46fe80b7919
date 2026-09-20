/* 访谈稿匿名化映射编辑器 —— 前端逻辑
 *
 * 核心规则：
 * 1. 显式框选优先：用户框选的片段占据其字符区间，任何称呼命中与之重叠时让位；
 * 2. 最长称呼优先：称呼命中之间发生重叠时，更长的称呼优先，长度相同则先出现者优先；
 * 3. 原稿永不改动：匿名结果只体现在预览中，同时维护双向字符区间映射。
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  var state = {
    text: '',          // 原稿（加载后只读）
    persons: [],       // { id, codename, aliases:[], color }
    selections: [],    // { id, start, end, personId } 显式框选
    history: [],       // { type:'person'|'selection', ... } 用于撤销
    currentPreview: '',
    currentMap: []     // { id, oStart, oEnd, pStart, pEnd, personId, explicit }
  };
  var personSeq = 1;
  var selSeq = 1;

  var PALETTE = ['#ffe08a', '#b5e0a8', '#a8d8ff', '#ffc6c6', '#e3c6ff', '#ffd9a8', '#a8e6e0', '#f5c6e0'];

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var inputSection = $('inputSection'), editorSection = $('editorSection');
  var textInput = $('textInput');
  var originalView = $('originalView'), previewView = $('previewView');
  var personForm = $('personForm'), codenameInput = $('codenameInput'), aliasesInput = $('aliasesInput');
  var personList = $('personList'), statsEl = $('stats');
  var mappingBody = document.querySelector('#mappingTable tbody');
  var selPopup = $('selPopup'), popupPerson = $('popupPerson'), popupNewFields = $('popupNewFields');
  var popupCodename = $('popupCodename'), popupAlias = $('popupAlias');
  var toastEl = $('toast');

  // ---------- 工具 ----------
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2200);
  }

  function parseAliases(raw) {
    return raw.split(/[,，、;；\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function personById(id) {
    for (var i = 0; i < state.persons.length; i++) {
      if (state.persons[i].id === id) return state.persons[i];
    }
    return null;
  }

  // ---------- 匿名化引擎（public/anonymize.js，纯函数） ----------
  function anonymize() {
    return Anonymizer.anonymize(state.text, state.persons, state.selections);
  }

  // ---------- 渲染 ----------
  function renderView(container, text, intervals) {
    container.innerHTML = '';
    var cursor = 0;
    intervals.forEach(function (iv) {
      if (iv.start > cursor) {
        container.appendChild(document.createTextNode(text.slice(cursor, iv.start)));
      }
      var span = document.createElement('span');
      span.className = 'frag' + (iv.explicit ? ' explicit' : '');
      span.dataset.mid = iv.id;
      span.textContent = text.slice(iv.start, iv.end);
      span.style.background = iv.color;
      container.appendChild(span);
      cursor = iv.end;
    });
    if (cursor < text.length) {
      container.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  function render() {
    var result = anonymize();
    state.currentPreview = result.preview;
    state.currentMap = result.map;

    // 原稿侧区间
    var oIntervals = result.map.map(function (m) {
      var p = personById(m.personId);
      return { id: m.id, start: m.oStart, end: m.oEnd, explicit: m.explicit, color: p.color };
    });
    // 预览侧区间（同一 id，实现双向对应）
    var pIntervals = result.map.map(function (m) {
      var p = personById(m.personId);
      return { id: m.id, start: m.pStart, end: m.pEnd, explicit: m.explicit, color: p.color };
    });

    renderView(originalView, state.text, oIntervals);
    renderView(previewView, result.preview, pIntervals);
    renderPersons();
    renderMapping(result.map);
    renderStats(result.map);

    $('btnUndo').disabled = state.history.length === 0;
    $('btnCopy').disabled = !state.text;
  }

  function renderPersons() {
    personList.innerHTML = '';
    state.persons.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'person-item';

      var head = document.createElement('div');
      head.className = 'person-head';
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      var name = document.createElement('span');
      name.className = 'codename';
      name.textContent = p.codename;
      var del = document.createElement('button');
      del.className = 'del';
      del.title = '删除该人物及其规则';
      del.textContent = '×';
      del.addEventListener('click', function () { removePerson(p.id); });
      head.appendChild(dot); head.appendChild(name); head.appendChild(del);
      li.appendChild(head);

      var tags = document.createElement('div');
      tags.className = 'alias-tags';
      if (p.aliases.length) {
        p.aliases.forEach(function (a) {
          var t = document.createElement('span');
          t.className = 'alias-tag';
          t.textContent = a;
          tags.appendChild(t);
        });
      } else {
        var em = document.createElement('span');
        em.className = 'alias-empty';
        em.textContent = '（未登记称呼，仅框选生效）';
        tags.appendChild(em);
      }
      li.appendChild(tags);
      personList.appendChild(li);
    });
  }

  function renderMapping(map) {
    mappingBody.innerHTML = '';
    map.forEach(function (m, i) {
      var p = personById(m.personId);
      var tr = document.createElement('tr');
      tr.dataset.mid = m.id;
      var cells = [
        String(i + 1),
        p.codename,
        null, // 来源
        '[' + m.oStart + ', ' + m.oEnd + ')',
        state.text.slice(m.oStart, m.oEnd),
        '[' + m.pStart + ', ' + m.pEnd + ')',
        state.currentPreview.slice(m.pStart, m.pEnd)
      ];
      cells.forEach(function (c, ci) {
        var td = document.createElement('td');
        if (ci === 2) {
          td.textContent = m.explicit ? '显式框选' : '称呼命中';
          td.className = m.explicit ? 'src-explicit' : 'src-alias';
        } else {
          td.textContent = c;
        }
        tr.appendChild(td);
      });
      tr.addEventListener('click', function () { activate(m.id, true); });
      mappingBody.appendChild(tr);
    });
  }

  function renderStats(map) {
    var explicit = map.filter(function (m) { return m.explicit; }).length;
    statsEl.textContent = '人物 ' + state.persons.length + ' 位 ｜ 共匿名化 ' + map.length +
      ' 处（框选 ' + explicit + ' · 称呼 ' + (map.length - explicit) + '）';
  }

  // ---------- 双向高亮 ----------
  function clearActive() {
    document.querySelectorAll('.frag.active').forEach(function (el) { el.classList.remove('active'); });
  }

  function activate(mid, scroll) {
    clearActive();
    var targets = document.querySelectorAll('.frag[data-mid="' + mid + '"]');
    targets.forEach(function (el) { el.classList.add('active'); });
    if (scroll && targets.length) {
      targets.forEach(function (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  [originalView, previewView].forEach(function (view) {
    view.addEventListener('click', function (e) {
      var frag = e.target.closest('.frag');
      if (!frag) { clearActive(); return; }
      activate(frag.dataset.mid, true);
    });
    // 悬停时联动另一侧
    view.addEventListener('mouseover', function (e) {
      var frag = e.target.closest('.frag');
      document.querySelectorAll('.frag.match').forEach(function (el) { el.classList.remove('match'); });
      if (!frag) return;
      document.querySelectorAll('.frag[data-mid="' + frag.dataset.mid + '"]').forEach(function (el) {
        if (el !== frag) el.classList.add('match');
      });
    });
    view.addEventListener('mouseleave', function () {
      document.querySelectorAll('.frag.match').forEach(function (el) { el.classList.remove('match'); });
    });
  });

  // ---------- 规则操作 ----------
  function addPerson(codename, aliases, recordHistory) {
    var person = {
      id: personSeq++,
      codename: codename,
      aliases: aliases,
      color: PALETTE[(personSeq - 2) % PALETTE.length]
    };
    state.persons.push(person);
    if (recordHistory !== false) state.history.push({ type: 'person', person: person });
    render();
    return person;
  }

  function addSelection(personId, start, end) {
    var clash = state.selections.some(function (s) { return start < s.end && end > s.start; });
    if (clash) { toast('所选区间与已有框选重叠'); return false; }
    var sel = { id: selSeq++, start: start, end: end, personId: personId };
    state.selections.push(sel);
    state.history.push({ type: 'selection', selection: sel });
    render();
    return true;
  }

  function removePerson(id) {
    state.persons = state.persons.filter(function (p) { return p.id !== id; });
    state.selections = state.selections.filter(function (s) { return s.personId !== id; });
    render();
  }

  function undo() {
    var action = state.history.pop();
    if (!action) return;
    if (action.type === 'person') {
      state.persons = state.persons.filter(function (p) { return p.id !== action.person.id; });
      state.selections = state.selections.filter(function (s) { return s.personId !== action.person.id; });
      toast('已撤销人物「' + action.person.codename + '」');
    } else {
      state.selections = state.selections.filter(function (s) { return s.id !== action.selection.id; });
      toast('已撤销一次框选');
    }
    render();
  }

  // ---------- 框选 ----------
  var pendingSel = null; // { start, end }

  function selectionOffsets() {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    if (!originalView.contains(range.startContainer) || !originalView.contains(range.endContainer)) return null;
    var pre = document.createRange();
    pre.selectNodeContents(originalView);
    pre.setEnd(range.startContainer, range.startOffset);
    var start = pre.toString().length;
    var end = start + range.toString().length;
    if (end <= start) return null;
    return { start: start, end: end, rect: range.getBoundingClientRect() };
  }

  function openPopup(info) {
    pendingSel = info;
    // 填充人物下拉
    popupPerson.innerHTML = '';
    var optNew = document.createElement('option');
    optNew.value = '__new';
    optNew.textContent = '＋ 新建人物…';
    popupPerson.appendChild(optNew);
    state.persons.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.codename;
      popupPerson.appendChild(o);
    });
    popupNewFields.classList.remove('hidden');
    popupCodename.value = '';
    popupAlias.value = state.text.slice(info.start, info.end);

    var x = Math.min(info.rect.left, window.innerWidth - 270);
    var y = info.rect.bottom + 8;
    if (y + 200 > window.innerHeight) y = info.rect.top - 210;
    selPopup.style.left = Math.max(8, x) + 'px';
    selPopup.style.top = Math.max(8, y) + 'px';
    selPopup.classList.remove('hidden');
  }

  function closePopup() {
    selPopup.classList.add('hidden');
    pendingSel = null;
  }

  originalView.addEventListener('mouseup', function () {
    setTimeout(function () {
      var info = selectionOffsets();
      if (info) openPopup(info);
    }, 10);
  });

  popupPerson.addEventListener('change', function () {
    popupNewFields.classList.toggle('hidden', popupPerson.value !== '__new');
  });

  $('popupOk').addEventListener('click', function () {
    if (!pendingSel) return;
    var personId;
    if (popupPerson.value === '__new') {
      var codename = popupCodename.value.trim();
      if (!codename) { toast('请填写统一代号'); return; }
      var aliases = parseAliases(popupAlias.value);
      var person = addPerson(codename, aliases); // 人物规则入历史
      personId = person.id;
    } else {
      personId = Number(popupPerson.value);
    }
    if (addSelection(personId, pendingSel.start, pendingSel.end)) {
      window.getSelection().removeAllRanges();
      closePopup();
    }
  });

  $('popupCancel').addEventListener('click', function () {
    window.getSelection().removeAllRanges();
    closePopup();
  });

  document.addEventListener('mousedown', function (e) {
    if (!selPopup.classList.contains('hidden') && !selPopup.contains(e.target) && e.target !== originalView) {
      // 点击弹窗以外区域时关闭（在原稿上重新框选会由 mouseup 重新打开）
      if (!originalView.contains(e.target)) closePopup();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePopup();
  });

  // ---------- 顶部操作 ----------
  $('btnLoadText').addEventListener('click', function () {
    var text = textInput.value;
    if (!text.trim()) { toast('请先粘贴访谈原稿'); return; }
    loadText(text);
  });

  function loadText(text) {
    state.text = text;
    state.persons = [];
    state.selections = [];
    state.history = [];
    inputSection.classList.add('hidden');
    editorSection.classList.remove('hidden');
    $('btnResetText').classList.remove('hidden');
    render();
  }

  $('btnResetText').addEventListener('click', function () {
    if ((state.persons.length || state.selections.length) &&
        !window.confirm('重新粘贴将清空当前所有人物规则与框选，确定继续？')) return;
    textInput.value = state.text;
    editorSection.classList.add('hidden');
    inputSection.classList.remove('hidden');
    $('btnResetText').classList.add('hidden');
    state.text = '';
    state.persons = [];
    state.selections = [];
    state.history = [];
  });

  $('btnExample').addEventListener('click', function () {
    fetch('/api/example')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        loadText(data.text);
        data.persons.forEach(function (p) { addPerson(p.codename, p.aliases, false); });
        state.history = []; // 示例预置规则不计入可撤销历史
        render();
        toast('已加载内置示例');
      })
      .catch(function () { toast('示例加载失败'); });
  });

  $('btnUndo').addEventListener('click', undo);

  $('btnCopy').addEventListener('click', function () {
    var done = function () { toast('匿名预览已复制到剪贴板'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.currentPreview).then(done, function () { toast('复制失败'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = state.currentPreview;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败'); }
      document.body.removeChild(ta);
    }
  });

  // ---------- 人物表单 ----------
  personForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var codename = codenameInput.value.trim();
    if (!codename) { toast('请填写统一代号'); return; }
    var aliases = parseAliases(aliasesInput.value);
    addPerson(codename, aliases);
    codenameInput.value = '';
    aliasesInput.value = '';
    toast('已添加人物「' + codename + '」');
  });
})();
