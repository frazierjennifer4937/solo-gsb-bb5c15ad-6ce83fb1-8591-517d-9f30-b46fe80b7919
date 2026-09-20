/* 匿名化引擎（纯函数，浏览器与 Node 共用）
 *
 * 规则：
 * 1. 显式框选优先：框选片段占据其字符区间，称呼命中与之重叠时让位；
 * 2. 最长称呼优先：称呼命中之间重叠时，更长者优先，长度相同则位置靠前者优先；
 * 3. 原稿不被改动：仅生成预览文本与双向字符区间映射。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Anonymizer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {string} text 原稿
   * @param {Array} persons [{ id, codename, aliases: [] }]
   * @param {Array} selections [{ start, end, personId }] 显式框选
   * @returns {{ preview: string, map: Array }} 预览文本与双向区间映射
   *   map 项: { id, oStart, oEnd, pStart, pEnd, personId, explicit }
   */
  function anonymize(text, persons, selections) {
    var byId = {};
    persons.forEach(function (p) { byId[p.id] = p; });

    var claimed = []; // 已被占用的字符区间 [[s,e),...]
    var reps = [];    // 最终替换项

    // 1) 显式框选优先占位
    selections.forEach(function (s) {
      if (!byId[s.personId]) return;
      reps.push({ start: s.start, end: s.end, personId: s.personId, explicit: true });
      claimed.push([s.start, s.end]);
    });

    // 2) 收集所有称呼命中
    var hits = [];
    persons.forEach(function (p) {
      p.aliases.forEach(function (alias) {
        if (!alias) return;
        var i = text.indexOf(alias);
        while (i !== -1) {
          hits.push({ start: i, end: i + alias.length, personId: p.id });
          i = text.indexOf(alias, i + 1);
        }
      });
    });

    // 最长称呼优先；长度相同则位置靠前者优先
    hits.sort(function (a, b) {
      return (b.end - b.start) - (a.end - a.start) || a.start - b.start;
    });

    function overlaps(s, e) {
      return claimed.some(function (c) { return s < c[1] && e > c[0]; });
    }
    hits.forEach(function (h) {
      if (overlaps(h.start, h.end)) return; // 与显式框选或更长称呼重叠，让位
      h.explicit = false;
      reps.push(h);
      claimed.push([h.start, h.end]);
    });

    // 3) 按原稿顺序生成预览与双向映射
    reps.sort(function (a, b) { return a.start - b.start; });
    var preview = '';
    var map = [];
    var cursor = 0;
    reps.forEach(function (r, idx) {
      var person = byId[r.personId];
      if (!person) return;
      preview += text.slice(cursor, r.start);
      var label = '【' + person.codename + '】';
      var pStart = preview.length;
      preview += label;
      map.push({
        id: idx,
        oStart: r.start, oEnd: r.end,
        pStart: pStart, pEnd: preview.length,
        personId: r.personId, explicit: r.explicit
      });
      cursor = r.end;
    });
    preview += text.slice(cursor);
    return { preview: preview, map: map };
  }

  return { anonymize: anonymize };
});
