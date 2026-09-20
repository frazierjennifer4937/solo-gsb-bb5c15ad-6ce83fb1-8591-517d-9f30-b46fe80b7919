/* 匿名化引擎（纯函数，浏览器与 Node 共用）
 *
 * 规则：
 * 1. 显式框选最高优先：框选片段占据其字符区间，称呼命中与保留原文例外与之重叠时让位；
 * 2. 保留原文例外：映射表中的称呼命中可标记为例外，例外按原稿字符区间记录，
 *    屏蔽与该区间重叠的所有自动称呼命中；例外本身不替换（原稿原文进入预览），
 *    其与显式框选重叠的部分仍被框选覆盖；
 * 3. 最长称呼优先：称呼命中之间重叠时，更长者优先，长度相同则位置靠前者优先；
 * 4. 原稿不被改动：仅生成预览文本与双向字符区间映射。
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
   * 计算 [start,end) 被若干互不重叠且已排序的区间覆盖后剩余的子区间
   */
  function subtractClips(start, end, covers) {
    var clips = [];
    var s = start;
    covers.forEach(function (c) {
      if (c[1] <= s || c[0] >= end) return;          // 与当前剩余区间不相交
      if (c[0] > s) clips.push([s, c[0]]);            // 覆盖起点之前的空隙保留
      s = Math.max(s, c[1] < end ? c[1] : end);       // 截到例外终点为止
    });
    if (s < end) clips.push([s, end]);
    return clips;
  }

  /**
   * @param {string} text 原稿
   * @param {Array} persons [{ id, codename, aliases: [] }]
   * @param {Array} selections [{ id, start, end, personId }] 显式框选
   * @param {Array} exceptions [{ id, start, end, personId }] 保留原文例外（来源人物）
   * @returns {{ preview: string, map: Array, exceptions: Array }}
   *   map 项: { id, oStart, oEnd, pStart, pEnd, personId, explicit }
   *   exceptions 项: { id, start, end, personId, ranges: [{oStart,oEnd,pStart,pEnd}] }
   *     ranges 为例外未被显式框选覆盖、在原稿与预览中均保留原文的可见片段（可能为空或多段）
   */
  function anonymize(text, persons, selections, exceptions) {
    var byId = {};
    persons.forEach(function (p) { byId[p.id] = p; });

    var claimed = []; // 已被占用的字符区间 [[s,e),...]：显式框选 + 保留原文例外 + 已采纳称呼
    var reps = [];    // 最终替换项

    // 1) 显式框选最高优先占位
    selections.forEach(function (s) {
      if (!byId[s.personId]) return;
      reps.push({ start: s.start, end: s.end, personId: s.personId, explicit: true });
      claimed.push([s.start, s.end]);
    });

    // 2) 保留原文例外占位（自身不替换，仅屏蔽自动称呼命中）
    var validExceptions = [];
    (exceptions || []).forEach(function (e) {
      if (!byId[e.personId]) return;
      validExceptions.push(e);
      claimed.push([e.start, e.end]);
    });

    // 3) 收集所有称呼命中
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
      if (overlaps(h.start, h.end)) return; // 与框选/例外/更长称呼重叠，让位
      h.explicit = false;
      reps.push(h);
      claimed.push([h.start, h.end]);
    });

    // 4) 按原稿顺序合并“替换段”与“例外保留段”，生成预览与双向映射
    reps.sort(function (a, b) { return a.start - b.start; });
    var explicitClips = reps.filter(function (r) { return r.explicit; })
      .map(function (r) { return [r.start, r.end]; });

    var segments = reps.map(function (r) { return { kind: 'rep', r: r, start: r.start, end: r.end }; });
    var excOut = {}; // id -> 输出项
    validExceptions.forEach(function (e) {
      var rec = { id: e.id, start: e.start, end: e.end, personId: e.personId, ranges: [] };
      excOut[e.id] = rec;
      // 例外与显式框选重叠的部分让位给框选，其余部分作为保留段进入预览
      subtractClips(e.start, e.end, explicitClips).forEach(function (clip) {
        segments.push({ kind: 'keep', start: clip[0], end: clip[1], rec: rec });
      });
    });
    segments.sort(function (a, b) { return a.start - b.start; });

    var preview = '';
    var map = [];
    var cursor = 0;
    var idx = 0;
    segments.forEach(function (seg) {
      if (seg.start > cursor) preview += text.slice(cursor, seg.start);
      if (seg.kind === 'rep') {
        var r = seg.r;
        var person = byId[r.personId];
        if (person) {
          var pStart = preview.length;
          preview += '【' + person.codename + '】';
          map.push({
            id: idx,
            oStart: r.start, oEnd: r.end,
            pStart: pStart, pEnd: preview.length,
            personId: r.personId, explicit: r.explicit
          });
        }
        idx += 1;
      } else {
        // 保留原文：原文片段原样进入预览，记录两侧区间供双向高亮
        var kStart = preview.length;
        preview += text.slice(seg.start, seg.end);
        seg.rec.ranges.push({
          oStart: seg.start, oEnd: seg.end,
          pStart: kStart, pEnd: preview.length
        });
      }
      cursor = seg.end;
    });
    preview += text.slice(cursor);

    return {
      preview: preview,
      map: map,
      exceptions: validExceptions.map(function (e) { return excOut[e.id]; })
    };
  }

  return { anonymize: anonymize };
});
