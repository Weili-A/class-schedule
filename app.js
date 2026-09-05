/*!
 * app.js — 我的课程表：界面与交互
 * 依赖：schedule-core.js（window.ScheduleCore）
 */
(function () {
  'use strict';

  var CORE = window.ScheduleCore;
  if (!CORE) {
    document.body.innerHTML = '<p style="padding:24px">加载失败：缺少 schedule-core.js</p>';
    return;
  }

  var STORAGE_KEY = 'class-schedule-data-v1';
  var state = null; // {version, config:{semesterStart,totalWeeks,firstWeekOdd}, courses:[], overrides:[], settings:{}}
  var weekOffset = 0;   // 周课表视图相对本周的偏移
  var nowTimer = null;
  var DAY_NAMES = CORE.DAY_NAMES;

  /* ================= 基础工具 ================= */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function $(id) { return document.getElementById(id); }

  function courseHue(id) {
    var h = 0;
    for (var i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
    return h % 360;
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 3200);
  }

  function dateCN(iso) {
    var d = CORE.parseISO(iso);
    if (!d) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function dayCN(dayOfWeek) {
    return DAY_NAMES[Math.min(6, Math.max(0, Math.round(dayOfWeek) - 1))];
  }

  /* ================= 状态 ================= */

  function defaultState() {
    var monday = CORE.toISO(CORE.startOfWeekMonday(new Date()));
    return {
      version: 1,
      config: { semesterStart: monday, totalWeeks: 20, firstWeekOdd: true },
      courses: [],
      overrides: [],
      settings: { onboardingDone: false }
    };
  }

  function loadState() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !parsed.config || !parsed.config.semesterStart) {
        throw new Error('bad shape');
      }
      if (!Array.isArray(parsed.courses)) parsed.courses = [];
      if (!Array.isArray(parsed.overrides)) parsed.overrides = [];
      parsed.config.totalWeeks = Math.min(40, Math.max(1, Math.round(+parsed.config.totalWeeks || 20)));
      parsed.config.firstWeekOdd = parsed.config.firstWeekOdd !== false;
      parsed.settings = parsed.settings || {};

      // 防御性清洗：本地数据若有非法课程/调休条目，剔除并上报数量
      var droppedCourses = 0;
      parsed.courses = parsed.courses.map(function (c) {
        var clean = CORE.sanitizeCourse(c);
        if (!clean) droppedCourses++;
        return clean;
      }).filter(function (c) { return !!c; });
      var beforeOv = parsed.overrides.length;
      parsed.overrides = parsed.overrides.map(function (o) { return CORE.sanitizeOverride(o); })
        .filter(function (o) { return !!o; });
      parsed._droppedCourses = droppedCourses;
      parsed._droppedOverrides = beforeOv - parsed.overrides.length;
      return parsed;
    } catch (err) {
      try { if (raw) localStorage.setItem(STORAGE_KEY + '-corrupt', raw); } catch (e2) {}
      return { corrupt: true };
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      toast('⚠️ 保存失败：存储空间不足或浏览器限制');
      return false;
    }
  }

  function findCourse(id) {
    for (var i = 0; i < state.courses.length; i++) {
      if (state.courses[i].id === id) return state.courses[i];
    }
    return null;
  }

  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // 传给核心函数的 config 必须带上调休/停课数据。
  // overrides 存放在 state.overrides，而核心从 config.overrides 读取——
  // 若直接传 state.config，调休/停课会在“今天/周课表”视图静默失效（只有导出日历正常）
  function coreConfig() {
    return Object.assign({}, state.config, { overrides: state.overrides });
  }

  /* ================= 渲染：顶栏 ================= */

  function renderTop() {
    var st = CORE.statusText(new Date(), state.config);
    var el = $('semester-status');
    el.textContent = st.text;
    el.className = 'app-sub ' + st.cls;

    var now = new Date();
    $('topbar-date').textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + dayCN((now.getDay() + 6) % 7 + 1);
  }

  /* ================= 渲染：今天 ================= */

  function courseItemHTML(c, extra) {
    var hue = courseHue(c.id);
    var cls = 'course-item' + (extra && extra.isPast ? ' is-past' : '') + (extra && extra.isNow ? ' is-now' : '');
    var sub = [];
    if (c.teacher) sub.push(c.teacher);
    if (c.location) sub.push('📍 ' + c.location);
    return '<div class="' + cls + '" style="--c:' + hue + '">' +
      '<div class="ci-time"><span>' + esc(c.startTime) + '</span><span>' + esc(c.endTime) + '</span></div>' +
      '<div class="ci-body"><div class="ci-name">' + esc(c.name) + '</div>' +
      (sub.length ? '<div class="ci-sub">' + esc(sub.join(' · ')) + '</div>' : '') +
      '</div></div>';
  }

  function renderNowCard() {
    var el = $('next-card');
    var now = new Date();
    var stage = CORE.semesterStage(CORE.getWeekNumber(now, state.config.semesterStart), state.config.totalWeeks);

    if (stage === 'unset') {
      el.innerHTML = '<div class="next-label">提示</div><div class="next-empty">请先到“设置”里填写学期开始日期</div>';
      return;
    }
    if (stage === 'before') {
      el.innerHTML = '<div class="next-label">未开学</div><div class="next-name">📅 学期尚未开始</div>' +
        '<div class="next-meta">第1周从 <b>' + esc(state.config.semesterStart) + '</b> 那一周开始</div>';
      return;
    }
    if (stage === 'after') {
      el.innerHTML = '<div class="next-label">学期已结束</div><div class="next-name">🎉 本学期课程全部结束</div>' +
        '<div class="next-meta">新学期记得更新“设置 → 学期开始日期”</div>';
      return;
    }

    var nn = CORE.getNowNext(state.courses, now, coreConfig());

    if (nn.sched.overriddenBy && nn.sched.overriddenBy.type === 'cancel') {
      el.innerHTML = '<div class="next-label">今天停课</div><div class="next-name">🚫 ' +
        esc(nn.sched.overriddenBy.label || '停课') + '</div>';
      return;
    }

    if (nn.nowCourse) {
      var c = nn.nowCourse.course;
      el.innerHTML = '<div class="next-label">正在上课</div>' +
        '<div class="next-name">🔔 ' + esc(c.name) + '</div>' +
        '<div class="next-meta">还有 <b>' + nn.nowCourse.minutesLeft + ' 分钟</b>下课（' + esc(c.endTime) + '）</div>' +
        (c.location ? '<span class="next-loc">📍 ' + esc(c.location) + '</span>' : '');
      return;
    }

    if (nn.nextCourse) {
      var n = nn.nextCourse;
      var nc = n.course;
      var isToday = n.date === CORE.toISO(now);
      var when;
      if (isToday) {
        when = n.minutesUntil < 60
          ? '<b>' + n.minutesUntil + ' 分钟</b>后开始'
          : '今天 <b>' + esc(nc.startTime) + '</b> 开始';
      } else {
        var dow = dayCN((CORE.parseISO(n.date).getDay() + 6) % 7 + 1);
        when = '<b>' + dow + '（' + dateCN(n.date) + '）' + esc(nc.startTime) + '</b>';
      }
      el.innerHTML = '<div class="next-label">下一节课</div>' +
        '<div class="next-name">⏰ ' + esc(nc.name) + '</div>' +
        '<div class="next-meta">' + when + '</div>' +
        (nc.location ? '<span class="next-loc">📍 ' + esc(nc.location) + '</span>' : '');
      return;
    }

    el.innerHTML = '<div class="next-label">下一节课</div><div class="next-name">🍵 近期没有课</div>' +
      '<div class="next-meta">好好休息，或去“周课表”看看安排</div>';
  }

  function renderToday() {
    renderNowCard();
    var now = new Date();
    var sched = CORE.getDaySchedule(state.courses, CORE.toISO(now), coreConfig());
    var week = sched.week;
    var badge = $('today-badge');
    if (Number.isFinite(week) && week >= 1) {
      badge.textContent = '第' + week + '周 · ' + CORE.weekParityLabel(week, state.config.firstWeekOdd);
    } else {
      badge.textContent = '';
    }
    $('today-title').textContent = '今天 · ' + dayCN(sched.dayOfWeek || ((now.getDay() + 6) % 7 + 1)) + ' · ' + dateCN(sched.date);

    var html = '';
    if (sched.reason === 'before' || sched.reason === 'after') {
      html = '<div class="empty-tip">' + (sched.reason === 'before' ? '学期还没开始，暂无课程。' : '学期已结束，暂无课程。') + '</div>';
    } else if (sched.overriddenBy) {
      var ov = sched.overriddenBy;
      if (ov.type === 'cancel') {
        html = '<div class="empty-tip">🚫 今天停课：' + esc(ov.label || '无备注') + '</div>';
      } else {
        html = '<div class="empty-tip">🔄 今天按 <b>' + dayCN(ov.targetDay) + '</b> 的课表上课（' + esc(ov.label || '调休') + '）</div>';
      }
    }

    var nowMs = now.getTime();
    sched.courses.forEach(function (c) {
      var m1 = /^(\d{1,2}):(\d{2})$/.exec(c.startTime || '');
      var m2 = /^(\d{1,2}):(\d{2})$/.exec(c.endTime || '');
      var st = null, en = null;
      if (m1 && m2) {
        st = new Date(nowMs); st.setHours(+m1[1], +m1[2], 0, 0);
        en = new Date(nowMs); en.setHours(+m2[1], +m2[2], 0, 0);
      }
      var isNow = st && en && nowMs >= st.getTime() && nowMs < en.getTime();
      var isPast = en && nowMs >= en.getTime();
      html += courseItemHTML(c, { isPast: isPast, isNow: isNow });
    });

    if (!html) html = '<div class="empty-tip">今天没有课 🍵</div>';
    $('today-list').innerHTML = html;
  }

  /* ================= 渲染：周课表 ================= */

  function renderWeek() {
    var today = new Date();
    var thisWeek = CORE.getWeekNumber(today, state.config.semesterStart);
    var w = thisWeek + weekOffset;

    var titleEl = $('week-title');
    var rangeEl = $('week-range');
    var gridEl = $('week-grid');

    if (!Number.isFinite(thisWeek)) {
      titleEl.textContent = '未设置学期';
      rangeEl.textContent = '请到“设置”填写学期开始日期';
      gridEl.innerHTML = '';
      $('week-today-btn').hidden = true;
      return;
    }

    var res = CORE.getWeekSchedule(state.courses, w, coreConfig());
    if (res.error) {
      titleEl.textContent = '出错了';
      rangeEl.textContent = res.error;
      gridEl.innerHTML = '';
      return;
    }

    var parity = CORE.weekParityLabel(res.week, state.config.firstWeekOdd);
    var stage = CORE.semesterStage(res.week, state.config.totalWeeks);
    var title = '第' + res.week + '周';
    if (stage === 'before') title += ' · 未开学';
    else if (stage === 'after') title += ' · 已结束';
    else title += ' · ' + parity;
    titleEl.textContent = title;
    rangeEl.textContent = dateCN(res.monday) + ' – ' + dateCN(res.sunday);
    $('week-today-btn').hidden = weekOffset === 0;

    var todayIso = CORE.toISO(today);
    var html = '';
    var anyCourse = false;

    res.days.forEach(function (day) {
      var isToday = day.date === todayIso;
      var dayName = dayCN(day.dayOfWeek);
      html += '<div class="day-block">' +
        '<div class="day-head"><span class="day-name">' + dayName + '</span>' +
        '<span class="day-date">' + dateCN(day.date) + '</span>' +
        (isToday ? '<span style="color:var(--accent);font-size:12px;font-weight:700">今天</span>' : '');
      if (day.overriddenBy) {
        var ov = day.overriddenBy;
        if (ov.type === 'cancel') {
          html += '<span class="day-note">停课</span>';
        } else {
          html += '<span class="day-note shift">按' + dayCN(ov.targetDay) + '上课</span>';
        }
      }
      html += '</div><div class="card day-card">';
      if (day.courses.length) {
        anyCourse = true;
        var nowMs = today.getTime();
        day.courses.forEach(function (c) {
          var m1 = /^(\d{1,2}):(\d{2})$/.exec(c.startTime || '');
          var m2 = /^(\d{1,2}):(\d{2})$/.exec(c.endTime || '');
          var isNow = false, isPast = false;
          if (isToday && m1 && m2) {
            var st = new Date(nowMs); st.setHours(+m1[1], +m1[2], 0, 0);
            var en = new Date(nowMs); en.setHours(+m2[1], +m2[2], 0, 0);
            isNow = nowMs >= st.getTime() && nowMs < en.getTime();
            isPast = nowMs >= en.getTime();
          }
          html += courseItemHTML(c, { isPast: isPast, isNow: isNow });
        });
      } else if (day.reason === 'before' || day.reason === 'after') {
        html += '<div class="empty-tip">' + (day.reason === 'before' ? '未开学' : '已结束') + '</div>';
      } else if (!day.overriddenBy) {
        html += '<div class="empty-tip">无课</div>';
      } else {
        html += '<div class="empty-tip">—</div>';
      }
      html += '</div></div>';
    });

    if (!anyCourse) {
      html += '<div class="card empty-tip">这一周没有课。若周次不对，去“设置”校准学期开始日期。</div>';
    }
    gridEl.innerHTML = html;
  }

  /* ================= 渲染：课程列表 ================= */

  function renderCourses() {
    var el = $('course-list');
    if (!state.courses.length) {
      el.innerHTML = '<div class="card empty-tip">还没有课程。点右上角“＋ 添加课程”，或去“设置”载入示例课程表看看效果。</div>';
      return;
    }
    var tw = state.config.totalWeeks;
    var fo = state.config.firstWeekOdd;
    var html = '';
    state.courses.forEach(function (c) {
      var weeks = CORE.ruleMatchedWeeks(c.weekRule, tw, fo);
      html += '<div class="course-row">' +
        '<div style="min-width:0">' +
        '<div class="cr-name">' + esc(c.name) + '</div>' +
        '<div class="cr-meta">' + dayCN(c.dayOfWeek) + ' ' + esc(c.startTime) + '-' + esc(c.endTime) +
        ' · 📍 ' + esc(c.location) + (c.teacher ? ' · ' + esc(c.teacher) : '') + '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;flex:0 0 auto">' +
        '<span class="cr-week">' + esc(CORE.ruleToText(c.weekRule, tw, fo)) + ' · ' + weeks.length + '次</span>' +
        '<span class="cr-act">' +
        '<button class="icon-btn" data-act="edit" data-id="' + esc(c.id) + '" aria-label="编辑">✏️</button>' +
        '<button class="icon-btn" data-act="del" data-id="' + esc(c.id) + '" aria-label="删除">🗑</button>' +
        '</span></div></div>';
    });
    el.innerHTML = html;
  }

  /* ================= 渲染：设置 ================= */

  function renderSettings() {
    $('set-semester-start').value = state.config.semesterStart;
    $('set-total-weeks').value = state.config.totalWeeks;
    $('set-first-week-odd').checked = state.config.firstWeekOdd !== false;
    if ($('ics-alarm')) $('ics-alarm').value = String(state.settings.icsAlarmMinutes || 15);
    if ($('set-periods')) {
      $('set-periods').value = (state.settings.periodTimes == null || state.settings.periodTimes === '')
        ? CORE.DEFAULT_PERIOD_TIMES : state.settings.periodTimes;
    }
    renderSettingsPreview();
    renderOverrides();
  }

  function renderSettingsPreview() {
    var start = CORE.parseISO($('set-semester-start').value);
    var el = $('set-preview');
    if (!start) {
      el.textContent = '日期无效';
      el.className = 'preview-line err';
      return;
    }
    var tw = Math.min(40, Math.max(1, Math.round(+$('set-total-weeks').value || 20)));
    var fo = $('set-first-week-odd').checked;
    var cfg = { semesterStart: $('set-semester-start').value, totalWeeks: tw, firstWeekOdd: fo, overrides: state.overrides };
    var st = CORE.statusText(new Date(), cfg);
    var w1 = CORE.toISO(CORE.startOfWeekMonday(start));
    el.textContent = '按当前设置：今天（' + dateCN(CORE.toISO(new Date())) + '）' + st.text + '；第1周自 ' + dateCN(w1) + '（周一）起';
    el.className = 'preview-line' + (st.cls === 'warn' ? ' err' : '');
  }

  function renderOverrides() {
    var el = $('override-list');
    if (!state.overrides.length) {
      el.innerHTML = '<div class="empty-tip" style="padding:4px 2px 10px">暂无调休/停课。国庆、中秋等假期记得在这里添加。</div>';
      return;
    }
    var html = '';
    state.overrides.forEach(function (o) {
      var range = o.end && o.end !== o.start ? dateCN(o.start) + ' – ' + dateCN(o.end) : dateCN(o.start);
      var title = o.type === 'cancel' ? '停课' : '按' + dayCN(o.targetDay) + '上课' + (o.sourceWeek ? '（第' + o.sourceWeek + '周）' : '');
      var sub = range + (o.type === 'shift' && o.keepOwn ? ' · 保留当天原课' : '');
      html += '<div class="override-row">' +
        '<span class="ov-badge ' + esc(o.type) + '">' + title + '</span>' +
        '<div class="ov-main"><div class="ov-title">' + esc(o.label || '（无备注）') + '</div>' +
        '<div class="ov-sub">' + sub + '</div></div>' +
        '<span class="cr-act" style="flex:0 0 auto">' +
        '<button class="icon-btn" data-act="ov-edit" data-id="' + esc(o.id) + '" aria-label="编辑">✏️</button>' +
        '<button class="icon-btn" data-act="ov-del" data-id="' + esc(o.id) + '" aria-label="删除">🗑</button>' +
        '</span></div>';
    });
    el.innerHTML = html;
  }

  /* ================= 弹窗 ================= */

  function openModal(html) {
    var root = $('modal-root');
    root.innerHTML = '<div class="modal">' + html + '</div>';
    root.hidden = false;
    root.onclick = function (e) {
      if (e.target === root && root.dataset.closable !== 'no') closeModal();
    };
    return root;
  }

  function closeModal() {
    var root = $('modal-root');
    root.hidden = true;
    root.innerHTML = '';
    root.dataset.closable = '';
  }

  /* ---------- 课程编辑 ---------- */

  function openCourseEditor(courseId) {
    var c = courseId ? findCourse(courseId) : null;
    var tw = state.config.totalWeeks;
    var fo = state.config.firstWeekOdd;
    var weekText = c ? CORE.ruleToText(c.weekRule, tw, fo) : '每周';

    var html =
      '<h3>' + (c ? '编辑课程' : '添加课程') + '</h3>' +
      '<label class="field"><span>课程名称 *</span>' +
      '<input type="text" id="mo-name" placeholder="如：高等数学" value="' + esc(c ? c.name : '') + '"></label>' +
      '<label class="field"><span>教师（可选）</span>' +
      '<input type="text" id="mo-teacher" placeholder="如：张老师" value="' + esc(c ? c.teacher : '') + '"></label>' +
      '<label class="field"><span>上课地点 *</span>' +
      '<input type="text" id="mo-location" placeholder="如：教三201 / 线上（腾讯会议）" value="' + esc(c ? c.location : '') + '"></label>' +
      '<div class="field"><span>星期几 *</span><div class="day-picker" id="mo-days">' +
      DAY_NAMES.map(function (n, i) {
        return '<button type="button" data-day="' + (i + 1) + '" class="' + (c && c.dayOfWeek === i + 1 ? 'on' : '') + '">' + n + '</button>';
      }).join('') +
      '</div></div>' +
      '<div class="row2">' +
      '<label class="field"><span>开始时间 *</span><input type="time" id="mo-start" value="' + esc(c ? c.startTime : '08:00') + '"></label>' +
      '<label class="field"><span>结束时间 *</span><input type="time" id="mo-end" value="' + esc(c ? c.endTime : '09:40') + '"></label>' +
      '</div>' +
      '<label class="field"><span>周次规则 *（哪些周上这门课）</span>' +
      '<input type="text" id="mo-week" placeholder="如：单周 / 1-16周 / 第1-4周 / 第2,3,5-7周" value="' + esc(weekText) + '"></label>' +
      '<div class="chip-row">' +
      ['每周', '单周', '双周', '前4周', '前8周', '第5-8周'].map(function (t) {
        return '<button type="button" class="chip" data-fill="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') +
      '</div>' +
      '<div class="preview-line" id="mo-preview"></div>' +
      '<div class="m-actions">' +
      '<button class="btn" id="mo-cancel">取消</button>' +
      '<button class="btn btn-primary" id="mo-save">保存</button>' +
      '</div>';

    var root = openModal(html);
    var selectedDay = c ? Math.round(+c.dayOfWeek) : 1;

    root.querySelectorAll('#mo-days button').forEach(function (b) {
      b.addEventListener('click', function () {
        selectedDay = +b.dataset.day;
        root.querySelectorAll('#mo-days button').forEach(function (x) {
          x.classList.toggle('on', +x.dataset.day === selectedDay);
        });
      });
    });
    root.querySelectorAll('.chip').forEach(function (ch) {
      ch.addEventListener('click', function () {
        $('mo-week').value = ch.dataset.fill;
        updateWeekPreview();
      });
    });
    $('mo-week').addEventListener('input', updateWeekPreview);
    $('mo-cancel').addEventListener('click', closeModal);

    function updateWeekPreview() {
      var res = CORE.parseWeekRule($('mo-week').value, state.config.totalWeeks, state.config.firstWeekOdd);
      var el = $('mo-preview');
      if (res.error) {
        el.textContent = '⚠️ ' + res.error;
        el.className = 'preview-line err';
        return;
      }
      var weeks = CORE.ruleMatchedWeeks(res.rule, state.config.totalWeeks, state.config.firstWeekOdd);
      var label = CORE.ruleToText(res.rule, state.config.totalWeeks, state.config.firstWeekOdd);
      el.textContent = '✓ ' + label + '，本学期共 ' + weeks.length + ' 次（第' + weeks.join('、') + '周）';
      el.className = 'preview-line';
    }
    updateWeekPreview();

    $('mo-save').addEventListener('click', function () {
      var name = $('mo-name').value.trim();
      var location = $('mo-location').value.trim();
      var startTime = $('mo-start').value;
      var endTime = $('mo-end').value;
      var parsed = CORE.parseWeekRule($('mo-week').value, state.config.totalWeeks, state.config.firstWeekOdd);

      var candidate = {
        id: c ? c.id : newId('c'),
        name: name,
        teacher: $('mo-teacher').value.trim(),
        location: location,
        dayOfWeek: selectedDay,
        startTime: startTime,
        endTime: endTime,
        weekRule: parsed.rule
      };
      var err = parsed.error || CORE.validateCourse(candidate);
      if (err) { toast('⚠️ ' + err); return; }
      // 统一走 sanitize（时间补零成 HH:MM、去首尾空格、周规则规范化）
      var clean = CORE.sanitizeCourse(candidate);
      if (!clean) { toast('⚠️ 课程信息不完整'); return; }

      // 冲突检测：同一天时间重叠且周次有交集的课程提醒确认（防止录错星期/时间；
      // 单双周错开的同一时段不算冲突）
      var sMins = CORE.timeToMinutes(clean.startTime);
      var eMins = CORE.timeToMinutes(clean.endTime);
      var clash = null;
      state.courses.forEach(function (x) {
        if (clash || x.id === (c ? c.id : '')) return;
        if (x.dayOfWeek !== selectedDay) return;
        var xs = CORE.timeToMinutes(x.startTime);
        var xe = CORE.timeToMinutes(x.endTime);
        if (!(Number.isFinite(xs) && Number.isFinite(xe) && xs < eMins && xe > sMins)) return;
        if (!weeksIntersect(clean.weekRule, x.weekRule)) return;
        clash = x;
      });
      if (clash && !confirm('⚠️ ' + dayCN(selectedDay) + ' 该时段已有「' + clash.name + '」（' + clash.startTime + '-' + clash.endTime + '），仍要保存吗？')) return;

      if (c) {
        var idx = state.courses.indexOf(c);
        if (idx >= 0) state.courses[idx] = clean;
      } else {
        state.courses.push(clean);
        // 首次添加课程后提醒一次“添加到主屏幕”以长期保存数据
        if (!state.settings.installNagged) {
          state.settings.installNagged = true;
          var installedNow = (navigator.standalone === true) ||
            (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
          if (!installedNow) {
            toast('💡 建议用 Safari 打开并“添加到主屏幕”：数据保存更持久（详见 设置→帮助）');
          }
        }
      }
      if (!saveState()) { toast('⚠️ 保存失败，课程未保存'); renderAll(); return; }
      closeModal();
      toast(c ? '已更新「' + name + '」' : '已添加「' + name + '」');
      renderAll();
    });
  }

  // 两条周规则在本学期内是否有交集的周次
  function weeksIntersect(ruleA, ruleB) {
    var tw = state.config.totalWeeks;
    var fo = state.config.firstWeekOdd;
    var wb = CORE.ruleMatchedWeeks(ruleB, tw, fo);
    if (!wb.length) return false;
    var wa = CORE.ruleMatchedWeeks(ruleA, tw, fo);
    for (var i = 0; i < wa.length; i++) {
      if (wb.indexOf(wa[i]) >= 0) return true;
    }
    return false;
  }

  /* ---------- 调休/停课编辑 ---------- */

  function openOverrideEditor(ovId) {
    var o = null;
    state.overrides.forEach(function (x) { if (x.id === ovId) o = x; });
    var html =
      '<h3>' + (o ? '编辑调休/停课' : '添加调休/停课') + '</h3>' +
      '<label class="field"><span>类型 *</span><select id="ov-type">' +
      '<option value="cancel"' + (o && o.type === 'cancel' ? ' selected' : '') + '>🚫 停课（整天不上课）</option>' +
      '<option value="shift"' + (o && o.type === 'shift' ? ' selected' : '') + '>🔄 补课（当天按其他星期几上课）</option>' +
      '</select></label>' +
      '<div id="ov-target-wrap" ' + (!o || o.type !== 'shift' ? 'hidden' : '') + '>' +
      '<label class="field"><span>当天按哪一天上课？</span><select id="ov-target">' +
      DAY_NAMES.map(function (n, i) {
        return '<option value="' + (i + 1) + '"' + (o && o.type === 'shift' && +o.targetDay === i + 1 ? ' selected' : '') + '>' + n + '</option>';
      }).join('') +
      '</select></label>' +
      '<label class="field"><span>补第几周的课？（可选）学校通知“补第4周周一的课”就填 4，按该周单双取课</span>' +
      '<input type="number" id="ov-sourceweek" min="1" max="40" step="1" value="' + esc(o && o.sourceWeek ? o.sourceWeek : '') + '"></label>' +
      '<label class="check-line"><input type="checkbox" id="ov-keepown"' + (o && o.keepOwn ? ' checked' : '') + '> 同时保留当天原有的课（如周末选修照常上）</label>' +
      '</div>' +
      '<label class="field"><span>开始日期 *</span><input type="date" id="ov-start" value="' + esc(o ? o.start : CORE.toISO(new Date())) + '"></label>' +
      '<label class="field"><span>结束日期（只停一天就留空）</span><input type="date" id="ov-end" value="' + esc(o && o.end ? o.end : '') + '"></label>' +
      '<label class="field"><span>备注（可选）</span><input type="text" id="ov-label" placeholder="如：国庆节 / 补周一的课" value="' + esc(o ? o.label : '') + '"></label>' +
      '<div class="m-actions">' +
      '<button class="btn" id="ov-cancel">取消</button>' +
      '<button class="btn btn-primary" id="ov-save">保存</button>' +
      '</div>';

    var root = openModal(html);
    $('ov-type').addEventListener('change', function () {
      $('ov-target-wrap').hidden = $('ov-type').value !== 'shift';
    });
    $('ov-cancel').addEventListener('click', closeModal);
    $('ov-save').addEventListener('click', function () {
      var type = $('ov-type').value;
      var start = $('ov-start').value;
      var end = $('ov-end').value || start;
      if (!CORE.parseISO(start) || !CORE.parseISO(end)) { toast('⚠️ 日期无效'); return; }
      if (end < start) { toast('⚠️ 结束日期早于开始日期'); return; }
      var targetDay = 1;
      var sourceWeek = null;
      var keepOwn = false;
      if (type === 'shift') {
        targetDay = Math.min(7, Math.max(1, Math.round(+$('ov-target').value || 1)));
        var swRaw = Math.round(+($('ov-sourceweek').value || 0));
        sourceWeek = Number.isFinite(swRaw) && swRaw >= 1 && swRaw <= 40 ? swRaw : null;
        keepOwn = $('ov-keepown').checked;
      }

      var item = {
        id: o ? o.id : newId('ov'),
        type: type,
        start: start,
        end: end,
        targetDay: targetDay,
        keepOwn: keepOwn,
        sourceWeek: sourceWeek,
        label: $('ov-label').value.trim()
      };
      if (o) {
        var idx = state.overrides.indexOf(o);
        if (idx >= 0) state.overrides[idx] = item;
      } else {
        state.overrides.push(item);
      }
      saveState();
      closeModal();
      toast('已保存');
      renderAll();
    });
  }

  /* ---------- 批量粘贴导入 ---------- */

  function openBatchImport() {
    var html =
      '<h3>📋 批量粘贴导入</h3>' +
      '<p class="hint" style="margin:0 0 10px">每行一门课：<b>课程名 周一 08:00-09:40 教三201 单周</b><br>' +
      '时间也可写“第1-2节”（按 设置→作息时间表 换算）；周规则可省略（=每周）；可加“张老师”；也支持“周一 08:00-09:40 高数 教三201 单周”的顺序。</p>' +
      '<textarea id="bi-text" rows="8" placeholder="高等数学 周二 第1-2节 教三201 1-18周&#10;大学英语 周一 10:00-11:40 外语楼305 双周 李老师&#10;程序设计基础 周三 10:00-11:40 机房B204 前4周"></textarea>' +
      '<div class="preview-line" id="bi-preview" style="margin-top:10px;white-space:pre-wrap;line-height:1.6"></div>' +
      '<label class="check-line"><input type="checkbox" id="bi-clear"> 导入前清空现有 ' + state.courses.length + ' 门课程</label>' +
      '<div class="m-actions">' +
      '<button class="btn" id="bi-cancel">取消</button>' +
      '<button class="btn btn-primary" id="bi-ok" disabled>导入</button>' +
      '</div>';

    var root = openModal(html);
    var lastResult = { courses: [], errors: [] };
    var importCfg = {
      totalWeeks: state.config.totalWeeks,
      firstWeekOdd: state.config.firstWeekOdd,
      periodTimes: state.settings.periodTimes
    };

    function update() {
      lastResult = CORE.parseScheduleLines($('bi-text').value, importCfg);
      var el = $('bi-preview');
      var okBtn = $('bi-ok');
      var parts = [];
      lastResult.errors.slice(0, 12).forEach(function (e) {
        parts.push('✗ 第' + e.line + '行：' + e.reason + '（' + (e.text.length > 18 ? e.text.slice(0, 18) + '…' : e.text) + '）');
      });
      if (lastResult.courses.length) {
        parts.unshift('✓ 可导入 ' + lastResult.courses.length + ' 门课程' +
          (lastResult.errors.length ? '，' + lastResult.errors.length + ' 行有误（将被跳过）' : ''));
        el.className = 'preview-line';
        okBtn.disabled = false;
        okBtn.textContent = '导入 ' + lastResult.courses.length + ' 门';
      } else {
        if (!parts.length) {
          parts.push('粘贴每行一门课，如：高等数学 周一 08:00-09:40 教三201 单周');
        }
        el.className = 'preview-line err';
        okBtn.disabled = true;
        okBtn.textContent = '导入';
      }
      el.textContent = parts.join('\n');
    }

    $('bi-text').addEventListener('input', update);
    update();
    $('bi-cancel').addEventListener('click', closeModal);
    $('bi-ok').addEventListener('click', function () {
      if (!lastResult.courses.length) return;
      if ($('bi-clear').checked) state.courses = [];
      lastResult.courses.forEach(function (c) { state.courses.push(c); });
      if (!saveState()) { toast('⚠️ 保存失败，导入未生效'); return; }
      closeModal();
      toast('已导入 ' + lastResult.courses.length + ' 门课程' + (lastResult.errors.length ? '，跳过 ' + lastResult.errors.length + ' 行' : ''));
      renderAll();
    });
  }

  /* ---------- 首次使用引导 ---------- */

  function showOnboarding() {
    var today = new Date();
    var html =
      '<h3>👋 欢迎使用课程表</h3>' +
      '<p class="hint" style="margin:0 0 14px">先确认学期信息（随时可在“设置”里改）。填“今天是第几周”即可，开学日期会自动推算；单双周按“第几周”自动判断。</p>' +
      '<label class="field"><span>今天是第几周？（学期中途开始用也没关系）</span>' +
      '<input type="number" id="ob-week" min="1" max="40" step="1" value="1"></label>' +
      '<label class="field"><span>学期总周数</span>' +
      '<input type="number" id="ob-weeks" min="1" max="40" step="1" value="20"></label>' +
      '<label class="check-line"><input type="checkbox" id="ob-odd" checked> 第1周为单周（按教务处校历核验）</label>' +
      '<div class="preview-line" id="ob-preview"></div>' +
      '<div class="m-actions">' +
      '<button class="btn" id="ob-demo">载入示例课程表（演示）</button>' +
      '<button class="btn btn-primary" id="ob-empty">开始使用</button>' +
      '</div>';

    var root = openModal(html);
    root.dataset.closable = 'no';

    function preview() {
      var n = Math.round(+$('ob-week').value);
      var fo = $('ob-odd').checked;
      var el = $('ob-preview');
      if (!Number.isFinite(n) || n < 1 || n > 40) {
        el.textContent = '⚠️ 请输入 1-40 之间的周数';
        el.className = 'preview-line err';
        return;
      }
      var start = CORE.toISO(CORE.addDays(CORE.startOfWeekMonday(today), -(n - 1) * 7));
      var parity = CORE.isOddWeek(n, fo) ? '单周' : '双周';
      el.textContent = '✓ 推算第1周从 ' + dateCN(start) + '（周一）开始；今天 = 第' + n + '周 · ' + parity;
      el.className = 'preview-line';
    }

    $('ob-week').addEventListener('input', preview);
    $('ob-weeks').addEventListener('input', preview);
    $('ob-odd').addEventListener('change', preview);
    preview();

    function go(demo) {
      var n = Math.round(+$('ob-week').value);
      if (!Number.isFinite(n) || n < 1 || n > 40) { toast('⚠️ 请输入 1-40 之间的周数'); return; }
      if (demo && state.courses.length && !confirm('载入示例课程表会覆盖你现有的 ' + state.courses.length + ' 门课程，确定吗？')) return;
      state.config.semesterStart = CORE.toISO(CORE.addDays(CORE.startOfWeekMonday(today), -(n - 1) * 7));
      state.config.totalWeeks = Math.min(40, Math.max(1, Math.round(+$('ob-weeks').value || 20)));
      state.config.firstWeekOdd = $('ob-odd').checked;
      state.settings.onboardingDone = true;
      if (demo) state.courses = CORE.buildDemoCourses();
      saveState();
      closeModal();
      toast(demo ? '已载入示例课程表：覆盖了每周/单双周/前4周等规则，去“课程”里改成你自己的课吧' : '已就绪：今天 = 第' + n + '周 · ' + CORE.weekParityLabel(n, state.config.firstWeekOdd));
      renderAll();
    }

    $('ob-empty').addEventListener('click', function () { go(false); });
    $('ob-demo').addEventListener('click', function () { go(true); });
  }

  /* ---------- 校准 ---------- */

  function openCalibrate() {
    var html =
      '<h3>🎯 校准周次</h3>' +
      '<p class="hint" style="margin:0 0 14px">如果发现单双周或第几周不对，回答两个问题即可，我来同时修正学期开始日期与单双周基准。</p>' +
      '<label class="field"><span>今天实际是第几周？</span>' +
      '<input type="number" id="cal-week" min="1" max="40" step="1" value="1"></label>' +
      '<div class="field"><span>这周是单周还是双周？</span><div class="day-picker" id="cal-parity">' +
      '<button type="button" data-p="odd" class="on">单周</button>' +
      '<button type="button" data-p="even">双周</button>' +
      '</div></div>' +
      '<div class="m-actions">' +
      '<button class="btn" id="cal-cancel">取消</button>' +
      '<button class="btn btn-primary" id="cal-ok">应用</button>' +
      '</div>';
    openModal(html);

    var parityPick = 'odd';
    document.querySelectorAll('#cal-parity button').forEach(function (b) {
      b.addEventListener('click', function () {
        parityPick = b.dataset.p;
        document.querySelectorAll('#cal-parity button').forEach(function (x) {
          x.classList.toggle('on', x.dataset.p === parityPick);
        });
      });
    });

    $('cal-cancel').addEventListener('click', closeModal);
    $('cal-ok').addEventListener('click', function () {
      var n = Math.round(+$('cal-week').value);
      if (!Number.isFinite(n) || n < 1 || n > 40) { toast('⚠️ 请输入 1-40 之间的周数'); return; }
      var today = new Date();
      var monday = CORE.startOfWeekMonday(today);
      // 联立推导：今天=第N周 且 今天=(单|双)周 → 反推 firstWeekOdd
      var answerOdd = parityPick === 'odd';
      state.config.semesterStart = CORE.toISO(CORE.addDays(monday, -(n - 1) * 7));
      state.config.firstWeekOdd = ((n % 2 === 1) === answerOdd);
      saveState();
      closeModal();
      toast('已校准：今天为第 ' + n + ' 周 · ' + (answerOdd ? '单周' : '双周'));
      renderAll();
    });
  }

  /* ---------- 数据操作 ---------- */

  function downloadBlob(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) {
      return false;
    }
  }

  function doExportJSON() {
    var json = CORE.exportState(state);
    var filename = '课程表备份-' + CORE.toISO(new Date()) + '.json';
    // 优先走系统分享（可存备忘录/微信/邮件），失败回退到文件下载
    if (navigator.canShare && navigator.share && window.File) {
      var file = new File([json], filename, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: '课程表备份' }).then(function () {
          toast('已通过系统分享发送备份（可存到备忘录/微信收藏/文件）');
        }).catch(function () {
          if (downloadBlob(filename, json, 'application/json')) {
            toast('备份文件已下载（“文件”App 的“下载”里可找到）');
          } else {
            showTextModal('备份文本（请全选复制保存）', json);
          }
        });
        return;
      }
    }
    if (downloadBlob(filename, json, 'application/json')) {
      toast('备份文件已下载（“文件”App 的“下载”里可找到）');
    } else {
      showTextModal('备份文本（请全选复制保存）', json);
    }
  }

  function showTextModal(title, text) {
    var html = '<h3>' + esc(title) + '</h3>' +
      '<textarea readonly rows="12" style="width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:12px;color:var(--text);font-family:monospace">' +
      esc(text) + '</textarea>' +
      '<div class="m-actions"><button class="btn btn-primary" id="txt-close">知道了</button></div>';
    var root = openModal(html);
    root.querySelector('textarea').addEventListener('focus', function () { this.select(); });
    $('txt-close').addEventListener('click', closeModal);
  }

  function doCopyJSON() {
    var json = CORE.exportState(state);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function () {
        toast('备份文本已复制，建议粘贴保存到备忘录或微信收藏');
      }).catch(function () {
        showTextModal('备份文本（请全选复制保存）', json);
      });
    } else {
      showTextModal('备份文本（请全选复制保存）', json);
    }
  }

  function doImportJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var res = CORE.parseState(String(reader.result || ''));
      if (res.error) { toast('⚠️ 导入失败：' + res.error); return; }
      if (!confirm('导入将覆盖当前的 ' + state.courses.length + ' 门课程与调休设置（建议先导出备份），继续吗？')) return;
      state = res.state;
      state.settings = state.settings || {};
      state.settings.onboardingDone = true;
      if (!saveState()) { toast('⚠️ 保存失败，导入未生效'); return; }
      toast('导入成功：' + state.courses.length + ' 门课程');
      renderAll();
    };
    reader.onerror = function () { toast('⚠️ 文件读取失败'); };
    reader.readAsText(file);
  }

  function doExportICS() {
    var alarm = 15;
    var alarmEl = $('ics-alarm');
    if (alarmEl) alarm = Math.min(120, Math.max(1, Math.round(+alarmEl.value || 15)));
    // 关键：把调休/停课也带进日历导出，避免节假日误提醒、补课日漏提醒
    var res = CORE.buildICS(state.courses, Object.assign({}, state.config, { overrides: state.overrides }), { alarmMinutes: alarm });
    if (res.error) { toast('⚠️ ' + res.error); return; }
    if (!res.count) { toast('⚠️ 当前没有可导出的课程'); return; }
    if (downloadBlob('我的课程表.ics', res.ics, 'text/calendar')) {
      toast('已导出 ' + res.count + ' 个日程（课前 ' + alarm + ' 分钟提醒）。在“文件”App 打开它 → 自动进入日历导入 → “全部添加”。若之前导入过旧课表，请先在“日历”App 删除旧事件，避免重复提醒');
    } else {
      showTextModal('导出失败，请复制以下内容保存为“我的课程表.ics”', res.ics);
    }
  }

  function doLoadDemo() {
    if (!confirm('载入示例课程表会覆盖你现有的 ' + state.courses.length + ' 门课程，确定吗？')) return;
    state.courses = CORE.buildDemoCourses();
    saveState();
    toast('已载入示例课程表（10 门课，覆盖单双周/前4周/自定义周次）');
    renderAll();
  }

  function doClearAll() {
    if (!confirm('确定清空所有数据（课程、调休、设置）？此操作不可撤销，建议先导出备份。')) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY + '-corrupt');
    } catch (e) {}
    location.reload();
  }

  /* ================= 视图切换 ================= */

  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('is-active'); });
    var view = $('view-' + name);
    if (view) view.classList.add('is-active');
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('is-active', t.dataset.view === name);
    });
    if (name === 'today') renderToday();
    if (name === 'week') renderWeek();
    if (name === 'courses') renderCourses();
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.dataset.view); });
    });

    $('week-prev').addEventListener('click', function () { weekOffset = Math.max(-60, weekOffset - 1); renderWeek(); });
    $('week-next').addEventListener('click', function () { weekOffset = Math.min(60, weekOffset + 1); renderWeek(); });
    $('week-today-btn').addEventListener('click', function () { weekOffset = 0; renderWeek(); });

    $('course-add').addEventListener('click', function () { openCourseEditor(null); });
    $('course-batch').addEventListener('click', openBatchImport);

    $('course-list').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      var id = btn.dataset.id;
      if (btn.dataset.act === 'edit') openCourseEditor(id);
      if (btn.dataset.act === 'del') {
        var c = findCourse(id);
        if (c && confirm('删除「' + c.name + '」？')) {
          state.courses = state.courses.filter(function (x) { return x.id !== id; });
          saveState();
          toast('已删除');
          renderAll();
        }
      }
    });

    $('set-semester-start').addEventListener('change', function () {
      if (!CORE.parseISO(this.value)) { toast('⚠️ 日期无效'); renderSettingsPreview(); return; }
      state.config.semesterStart = this.value;
      saveState();
      renderAll();
    });
    $('set-total-weeks').addEventListener('change', function () {
      state.config.totalWeeks = Math.min(40, Math.max(1, Math.round(+this.value || 20)));
      this.value = state.config.totalWeeks;
      saveState();
      renderAll();
    });
    $('set-first-week-odd').addEventListener('change', function () {
      state.config.firstWeekOdd = this.checked;
      saveState();
      renderAll();
    });
    $('set-calibrate').addEventListener('click', openCalibrate);

    $('set-periods').addEventListener('change', function () {
      var v = String(this.value || '').trim();
      var table = CORE.parsePeriodTable(v);
      if (v && !table.length) { toast('⚠️ 作息时间表格式不对：每行如“第1-2节 08:00-09:40”'); return; }
      state.settings.periodTimes = v;
      saveState();
      toast(table.length ? '已保存作息时间表（' + table.length + ' 条）' : '已恢复默认作息时间表');
    });

    $('override-add').addEventListener('click', function () { openOverrideEditor(null); });
    $('override-list').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      var id = btn.dataset.id;
      if (btn.dataset.act === 'ov-edit') { openOverrideEditor(id); return; }
      if (btn.dataset.act !== 'ov-del') return;
      if (confirm('删除这条调休/停课？')) {
        state.overrides = state.overrides.filter(function (x) { return x.id !== id; });
        saveState();
        toast('已删除');
        renderAll();
      }
    });

    $('data-export').addEventListener('click', doExportJSON);
    $('data-export-copy').addEventListener('click', doCopyJSON);
    $('data-import').addEventListener('click', function () { $('data-import-file').click(); });
    $('data-import-file').addEventListener('change', function () {
      if (this.files && this.files[0]) doImportJSON(this.files[0]);
      this.value = '';
    });
    $('ics-alarm').addEventListener('change', function () {
      state.settings.icsAlarmMinutes = Math.min(120, Math.max(1, Math.round(+this.value || 15)));
      saveState();
    });
    $('data-ics').addEventListener('click', doExportICS);
    $('data-demo').addEventListener('click', doLoadDemo);
    $('data-clear').addEventListener('click', doClearAll);
  }

  /* ================= 帮助内容 ================= */

  function renderHelp() {
    var installed = (navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var html = '';
    if (!installed) {
      html += '<p><b>⚠️ 请务必安装成 App：</b>用 Safari 打开本页面 → 点底部“分享”按钮 → 选择“添加到主屏幕” → 点“添加”。iOS 会清理长期未访问的网页数据，安装到主屏幕后数据长期保存更可靠。</p>';
    } else {
      html += '<p><b>✅ 已作为 App 安装。</b>数据保存在本机，长期有效。</p>';
    }
    html +=
      '<p><b>🔢 单双周怎么判断：</b>以学期开始日期所在周为第1周（单周），第2周双周，以此类推。若与实际不符，用“校准”同时告诉 App 今天是第几周、单周还是双周。</p>' +
      '<p><b>⏰ 上课提醒：</b>本 App 是纯静态网页、没有推送服务器，无法主动发通知（含 App 关闭时）。推荐用“导出到苹果日历”，在“日历”App 里获得系统级提醒。</p>' +
      '<p><b>💾 备份：</b>数据只存在这台设备。换手机或怕丢数据时，用“导出备份”通过系统分享保存到备忘录/微信，或在新设备“导入备份”。</p>' +
      '<p><b>🧭 数据在哪：</b>若用 Safari 直接打开网址发现是空白或旧数据，不要担心数据丢失——Safari 与主屏幕 App 的数据可能分开存放，从主屏幕图标打开即可找回。</p>' +
      '<p><b>🔒 隐私：</b>所有数据只保存在你手机的浏览器本地，不经过任何服务器、无账号、无广告、无追踪。</p>';
    $('help-box').innerHTML = html;
  }

  /* ================= 主流程 ================= */

  function renderAll() {
    renderTop();
    renderToday();
    renderWeek();
    renderCourses();
    renderSettings();
    renderHelp();
  }

  function init() {
    var loaded = loadState();
    if (loaded && loaded.corrupt) {
      state = defaultState();
      toast('检测到本地数据损坏，已重置（损坏数据已备份到浏览器存储）');
    } else if (loaded) {
      state = loaded;
      if (loaded._droppedCourses || loaded._droppedOverrides) {
        toast('已自动清理 ' + loaded._droppedCourses + ' 条损坏课程、' + loaded._droppedOverrides + ' 条损坏调休数据');
      }
    } else {
      state = defaultState();
    }

    bindEvents();
    renderAll();

    if (!state.settings.onboardingDone) showOnboarding();

    // 开学前首次打开：周课表直接定位到第 1 周（而不是停在“未开学”的负周）
    var thisWeekNow = CORE.getWeekNumber(new Date(), state.config.semesterStart);
    if (Number.isFinite(thisWeekNow) && thisWeekNow < 1) {
      weekOffset = 1 - thisWeekNow;
    }

    // “下一节课”卡片每 30 秒刷新一次
    nowTimer = setInterval(function () {
      if ($('view-today').classList.contains('is-active')) renderToday();
      renderTop();
    }, 30000);

    // 主题色跟随深色模式
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function applyThemeColor() {
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.content = (mq && mq.matches) ? '#0f1219' : '#4a6cf7';
    }
    if (mq && mq.addEventListener) mq.addEventListener('change', applyThemeColor);
    applyThemeColor();

    // 键盘弹出时给底部弹窗留出空间，避免遮挡“保存”按钮
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        var modal = document.querySelector('.modal');
        if (!modal) return;
        var kb = window.innerHeight - window.visualViewport.height;
        modal.style.paddingBottom = kb > 0 ? (kb + 24) + 'px' : '';
      });
    }

    // 注册 Service Worker（需要 https 或 localhost）
    if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      });
    }
  }

  init();
})();
