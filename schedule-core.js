/*!
 * schedule-core.js — 课程表核心逻辑（纯函数，无 DOM 依赖，浏览器与 Node 通用）
 *
 * 核心约定（对抗式审查的重点，已集中在此文件）：
 *  1. 所有日期均按“本地时间正午”构造，避免时区 / 夏令时边界误差
 *  2. 学期第 1 周 = 学期开始日期所在的那一周（周一起始）。
 *     例如 2026-09-02（周三）开学，则第 1 周为 2026-08-31 ~ 2026-09-06
 *  3. 第 1 周默认为“单周”，即 单周 = 1,3,5…；双周 = 2,4,6…
 *     若学校校历与此不一致，可在设置中翻转或校准学期开始日期
 *  4. 周规则表示课程的周次范围与单双：
 *      {type:'all', start, end}          每周，如 1-16 周
 *      {type:'odd', start, end}          仅单周，如 1-16 周(单)
 *      {type:'even', start, end}         仅双周，如 3-15 周(双)
 *      {type:'list', weeks:[2,3,5,7]}    自定义周次列表（如“只上 4 个周”：1-4）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ScheduleCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var MS_PER_DAY = 86400000;

  /* ================= 日期工具 ================= */

  function dateAtNoon(y, m, d) {
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }

  // 'YYYY-MM-DD' -> Date（本地正午）；非法日期（如 2026-02-30）返回 null
  function parseISO(iso) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(iso == null ? '' : iso).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = dateAtNoon(y, mo, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function toISO(dt) {
    var y = dt.getFullYear();
    var mo = String(dt.getMonth() + 1).padStart(2, '0');
    var d = String(dt.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + d;
  }

  // 所在周的周一（本地正午）
  function startOfWeekMonday(dt) {
    var d = dateAtNoon(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
    var day = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
    d.setDate(d.getDate() - day);
    return d;
  }

  function addDays(dt, n) {
    var d = dateAtNoon(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }

  // a - b 的天数差（整日，按本地日历日）
  function diffDays(a, b) {
    var da = dateAtNoon(a.getFullYear(), a.getMonth() + 1, a.getDate());
    var db = dateAtNoon(b.getFullYear(), b.getMonth() + 1, b.getDate());
    return Math.round((da - db) / MS_PER_DAY);
  }

  /* ================= 周次 / 单双 ================= */

  // 学期第几周（1 起）。开课前为 <=0。semesterStart 无效/缺失时返回 NaN
  function getWeekNumber(date, semesterStart) {
    var s = null;
    if (typeof semesterStart === 'string') s = parseISO(semesterStart);
    else if (semesterStart instanceof Date) s = parseISO(toISO(semesterStart));
    if (!s) return NaN;

    var d = null;
    if (typeof date === 'string') d = parseISO(date);
    else if (date instanceof Date) d = parseISO(toISO(date));
    if (!d) return NaN;

    // 两边都归一化到“周一”，天数差必为 7 的倍数；除以 7 得周数差
    return Math.round(diffDays(startOfWeekMonday(d), startOfWeekMonday(s)) / 7) + 1;
  }

  // 是否单周。firstWeekOdd=false 时第 1 周算双周（整体翻转）
  function isOddWeek(week, firstWeekOdd) {
    var w = Math.round(week);
    var idx = w + (firstWeekOdd === false ? 1 : 0);
    return ((idx % 2) + 2) % 2 === 1;
  }

  function weekParityLabel(week, firstWeekOdd) {
    if (!Number.isFinite(week)) return '';
    return isOddWeek(week, firstWeekOdd) ? '单周' : '双周';
  }

  // 今天处于学期的什么阶段：'ok' | 'before' | 'after' | 'unset'
  function semesterStage(week, totalWeeks) {
    if (!Number.isFinite(week)) return 'unset';
    if (week < 1) return 'before';
    if (week > Math.max(1, Math.round(+totalWeeks || 0))) return 'after';
    return 'ok';
  }

  // 顶部状态文本，如 “第3周 · 单周”
  function statusText(date, config) {
    var cfg = config || {};
    var week = getWeekNumber(date, cfg.semesterStart);
    var stage = semesterStage(week, cfg.totalWeeks);
    if (stage === 'unset') return { text: '请先设置学期开始日期', cls: 'warn' };
    if (stage === 'before') return { text: '未开学（第1周从 ' + (cfg.semesterStart || '?') + ' 那周开始）', cls: 'muted' };
    if (stage === 'after') return { text: '本学期课程已结束', cls: 'muted' };
    return { text: '第' + week + '周 · ' + weekParityLabel(week, cfg.firstWeekOdd), cls: 'ok' };
  }

  /* ================= 周规则 ================= */

  // 规范化周规则；输入脏数据时做防御
  // 支持两种形态：
  //   {type:'all'|'odd'|'even', start, end}   连续区间（单双动态求值，跟随 firstWeekOdd 翻转）
  //   {type:'list'|'odd'|'even', weeks:[...]}  周次列表（type 为 odd/even 时同样动态求值）
  function normalizeWeekRule(rule) {
    if (Array.isArray(rule)) {
      return { type: 'list', weeks: sortUniqInts(rule) };
    }
    if (rule && typeof rule === 'object') {
      if (Array.isArray(rule.weeks) || rule.type === 'list') {
        var type = (rule.type === 'odd' || rule.type === 'even') ? rule.type : 'list';
        return { type: type, weeks: sortUniqInts(rule.weeks || []) };
      }
      var start = Math.max(1, Math.round(+rule.start || 1));
      var end = Math.max(start, Math.round(+rule.end || start));
      var rtype = (rule.type === 'odd' || rule.type === 'even') ? rule.type : 'all';
      return { type: rtype, start: start, end: end };
    }
    return null;
  }

  function sortUniqInts(arr) {
    var out = [];
    (arr || []).forEach(function (x) {
      var n = Math.round(+x);
      if (Number.isFinite(n) && n >= 1 && out.indexOf(n) < 0) out.push(n);
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  // 该规则在第 w 周是否上课
  function matchesWeek(rule, week, firstWeekOdd) {
    var r = normalizeWeekRule(rule);
    if (!r) return false;
    var w = Math.round(week);
    if (!Number.isFinite(w)) return false; // NaN（如学期未设置）绝不匹配，防止“今天”泄漏课程
    if (r.weeks) {
      if (r.weeks.indexOf(w) < 0) return false;
      if (r.type === 'odd') return isOddWeek(w, firstWeekOdd);
      if (r.type === 'even') return !isOddWeek(w, firstWeekOdd);
      return true;
    }
    if (w < r.start || w > r.end) return false;
    if (r.type === 'odd') return isOddWeek(w, firstWeekOdd);
    if (r.type === 'even') return !isOddWeek(w, firstWeekOdd);
    return true;
  }

  // 该规则在本学期内实际要上的周次列表（用于录入时的实时预览，防呆）
  function ruleMatchedWeeks(rule, totalWeeks, firstWeekOdd) {
    var r = normalizeWeekRule(rule);
    var tw = Math.max(1, Math.round(+totalWeeks || 20));
    if (!r) return [];
    var out = [];
    for (var w = 1; w <= tw; w++) {
      if (matchesWeek(r, w, firstWeekOdd)) out.push(w);
    }
    return out;
  }

  // 解析中文周次文本，如 "1-16周" "1-16周(单)" "3-15双周" "前4周" "前4周(单)" "双周(3-15)" "第2,3,5-7周" "单周"
  // 括号内容既可能是“单/双”，也可能是周次范围（如“双周(3-15)”）
  // 返回 {rule, error}；error 非空时 rule 为 null
  function parseWeekRule(text, totalWeeks, firstWeekOdd) {
    var tw = Math.max(1, Math.round(+totalWeeks || 20));
    var fo = firstWeekOdd !== false;
    var t = String(text == null ? '' : text).trim().replace(/[\u3000\s]+/g, '');

    if (!t || t === '每周' || t === '每星期' || t === '全周' || t === '全学期' || t === '整个学期') {
      return { rule: { type: 'all', start: 1, end: tw }, error: null };
    }

    // “前N周” = 第 1~N 周；允许带单/双后缀，如“前4周(单)”“前4周单周”
    var mPre = /^前\s*(\d{1,2})\s*周?/.exec(t);
    if (mPre) {
      var nPre = Math.min(tw, Math.max(1, +mPre[1]));
      var restPre = t.slice(mPre[0].length);
      var parityPre = null;
      if (/^[(（]\s*单/.test(restPre) || /^单/.test(restPre)) parityPre = 'odd';
      else if (/^[(（]\s*双/.test(restPre) || /^双/.test(restPre)) parityPre = 'even';
      var junkPre = restPre.replace(/[(（][^）)]*[)）]/g, '').replace(/[周第单双奇偶\s]/g, '');
      if (junkPre) return { rule: null, error: '无法识别的内容：“' + junkPre + '”' };
      var rulePre = { type: parityPre || 'all', start: 1, end: nPre };
      if (ruleMatchedWeeks(rulePre, tw, fo).length === 0) {
        return { rule: null, error: '第1-' + nPre + '周内没有符合条件的' + (parityPre === 'odd' ? '单' : '双') + '周' };
      }
      return { rule: rulePre, error: null };
    }

    // 括号内容：可能是“单/双”，也可能是周次（如“双周(3-15)”）
    var parity = null;
    var parenSpec = null;
    var parenM = /[（(]([^）)]*)[）)]/.exec(t);
    if (parenM) {
      var pc = parenM[1].trim();
      if (pc === '单') parity = 'odd';
      else if (pc === '双') parity = 'even';
      else parenSpec = pc;
      t = t.replace(/[（(][^）)]*[）)]/g, '');
    }

    if (parity === null && /单周?/.test(t)) parity = 'odd';
    if (parity === null && /双周?/.test(t)) parity = 'even';
    t = t.replace(/[周第单双奇偶]/g, '');

    if (parenSpec && t === '') t = parenSpec;
    if (t === '' || t === '每') {
      return { rule: { type: parity || 'all', start: 1, end: tw }, error: null };
    }

    var weeks = [];
    var parts = t.split(/[,，、;；]/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var r;
      if ((r = /^(\d{1,2})$/.exec(p))) {
        if (+r[1] < 1) return { rule: null, error: '周次必须 ≥ 1（“' + p + '”无效）' };
        weeks.push(+r[1]);
        continue;
      }
      if ((r = /^(\d{1,2})-(\d{1,2})$/.exec(p))) {
        var a = +r[1], b = +r[2];
        if (a < 1) return { rule: null, error: '周次必须 ≥ 1（“' + p + '”无效）' };
        if (b < a) return { rule: null, error: '周次范围“' + p + '”起止颠倒，应为如 5-8' };
        for (var w = a; w <= b; w++) weeks.push(w);
        continue;
      }
      return { rule: null, error: '无法识别的周次片段：“' + p + '”，支持如 1-16周 / 单周 / 第2,3,5-7周 / 双周(3-15)' };
    }

    if (!weeks.length) {
      return { rule: null, error: '请输入周次，例如 1-16周、3-15双周、第2,4,6周、前4周、双周(3-15)' };
    }

    var uniq = [];
    weeks.forEach(function (w) { if (uniq.indexOf(w) < 0) uniq.push(w); });
    uniq.sort(function (a, b) { return a - b; });

    // 连续区间优先保留为 range+parity 形式：
    // 好处是“单/双周”跟随设置里的 firstWeekOdd 动态求值，
    // 用户翻转单双时规则跟着翻转，而不是被冻结成解析时的周次列表
    var contiguous = true;
    for (var j = 1; j < uniq.length; j++) {
      if (uniq[j] !== uniq[j - 1] + 1) { contiguous = false; break; }
    }

    var rule;
    if (contiguous) {
      rule = { type: parity || 'all', start: uniq[0], end: uniq[uniq.length - 1] };
    } else if (parity) {
      // 非连续周次 + 单双：保留 {type:odd/even, weeks:[...]}，
      // 单双在匹配时动态求值，跟随 firstWeekOdd 翻转，而不是冻结成解析时的列表
      rule = { type: parity, weeks: uniq };
    } else {
      rule = { type: 'list', weeks: uniq };
    }

    // 防呆：规则在 1..totalWeeks 内一节课都匹配不到（如“2-2周(单)”或超出总周数）时直接报错
    if (ruleMatchedWeeks(rule, tw, fo).length === 0) {
      if (parity) {
        return { rule: null, error: '该周次范围内没有符合条件的' + (parity === 'odd' ? '单' : '双') + '周（本学期共 ' + tw + ' 周）' };
      }
      return { rule: null, error: '本学期（共 ' + tw + ' 周）内没有这些周次的课' };
    }
    return { rule: rule, error: null };
  }

  // 规则 -> 人类可读文本（用于课程列表展示与编辑框回填）
  function ruleToText(rule, totalWeeks, firstWeekOdd) {
    var r = normalizeWeekRule(rule);
    var tw = Math.max(1, Math.round(+totalWeeks || 20));
    if (!r) return '';
    var parityWord = r.type === 'odd' ? '(单)' : r.type === 'even' ? '(双)' : '';
    if (r.weeks) {
      // 列表（可能带单双）-> 压缩连续区间
      var parts = [];
      var i = 0;
      var ws = r.weeks;
      while (i < ws.length) {
        var j = i;
        while (j + 1 < ws.length && ws[j + 1] === ws[j] + 1) j++;
        parts.push(j === i ? String(ws[i]) : ws[i] + '-' + ws[j]);
        i = j + 1;
      }
      return '第' + parts.join(',') + '周' + parityWord;
    }
    if (r.start === 1 && r.end >= tw) {
      return r.type === 'odd' ? '单周' : r.type === 'even' ? '双周' : '每周';
    }
    if (r.start === r.end) return '第' + r.start + '周' + parityWord;
    return '第' + r.start + '-' + r.end + '周' + parityWord;
  }

  /* ================= 时间工具 ================= */

  // '08:05' -> 485（分钟）；非法返回 NaN
  function timeToMinutes(t) {
    if (t == null) return NaN;
    if (t instanceof Date) return t.getHours() * 60 + t.getMinutes();
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    if (!m) return NaN;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return NaN;
    return h * 60 + mi;
  }

  function minutesToTime(min) {
    if (!Number.isFinite(min)) return '';
    var m = ((Math.round(min) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  // 按开始时间排序（同日课程）
  function compareByStartTime(a, b) {
    var ta = timeToMinutes(a.startTime), tb = timeToMinutes(b.startTime);
    if (Number.isFinite(ta) && Number.isFinite(tb)) {
      if (ta !== tb) return ta - tb;
      var ea = timeToMinutes(a.endTime), eb = timeToMinutes(b.endTime);
      if (Number.isFinite(ea) && Number.isFinite(eb)) return ea - eb;
    }
    return 0;
  }

  /* ================= 节次 -> 时间（作息时间表） ================= */

  // 默认作息时间表（可在设置中修改；每行一条：第X-Y节 开始-结束）。
  // 各校作息不同，粘贴“第X-Y节”课表前请先在“设置 → 作息时间表”里核对
  var DEFAULT_PERIOD_TIMES =
    '第1-2节 08:00-09:40\n' +
    '第3-4节 10:00-11:40\n' +
    '第5-6节 14:00-15:40\n' +
    '第7-8节 16:00-17:40\n' +
    '第9-10节 19:00-20:40\n' +
    '第11-12节 20:50-22:30';

  // 解析作息表文本 -> [{from,to,start,end}]（start/end 为分钟）；非法行静默忽略
  function parsePeriodTable(text) {
    var src = (text == null || String(text).trim() === '') ? DEFAULT_PERIOD_TIMES : String(text);
    var rows = src.split(/\r?\n/);
    var out = [];
    rows.forEach(function (raw) {
      var t = normalizeLineText(raw).trim();
      if (!t) return;
      var m = /^(?:第)?\s*(\d{1,2})\s*[-~至]\s*(\d{1,2})\s*节?\s*(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})$/.exec(t);
      if (!m) return; // 只认“第X-Y节 HH:MM-HH:MM”形态（分隔空格可省略），其余行忽略
      var from = +m[1], to = +m[2];
      var s = timeToMinutes(m[3] + ':' + m[4]);
      var e = timeToMinutes(m[5] + ':' + m[6]);
      if (!(from >= 1 && to >= from && to <= 30)) return;
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
      out.push({ from: from, to: to, start: s, end: e });
    });
    return out;
  }

  // “第X-Y节” -> {start, end}（分钟）；作息表里找不到对应条目返回 null
  // 先找精确条目（如 1-2），再允许跨条目拼接（如 第1-4节 = 1-2 的开始 + 3-4 的结束）
  function resolvePeriods(x, y, table) {
    if (!(x >= 1 && y >= x && y <= 30)) return null;
    var tb = (table && table.length) ? table : parsePeriodTable('');
    for (var i = 0; i < tb.length; i++) {
      if (tb[i].from === x && tb[i].to === y) return { start: tb[i].start, end: tb[i].end };
    }
    var rs = null, re = null;
    for (var j = 0; j < tb.length; j++) {
      if (tb[j].from === x) rs = tb[j];
      if (tb[j].to === y) re = tb[j];
    }
    if (rs && re) return { start: rs.start, end: re.end };
    return null;
  }

  /* ================= 调休 / 停课覆盖 ================= */
  // override 结构：
  //   { id, type:'cancel'|'shift', start:'YYYY-MM-DD', end:'YYYY-MM-DD'(默认=start), targetDay:1-7(仅shift), label }

  // 清洗/校验调休条目，非法返回 null（导入与本地加载共用）
  // 注意：日期统一归一化为零填充 ISO（YYYY-MM-DD），保证 overrideForDate 的字符串比较正确
  function sanitizeOverride(o) {
    if (!o || (o.type !== 'cancel' && o.type !== 'shift')) return null;
    var s = parseISO(o.start);
    if (!s) return null;
    var end = o.end ? parseISO(o.end) : s;
    if (!end || toISO(end) < toISO(s)) return null;
    var sw = Math.round(+o.sourceWeek);
    return {
      id: String(o.id || 'ov-' + Math.random().toString(36).slice(2, 10)),
      type: o.type,
      start: toISO(s),
      end: toISO(end),
      targetDay: Math.min(7, Math.max(1, Math.round(+o.targetDay) || 1)),
      keepOwn: !!o.keepOwn,
      sourceWeek: Number.isFinite(sw) && sw >= 1 && sw <= 40 ? sw : null,
      label: String(o.label || '').slice(0, 60)
    };
  }

  function overrideForDate(overrides, date) {
    var iso = typeof date === 'string' ? date : toISO(date);
    var list = overrides || [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o && (o.type === 'cancel' || o.type === 'shift')) {
        var end = o.end || o.start;
        if (iso >= o.start && iso <= end) return o;
      }
    }
    return null;
  }

  /* ================= 排课 ================= */

  // 某一天的课程。config: {semesterStart, totalWeeks, firstWeekOdd, overrides}
  // 返回 {date, week, dayOfWeek, overriddenBy, reason, courses[]}
  function getDaySchedule(courses, date, config) {
    var cfg = config || {};
    var d = typeof date === 'string' ? parseISO(date) : parseISO(toISO(date));
    if (!d) return { date: null, week: NaN, dayOfWeek: 0, overriddenBy: null, reason: 'bad-date', courses: [] };
    var iso = toISO(d);
    var dayOfWeek = (d.getDay() + 6) % 7 + 1; // 周一=1 … 周日=7
    var week = getWeekNumber(iso, cfg.semesterStart);
    var stage = semesterStage(week, cfg.totalWeeks);

    if (stage === 'unset') {
      // 学期开始日期缺失/非法：绝不显示任何课程（防止 matchesWeek(NaN) 误判）
      return { date: iso, week: week, dayOfWeek: dayOfWeek, overriddenBy: null, reason: 'unset', courses: [] };
    }
    if (stage === 'before') {
      return { date: iso, week: week, dayOfWeek: dayOfWeek, overriddenBy: null, reason: 'before', courses: [] };
    }
    if (stage === 'after') {
      return { date: iso, week: week, dayOfWeek: dayOfWeek, overriddenBy: null, reason: 'after', courses: [] };
    }

    var ov = overrideForDate(cfg.overrides, iso);
    if (ov && ov.type === 'cancel') {
      return { date: iso, week: week, dayOfWeek: dayOfWeek, overriddenBy: ov, reason: 'cancelled', courses: [] };
    }

    // 补课（shift）：默认当天整体按 targetDay 的课表上；
    // 可选 keepOwn 保留当天原有课程；可选 sourceWeek 按指定周次判断单双（如“补第4周周一的课”）
    var shiftTarget = null;
    var sourceWeek = null;
    if (ov && ov.type === 'shift') {
      shiftTarget = Math.min(7, Math.max(1, Math.round(+ov.targetDay) || dayOfWeek));
      if (ov.sourceWeek) sourceWeek = Math.min(40, Math.max(1, Math.round(+ov.sourceWeek)));
    }

    var list = [];
    (courses || []).forEach(function (c) {
      if (!c) return;
      var dow = +c.dayOfWeek || 0;
      var matchWeek = week;
      if (ov && ov.type === 'shift') {
        if (dow === shiftTarget) {
          // 被补进来的课：单双跟随 sourceWeek（未填则跟随真实周次）
          matchWeek = sourceWeek || week;
        } else if (dow === dayOfWeek && ov.keepOwn && shiftTarget !== dayOfWeek) {
          // 保留的当天原课：永远按真实周次求单双，不受 sourceWeek 影响
          // （否则“周六双周课 + 补第5周周的单周课”会把原课误杀）
        } else {
          return;
        }
      } else if (dow !== dayOfWeek) {
        return;
      }
      if (!matchesWeek(c.weekRule, matchWeek, cfg.firstWeekOdd)) return;
      list.push(c);
    });
    list.sort(compareByStartTime);

    return {
      date: iso,
      week: week,
      matchWeek: (sourceWeek && sourceWeek !== week) ? sourceWeek : null,
      dayOfWeek: dayOfWeek,
      effectiveDay: shiftTarget || dayOfWeek,
      overriddenBy: ov || null,
      reason: 'ok',
      courses: list
    };
  }

  // 某一整周的课程（周一到周日）
  function getWeekSchedule(courses, weekNumber, config) {
    var cfg = config || {};
    var s = parseISO(cfg.semesterStart);
    if (!s) return { days: [], week: weekNumber, error: '学期开始日期未设置' };
    var w = Math.round(weekNumber);
    var monday = addDays(startOfWeekMonday(s), (w - 1) * 7);
    var days = [];
    for (var i = 0; i < 7; i++) {
      days.push(getDaySchedule(courses, toISO(addDays(monday, i)), cfg));
    }
    return { days: days, week: w, monday: toISO(monday), sunday: toISO(addDays(monday, 6)), error: null };
  }

  // 今天之后最近的下一节课（不含已开始的课）。lookaheadDays 默认 14
  function getNextClass(courses, now, config, lookaheadDays) {
    var look = Math.min(60, Math.max(1, Math.round(+lookaheadDays || 14)));
    var nowMs = now instanceof Date ? now.getTime() : Date.now();
    var best = null;
    for (var off = 0; off < look; off++) {
      var dayIso = toISO(addDays(new Date(nowMs), off));
      var sched = getDaySchedule(courses, dayIso, config);
      for (var i = 0; i < sched.courses.length; i++) {
        var c = sched.courses[i];
        var m = /^(\d{1,2}):(\d{2})$/.exec(c.startTime || '');
        if (!m) continue;
        var startMs = new Date(nowMs);
        startMs.setDate(startMs.getDate() + off); // 关键：加上天数偏移，否则未来日期的时刻错误
        startMs.setHours(+m[1], +m[2], 0, 0);
        if (off === 0 && startMs.getTime() <= nowMs) continue;
        var cand = {
          course: c,
          date: dayIso,
          week: sched.week,
          startMs: startMs.getTime(),
          minutesUntil: Math.max(0, Math.round((startMs.getTime() - nowMs) / 60000))
        };
        if (!best || cand.startMs < best.startMs) best = cand;
      }
      if (best) break; // 更远的日子只会更晚
    }
    return best;
  }

  // 当前状态：正在上的课 + 下一节课（今天或之后）
  function getNowNext(courses, now, config) {
    var cfg = config || {};
    var nowMs = now instanceof Date ? now.getTime() : Date.now();
    var dayIso = toISO(new Date(nowMs));
    var sched = getDaySchedule(courses, dayIso, cfg);
    var nowCourse = null;
    var nextCourse = null;

    for (var i = 0; i < sched.courses.length; i++) {
      var c = sched.courses[i];
      var m1 = /^(\d{1,2}):(\d{2})$/.exec(c.startTime || '');
      var m2 = /^(\d{1,2}):(\d{2})$/.exec(c.endTime || '');
      if (!m1 || !m2) continue;
      var st = new Date(nowMs); st.setHours(+m1[1], +m1[2], 0, 0);
      var en = new Date(nowMs); en.setHours(+m2[1], +m2[2], 0, 0);
      if (nowMs >= st.getTime() && nowMs < en.getTime()) {
        nowCourse = { course: c, date: dayIso, week: sched.week, endMs: en.getTime(), minutesLeft: Math.max(0, Math.round((en.getTime() - nowMs) / 60000)) };
      } else if (st.getTime() > nowMs && (!nextCourse || st.getTime() < nextCourse.startMs)) {
        nextCourse = {
          course: c, date: dayIso, week: sched.week, startMs: st.getTime(),
          minutesUntil: Math.max(0, Math.round((st.getTime() - nowMs) / 60000))
        };
      }
    }

    if (!nextCourse) {
      var nx = getNextClass(courses, now, cfg, 14);
      if (nx && nx.date !== dayIso) nextCourse = nx;
    }
    return { sched: sched, nowCourse: nowCourse, nextCourse: nextCourse };
  }

  /* ================= 课程校验 ================= */

  function validateCourse(c) {
    if (!c || typeof c !== 'object') return '课程数据缺失';
    if (!String(c.name || '').trim()) return '请填写课程名称';
    if (!String(c.location || '').trim()) return '请填写上课地点';
    var dayRaw = +c.dayOfWeek;
    if (!Number.isFinite(dayRaw) || dayRaw < 1 || dayRaw > 7 || Math.round(dayRaw) !== dayRaw) return '请选择星期几';
    if (!Number.isFinite(timeToMinutes(c.startTime))) return '开始时间格式错误';
    if (!Number.isFinite(timeToMinutes(c.endTime))) return '结束时间格式错误';
    if (timeToMinutes(c.endTime) <= timeToMinutes(c.startTime)) return '结束时间必须晚于开始时间';
    var nr = normalizeWeekRule(c.weekRule);
    if (!nr || (nr.weeks && nr.weeks.length === 0)) return '周次规则无效';
    return null;
  }

  // 清洗/规范化课程（导入与本地加载共用）；非法返回 null
  // 关键点：时间统一补零成 "HH:MM"（iOS <input type=time> 要求两位小时），
  // 星期取整、文本去首尾空格、周规则规范化
  function sanitizeCourse(c) {
    if (validateCourse(c)) return null;
    return {
      id: String(c.id || 'c-' + Math.random().toString(36).slice(2, 10)),
      name: String(c.name || '').trim(),
      teacher: String(c.teacher || '').trim(),
      location: String(c.location || '').trim(),
      dayOfWeek: Math.round(+c.dayOfWeek),
      startTime: minutesToTime(timeToMinutes(c.startTime)),
      endTime: minutesToTime(timeToMinutes(c.endTime)),
      weekRule: normalizeWeekRule(c.weekRule)
    };
  }

  /* ================= 备份 / 导入 ================= */

  function exportState(state) {
    return JSON.stringify({
      app: 'class-schedule',
      version: 1,
      exportedAt: new Date().toISOString(),
      state: {
        config: state.config,
        courses: state.courses,
        overrides: state.overrides || [],
        settings: state.settings || {}
      }
    }, null, 2);
  }

  // 导入校验：逐项检查，返回 {state, error}
  function parseState(jsonText) {
    var raw;
    try {
      raw = JSON.parse(jsonText);
    } catch (e) {
      return { state: null, error: '不是有效的 JSON 文件' };
    }
    var st = raw && raw.state ? raw.state : raw;
    if (!st || typeof st !== 'object') return { state: null, error: '备份内容结构不对' };
    if (!st.config || !parseISO(st.config.semesterStart)) {
      return { state: null, error: '备份缺少有效的学期开始日期' };
    }
    if (!Array.isArray(st.courses)) st.courses = [];
    if (!Array.isArray(st.overrides)) st.overrides = [];
    if (st.courses.length > 500) {
      return { state: null, error: '备份中的课程数量（' + st.courses.length + '）超过上限 500' };
    }
    var seenIds = {};
    for (var i = 0; i < st.courses.length; i++) {
      var err = validateCourse(st.courses[i]);
      if (err) return { state: null, error: '第 ' + (i + 1) + ' 门课程有问题：' + err };
      if (st.courses[i].id != null) {
        var key = String(st.courses[i].id);
        if (seenIds[key]) return { state: null, error: '备份中课程 ID 重复（' + key + '）' };
        seenIds[key] = true;
      }
    }
    var cleanCourses = st.courses.map(function (c) { return sanitizeCourse(c); });
    var cleanOverrides = [];
    var seenOvIds = {};
    st.overrides.forEach(function (o) {
      var so = sanitizeOverride(o);
      if (!so) return;
      if (seenOvIds[so.id]) return; // 重复 id 会导致删除/编辑命中多条，导入时去重
      seenOvIds[so.id] = true;
      cleanOverrides.push(so);
    });
    return {
      state: {
        version: 1,
        config: {
          semesterStart: toISO(parseISO(st.config.semesterStart)),
          totalWeeks: Math.min(40, Math.max(1, Math.round(+st.config.totalWeeks || 20))),
          firstWeekOdd: st.config.firstWeekOdd !== false
        },
        courses: cleanCourses,
        overrides: cleanOverrides,
        settings: st.settings || {}
      },
      error: null
    };
  }

  /* ================= 日历导出（.ics）================= */

  function icsEscape(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  var UTF8_ENCODER = null;
  // RFC 5545 行折叠：每行最多 75 字节（UTF-8，含续行的前导空格），续行以空格开头。
  // 按 Unicode 码点迭代，避免在 emoji 等代理对中间折行导致内容损坏
  function foldLine(line) {
    if (!UTF8_ENCODER && typeof TextEncoder !== 'undefined') UTF8_ENCODER = new TextEncoder();
    var enc = UTF8_ENCODER;
    var lines = [];
    var cur = '';
    var curBytes = 0;
    var chars = Array.from(line);
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var b = enc ? enc.encode(ch).length : 2; // 无 TextEncoder 的环境按常见中文宽度估算，仅影响折行点
      var limit = lines.length === 0 ? 75 : 74; // 续行多一个前导空格
      if (curBytes + b > limit) {
        lines.push(cur);
        cur = '';
        curBytes = 0;
      }
      cur += ch;
      curBytes += b;
    }
    if (cur) lines.push(cur);
    return lines.join('\r\n ');
  }

  var VTIMEZONE_LINES = [
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE'
  ];

  // 生成整学期的 .ics 文本。每个事件带“课前 N 分钟”提醒。
  // 返回 {ics, count, error}
  function buildICS(courses, config, opts) {
    var cfg = config || {};
    var o = opts || {};
    var alarmRaw = Math.round(+o.alarmMinutes);
    var alarmMinutes = Number.isFinite(alarmRaw) ? Math.min(120, Math.max(0, alarmRaw)) : 15; // 0 = 上课瞬间提醒，不能被 || 当成缺省
    var s = parseISO(cfg.semesterStart);
    if (!s) return { ics: null, count: 0, error: '请先设置学期开始日期' };
    var total = Math.max(1, Math.round(+cfg.totalWeeks || 20));

    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ClassSchedule//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    lines.push.apply(lines, VTIMEZONE_LINES);

    var dtstamp = (function () {
      var n = new Date();
      var p = function (x) { return String(x).padStart(2, '0'); };
      return n.getUTCFullYear() + p(n.getUTCMonth() + 1) + p(n.getUTCDate()) + 'T' + p(n.getUTCHours()) + p(n.getUTCMinutes()) + p(n.getUTCSeconds()) + 'Z';
    })();

    var count = 0;
    var monday1 = startOfWeekMonday(s);

    for (var w = 1; w <= total; w++) {
      for (var day = 1; day <= 7; day++) {
        var iso = toISO(addDays(addDays(monday1, (w - 1) * 7), day - 1));
        var sched = getDaySchedule(courses, iso, cfg);
        for (var i = 0; i < sched.courses.length; i++) {
          var c = sched.courses[i];
          var m1 = /^(\d{1,2}):(\d{2})$/.exec(c.startTime || '');
          var m2 = /^(\d{1,2}):(\d{2})$/.exec(c.endTime || '');
          if (!m1 || !m2) continue;
          var datePart = iso.replace(/-/g, '');
          // 防御性补零：即使数据里有 '8:00'，也输出合法的 HHMMSS（RFC 5545 DATE-TIME）
          var dtStart = datePart + 'T' + String(+m1[1]).padStart(2, '0') + m1[2] + '00';
          var dtEnd = datePart + 'T' + String(+m2[1]).padStart(2, '0') + m2[2] + '00';
          var uid = 'class-schedule-' + icsEscape(String(c.id || 'c')) + '-' + datePart;

          lines.push('BEGIN:VEVENT');
          lines.push(foldLine('UID:' + uid));
          lines.push('DTSTAMP:' + dtstamp);
          lines.push('DTSTART;TZID=Asia/Shanghai:' + dtStart);
          lines.push('DTEND;TZID=Asia/Shanghai:' + dtEnd);
          lines.push(foldLine('SUMMARY:' + icsEscape(c.name)));
          if (c.location) lines.push(foldLine('LOCATION:' + icsEscape(c.location)));
          var desc = (c.teacher ? '教师：' + c.teacher + '；' : '') + '第' + (sched.matchWeek || sched.week) + '周（' +
            weekParityLabel(sched.matchWeek || sched.week, cfg.firstWeekOdd) + '）';
          lines.push(foldLine('DESCRIPTION:' + icsEscape(desc)));
          lines.push('BEGIN:VALARM');
          lines.push('ACTION:DISPLAY');
          lines.push(foldLine('DESCRIPTION:' + icsEscape((alarmMinutes > 0 ? '还有 ' + alarmMinutes + ' 分钟上课' : '要上课了') + '：' + c.name + (c.location ? ' @ ' + c.location : ''))));
          lines.push('TRIGGER:-PT' + alarmMinutes + 'M');
          lines.push('END:VALARM');
          lines.push('END:VEVENT');
          count++;
        }
      }
    }
    lines.push('END:VCALENDAR');
    return { ics: lines.join('\r\n') + '\r\n', count: count, error: null };
  }

  /* ================= 示例课程 ================= */

  // 覆盖：每周 / 单周 / 双周 / 只上前4周 / 中间几周 / 双周+区间 / 自定义周次
  function buildDemoCourses() {
    function c(id, name, teacher, location, dayOfWeek, startTime, endTime, rule) {
      return {
        id: 'demo-' + id, name: name, teacher: teacher, location: location,
        dayOfWeek: dayOfWeek, startTime: startTime, endTime: endTime, weekRule: rule
      };
    }
    return [
      c(1, '高等数学', '张老师', '教三201', 1, '08:00', '09:40', { type: 'odd', start: 1, end: 16 }),
      c(2, '大学英语', '李老师', '外语楼305', 1, '10:00', '11:40', { type: 'even', start: 1, end: 16 }),
      c(3, '线性代数', '王老师', '教三302', 2, '08:00', '09:40', { type: 'all', start: 1, end: 16 }),
      c(4, '大学物理', '陈老师', '物理楼101', 2, '14:00', '15:40', { type: 'odd', start: 1, end: 16 }),
      c(5, '程序设计基础', '赵老师', '机房B204', 3, '10:00', '11:40', { type: 'all', start: 1, end: 4 }),
      c(6, '体育（篮球）', '孙老师', '东区篮球场', 4, '16:00', '17:40', { type: 'all', start: 1, end: 16 }),
      c(7, '形势与政策', '周老师', '大礼堂', 5, '14:00', '15:40', { type: 'all', start: 5, end: 8 }),
      c(8, '大学物理实验', '陈老师', '物理楼304', 5, '08:00', '09:40', { type: 'even', start: 3, end: 15 }),
      c(9, '艺术鉴赏（选修）', '吴老师', '文科楼110', 6, '09:00', '10:40', { type: 'list', weeks: [2, 3, 5, 7] }),
      c(10, '思政实践', '郑老师', '线上（腾讯会议）', 7, '15:00', '16:40', { type: 'list', weeks: [3, 4] })
    ];
  }

  /* ================= 批量导入（粘贴文本解析） ================= */

  var FULLWIDTH_MAP = { '，': ',', '、': ',', '：': ':', '；': ';', '～': '-', '—': '-', '－': '-', '–': '-' };

  function normalizeLineText(s) {
    var out = String(s == null ? '' : s).replace(/[\u3000]/g, ' ');
    for (var k in FULLWIDTH_MAP) {
      if (Object.prototype.hasOwnProperty.call(FULLWIDTH_MAP, k)) {
        out = out.split(k).join(FULLWIDTH_MAP[k]);
      }
    }
    return out;
  }

  // 解析一段粘贴文本：每行一门课。返回 {courses, errors:[{line,text,reason}]}
  // 支持两种常见顺序（全角标点自动兼容）：
  //   A: 高等数学 周一 08:00-09:40 教三201 单周 [张老师]
  //   B: 周一 08:00-09:40 高等数学 教三201 单周
  // 时间也支持“第X-Y节”写法（经 config.periodTimes 作息表换算，如“高数 周二 第1-2节 教三201 1-18周”）
  // 周规则可省略（=每周）；支持 每周/单周/双周/前4周/第5-8周/1-16周/第2,3,5-7周 等
  function parseScheduleLines(text, config) {
    var cfg = config || {};
    var tw = Math.max(1, Math.round(+cfg.totalWeeks || 20));
    var fo = cfg.firstWeekOdd !== false;
    var periodTable = parsePeriodTable(cfg.periodTimes);
    var rawLines = String(text == null ? '' : text).split(/\r?\n/);
    var courses = [];
    var errors = [];

    rawLines.forEach(function (raw, idx) {
      var lineNo = idx + 1;
      var t = normalizeLineText(raw).trim();
      if (!t) return;

      // 星期几
      var dayM = /(?:周|星期)\s*([一二三四五六日天1-7])/.exec(t);
      if (!dayM) { errors.push({ line: lineNo, text: raw.trim(), reason: '缺少星期几（如 周一）' }); return; }
      var dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
      var dayOfWeek = dayMap[dayM[1]] || Math.round(+dayM[1]);
      if (!(dayOfWeek >= 1 && dayOfWeek <= 7)) {
        errors.push({ line: lineNo, text: raw.trim(), reason: '星期几无法识别' });
        return;
      }

      // 节次（第X-Y节 / 第X节）：先从行里摘出，避免被误当成周次规则；
      // 行内没有具体时间时，用“设置 → 作息时间表”换算
      var perM = /(?:第)?\s*(\d{1,2})\s*[-~至]\s*(\d{1,2})\s*节/.exec(t);
      if (perM) {
        t = t.replace(perM[0], ' ');
      } else {
        var perSingle = /(?:第)?\s*(\d{1,2})\s*节/.exec(t);
        if (perSingle) { perM = perSingle; t = t.replace(perSingle[0], ' '); }
      }

      // 时间范围
      var timeM = /(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})/.exec(t);
      var startTime = null;
      var endTime = null;
      if (timeM) {
        startTime = String(+timeM[1]).padStart(2, '0') + ':' + timeM[2];
        endTime = String(+timeM[3]).padStart(2, '0') + ':' + timeM[4];
      } else if (perM) {
        var per = resolvePeriods(+perM[1], +perM[2], periodTable);
        if (!per) {
          errors.push({ line: lineNo, text: raw.trim(), reason: '作息表里没有第' + perM[1] + '-' + perM[2] + '节的时间，请到“设置 → 作息时间表”核对' });
          return;
        }
        startTime = minutesToTime(per.start);
        endTime = minutesToTime(per.end);
      } else {
        errors.push({ line: lineNo, text: raw.trim(), reason: '缺少时间范围（如 08:00-09:40 或 第1-2节）' });
        return;
      }
      if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
        errors.push({ line: lineNo, text: raw.trim(), reason: '结束时间必须晚于开始时间' });
        return;
      }

      // 去掉星期与时间段，剩余 token 化
      var rest = t.replace(dayM[0], ' ');
      if (timeM) rest = rest.replace(timeM[0], ' ');
      var tokens = rest.split(/[\s,，、]+/).filter(function (x) { return x; });

      // 周规则：取最后一个能解析成功的 token（"教三201"这类不会被误判）
      var ruleTokenIdx = -1;
      for (var i = tokens.length - 1; i >= 0; i--) {
        if (!parseWeekRule(tokens[i], tw, fo).error) { ruleTokenIdx = i; break; }
      }
      var weekRule;
      if (ruleTokenIdx >= 0) {
        weekRule = parseWeekRule(tokens[ruleTokenIdx], tw, fo).rule;
        tokens.splice(ruleTokenIdx, 1);
      } else {
        weekRule = { type: 'all', start: 1, end: tw }; // 未写周规则 = 每周
      }

      // 教师：以“老师/教师”结尾的 token（兼容课表里的“虚拟教师”）
      var teacher = '';
      for (var j = tokens.length - 1; j >= 0; j--) {
        if (/(?:老师|教师)$/.test(tokens[j])) { teacher = tokens[j]; tokens.splice(j, 1); break; }
      }

      // 名称与地点：名称在星期前（A 顺序）或紧跟在时间后（B 顺序）
      var name = '';
      var location = '';
      var beforeDay = t.slice(0, t.indexOf(dayM[0])).trim();
      if (beforeDay && !/\d{1,2}:\d{2}/.test(beforeDay)) {
        name = beforeDay.replace(/[\s,，、;；]+$/, '');
        // A 顺序：tokens 里也包含名称 token，剔除它（按 token 逐一过滤，兼容带空格的名称）
        var nameTokens = name.split(/[\s,，、]+/).filter(function (x) { return x; });
        location = tokens.filter(function (x) { return nameTokens.indexOf(x) < 0; }).join(' ');
      } else {
        if (!tokens.length) {
          errors.push({ line: lineNo, text: raw.trim(), reason: '缺少课程名称' });
          return;
        }
        name = tokens[0];
        location = tokens.slice(1).join(' ');
      }

      var course = sanitizeCourse({
        id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + lineNo,
        name: name,
        teacher: teacher,
        location: location,
        dayOfWeek: dayOfWeek,
        startTime: startTime,
        endTime: endTime,
        weekRule: weekRule
      });
      if (!course) {
        errors.push({ line: lineNo, text: raw.trim(), reason: '信息不完整（需要课程名、星期几、时间、地点）' });
        return;
      }
      courses.push(course);
    });

    return { courses: courses, errors: errors };
  }

  /* ================= 导出 ================= */

  return {
    DAY_NAMES: DAY_NAMES,
    MS_PER_DAY: MS_PER_DAY,
    dateAtNoon: dateAtNoon,
    parseISO: parseISO,
    toISO: toISO,
    startOfWeekMonday: startOfWeekMonday,
    addDays: addDays,
    diffDays: diffDays,
    getWeekNumber: getWeekNumber,
    isOddWeek: isOddWeek,
    weekParityLabel: weekParityLabel,
    semesterStage: semesterStage,
    statusText: statusText,
    normalizeWeekRule: normalizeWeekRule,
    matchesWeek: matchesWeek,
    ruleMatchedWeeks: ruleMatchedWeeks,
    parseWeekRule: parseWeekRule,
    ruleToText: ruleToText,
    timeToMinutes: timeToMinutes,
    minutesToTime: minutesToTime,
    compareByStartTime: compareByStartTime,
    DEFAULT_PERIOD_TIMES: DEFAULT_PERIOD_TIMES,
    parsePeriodTable: parsePeriodTable,
    resolvePeriods: resolvePeriods,
    sanitizeCourse: sanitizeCourse,
    sanitizeOverride: sanitizeOverride,
    overrideForDate: overrideForDate,
    getDaySchedule: getDaySchedule,
    getWeekSchedule: getWeekSchedule,
    getNextClass: getNextClass,
    getNowNext: getNowNext,
    validateCourse: validateCourse,
    exportState: exportState,
    parseState: parseState,
    buildICS: buildICS,
    buildDemoCourses: buildDemoCourses,
    parseScheduleLines: parseScheduleLines
  };
});
