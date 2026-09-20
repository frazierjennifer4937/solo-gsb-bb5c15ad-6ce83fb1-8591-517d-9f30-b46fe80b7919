/* 访谈稿匿名化映射编辑器 —— 前端逻辑
 *
 * 核心规则：
 * 1. 显式框选最高优先：用户框选的片段占据其字符区间，称呼命中与保留原文例外与之重叠时让位；
 * 2. 保留原文例外：称呼命中可标为例外，按原稿字符区间记录并屏蔽与之重叠的自动称呼命中，
 *    例外自身不匿名；显式框选仍可覆盖例外；
 * 3. 最长称呼优先：称呼命中之间发生重叠时，更长的称呼优先，长度相同则先出现者优先；
 * 4. 原稿永不改动：匿名结果只体现在预览中，同时维护双向字符区间映射。
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  var state = {
    text: '',          // 原稿（加载后只读）
    persons: [],       // { id, codename, aliases:[], color }
    selections: [],    // { id, start, end, personId } 显式框选
    exceptions: [],    // { id, start, end, personId } 保留原文例外
    history: [],       // { type, ... } 用于撤销
    currentPreview: '',
    currentMap: [],    // { id, oStart, oEnd, pStart, pEnd, personId, explicit }
    currentExceptions: [] // { id, start, end, personId, ranges:[{oStart,oEnd,pStart,pEnd}] }
  };
  var personSeq = 1;
  var selSeq = 1;
  var excSeq = 1;

  var PALETTE = ['#ffe08a', '#b5e0a8', '#a8d8ff', '#ffc6c6', '#e3c6ff', '#ffd9a8', '#a8e6e0', '#f5c6e0'];

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var inputSection = $('inputSection'), editorSection = $('editorSection');
  var textInput = $('textInput');
  var originalView = $('originalView'), previewView = $('previewView');
  var personForm = $('personForm'), codenameInput = $('codenameInput'), aliasesInput = $('aliasesInput');
  var personList = $('personList'), statsEl = $('stats');
  var mappingBody = document.querySelector('#mappingTable tbody');
  var exceptionList = $('exceptionList'), exceptionEmpty = $('exceptionEmpty');
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
    return Anonymizer.anonymize(state.text, state.persons, state.selections, state.exceptions);
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
      span.className = 'frag' + (iv.explicit ? ' explicit' : '') + (iv.except ? ' except' : '');
      span.dataset.mid = iv.id;
      if (iv.except) span.dataset.eid = iv.eid;
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
    state.currentExceptions = result.exceptions;

    // 合并替换映射与例外保留区间（按起点排序，互不重叠）
    var oIntervals = [];
    var pIntervals = [];
    result.map.forEach(function (m) {
      var p = personById(m.personId);
      var color = p ? p.color : '';
      oIntervals.push({ id: m.id, start: m.oStart, end: m.oEnd, explicit: m.explicit, color: color });
      pIntervals.push({ id: m.id, start: m.pStart, end: m.pEnd, explicit: m.explicit, color: color });
    });
    result.exceptions.forEach(function (e) {
      var p = personById(e.personId);
      var color = p ? p.color : '';
      e.ranges.forEach(function (rg) {
        oIntervals.push({ id: 'e' + e.id, eid: e.id, start: rg.oStart, end: rg.oEnd, except: true, color: color });
        pIntervals.push({ id: 'e' + e.id, eid: e.id, start: rg.pStart, end: rg.pEnd, except: true, color: color });
      });
    });
    oIntervals.sort(function (a, b) { return a.start - b.start; });
    pIntervals.sort(function (a, b) { return a.start - b.start; });

    renderView(originalView, state.text, oIntervals);
    renderView(previewView, result.preview, pIntervals);
    renderPersons();
    renderMapping(result.map);
    renderExceptions(result.exceptions);
    renderStats(result.map, result.exceptions);

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

  // 判断某个替换映射的原稿区间是否已被例外覆盖（用于禁用“保留原文”）
  function mapCoveredByException(m) {
    return state.exceptions.some(function (e) {
      return e.personId === m.personId && e.start <= m.oStart && e.end >= m.oEnd;
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
        state.currentPreview.slice(m.pStart, m.pEnd),
        null // 操作
      ];
      cells.forEach(function (c, ci) {
        var td = document.createElement('td');
        if (ci === 2) {
          td.textContent = m.explicit ? '显式框选' : '称呼命中';
          td.className = m.explicit ? 'src-explicit' : 'src-alias';
        } else if (ci === 7) {
          var btn = document.createElement('button');
          btn.className = 'btn-small';
          btn.textContent = '保留原文';
          if (m.explicit) {
            btn.disabled = true;
            btn.title = '显式框选保持最高优先级，不能设为例外';
          } else if (mapCoveredByException(m)) {
            btn.disabled = true;
            btn.title = '该区间已在保留原文例外中';
          } else {
            btn.title = '将此称呼命中标记为例外：保留原文、不匿名';
            btn.addEventListener('click', function (ev) {
              ev.stopPropagation();
              addException(m.personId, m.oStart, m.oEnd);
            });
          }
          td.appendChild(btn);
        } else {
          td.textContent = c;
        }
        tr.appendChild(td);
      });
      tr.addEventListener('click', function () { activate(String(m.id), true); });
      mappingBody.appendChild(tr);
    });
  }

  function renderExceptions(exceptions) {
    exceptionList.innerHTML = '';
    exceptionEmpty.classList.toggle('hidden', exceptions.length > 0);
    exceptions.forEach(function (e) {
      var p = personById(e.personId);
      var li = document.createElement('li');
      li.className = 'exception-item';
      li.title = '点击定位原稿与预览中的对应位置';
      li.addEventListener('click', function () { activate('e' + e.id, true); });

      var frag = document.createElement('span');
      frag.className = 'exc-frag';
      frag.textContent = state.text.slice(e.start, e.end);

      var meta = document.createElement('span');
      meta.className = 'exc-meta';
      meta.textContent = '来源人物：' + (p ? p.codename : '（已删除）') +
        ' ｜ 原稿区间 [' + e.start + ', ' + e.end + ')';
      if (!e.ranges.length) meta.textContent += ' ｜ 当前被显式框选完全覆盖';

      var restore = document.createElement('button');
      restore.className = 'btn-small exc-restore';
      restore.textContent = '恢复匿名';
      restore.title = '删除该例外，恢复该区间的自动称呼命中';
      restore.addEventListener('click', function (ev) {
        ev.stopPropagation();
        removeException(e.id);
      });

      li.appendChild(frag);
      li.appendChild(meta);
      li.appendChild(restore);
      exceptionList.appendChild(li);
    });
  }

  function renderStats(map, exceptions) {
    var explicit = map.filter(function (m) { return m.explicit; }).length;
    statsEl.textContent = '人物 ' + state.persons.length + ' 位 ｜ 共匿名化 ' + map.length +
      ' 处（框选 ' + explicit + ' · 称呼 ' + (map.length - explicit) +
      '）｜ 保留原文例外 ' + exceptions.length + ' 处';
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

  function addException(personId, start, end) {
    if (!personById(personId)) return;
    var dup = state.exceptions.some(function (e) {
      return e.personId === personId && e.start === start && e.end === end;
    });
    if (dup) { toast('该片段已在保留原文例外中'); return; }
    var exc = { id: excSeq++, start: start, end: end, personId: personId };
    state.exceptions.push(exc);
    state.history.push({ type: 'exception-add', exception: exc });
    render();
    toast('已标记保留原文，自动称呼命中将与此区间避让');
  }

  function removeException(id, recordHistory) {
    var exc = null;
    state.exceptions = state.exceptions.filter(function (e) {
      if (e.id === id) { exc = e; return false; }
      return true;
    });
    if (!exc) return;
    if (recordHistory !== false) state.history.push({ type: 'exception-remove', exception: exc });
    render();
    if (recordHistory !== false) toast('已恢复匿名');
  }

  function removePerson(id) {
    var person = personById(id);
    if (!person) return;
    // 人物删除连同其框选与例外一并删除，整体进入撤销栈
    var removedSels = state.selections.filter(function (s) { return s.personId === id; });
    var removedExcs = state.exceptions.filter(function (e) { return e.personId === id; });
    state.persons = state.persons.filter(function (p) { return p.id !== id; });
    state.selections = state.selections.filter(function (s) { return s.personId !== id; });
    state.exceptions = state.exceptions.filter(function (e) { return e.personId !== id; });
    state.history.push({
      type: 'person-delete',
      person: person,
      selections: removedSels,
      exceptions: removedExcs
    });
    render();
  }

  // 恢复对象时分配新的自增 id，避免与删除后新建的记录冲突
  function reassignId(obj, seqName) {
    var copy = { start: obj.start, end: obj.end, personId: obj.personId };
    if (seqName === 'sel') copy.id = selSeq++;
    else copy.id = excSeq++;
    return copy;
  }

  function undo() {
    var action = state.history.pop();
    if (!action) return;
    var i, restored;
    if (action.type === 'person') {
      state.persons = state.persons.filter(function (p) { return p.id !== action.person.id; });
      state.selections = state.selections.filter(function (s) { return s.personId !== action.person.id; });
      state.exceptions = state.exceptions.filter(function (e) { return e.personId !== action.person.id; });
      toast('已撤销人物「' + action.person.codename + '」');
    } else if (action.type === 'selection') {
      state.selections = state.selections.filter(function (s) { return s.id !== action.selection.id; });
      toast('已撤销一次框选');
    } else if (action.type === 'exception-add') {
      state.exceptions = state.exceptions.filter(function (e) { return e.id !== action.exception.id; });
      toast('已撤销保留原文标记');
    } else if (action.type === 'exception-remove') {
      state.exceptions.push(action.exception);
      toast('已撤销恢复匿名');
    } else if (action.type === 'person-delete') {
      state.persons.push(action.person);
      for (i = 0; i < action.selections.length; i++) {
        restored = reassignId(action.selections[i], 'sel');
        state.selections.push(restored);
      }
      for (i = 0; i < action.exceptions.length; i++) {
        restored = reassignId(action.exceptions[i], 'exc');
        state.exceptions.push(restored);
      }
      toast('已恢复人物「' + action.person.codename + '」及其规则');
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
    state.exceptions = [];
    state.history = [];
    state.currentPreview = '';
    state.currentMap = [];
    state.currentExceptions = [];
    personSeq = 1;
    selSeq = 1;
    excSeq = 1;
    inputSection.classList.add('hidden');
    editorSection.classList.remove('hidden');
    $('btnResetText').classList.remove('hidden');
    render();
  }

  $('btnResetText').addEventListener('click', function () {
    if ((state.persons.length || state.selections.length || state.exceptions.length) &&
        !window.confirm('重新粘贴将清空当前所有人物规则、框选与例外，确定继续？')) return;
    textInput.value = state.text;
    editorSection.classList.add('hidden');
    inputSection.classList.remove('hidden');
    $('btnResetText').classList.add('hidden');
    state.text = '';
    state.persons = [];
    state.selections = [];
    state.exceptions = [];
    state.history = [];
    state.currentPreview = '';
    state.currentMap = [];
    state.currentExceptions = [];
    personSeq = 1;
    selSeq = 1;
    excSeq = 1;
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
