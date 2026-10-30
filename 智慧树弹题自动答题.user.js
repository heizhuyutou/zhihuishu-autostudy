// 智慧树(知到)看课自动化 —— Chromium 扩展内容脚本，run_at=document_start，world=MAIN（与页面同世界，才摸得到站点的 XHR/zhsMonitor）
// 部署在 Ubuntu 上用：~/.local/share/zhs-clicker/zhs_clicker_linux.py 提供 CDP 真点击通道（127.0.0.1:8971）
// 功能：弹题自动作答+代关、播完自动下一课、掉线续播、每日观看时长上限、到点开播


(function () {
  'use strict';
  if (window !== window.top) return;   // 只在顶层页面跑一套状态机；同源 iframe 里的弹题由顶层读 DOM + 算坐标

  // 脚本以 world=MAIN 注入：和站点同一个 JS 世界，环境自检/修复、zhsMonitor 捕获才真的作用在页面上。
  const REALM = window;

  // ================= 可调参数 =================
  const CFG = {
    // 功能开关（排查"被发现"用：先全关观察，再逐个开）
    autoAnswer: true,       // 弹题自动作答
    autoNext: true,         // 播完自动下一课
    autoResume: true,       // 暂停自动恢复播放
    stallMin: 8,            // 视频多久没进度就提醒一次（分钟）：登录掉线/被弹窗挡住/断网都会表现为"进度不动"
    startAt: '08:00',       // 每天几点才允许"自动开播"（格式 HH:MM）：页面提前开着、视频停着，到点自己播；空字符串 = 不限时间，随时自动续播
    startJitter: 30,        // 开播窗口(分钟)：每天在 startAt ~ startAt+startJitter 之间随机取一分钟开播（0 = 老行为，固定 startAt）
    // 行为参数
    tick: 1500,             // 主循环间隔(ms)
    startDelay: 6000,       // 页面加载后延迟多久才开始动作(ms)
    humanize: true,         // 人味节奏：看题4~10s、每次尝试间隔3~6s、切课15~30s（关掉=更快）
    // 人味节奏参数（人类真实节奏：读短题+点选 3~10 秒；晾太久比太快更可疑，弹题有作答窗口）
    thinkMin: 4000, thinkMax: 10000,     // 看到题后"思考"多久才开始作答
    gapMin: 3000, gapMax: 6000,          // 每次尝试之间
    jumpMin: 15000, jumpMax: 30000,      // 播完后隔多久切下一课
    hideWarn: false,        // 吞掉"异常脚本"警告弹窗——只隐藏表象，服务端处罚记录照旧累积，慎开
    feedbackWait: 2200,     // 点一个选项后等判定结果的时间(ms)（humanize 关闭时生效）
    jitter: 800,            // 动作间隔随机抖动上限(ms)，模拟人的节奏
    randomPick: true,       // 单选/判断题：随机挑一个选项点一次就收工（站点不给"做对了"的反馈，一直点下去没意义）
    questionTimeout: 300000, // 单个题目最长处理时间(ms)，超时强制关闭（humanize 时看题+尝试可达3分钟）
    closeCooldown: 3500,    // 关闭弹窗后多久内不再理会同一弹层(躲关闭动画)
    endThreshold: 0.98,     // 播放进度达到该比例视为播完
    jumpDelay: 15000,       // 播完后隔多久再切下一课(ms)：站点在"学习上报"时刻做环境自检，避开那个瞬间
    helper: true,           // 第6档"真鼠标"：需要另开 zhs_clicker.py（本机 helper），合成事件被忽略时靠它用系统级真实点击
    helperPort: 8971,       // helper 监听端口（只监听 127.0.0.1）
    autoClose: true,        // 答对后是否由脚本点"关闭"；设 false = 只作答不代关，关闭动作全交给你（关闭动作零风险）
    jumpVerifyWait: 30000,  // 点了下一课时后，多久没真的切过去就判该条目点不动(大纲行)，拉黑换下一条（3分钟后黑名单作废重试）
    nextCooldown: 25000,    // 点击下一课后的冷却时间(ms)，防重复点击
    useDomAnswer: true,     // 页面把正确答案写在 DOM 里(旧版播放器 .answer)时直接用，否则退回依次点击
    repairEnv: true,        // 环境脏了才动手：把被 hook 的 XHR.open/addEventListener 覆盖回原生
    capture422: true,       // 挂一层 window.zhsMonitor.open 记录服务端判定(plan/type)显示到角标；关掉则不碰页面对象
    cookieGuard: true,      // 吞掉"清 cookie"惩罚写法，保住登录态
    badge: true,            // 页面右下角显示状态角标（诊断用，可关）
    debug: false,           // 控制台日志（平时关：留日志要开 DevTools，本身易触发网页检测）
  };

  const log = (...a) => { if (CFG.debug) console.log('[zhs]', ...a); };
  const VERSION = '1.19.0';   // 与 @version 同步；显示在角标上，用来确认浏览器里跑的是哪一版
  try { window.__zhsRan = VERSION; } catch (e) { /* 诊断标记：确认内容脚本注入了 */ }
  const rand = () => Math.floor(Math.random() * CFG.jitter);

  // ================= 每日观看时长上限 =================
  // 学校要求连续多天、每天看够一定时长：一天把课看完，连续性就断了。
  // 口径 = 播放进度增量（currentTime），也就是站点自己记的"学习时长"：
  //   暂停/结束时进度不动 → 答题、切课、缓冲的时间天然不算，不用额外扣除。
  // 到点只做两件事：停住视频、不再自动续播/切课。用户手动点播放不硬刚（但角标会标"超"）。
  const LS_CFG = 'zhs-watch-cfg-v1';
  const LS_DAY = 'zhs-watch-day-v1';
  const lsGet = (k, d) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式就算了 */ } };
  let WCFG = Object.assign({ mode: 'off', custom: 25, autoMin: 28, autoMax: 35 }, lsGet(LS_CFG, {}));
  const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const fmtHM = (sec) => { const s = Math.max(0, Math.floor(sec)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };
  // startAtMin：今天抽到的开播时刻（当天固定的分钟数，-1 = 不限制）
  let WDAY = { date: '', target: 0, watched: 0, startedAt: 0, startAtMin: -1 };
  let wDirty = false, wSavedAt = 0, wPauseOnce = false;
  const ctSeen = new WeakMap();      // video → 上一轮读到的 currentTime

  function rollTarget() {
    if (WCFG.mode === 'off') return 0;
    if (WCFG.mode === 'custom') return Math.max(60, Math.round((WCFG.custom || 25) * 60));
    const lo = Math.max(1, Math.round(WCFG.autoMin || 28));
    const hi = Math.max(lo, Math.round(WCFG.autoMax || 35));
    return Math.round((lo + Math.random() * (hi - lo)) * 60);   // 每天抽一次，当天固定
  }
  // 开播时刻每天抽一次：固定 08:00 太像机器，窗口内随机更像人；抽到的当天不变，跨天重抽。
  function rollStartAt() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(CFG.startAt || '').trim());
    if (!m) return -1;
    const base = (+m[1]) * 60 + (+m[2]);
    const j = Math.max(0, Math.round(Number(CFG.startJitter) || 0));
    return j ? base + Math.floor(Math.random() * (j + 1)) : base;
  }
  const fmtAtMin = (v) => (v < 0 ? '不限时间' : Math.floor(v / 60) + ':' + ('0' + (v % 60)).slice(-2));
  function saveDay(force) {
    if (!force && Date.now() - wSavedAt < 5000) { wDirty = true; return; }
    wSavedAt = Date.now(); wDirty = false;
    lsSet(LS_DAY, WDAY);
  }
  function loadDay() {
    const t = todayKey();
    const d = lsGet(LS_DAY, null);
    if (d && d.date === t) {
      WDAY = { date: t, target: Math.max(0, Math.round(d.target || 0)), watched: Math.max(0, d.watched || 0), startedAt: Math.max(0, d.startedAt || 0),
               startAtMin: Number.isFinite(d.startAtMin) ? Math.round(d.startAtMin) : rollStartAt() };
    } else {
      WDAY = { date: t, target: 0, watched: 0, startedAt: 0, startAtMin: rollStartAt() };
    }
    if (WCFG.mode === 'off') WDAY.target = 0;
    else if (!WDAY.target) WDAY.target = rollTarget();
    wPauseOnce = false;
    saveDay(true);
  }
  // 每天几点才允许自动开播：到点前只"看着"，不替你按播放
  const startMin = () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(CFG.startAt || '').trim());
    return m ? (+m[1]) * 60 + (+m[2]) : -1;
  };
  const waitForStart = () => {
    const sm = startMin();
    if (sm < 0) return false;                       // 没设时间 = 不限
    if (WDAY.startedAt) return false;               // 今天已经开过了（不管是它自己开的还是你手动开的）
    const d = new Date();
    const at = Number.isFinite(WDAY.startAtMin) && WDAY.startAtMin >= 0 ? WDAY.startAtMin : sm;
    return (d.getHours() * 60 + d.getMinutes()) < at;
  };

  // ---- 看门狗：登录掉线 / 视频长时间不动，要立刻让人知道（今天就是卡了一百多分钟没人发现）----
  let nagAt = 0, nagWhat = '', lastProgressAt = Date.now(), lastWatchedSeen = 0, loginWallSeen = false;
  function onScreen(el) {
    try {
      if (!el || (el.isConnected === false)) return false;
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        const st = getComputedStyle(e);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      }
      const r = rectOf(el);
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }
  function detectLoginWall(docs) {
    try {
      if (/passport\.|\/login/i.test(location.href)) return '登录过期，需要重新登录';
      for (const d of docs) {
        // 播放页上出现**真看得见的**密码框 = 登录已经掉了
        // （站点常把登录弹层留在 DOM 里，靠祖先 display:none 藏起来——所以必须逐层往上查）
        for (const pw of d.querySelectorAll('input[type=password]')) {
          if (onScreen(pw)) return '登录过期，需要重新登录';
        }
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }
  function nag(msg, force, key) {
    const now = Date.now();
    // 去重键：默认用全文，但"视频 1141 分钟没动"这种带数字的必须给稳定键，
    // 否则数字每变一次就算一条新消息，10 分钟去重形同虚设 → 每分钟响一次。
    const k = key || msg;
    if (!force && k === nagWhat && now - nagAt < 10 * 60000) return;
    nagAt = now; nagWhat = k;
    log('提醒：' + msg);
    try {                                          // 系统通知（经外挂 notify-send）
      if (CFG.helper && HELP.ok !== false) helperSend('notify', 'title=' + encodeURIComponent('智慧树') + '&msg=' + encodeURIComponent(msg));
    } catch (e) { /* 忽略 */ }
    try {                                          // 通知被系统拦了，至少要能看见
      const base = document.title.replace(/^⚠ [^|]*\| /, '');
      document.title = '⚠ ' + msg + ' | ' + base;
    } catch (e) { /* 忽略 */ }
  }
  // 会话保活：知到用的是 CAS 票据，长时间一点请求都没有就可能被服务端判闲置回收。
  // 夜里等 08:00 开播这一段最容易过期（早上一开口就是"需登录"，白等）。
  // 做法：空闲时每 8 分钟用同源请求碰一下页面本身；被重定向到登录页 = 票没了，立刻叫人。
  // 间隔随机 6~14 分钟：等间隔本身也是"机器特征"（日志里每 8 分钟一次，太整齐）。
  let warmAt = 0, warmBad = false;
  const warmGap = () => (6 + Math.random() * 8) * 60000;
  function keepWarm(idle) {
    if (!idle) return;
    if (Date.now() - warmAt < warmGap()) return;
    warmAt = Date.now();
    try {
      fetch(location.href, { credentials: 'include', cache: 'no-store' }).then((r) => {
        if (/passport\.|\/login/i.test(r.url || '')) {
          if (!warmBad) { warmBad = true; nag('登录已过期（保活请求被跳到登录页）'); }
        } else if (warmBad) { warmBad = false; log('保活恢复正常'); }
      }).catch(() => { /* 断网之类：下一轮再试，不吵人 */ });
    } catch (e) { /* 忽略 */ }
  }
  const overLimit = () => WDAY.target > 0 && WDAY.watched >= WDAY.target;
  const leftSec = () => (WDAY.target > 0 ? Math.max(0, WDAY.target - WDAY.watched) : -1);

  function trackWatch(docs) {
    const t = todayKey();
    if (WDAY.date !== t) {                       // 跨天了：清零，随机模式重新抽
      WDAY = { date: t, target: rollTarget(), watched: 0, startedAt: 0, startAtMin: rollStartAt() };
      wPauseOnce = false;
      saveDay(true);
      log('新的一天：观看计时清零', WDAY.target ? '（今日上限 ' + fmtHM(WDAY.target) + '）' : '（不限时）');
    }
    for (const d of docs) {
      const v = d.querySelector('video');
      if (!v) continue;
      const prev = ctSeen.get(v);
      const ct = isFinite(v.currentTime) ? v.currentTime : 0;
      ctSeen.set(v, ct);
      if (prev === undefined) continue;
      const dt = ct - prev;
      // 只累加"真在播"的进度：暂停/结束时进度不动，答题和切课的时间天然不计；
      // dt 过大只可能是拖进度条或换片源，不能算成观看
      if (!v.paused && !v.ended && dt > 0 && dt < 3) {
        WDAY.watched += dt; wDirty = true;
        if (!WDAY.startedAt) { WDAY.startedAt = Date.now(); log('今天开始看（' + fmtHM(WDAY.watched) + '）'); }   // 不论谁按的播放，都算今天已开工
      }
    }
    if (wDirty) saveDay(false);
  }
  // 到点把视频停住（只停一次；之后用户手动再点播放就随他，但我们不再自动续播/切课）
  function enforceLimit(doc) {
    if (!overLimit()) return false;
    const v = doc && doc.querySelector('video');
    if (v && !v.paused && !wPauseOnce) {
      wPauseOnce = true;
      try { v.pause(); } catch (e) { /* 忽略 */ }
      saveDay(true);     // 立刻落盘：刷新/关页也不会把"今天已看满"丢了
      log('今日视频时长已到 ' + fmtHM(WDAY.watched) + '/' + fmtHM(WDAY.target) + '，暂停');
    }
    return true;
  }

  function buildPanel() {
    if (document.getElementById('zhs-watch-panel')) return;
    const p = document.createElement('div');
    p.id = 'zhs-watch-panel';
    p.style.cssText = 'position:fixed;right:8px;bottom:36px;z-index:2147483647;width:258px;' +
      'background:rgba(22,22,22,.96);color:#ddd;border-radius:8px;padding:10px 12px;' +
      'font:12px/1.8 "Noto Sans CJK SC","WenQuanYi Micro Hei",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.45);display:none';
    p.innerHTML =
      '<div style="font-weight:600;color:#fff">观看时长（不含答题/切课）</div>' +
      '<div style="color:#9a9a9a">今日已看 <b id="zhs-w-now" style="color:#7fd">0:00</b> / <span id="zhs-w-goal">不限</span></div>' +
      '<div style="color:#9a9a9a">自动开播：<b style="color:#fc6">' +
      (startMin() >= 0 ? (Number(CFG.startJitter) > 0 ? CFG.startAt + '–' + fmtAtMin(startMin() + Math.round(Number(CFG.startJitter))) + ' 之间' : CFG.startAt) : '不限时间') +
      '</b>' + (Number.isFinite(WDAY.startAtMin) && WDAY.startAtMin >= 0 && Number(CFG.startJitter) > 0 ? '（今日 ' + fmtAtMin(WDAY.startAtMin) + '）' : '') +
      (startMin() >= 0 ? ' 页面先开着，到点自己播' : '') + '</div>' +
      '<label style="display:block;margin-top:5px;cursor:pointer"><input type="radio" name="zhs-wm" value="off"> 不限时（一直看下去）</label>' +
      '<label style="display:block;cursor:pointer"><input type="radio" name="zhs-wm" value="auto"> 每天随机 ' +
      '<input id="zhs-w-min" type="number" min="1" max="600" style="width:42px"> – <input id="zhs-w-max" type="number" min="1" max="600" style="width:42px"> 分钟</label>' +
      '<label style="display:block;cursor:pointer"><input type="radio" name="zhs-wm" value="custom"> 自定义 ' +
      '<input id="zhs-w-cus" type="number" min="1" max="600" style="width:50px"> 分钟</label>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
      '<button id="zhs-w-save" style="flex:1;padding:4px 0;border:0;border-radius:4px;background:#2d7;color:#111;font-weight:600;cursor:pointer">保存并生效</button>' +
      '<button id="zhs-w-close" style="padding:4px 10px;border:0;border-radius:4px;background:#444;color:#ddd;cursor:pointer">关闭</button>' +
      '</div>';
    document.body.appendChild(p);
    p.querySelectorAll('input[type=number]').forEach(n => {
      n.style.cssText = 'color:#111;background:#eee;border:0;border-radius:3px;padding:1px 3px';
    });
    ['click', 'mousedown', 'mouseup', 'keydown'].forEach(ev => p.addEventListener(ev, e => e.stopPropagation()));
    p.querySelector('#zhs-w-close').onclick = () => { p.style.display = 'none'; };
    p.querySelector('#zhs-w-save').onclick = applyPanel;
    syncPanel();
  }
  // 面板上最后一次操作的时间。以前 syncPanel 每 1.5s 无条件把控件刷成存档值，
  // 结果"刚点单选/刚删掉一个数字，1 秒内自己弹回去"，得抢在刷新前点保存——这就是那个回弹。
  let panelTouch = 0;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#zhs-watch-panel')) panelTouch = Date.now();
  }, true);
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#zhs-watch-panel')) panelTouch = Date.now();
  }, true);

  function syncPanel() {
    const p = document.getElementById('zhs-watch-panel');
    if (!p) return;
    const now = p.querySelector('#zhs-w-now'), goal = p.querySelector('#zhs-w-goal');
    if (now) now.textContent = fmtHM(WDAY.watched);
    if (goal) {
      goal.textContent = WDAY.target > 0
        ? fmtHM(WDAY.target) + (overLimit() ? '（已到，已停）' : '（还剩 ' + fmtHM(leftSec()) + '）')
        : '不限';
    }
    // 进度文字照常刷新；控件在用户动过之后 20 秒内不再被覆盖
    if (Date.now() - panelTouch < 20000) return;
    p.querySelector('#zhs-w-min').value = WCFG.autoMin;
    p.querySelector('#zhs-w-max').value = WCFG.autoMax;
    p.querySelector('#zhs-w-cus').value = WCFG.custom;
    const r = p.querySelector('input[name=zhs-wm][value="' + WCFG.mode + '"]');
    if (r) r.checked = true;
  }
  function applyPanel() {
    const p = document.getElementById('zhs-watch-panel');
    if (!p) return;
    const mode = (p.querySelector('input[name=zhs-wm]:checked') || {}).value || 'off';
    const num = (sel, d) => {
      const v = parseInt(p.querySelector(sel).value, 10);
      return isFinite(v) && v > 0 ? Math.min(v, 600) : d;
    };
    const min = num('#zhs-w-min', 28), max = num('#zhs-w-max', 35);
    WCFG = { mode, autoMin: Math.min(min, max), autoMax: Math.max(min, max), custom: num('#zhs-w-cus', 25) };
    lsSet(LS_CFG, WCFG);
    WDAY.target = rollTarget();        // 换规则后今天的上限按新规则重算（已看的时长保留）
    wPauseOnce = false;
    saveDay(true);
    panelTouch = 0;                   // 存完了：控件跟着存档值走（顺带把 28/35 这种大小颠倒纠正过来）
    syncPanel();
    activity = WDAY.target > 0 ? '今日上限 ' + fmtHM(WDAY.target) : '不限时';
    updateBadge();
    log('观看时长规则已更新', JSON.stringify(WCFG), '今日上限', fmtHM(WDAY.target));
  }
  function togglePanel() {
    buildPanel();
    const p = document.getElementById('zhs-watch-panel');
    if (!p) return;
    const show = !p.style.display || p.style.display === 'none';
    panelTouch = 0;
    p.style.display = show ? 'block' : 'none';
    if (show) syncPanel();
  }

  // ================= 环境自检/修复 =================
  // 站点在每次学习上报时做 isNative 校验（源码实测四条）：
  //   XMLHttpRequest 原生 / XMLHttpRequest.prototype.open 原生 / 无 window.OCS / addEventListener 原生
  // 谁 hook 了 XHR.open 或 addEventListener（翻页类脚本、安全软件注入），谁触发"异常脚本"清 cookie 弹回。
  // 修法：同源隐藏 iframe 有全新 realm，其原生实现是干净的，覆盖回去即可——页面自己从不包装这几个。
  const nativeLike = /\{\s*\[native code\]\s*\}/;
  const ots = (REALM.originFunction && REALM.originFunction.FunctionToString) || Function.prototype.toString;
  function isNative(fn) {
    try { return typeof fn === 'function' && nativeLike.test(ots.call(fn)); } catch (e) { return false; }
  }
  let cleanRealm = null;
  function getCleanWindow() {
    if (cleanRealm && cleanRealm.document) return cleanRealm;
    const f = document.createElement('iframe');
    f.style.display = 'none';
    (document.body || document.documentElement).appendChild(f);
    cleanRealm = f.contentWindow;
    try { cleanRealm.__zhsCleanRealm = true; } catch (e) { /* 忽略 */ }
    return cleanRealm;
  }
  let envLogged = false;
  let cookieGuarded = false;   // cookie setter 是否已包过（标记放闭包，不写页面对象）
  let envBad = [];        // 最近一次环境检查结果
  let lastCheck = null;   // 最近一次服务端 422 判定：{plan, type, count}
  let activity = '准备中';  // 当前动作，实时显示在角标上（免得看起来像卡死）
  let doneAll = false;     // 这一科的视频全部看完了：不再自动切课/续播，角标停在"全部看完了"
  let deferredEl = null;   // 点不中而放弃代答的弹层：长时间不再理会，把题留给人工
  let deferredAt = 0;
  let pendingJump = null;  // 已点击、等待验证的课时条目：确认真的切过去了才算成功
  let seekDone = false;    // 本次页面加载是否已做过"跳到第一个没看完的课时"
  const deadItems = [];    // 点了却没切过去的死条目（大纲行等），本轮不再点
  let deadItemsAt = 0;     // 拉黑时间：3 分钟后作废重试（别把一次偶发失败当成永久拉黑）
  let quickJump = false;   // 展开章节/滚动目录之后：下一轮快速重扫，不等 15~30s 的人味间隔
  const expandTried = new Map();   // 章节标题行 → 已尝试次数(1=点箭头, 2=点整行)；每次切课成功都清空，免得第五章第六章被判成"试过了"
  let lastNextBtnTryAt = 0;        // "下一节"按钮的尝试冷却：按时间算，不按元素身份（按钮往往自始至终是同一个节点）
  const NEXT_BTN_COOLDOWN = 45000;
  // 钉死检查点：属性换成"永远返回干净原生"的访问器，谁再写入都被吞掉。
  // 比"脏了再覆盖"强在没有竞争窗口——对方反复 re-hook 也翻不了天。
  function pinClean(obj, prop, cleanValue) {
    try {
      Object.defineProperty(obj, prop, {
        configurable: true,
        get: () => cleanValue,
        set: () => { /* 吞掉 re-hook */ },
      });
      return true;
    } catch (e) {
      try { obj[prop] = cleanValue; } catch (e2) { /* 忽略 */ }
      return isNative(obj[prop]);
    }
  }
  // 四条检测条件此刻是否干净（和站点同一把尺子）
  function checkPoints() {
    const bad = [];
    if (!isNative(REALM.XMLHttpRequest)) bad.push('XHR');
    if (!isNative(REALM.XMLHttpRequest.prototype.open)) bad.push('XHR.open');
    if (REALM.OCS) bad.push('OCS');
    if (!isNative(Element.prototype.addEventListener)) bad.push('addEventListener');
    return bad;
  }
  function updateBadge(stillBad) {
    if (!CFG.badge) return;
    try {
      let el = document.getElementById('zhs-badge');
      if (!el) {
        el = document.createElement('div');
        el.id = 'zhs-badge';
        el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;' +
          'background:rgba(0,0,0,.7);color:#fff;font:12px/1.6 monospace;padding:2px 8px;' +
          'border-radius:4px;pointer-events:auto;cursor:pointer;opacity:.85';
        el.title = '点这里设置每天观看多久';
        el.onclick = () => togglePanel();      // 点角标 → 观看时长面板
        (document.body || document.documentElement).appendChild(el);
      }
      const bad = stillBad || envBad || [];
      let t = 'zhs v' + VERSION + ' ' + activity + ' | ' + (bad.length ? 'env✗ ' + bad.join(',') : 'env✓');
      // 外挂(真鼠标通道)状态：没装/没跑/没授权 都如实显示，免得"看起来在工作"
      if (CFG.helper) t += HELP.ok === true
        ? (HELP.trusted === false ? ' | 外挂未授权' : (HELP.via === 'img' ? ' | 外挂✓(img)' : ' | 外挂✓'))
        : (HELP.ok === false ? ' | 外挂不通' : ' | 外挂?');
      // 服务端 422 判定：把 checkType/checkPlan 摆出来（这就是"哪条规则判的"）
      if (lastCheck) t += ' | 422×' + lastCheck.count + ' plan=' + lastCheck.plan + ' type=' + lastCheck.type;
      // 今日观看时长：有上限就显示 已看/上限
      if (WDAY.target > 0) t += ' | 今日 ' + fmtHM(WDAY.watched) + '/' + fmtHM(WDAY.target) + (overLimit() ? ' 已停' : '');
      else if (WDAY.watched > 0) t += ' | 今日 ' + fmtHM(WDAY.watched);
      if (!overLimit() && waitForStart()) t += ' | 等 ' + fmtAtMin(WDAY.startAtMin) + ' 开播';
      el.textContent = t;
      el.style.background = lastCheck ? 'rgba(150,0,0,.85)' : 'rgba(0,0,0,.7)';
      syncPanel();                            // 面板开着就同步刷新
    } catch (e) { /* 忽略 */ }
  }
  // 清 cookie 的惩罚写法（expires=1970）一律吞掉，保住登录态
  function guardCookies() {
    try {
      if (cookieGuarded) return;
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (!desc || !desc.set) return;
      const cleanSet = desc.set;
      const wrapped = function (v) {
        try {
          if (/expires=(Thu,\s*01\s*Jan\s*1970|Wed,\s*31\s*Dec\s*1969)|max-age=0/i.test(String(v))) return;
        } catch (e) { /* 忽略 */ }
        return cleanSet.call(this, v);
      };
      // 同样伪装成原函数（名字/长度/toString），不在页面对象上留自定义属性
      try { Object.defineProperty(wrapped, 'name', { value: cleanSet.name, configurable: true }); } catch (e) { /* 忽略 */ }
      try { Object.defineProperty(wrapped, 'length', { value: cleanSet.length, configurable: true }); } catch (e) { /* 忽略 */ }
      try { Object.defineProperty(wrapped, 'toString', { value: cleanSet.toString.bind(cleanSet), enumerable: false, configurable: true, writable: true }); } catch (e) { /* 忽略 */ }
      cookieGuarded = true;
      Object.defineProperty(Document.prototype, 'cookie', { get: desc.get, set: wrapped, configurable: true });
    } catch (e) { /* 忽略 */ }
  }
  function ensureEnv() {
    try {
      const before = checkPoints();
      if (!before.length) {          // 环境本来就干净：什么都不做、一个 iframe 都不插（减少被动足迹）
        envBad = [];
        updateBadge();
        if (!envLogged) { envLogged = true; log('env: 干净'); }
        return;
      }
      const cw = getCleanWindow();   // 只有真的脏了才插隐藏 iframe 取干净原件
      if (CFG.repairEnv) {
        if (before.includes('XHR')) pinClean(REALM, 'XMLHttpRequest', cw.XMLHttpRequest);
        if (before.includes('XHR.open')) pinClean(REALM.XMLHttpRequest.prototype, 'open', cw.XMLHttpRequest.prototype.open);
        if (before.includes('OCS')) pinClean(REALM, 'OCS', undefined);
        if (before.includes('addEventListener')) pinClean(Element.prototype, 'addEventListener', cw.Element.prototype.addEventListener);
      }
      const stillBad = checkPoints();
      envBad = stillBad;
      updateBadge(stillBad);
      if (!envLogged) {
        envLogged = true;
        log('env 脏:', before.join(','), stillBad.length ? '→ 修不掉:' + stillBad.join(',') : '→ 已钉死');
      }
    } catch (e) {
      if (!envLogged) { envLogged = true; log('env 处理失败:', e && e.message); }
    }
  }

  // ================= 基础工具 =================
  function vis(el) {
    if (!el) return false;
    try {
      return el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== 'hidden' &&
        getComputedStyle(el).display !== 'none';
    } catch (e) { return false; }
  }

  function textOf(el) {
    return ((el && el.innerText) || '').replace(/\s+/g, ' ').trim();
  }

  // 向上找可访问的最顶层窗口：同源多 frame 只让最上面那个实例干活，避免重复点击；
  // 跨域 frame 里 top.document 取不到，那个 frame 自己就是根，照常干活。
  function rootWindow() {
    let w = window;
    while (true) {
      try {
        if (w.parent && w.parent !== w && w.parent.document) w = w.parent;
        else break;
      } catch (e) { break; }
    }
    return w;
  }

  function collectDocs() {
    const docs = [];
    const seen = new Set();
    (function walk(w) {
      try {
        if (w.__zhsCleanRealm) return;   // 环境修复用的隐藏 iframe，不参与扫描
        const d = w.document;
        if (d && !seen.has(d)) { seen.add(d); docs.push(d); }
        for (let i = 0; i < w.frames.length; i++) walk(w.frames[i]);
      } catch (e) { /* 跨域忽略 */ }
    })(rootWindow());
    return docs;
  }

  function firstVisible(doc, selectors) {
    for (const sel of selectors) {
      let els;
      try { els = doc.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of els) if (vis(el)) return el;
    }
    return null;
  }

  // 找文字完全匹配 re 的可点击元素，返回最深的那个(不套娃)
  function clickable(scope, re, tagFilter) {
    const cands = scope.querySelectorAll(tagFilter || 'button, a, div, span, li, p, input');
    const hits = [];
    for (const el of cands) {
      if (!vis(el)) continue;
      const t = el.tagName === 'INPUT' ? (el.value || '') : textOf(el);
      if (t && re.test(t.trim())) hits.push(el);
    }
    if (!hits.length) return null;
    for (const el of hits) if (!hits.some(o => o !== el && el.contains(o))) return el;
    return hits[0];
  }

  // ================= 动作派发（不留调用栈痕迹 + 完整人类鼠标序列） =================
  // 页面侧检测会看事件触发时的调用栈，所以派发一律走"原生方法绑定 + 定时器"。
  // 更要紧的是：el.click() 只发一个 click 事件，没有 mousedown/mouseup——
  // 若站点用真实输入事件追踪"用户活动"，纯 click 等于零输入，作答/切课会被判成无人操作。
  // 所以这里补齐 mouseover→mousemove→mousedown→mouseup→click（含 pointer 事件与元素中心坐标）。
  function mouseSeq(el, delay) {
    const d = (delay || 0) + rand();
    let r = { left: 0, top: 0, width: 0, height: 0 };
    try { if (el.getBoundingClientRect) r = el.getBoundingClientRect(); } catch (e) { /* 忽略 */ }
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    // 真实鼠标命中的是坐标处"最内层"节点，再向上冒泡；只往祖先派发会漏掉挂在深层子节点上的处理函数
    let target = el;
    try {
      const doc = el.ownerDocument || document;
      const hit = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
      if (hit && (hit === el || el.contains(hit))) target = hit;
    } catch (e) { /* 忽略 */ }
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
    const mk = (type, buttons) => {
      try { return new MouseEvent(type, Object.assign({}, base, { buttons: buttons })); } catch (e) { return null; }
    };
    const mkP = (type, buttons) => {
      try { return typeof PointerEvent === 'function' ? new PointerEvent(type, Object.assign({}, base, { buttons: buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true })) : null; } catch (e) { return null; }
    };
    const send = (evt, at) => { if (evt) setTimeout(target.dispatchEvent.bind(target), at, evt); };
    send(mkP('pointerover', 0), d);
    send(mk('mouseover', 0), d + 20);
    send(mkP('pointermove', 0), d + 70);
    send(mk('mousemove', 0), d + 90);
    send(mkP('pointerdown', 1), d + 150);
    send(mk('mousedown', 1), d + 160);
    send(mkP('pointerup', 0), d + 230);
    send(mk('mouseup', 0), d + 240);
    const clickEvt = mk('click', 0);
    if (clickEvt) { try { Object.defineProperty(clickEvt, 'detail', { value: 1 }); } catch (e) { /* 忽略 */ } }
    send(clickEvt, d + 270);
  }

  function fireClick(el, delay) {
    if (!el) return;
    try {
      if (el.dispatchEvent) { mouseSeq(el, delay); return; }
      if (typeof el.click === 'function') setTimeout(el.click.bind(el), (delay || 0) + rand());
    } catch (e) { log('派发失败'); }
  }

  // 关提示/关弹窗专用：这类按钮常是 <a href> 外链（知到的公告会链回主站），
  // 一点就把课程页带走。点之前先把 href 摘掉（站点自己的 click 监听照旧触发），1.5s 后还回去。
  const SAFE_HREF = /^(#|javascript:|$)/i;
  function clickNoNav(el) {
    if (!el) return;
    try {
      const a = el.closest ? el.closest('a[href]') : null;
      if (a && !SAFE_HREF.test(a.getAttribute('href') || '')) {
        const href = a.getAttribute('href');
        a.setAttribute('data-zhs-href', href);
        a.removeAttribute('href');
        setTimeout(() => { try { if (!a.getAttribute('href')) a.setAttribute('href', href); } catch (e) { /* 忽略 */ } }, 1500);
      }
    } catch (e) { /* 忽略 */ }
    fireClick(el);
  }

  function fireKey(el, key, code) {
    try {
      const evt = new KeyboardEvent('keydown', { key: key, keyCode: code, bubbles: true, cancelable: true });
      setTimeout(el.dispatchEvent.bind(el), rand(), evt);
    } catch (e) { /* 忽略 */ }
  }

  // 人味节奏：服务端按时序判"脚本"——太快（2秒答完）和太慢（晾一分钟）都可疑
  const rndIn = (a, b) => a + Math.floor(Math.random() * (b - a));
  function thinkDelay() {
    return CFG.humanize ? rndIn(CFG.thinkMin, CFG.thinkMax) : 0;
  }
  function attemptGap() {
    return CFG.humanize ? rndIn(CFG.gapMin, CFG.gapMax) : CFG.feedbackWait;
  }
  function jumpGap() {
    return CFG.humanize ? rndIn(CFG.jumpMin, CFG.jumpMax) : CFG.jumpDelay;
  }

  // 服务端 422 后客户端只是弹窗：window.zhsMonitor.open('blacklist'|'nostudy', {checkType, checkPlan})
  // 这里始终挂一层：把服务端判定的 checkType/checkPlan 显示到角标（定位哪条规则判的）；
  // CFG.hideWarn=true 时顺便吞掉弹窗——但那只是遮脸，处罚记录照旧由服务端累积。
  function neuterWarn() {
    try {
      if (!CFG.capture422) return;
      const zm = REALM.zhsMonitor;
      if (!zm || typeof zm.open !== 'function' || warnGuarded) return;
      const orig = zm.open;
      const wrapped = function (name, opts) {
        try {
          if (name === 'blacklist' || name === 'nostudy') {
            lastCheck = {
              plan: name === 'nostudy' ? 3 : ((opts && opts.checkPlan) || 1),
              type: name === 'nostudy' ? 'nostudy' : ((opts && opts.checkType) || '?'),
              count: (lastCheck && lastCheck.count ? lastCheck.count : 0) + 1,
            };
            updateBadge();
            log('服务端判定 422:', JSON.stringify(lastCheck));
          }
        } catch (e) { /* 忽略 */ }
        if (CFG.hideWarn && (name === 'blacklist' || name === 'nostudy')) return;
        return orig.apply(this, arguments);
      };
      // 伪装成原函数：名字/长度/toString 全部保持原样，也不挂自定义属性——
      // 万一站点哪天检查"这个函数是不是被换过"，看到的还是原生那个。
      try { Object.defineProperty(wrapped, 'name', { value: orig.name, configurable: true }); } catch (e) { /* 忽略 */ }
      try { Object.defineProperty(wrapped, 'length', { value: orig.length, configurable: true }); } catch (e) { /* 忽略 */ }
      try { Object.defineProperty(wrapped, 'toString', { value: orig.toString.bind(orig), enumerable: false, configurable: true, writable: true }); } catch (e) { /* 忽略 */ }
      warnGuarded = true;      // 标记放在闭包里，不写到函数对象上（属性名本身就是破绽）
      zm.open = wrapped;
    } catch (e) { /* 忽略 */ }
  }

  // ================= 弹题识别 =================
  function isAbsolute(el) {
    try { return getComputedStyle(el).position === 'absolute'; } catch (e) { return false; }
  }
  function getOptions(dialog) {
    // 顺序要紧：行级元素排在前面。studyvideoh5 的坑——`.topic-item` 才是 cursor:pointer 的选项行，
    // `.topic-option-item` 是它里面 position:absolute 的字母装饰元素，点它等于没作答。
    const sels = [
      '.topic-list .topic-item', '.topic-item',
      '.question-detail-item .radio-view li', '.question-detail-item .checkbox-view li',
      '.radio-view li', '.checkbox-view li',
      '.question-item-node .radio-view li', '.question-item-node .checkbox-view li',
      '.ai-class-exercise-dialog .option',
      'span.class-question-select',
      '.topic-list .topic-option-item', '.topic-option-item',
      '[class*="option-item"]', '[class*="answer-item"]',
      'label.el-radio', 'label.el-checkbox',
    ];
    for (const sel of sels) {
      let list = [];
      try { list = Array.from(dialog.querySelectorAll(sel)); } catch (e) { continue; }
      list = list.filter(el => vis(el) && !isAbsolute(el));    // 绝对定位的是装饰元素，不是可点行
      if (list.length >= 2) return list;
    }
    // 兜底：以 A. B. C. D. 开头的条目(取最深，避免父子重复)，同样排除绝对定位
    const hits = [];
    for (const el of dialog.querySelectorAll('li, label, div, span, p')) {
      if (!vis(el) || isAbsolute(el)) continue;
      if (/^[A-Da-d][.、．:：]/.test(textOf(el))) hits.push(el);
    }
    return hits.filter(el => !hits.some(o => o !== el && el.contains(o)));
  }

  // 点击效果探针：点完弹层 DOM 有没有任何变化（class/结构）——用来判定处理函数到底收没收到
  function snap(d) {
    try { return d.innerHTML.length + '|' + (d.className || ''); } catch (e) { return ''; }
  }

  // ================= 第6档：真鼠标（本机 helper） =================
  // 弹题组件对页内合成事件彻底无响应（实测连直接调 Vue 方法都不行），只剩系统级真实点击一条路。
  // 脚本只负责"算坐标 + 校准 + 验证"，helper 只负责"按下/抬起"，判断逻辑一点都不外流。
  const HELP = { ok: null, trusted: null, good: null, lastPing: 0, via: null };
  const helperUrl = (path, q) => 'http://127.0.0.1:' + CFG.helperPort + '/' + path + (q ? '?' + q : '');

  // <img> 信标通道：浏览器用策略拦掉 fetch(本地网络权限/CSP)时，图片请求经常还是通的。
  // 我们反正用 hover + DOM 快照验证结果，不需要读返回——所以"发出去"就够用。
  function beaconSend(path, q) {
    try {
      const im = new Image();
      im.referrerPolicy = 'no-referrer';
      im.src = helperUrl(path, (q ? q + '&' : '') + 'r=' + Date.now());
      return true;
    } catch (e) { return false; }
  }

  // 探测外挂在不在：fetch（能读到 trusted）→ img 信标（被拦时的兜底，异步等 onload/onerror）
  function probeHelper(cb) {
    const eff = (ok, via, info) => { HELP.ok = ok; HELP.via = via; HELP.lastPing = Date.now(); if (info) HELP.trusted = info.trusted !== false; cb && cb(ok, via); };
    if (window.fetch) {
      try {
        window.fetch(helperUrl('ping', 't=' + Date.now()), { cache: 'no-store' })
          .then(r => r.json())
          .then(j => eff(true, 'fetch', j))
          .catch(() => imgProbe(ok => eff(ok, ok ? 'img' : null)));
        return;
      } catch (e) { /* 落到 img 探 */ }
    }
    imgProbe(ok => eff(ok, ok ? 'img' : null));
  }
  function imgProbe(cb) {
    try {
      const im = new Image();
      let done = false;
      const fin = (ok) => { if (!done) { done = true; cb(ok); } };
      im.onload = () => fin(true);
      im.onerror = () => fin(false);
      im.src = helperUrl('ping', 'img=1&r=' + Date.now());
      setTimeout(() => fin(false), 2500);
    } catch (e) { cb(false); }
  }

  function pingHelper() {
    if (!CFG.helper) return;
    if (HELP.ok !== null && Date.now() - HELP.lastPing < 60000) return;   // 一分钟一次足够
    probeHelper((ok, via) => log('helper:', ok ? ('通了(' + via + ')') : '不通'));
  }

  // 注意：到量只停播，不再退外挂。以前“到量就收摊”会把 8971 关掉，
  // 而没有任何东西负责把它拉回来——第二天自动答题、切课、拉回页面全部退化。

  // 鼠标此刻是否真的停在这一行上（系统级点击落点验证：Chrome 的 :hover 只认真实指针位置）
  function pagePoint(el) {
    try {
      const doc = el.ownerDocument || document;
      const win = doc.defaultView || window;
      const r = rectOf(el);
      if (!r || !r.width || !r.height) return null;
      let x = r.left + Math.min(r.width / 2, 60);
      let y = r.top + r.height / 2;
      // 目标在 iframe 里：CDP 按顶层页面坐标派发，得把每层 frameElement 的位置加上去
      let w = win, f = win.frameElement;
      while (f) {
        const fr = f.getBoundingClientRect();
        x += fr.left; y += fr.top;
        w = (f.ownerDocument || document).defaultView || window;
        f = w.frameElement;
      }
      const iw = window.innerWidth || 1e9, ih = window.innerHeight || 1e9;
      if (x < 2 || y < 2 || x > iw - 2 || y > ih - 2) return null;   // 视口外不点（点了也是点空）
      return { x: Math.round(x), y: Math.round(y) };
    } catch (e) { return null; }
  }

  function helperSend(path, q) {
    // 顺位：fetch（能读到返回，含 trusted）→ <img> 信标（被 LNA/CSP 拦时兜底，能发出去就够——结果我们本就用 DOM 验证）
    if (window.fetch) {
      try {
        return window.fetch(helperUrl(path, q), { cache: 'no-store' }).then(r => r.json())
          .catch(() => {
            const ok = beaconSend(path, q);
            if (ok) { HELP.ok = true; HELP.via = 'img'; }
            return { ok: ok, via: 'img' };
          });
      } catch (e) { /* 落到信标 */ }
    }
    const ok = beaconSend(path, q);
    if (ok) { HELP.ok = true; HELP.via = 'img'; }
    return Promise.resolve({ ok: ok, via: 'img' });
  }
  function helperDoClick(p) {
    return helperSend('click', 'x=' + p.x + '&y=' + p.y)
      .then(j => { if (j.ok === false && j.via !== 'img') { HELP.trusted = false; log('helper 拒绝点击:', j.error); } return j; });
  }

  // 目标是否在"滚动容器可视范围"内；不在就先滚到中间，等滚动稳定再点。
  // 必要原因：真鼠标按屏幕坐标点——目标滚出可视区时坐标落在面板外面，会点到别的东西。
  // 取"有实际尺寸"的矩形：传进来的可能是行内文字节点（空矩形），那就向上找有盒子的祖先。
  // 没有这一层，空矩形会算出错误的滚动量/点击坐标（真机上点击就会落空）。
  function rectOf(el) {
    try {
      let e = el, r = e.getBoundingClientRect();
      let n = 0;
      while ((!r || !r.height || !r.width) && e.parentElement && n++ < 8) {
        e = e.parentElement;
        r = e.getBoundingClientRect();
      }
      return r || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    } catch (e) {
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    }
  }
  function scrollBoxOf(el) {
    try {
      let p = el.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        const st = getComputedStyle(p);
        if (/(auto|scroll|overlay)/.test((st.overflowY || '') + ' ' + (st.overflow || ''))) return p;
        p = p.parentElement;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }
  function ensureVisible(el) {
    try {
      const box = scrollBoxOf(el);
      if (!box) return true;
      const r = rectOf(el);
      const br = box.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // 判定标准放在"我们要点的那个中心点"上：中心点在框内就能点中，不必要求整行都在框里
      if (cy >= br.top + 4 && cy <= br.bottom - 4 && cx >= br.left + 4 && cx <= br.right - 4) return true;
      const center = (br.height - r.height) / 2;
      box.scrollTop = Math.max(0, box.scrollTop + (r.top - br.top) - center);
      return false;                 // 刚滚过：调用方等下一轮再点（等滚动稳定）
    } catch (e) { return true; }
  }

  // 通用"真点击某个元素"：算页面坐标 → 交给外挂用 CDP 派发真实鼠标事件。
  // 弹题组件忽略页内合成事件（isTrusted=false），所以选项和"关闭"都得走这条路。
  function realClickElement(el, label, guard, retried) {
    if (!CFG.helper) return false;
    pingHelper();          // 顺手重新探一次（有 60s 节流），外挂刚启动也能补上
    const tag = label || '点击';
    const doc = el.ownerDocument || document;
    if (doc.hasFocus && !doc.hasFocus()) {      // 窗口不在前台时点击会落到别的程序上，一律不动手
      activity = '窗口未聚焦，先不动手';
      updateBadge();
      return false;
    }
    if (!ensureVisible(el)) {                   // 目标不在滚动容器可视区：先滚过去，稳定后自己重试一次
      activity = tag + ':滚动定位';
      updateBadge();
      log('目标不在目录可视区，先滚动定位');
      if (!retried) setTimeout(() => realClickElement(el, label, guard, true), 500);
      return true;                              // 告诉调用方"这一下已经安排了"，别当失败
    }
    const pt = pagePoint(el);
    if (!pt) { activity = tag + ':不在可视区'; updateBadge(); return false; }
    if (guard && guard() === false) return false;   // 点击前复核：目标还在、页面仍聚焦
    activity = tag + ':点击';
    updateBadge();
    helperDoClick(pt);
    return true;
  }

  // 真鼠标点击一条候选选项行
  function optionSelected(el) {
    try {
      if (!el) return false;
      if (/active|isselected|selected|ischecked|checked/i.test((el.className || '').toString())) return true;
      if (el.querySelector('input:checked')) return true;
      const kids = el.querySelectorAll('*');
      for (let i = 0; i < kids.length && i < 40; i++) {
        if (/active|isselected|selected|ischecked|checked/i.test((kids[i].className || '').toString())) return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function findQuestionDialog(doc) {
    // 1) 已知结构（.dialog-test 是智慧树弹题的容器类，studyvideoh5 上它是 .video-study .dialog-test .el-dialog）
    for (const sel of ['.el-dialog__wrapper.dialog-test', '.dialog-test', '.ai-class-exercise-dialog']) {
      const el = firstVisible(doc, [sel]);
      if (el && getOptions(el).length) return el;
    }
    // 2) 题干特征类所在的弹层
    for (const t of doc.querySelectorAll('.topic-title, span.type')) {
      if (!vis(t)) continue;
      const box = t.closest('.el-dialog__wrapper, .el-dialog, [class*="dialog"], [class*="modal"], [class*="pop"], [class*="question"], [class*="topic"]') || t.parentElement;
      if (box && getOptions(box).length) return box;
    }
    // 3) 兜底：可见弹层里同时有题干特征和 >=2 个选项
    for (const box of doc.querySelectorAll('[class*="dialog"], [class*="modal"], [class*="pop"], [class*="exam"], [class*="quiz"], [class*="question"]')) {
      if (!vis(box)) continue;
      if (!/(单选|多选|判断|选择题|填空|问答|题目)/.test(textOf(box))) continue;
      if (getOptions(box).length >= 2) return box;
    }
    return null;
  }

  // ================= 判定结果 =================
  // 题型判断：文字里有多选字样、或选项区出现 checkbox，就是多选题
  function isMultiChoice(dialog) {
    try {
      if (/多选|多项选择题|多选题/.test(textOf(dialog))) return true;
      if (dialog.querySelector('input[type="checkbox"], .checkbox, [class*="checkbox"]')) return true;
      return false;
    } catch (e) { return false; }
  }

  function feedbackOf(dialog, clicked) {
    if (clicked) {
      const c = (clicked.className || '').toString();
      if (/(correct|right|success|is-right|is-correct)/i.test(c)) return 'correct';
      if (/(error|wrong|fail|is-error|is-wrong)/i.test(c)) return 'wrong';
    }
    const txt = textOf(dialog);
    // 先看"错"：答错时往往同时出现"正确答案是X"
    if (/回答错误|答错了|回答有误|很遗憾|答案错误|选择错误/.test(txt)) return 'wrong';
    if (/回答正确|答对了|恭喜.{0,8}答对|答案正确|太棒了/.test(txt)) return 'correct';
    return 'unknown';
  }

  // 旧版播放器把正确答案写在 .answer 里(页面自己暴露的)
  function domAnswer(dialog) {
    const el = dialog.querySelector('.answer');
    const t = ((el && el.textContent) || '').replace(/[^A-Da-d]/g, '').toUpperCase();
    return t.length ? t : null;
  }

  // ================= 弹窗按钮 =================
  function findSubmit(dialog) {
    const b = clickable(dialog, /^(提交|提交答案|提交作答|交卷|提交并继续|确认提交|submits?)(！)?$/i, 'button, a, div, span, li, input');
    if (b) return b;
    // 没有明确提交按钮时：选项已被选中、且弹层里没有"关闭/继续"类按钮，才把"确定"当提交
    const selected = dialog.querySelector('.active, .isSelect, .selected, [class*="checked"], input:checked');
    const closeish = clickable(dialog, /^(关闭|关闭弹窗|继续播放|继续|知道了|下一题|完成)(！)?$/, 'button, a, div, span, li, input');
    if (selected && !closeish) {
      return clickable(dialog, /^(确定|确认|好的|OK)(！)?$/i, 'button, a, div, span, li, input');
    }
    return null;
  }

  const CLOSE_TEXT = /^(关闭|关闭弹窗|继续播放|继续|知道了|下一题|完成|确定|确认|好的|OK)(！)?$/i;
  // 关闭控件候选（按可能性排序）：先文字按钮，再关闭图标，再右上角 X
  function findCloseCandidates(dialog) {
    const out = [];
    const add = (el) => { try { if (el && out.indexOf(el) < 0 && vis(el)) out.push(el); } catch (e) { /* 忽略 */ } };
    add(clickable(dialog, CLOSE_TEXT, 'button, a, div, span, li, input'));
    ['.close-box', '.close-btn', '.dialog-close', '.close'].forEach(sel => {
      const el = dialog.querySelector(sel);
      if (el) add(el);
    });
    add(firstVisible(dialog.ownerDocument, ['.el-dialog__headerbtn', '.el-message-box__headerbtn']));
    return out;
  }

  // ================= 播放控制 =================
  let wasPaused = false;
  let lastPlayClick = 0;
  function resumePlay(doc) {
    if (!CFG.autoResume) return;
    if (doneAll) return;   // 全看完：不重播最后一节
    if (overLimit()) return;      // 今日时长已到：不再自动续播（用户手动点播放不拦）
    if (waitForStart()) return;   // 还没到自动开播时间：页面开着也先不动手
    const v = doc.querySelector('video');
    if (v) {
      if (v.paused && !v.ended) {
        try {
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
          if (!wasPaused) { log('恢复播放'); wasPaused = true; }
        } catch (e) { /* 忽略 */ }
      } else if (!v.paused) {
        wasPaused = false;
      }
      return;
    }
    // 大播放键：点不到就隔 8s 重试，避免等间隔连点
    const big = firstVisible(doc, ['.bigPlayButton.pointer', '.bigPlayButton']);
    if (big && vis(big) && Date.now() - lastPlayClick > 8000) {
      lastPlayClick = Date.now();
      fireClick(big);
    }
  }

  function videoState(doc) {
    const v = doc.querySelector('video');
    if (v && isFinite(v.duration) && v.duration > 0) {
      return { ended: v.ended || v.currentTime >= v.duration - 1 };
    }
    const pass = doc.querySelector('.passTime');   // 旧版进度条
    if (pass && pass.style && pass.style.width) {
      const r = parseInt(pass.style.width, 10) / 100;
      return { ended: !isNaN(r) && r >= CFG.endThreshold };
    }
    return null;
  }

  // ================= 目录 / 下一课 =================
  // 跨章时的三招兜底：站点自带"下一节"按钮 → 展开折叠的下一章 → 往下滚触发懒渲染
  function findNextButton(doc) {
    return firstVisible(doc, ['#nextBtn', '.next-btn', '.nextBtn', '[class*="next-btn"]', '[class*="nextBtn"]',
      '[title="下一节"]', '[title="下一集"]', '[title="下一课"]', '[aria-label="下一节"]']);
  }
  function findExpandableChapter(doc, cat, afterEl) {
    const items = Array.prototype.slice.call(doc.querySelectorAll(cat.item));
    const idx = afterEl ? items.indexOf(afterEl) : -1;
    const untried = (el) => (expandTried.get(el) || 0) < 2;   // 同一行最多试两种点法（箭头 / 整行）
    for (let i = idx + 1; i < items.length; i++) {           // 优先找"第X章"这种明确的章节标题行
      const el = items[i];
      if (/第[一二三四五六七八九十百零〇\d]+章/.test(textOf(el)) && untried(el)) return el;
    }
    for (let i = idx + 1; i < items.length; i++) {           // 兜底：后面第一个"没有时长"的行（多半就是标题）
      const el = items[i];
      if (!cat.requireText || !cat.requireText.test(textOf(el))) { if (untried(el)) return el; }
    }
    return null;
  }
  function nudgeCatalogList(doc, cat) {                      // 懒渲染列表：往下滚一点，让后面的课时渲染出来
    const first = doc.querySelector(cat.item);
    const box = doc.querySelector('.box-right .list') || doc.querySelector('.box-right') || (first && first.parentElement);
    if (!box || !box.scrollHeight) return false;
    if (box.scrollHeight - box.clientHeight - box.scrollTop < 40) return false;   // 已经到底
    if (nudgeCatalogList.n++ > 12) return false;             // 防死循环
    box.scrollTop = Math.min(box.scrollTop + Math.max(200, (box.clientHeight || 400) * 0.8), box.scrollHeight - box.clientHeight);
    return true;
  }
  nudgeCatalogList.n = 0;

  // ================= wisdom-mooc 课程场景（2026-10 每日课程）=================
  // 实测结构：章节折叠面板(el-collapse) + .chapter-item 课时行；看完的条目带 img.finish-icon；
  // 当前课 = .chapter-item.current；进度条节点 #current-node-box .title 显示"知识点：xxx"；
  // 弹题是 AI随堂练习弹窗(.ai-class-exercise-dialog)，一次可能挂多个小题(.ques-list .item)，共用一个"提交作答"。
  // 52 个课时条目全在 DOM 里（折叠章节只是不可见），所以定位/切课看全量条目、要跨章就先展开。
  const MOOC = /^wisdom-mooc\./.test(location.hostname);
  // 免考知识点（掌握度页实测 16 个；页面明示"该知识点为免考知识点，不计入掌握度"→ 不进成绩）。
  // 换课时照掌握度页的蓝色格子更新这两个清单；拿不准的场景一律默认不自动答。
  const MOOC_EXEMPT_POINTS = ['映射', '有界集', '确界原理', '数列极限的精确定义', '斐波那契数列', '归结原则',
    '连续函数的局部性质', '反函数的导数', '微分的运算法则', '高阶微分',
    '不定积分的概念', '降幂法', '升幂法', '循环法', '递推法', '可积条件'];
  // 整节课的知识点全是免考的课时：这些课时上的弹题随便答都不影响成绩
  const MOOC_EXEMPT_LESSONS = [/有界集\s*确界原理/, /斐波那契数列/, /归结原则/, /定积分的概念/];
  const moocExpandTried = new Set();

  function moocAllItems(doc) {
    return Array.prototype.slice.call(doc.querySelectorAll('.chapter-item'));
  }
  function moocFirstUnfinished(doc) {
    for (const el of moocAllItems(doc)) {
      if (el.querySelector('.finish-icon')) continue;   // 看完的跳过
      return el;
    }
    return null;
  }
  function moocLessonDone(doc) {
    const cur = doc.querySelector('.chapter-item.current');
    if (!cur) return null;
    return !!cur.querySelector('.finish-icon');
  }
  // 免考判定：先看当前知识点节点（"知识点：xxx"），再看整节全免考的课时白名单；都不中 = 算成绩/判不准，不碰
  function moocQuizAllowed(doc) {
    try {
      const t = ((doc.querySelector('#current-node-box .title') || {}).textContent || '').trim();
      const kp = t.replace(/^.*知识点[：:]\s*/, '').trim();
      if (kp && MOOC_EXEMPT_POINTS.indexOf(kp) >= 0) return true;
      const lesson = ((doc.querySelector('.chapter-item.current .item-box-name') || {}).textContent || '');
      for (const re of MOOC_EXEMPT_LESSONS) if (re.test(lesson)) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }
  // 条目在折叠的章节里：先把它的章节头点开（点过还不出来就交给下一轮）
  function moocEnsureVisible(doc, el) {
    if (el.getClientRects && el.getClientRects().length) return true;
    const item = el.closest ? el.closest('.el-collapse-item') : null;
    const hdr = item && item.querySelector('.el-collapse-item__header');
    if (!hdr || moocExpandTried.has(hdr)) return false;
    moocExpandTried.add(hdr);
    log('展开折叠章节:', (hdr.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 16));
    quickJump = true; lastNextAt = 0; endAt = 0; endTarget = 0;
    if (CFG.helper && HELP.ok !== false) { if (!realClickElement(hdr, '展开章节', () => true)) fireClick(hdr); }
    else fireClick(hdr);
    return false;
  }
  // 切课：只挑没看完的（看完的不回头重播），跨章先展开
  function moocNextLesson(doc) {
    const items = moocAllItems(doc);
    if (!items.length) return true;   // 目录还没渲染出来：这轮先不动，也别急着判"全看完"
    let cur = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].classList.contains('current')) { cur = i; break; }
    }
    const start = cur >= 0 ? cur + 1 : 0;
    let target = null;
    for (let i = start; i < items.length; i++) {
      const el = items[i];
      if (el.querySelector('.finish-icon')) continue;
      target = el; break;
    }
    if (!target) { log('mooc: 后面没有没看完的课时'); return false; }
    if (!moocEnsureVisible(doc, target)) return true;
    const titleEl = target.querySelector('.item-box-name') || target;
    log('mooc 切下一课:', (titleEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24));
    jumpTo(doc, target, titleEl, '切课');
    return true;
  }

  // studyvideoh5（用户实际播放页，2026-10 从 stustudy.css 挖出的真实结构）
  //   容器 .box-right .list，条目 li：视频课时 li.video、章节标题 .font_gray_inclined、测验 li.chapter-test
  //   当前播放 .current_play；完成/半完成 .time_icofinish / .time_ico_half；进度 .el-progress__text 或 .progress-num
  // 目录里混着的非视频行：章节/小节标题（如 `第三章 战争史与军事思想`、`3.1 孙子兵法`）、测试任务（如 `平时测试`）。
  // 它们**共同特征是没有时长**——所以主判据是"文本里有没有 00:20:13 这样的时长"，下面的名字词表只是兜底，
  // 且只在"这行也没有任何课时特征"时才生效，免得误杀课名自带这些字的真课时。
  const NON_VIDEO_TEXT = /测验|测试|考试|题目|练习|作业|问卷|讨论|答疑|实验|直播|公告|回放|期中|期末/;
  const VIDEO_CLS = /(^|\s)video(\s|$)/;
  const CATALOGS = [
    { item: '.box-right .list li',  active: '.current_play',         finish: '.time_icofinish', title: '.catalogue_title', activeClass: 'current_play', skip: /font_gray_inclined|chapter-test/, requireText: /\d{1,2}:\d{2}/ },
    { item: '.child-info.hasvideo', active: '.current',              finish: '.child-check',    title: '.child-name',   activeClass: 'current' },
    { item: '.chapter-item',        active: '.chapter-content-second.current', finish: '.finish-icon', title: '.item-name', activeClass: 'current' },
    { item: '.file-item',           active: '.active',               finish: '.icon-finish',    title: 'span[title]',   activeClass: 'active' },
    { item: '.clearfix.video',      active: '.current_play',         finish: '.time_icofinish', title: '#lessonOrder',  activeClass: 'current_play' },
  ];

  // 课时学完没：读目录里当前项的百分比/完成图标（比 video.ended 更贴近站点判据）
  function lessonDone(doc) {
    if (MOOC) return moocLessonDone(doc);
    try {
      const act = doc.querySelector('.box-right .list li.current_play');
      if (!act) return null;
      if (act.querySelector('.time_icofinish')) return true;
      const tnode = act.querySelector('.el-progress__text, .progress-num, .learningPercentage-span');
      const pct = tnode ? parseInt((tnode.textContent || '').replace(/[^\d]/g, ''), 10) : NaN;
      if (!isNaN(pct)) return pct >= 100;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  // 目录里第一个"没看完"的课时。完成标记 = 条目里的 .time_icofinish 图标（页面实测：看完的带它，没看的没有）。
  // 站点每次打开都从第一节开始，顺序切会把已看完的又播一遍——所以进来先靠它定位。
  function firstUnfinished(doc) {
    for (const cat of CATALOGS) {
      let items = [];
      try { items = Array.from(doc.querySelectorAll(cat.item)); } catch (e) { continue; }
      items = items.filter(vis);
      if (!items.length) continue;
      for (const el of items) {
        const cls = (el.className || '').toString();
        if (cat.skip && cat.skip.test(cls)) continue;                     // 章节标题/测验行
        const t = textOf(el);
        if (cat.requireText && !cat.requireText.test(t)) continue;        // 没有时长 → 不是课时
        if (deadItems.indexOf(el) >= 0) continue;                          // 点过切不过去的死条目
        if (cat.finish && el.querySelector(cat.finish)) continue;          // 已看完，跳过
        const titleEl = el.querySelector(cat.title) || el;
        return { el: el, titleEl: titleEl, name: (textOf(titleEl) || t).slice(0, 30) };
      }
    }
    return null;
  }

  // 跳到某个课时：和"切下一课"共用同一套真鼠标点击 + 跳转验证
  function jumpTo(doc, el, titleEl, why) {
    const v = doc.querySelector('video');
    pendingJump = {
      el: el, titleEl: titleEl, at: Date.now(),
      src: v ? (v.currentSrc || v.src || '') : '', ct: v ? (v.currentTime || 0) : 0,
      fellBack: false,
    };
    if (CFG.helper && HELP.ok !== false) realClickElement(titleEl, why, () => pendingJump && pendingJump.el === el);
    else { fireClick(titleEl); pendingJump.fellBack = true; }
  }

  function nextLesson(doc) {
    if (MOOC) return moocNextLesson(doc);
    // 说明：这里不再"看到下一课按钮就点"——那是旧逻辑，而播放器按钮和目录是同一套远程插件渲染的，
    // 合成点击会被忽略，结果是永远卡在当前课时、也不去看目录。现在顺序是：先扫目录（能看见课时就最可靠），
    // 目录里真没有可点的下一课时时，才在下面用【真鼠标】去点"下一节"按钮 / 展开下一章 / 滚动加载。

    // 1) 目录里当前课时的下一项
    for (const cat of CATALOGS) {
      let items;
      try { items = Array.from(doc.querySelectorAll(cat.item)); } catch (e) { continue; }
      items = items.filter(vis);
      if (!items.length) continue;

      let cur = -1;
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const isActive = (cat.active && el.matches(cat.active)) ||
          (cat.active && el.querySelector(cat.active)) ||
          (cat.activeClass && (el.className || '').toString().split(/\s+/).includes(cat.activeClass));
        if (isActive) { cur = i; break; }
      }

      const start = cur >= 0 ? cur + 1 : 0;
      // 候选收集：软排序（带时长的课时行优先，大纲/标题行排后面）+ 硬验证（点完切不过去就拉黑）
      const cands = [];
      for (let i = start; i < items.length; i++) {
        const el = items[i];
        const t = textOf(el);
        if (cat.skip && cat.skip.test((el.className || '').toString())) continue;   // 章节标题/测验行跳过
        if (deadItems.indexOf(el) >= 0) continue;             // 点过但没切过去的死条目（大纲行等）
        const finished = !!(cat.finish && el.querySelector(cat.finish));
        // 判定"这行是不是视频课时"，用截图证实过的两个特征（不靠行名里的字）：
        //   ① 文本带时长(00:20:13) —— 课时行必有，章节/小节标题、测试任务都没有
        //   ② class 里有 video —— 顺序里做加权，不作为唯一依据
        const cls = (el.className || '').toString();
        const hasVideoCls = VIDEO_CLS.test(cls);
        const hasDur = !cat.requireText || cat.requireText.test(t);
        if (NON_VIDEO_TEXT.test(t) && !hasVideoCls && !hasDur) continue;   // 兜底：明显是测试/任务名且没有任何课时特征
        // 没看完的加权：候选里有没看完的就不选已看完的（否则重进页面会把看完的又播一遍）
        if (cur >= 0 || !finished) cands.push({ el: el, hasDur: hasDur, score: (hasDur ? 4 : 0) + (hasVideoCls ? 2 : 0) + (finished ? 0 : 8) });
      }
      // 带时长的优先（截图证实：课时一定有时长）；一条带时长的都没有时才退回全体，避免别的课程形态被筛空
      const withDur = cands.filter(c => c.hasDur);
      const ordered = (withDur.length ? withDur : cands).sort((a, b) => b.score - a.score);   // 稳定排序：同分保持目录顺序
      if (ordered.length) {
        const el = ordered[0].el;
        const name = textOf(el.querySelector(cat.title)) || textOf(el).slice(0, 30);
        log('切下一课:', name, ordered[0].hasDur ? '' : '(无时长，可能是标题/测试行)');
        const v = doc.querySelector('video');
        const titleEl = el.querySelector(cat.title) || el;
        pendingJump = {
          el: el, titleEl: titleEl, at: Date.now(),
          src: v ? (v.currentSrc || v.src || '') : '', ct: v ? (v.currentTime || 0) : 0,
          fellBack: false,
        };
        // 目录和弹题是同一套远程插件渲染的 → 合成点击可能同样被忽略，所以先用真鼠标
        if (CFG.helper && HELP.ok !== false) realClickElement(titleEl, '切课', () => pendingJump && pendingJump.el === el);
        else { fireClick(titleEl); pendingJump.fellBack = true; }
        return true;
      }
      if (cur >= 0) {                                   // 当前之后没有可点的课时了：先试不离开页面的两招
        const hdr = findExpandableChapter(doc, cat, items[cur]);   // ① 展开折叠的下一章，让它的课时渲染出来
        if (hdr) {
          const triedN = expandTried.get(hdr) || 0;
          expandTried.set(hdr, triedN + 1);
          quickJump = true; lastNextAt = 0; endAt = 0; endTarget = 0;
          // 第一次点箭头图标，第二次改点整行（有的版本箭头只是装饰，真正的开关在整行上）
          const arrow = hdr.querySelector('[class*="arrow"], [class*="el-icon-arrow"], [class*="icon"]');
          const target = (triedN === 0 && arrow) ? arrow : hdr;
          log('目录里没有下一课时，展开后面的章节:', textOf(hdr).slice(0, 20));
          if (CFG.helper && HELP.ok !== false) { if (!realClickElement(target, '展开章节', () => true)) fireClick(target); }
          else fireClick(target);
          return true;
        }
        if (nudgeCatalogList(doc, cat)) {                // ② 懒渲染列表：往下滚一点再扫
          quickJump = true; lastNextAt = 0; endAt = 0; endTarget = 0;
          log('目录里没有下一课时，往下滚动加载');
          return true;
        }
        // ③ 站点自带的"下一节"按钮：只有发现过"后面还有章节"却打不开时才借它跨过去。
        //    全看完时它会把人带去"平时测试"（考试系统、另一套登录），实测踩过这个坑：
        //    点进测试后被要求重新登录。所以后面只剩测试/标题行时，宁可停在这里。
        const nb = findNextButton(doc);
        if (nb && expandTried.size > 0 && Date.now() - lastNextBtnTryAt > NEXT_BTN_COOLDOWN) {   // 按时间冷却：按钮元素一直是同一个，不能用"试过一次"来记
          lastNextBtnTryAt = Date.now();
          log('目录里没有下一课时，试站点的"下一节"按钮');
          const v = doc.querySelector('video');
          pendingJump = { el: nb, titleEl: nb, at: Date.now(), src: v ? (v.currentSrc || v.src || '') : '', ct: v ? (v.currentTime || 0) : 0, fellBack: false };
          if (CFG.helper && HELP.ok !== false) { if (!realClickElement(nb, '下一节', () => true)) { fireClick(nb); pendingJump.fellBack = true; } }
          else { fireClick(nb); pendingJump.fellBack = true; }
          return true;
        }
        log('当前已是最后一课时'); return false;
      }
    }
    log('未找到可切换的下一课(目录未识别)');
    return false;
  }

  // ================= 提示弹窗(只点"看完/知道了"类) =================
  // 含"检测/异常/插件/登录/验证"等字样的弹窗一律不碰——尤其不能替它点确认，
  // 否则"检测到异常脚本"的确认键被点掉，页面立即弹回主页。
  const DANGER = /检测|异常|插件|脚本|安全|验证|登录|账号|设备|风控|作弊|违规/;
  const NOTICE_OK = /^(确定|知道了|继续观看|继续播放|关闭|好的|OK|开始观看|进入学习)(！)?$/i;
  let lastNoticeClick = 0;
  let warnGuarded = false;   // zhsMonitor.open 是否已被本脚本包过（标记放闭包，不挂到函数对象上）

  function handleNotice(doc) {
    if (Date.now() - lastNoticeClick < 12000) return;   // 重试冷却，防等间隔连点
    for (const sel of ['.el-message-box__wrapper', '.el-message-box', '[class*="notice"]', '[class*="tip-pop"]']) {
      const box = firstVisible(doc, [sel]);
      if (!box) continue;
      const txt = textOf(box);
      if (!txt || DANGER.test(txt)) continue;
      if (!/看完|完成|继续|知道|观看|下一/.test(txt)) continue;
      const ok = clickable(box, NOTICE_OK, 'button, a, div, span, li');
      if (ok) { lastNoticeClick = Date.now(); clickNoNav(ok); }
    }
  }

  // ================= 主循环 =================
  let q = null;
  let closed = { el: null, at: 0 };
  let lastNextAt = 0;
  let endAt = 0;
  let endTarget = 0;
  let doneNotified = false;

  function closeQuestion(dialog, doc) {
    if (!CFG.autoClose) {
      // 只作答、不代关：关闭弹窗这个动作完全不经过脚本（自动关闭那条路的风险就此归零）
      activity = '已作答，请你手动关闭';
      updateBadge();
      deferredEl = dialog;
      deferredAt = Date.now();
      q = null;
      log('autoClose=false：作答后不代关，交给人工');
      return;
    }
    const cands = findCloseCandidates(dialog);
    const btn = cands[0] || null;
    activity = '关闭弹窗';
    updateBadge();
    // 弹题组件忽略页内合成事件（选项如此，"关闭"按钮同样如此）→ 优先用真鼠标关
    if (btn && CFG.helper && HELP.ok !== false) {
      log('用真鼠标关闭弹窗');
      realClickElement(btn, '关弹窗', () => {
        if (!dialog.isConnected || !dialog.getClientRects().length) return false;
        return true;
      });
      // 兜底：有些关闭按钮是真 DOM 按钮，合成点击本来就有效——1.2s 后还在就补一发
      setTimeout(() => { if (dialog.isConnected && dialog.getClientRects().length) clickNoNav(btn); }, 1200);
    } else if (btn) { clickNoNav(btn); log('关闭弹题弹窗'); }
    else { fireKey(dialog, 'Escape', 27); log('用 Esc 关闭弹题弹窗'); }
    q = null;
    closed = { el: dialog, at: Date.now() };
    setTimeout(() => collectDocs().forEach(resumePlay), 800);
    if (btn) verifyClose(dialog, cands, 0);
  }

  // 关掉验证：关不掉就换下一个候选控件再试；都不行就放着不动（绝不重新作答、不反复对着坐标点）
  function verifyClose(dialog, cands, round) {
    setTimeout(() => {
      if (!dialog.isConnected || !dialog.getClientRects().length) { log('弹窗已关闭'); return; }
      closed = { el: dialog, at: Date.now() };      // 验证期间继续压住，别让状态机重新开始作答
      const next = cands[round + 1];
      if (next && round < 2) {
        activity = '换个关闭控件再试';
        updateBadge();
        log('弹窗还在，换关闭控件重试');
        if (CFG.helper && HELP.ok !== false) realClickElement(next, '关弹窗');
        else clickNoNav(next);
        verifyClose(dialog, cands, round + 1);
        return;
      }
      deferredEl = dialog;
      deferredAt = Date.now();
      activity = '弹窗没关掉，视频在播';
      updateBadge();
      log('关不掉弹窗，放着不再动');
    }, round === 0 ? 3000 : 2500);
  }

  // 点不中/无法自动作答 → 交给人工：不代关、不重复点，角标说清原因
  function deferQuestion(dialog, why) {
    const tag = why === '外挂不可用'
      ? (HELP.ok === false ? '外挂不通' : HELP.trusted === false ? '外挂未授权' : '外挂不可用')
      : why;
    activity = tag + '，请你手动作答';
    updateBadge();
    deferredEl = dialog;
    deferredAt = Date.now();
    q = null;
    log('交给人工:', tag);
  }

  function handleQuestion(dialog, doc) {
    // 刚关掉的弹层还在做关闭动画，别理它
    if (dialog === closed.el && Date.now() - closed.at < CFG.closeCooldown) return;
    // 之前处理不了、已交给人工的弹层：10 分钟内不再碰（免得反复点、反复失败）
    if (dialog === deferredEl && Date.now() - deferredAt < 600000) return;

    const now = Date.now();
    if (!q || q.el !== dialog) {
      // wisdom-mooc 的 AI随堂练习：只在免考知识点上自动答（不进成绩）；其余/判不准一律留人工
      const moocQuiz = MOOC && dialog.classList.contains('ai-class-exercise-dialog');
      if (moocQuiz && !moocQuizAllowed(doc)) {
        deferQuestion(dialog, '非免考或判不准');
        nag('弹题在计成绩的知识点上，留你手动答', false, 'quiz-manual');
        return;
      }
      const opts = getOptions(dialog);
      let queue = [];
      if (moocQuiz) {
        // 一次可能挂多个小题：按小题分组作答（单选随机一个、多选全点），再统一"提交作答"
        const groups = Array.from(dialog.querySelectorAll('.ques-list .item')).filter(vis);
        for (const gEl of (groups.length ? groups : [dialog])) {
          const gOpts = getOptions(gEl);
          if (!gOpts.length) continue;
          const multi = /多选/.test(textOf(gEl));
          const picks = multi ? gOpts.map((_, i) => i) : [Math.floor(Math.random() * gOpts.length)];
          for (const p of picks) {
            const idx = opts.indexOf(gOpts[p]);
            if (idx >= 0 && queue.indexOf(idx) < 0) queue.push(idx);
          }
        }
        log('mooc AI随堂练习(免考自动答): 计划点', queue.length, '个选项');
      }
      if (CFG.useDomAnswer && !moocQuiz) {
        const ans = domAnswer(dialog);          // 旧版播放器把答案写在页面里，能读就直接点那一个
        if (ans) {
          queue = String(ans).toUpperCase().split('').map(ch => ch.charCodeAt(0) - 65).filter(i => i >= 0 && i < opts.length);
          if (queue.length) log('页面内置答案:', ans);
        }
      }
      if (!queue.length) {
        // 站点不会给"做对了"的反馈（弹题也不计入成绩），所以没必要一路点到底：
        //   多选题 → 每个选项各点一次；单选/判断题 → 随机挑一个点一次
        const multi = isMultiChoice(dialog) || (opts.length > 1 && dialog.querySelectorAll('input[type="checkbox"]').length > 0);
        if (multi) queue = opts.map((_, i) => i);
        else if (CFG.randomPick) queue = [Math.floor(Math.random() * opts.length)];
        else queue = [0];
        log('题型:', multi ? '多选(全点)' : '单选/判断(随机一个)', '| 选项数', opts.length);
      }
      q = { el: dialog, queue: queue, idx: 0, lastClick: 0, submitted: false, t0: now, clicked: [], thinkUntil: now + thinkDelay() };
      log('发现弹题:', textOf(dialog).slice(0, 40), '| 计划点', queue.length, '个选项');
    }

    if (now - q.t0 > CFG.questionTimeout) {
      log('弹题处理超时，强制关闭');
      closeQuestion(dialog, doc);
      return;
    }
    if (q.thinkUntil && now < q.thinkUntil) {            // 人看题要时间
      activity = '看题 ' + Math.ceil((q.thinkUntil - now) / 1000) + 's';
      updateBadge();
      return;
    }
    if (now - q.lastClick < attemptGap()) {               // 等判定结果 + 人味间隔
      activity = '等判定';
      updateBadge();
      return;
    }

    const clickedEl = q.clicked[q.clicked.length - 1] || null;
    const fb = feedbackOf(dialog, clickedEl);
    const domChanged = typeof q.snap === 'string' ? snap(dialog) !== q.snap : true;   // 上次点击有没有引起变化
    if (fb === 'correct') { activity = '答对了'; log('答对了'); closeQuestion(dialog, doc); return; }

    const opts = getOptions(dialog);
    const submit = findSubmit(dialog);

    // 需要"提交"的题型：选完一个就提交（同样走真鼠标）
    if (submit && q.lastClick > 0 && !q.submitted) {
      q.submitted = true;
      q.lastClick = now;
      log('提交当前选项');
      realClickElement(submit, '点提交', () => dialog.isConnected && dialog.getClientRects().length > 0);
      return;
    }

    // 作答题：只用真鼠标。页内合成事件这个组件一律忽略（实测五种打法全无效，相关代码已删除）
    if (q.idx < q.queue.length) {
      if (!CFG.helper || HELP.ok === false) { deferQuestion(dialog, '外挂不可用'); return; }
      const el = opts[q.queue[q.idx]];
      if (!el) { deferQuestion(dialog, '找不到选项行'); return; }
      const letter = String.fromCharCode(65 + q.queue[q.idx]);
      q.snap = snap(dialog);
      q.idx++; q.lastClick = now;
      q.clicked.push(el);
      activity = '真鼠标点选项 ' + letter;
      updateBadge();
      log('真鼠标点选项', letter, textOf(el).slice(0, 16));
      // 返回 false = 这一下没发出去（窗口没聚焦/算不出坐标）→ 交给人工，不重复尝试
      if (!realClickElement(el, '选项' + letter, () => dialog.isConnected && dialog.getClientRects().length > 0)) {
        deferQuestion(dialog, doc.hasFocus && !doc.hasFocus() ? '窗口未聚焦' : '点击没发出');
      }
      return;
    }

    // 选项按计划点完了：答对的分支在上面已返回，这里只剩"都不对/没反馈"
    const answered = fb === 'wrong' || optionSelected(clickedEl) || domChanged;
    if (CFG.safeClose && !answered) { deferQuestion(dialog, '点不中'); return; }
    log(fb === 'wrong' ? '所有选项都不对，按关闭处理' : '选项已点完，关闭弹窗');
    closeQuestion(dialog, doc);
  }

  // 切课验证：点完要确认真的切过去了；没切成 → 补一发合成点击、再不行才拉黑换下一条，绝不干等
  function verifyJump(docs) {
    const el = pendingJump.el;
    const act = docs.map(d => d.querySelector('.box-right .list li.current_play') || d.querySelector('.chapter-item.current') || d.querySelector('.current_play')).find(Boolean) || null;
    const same = !!(act && (act === el || act.contains(el) || el.contains(act)));
    const v = docs.map(d => d.querySelector('video')).find(Boolean) || null;
    const srcChanged = !!(v && pendingJump.src && (v.currentSrc || v.src) !== pendingJump.src);
    const restarted = !!(v && pendingJump.ct > 20 && v.currentTime < pendingJump.ct - 10);
    if (same || srcChanged || restarted) {
      pendingJump = null;
      deadItems.length = 0;          // 成功换课：死条目清单、章节展开记录、滚动预算、按钮冷却全部重置
      expandTried.clear();           //   —— 否则第五章第六章会继承"已经试过"的旧账，重演跳不过去
      nudgeCatalogList.n = 0;
      doneAll = false; doneNotified = false;   // 新的一课（或新的一科）：清掉"全看完"状态
      lastNextBtnTryAt = 0;
      log('切课成功');
      return;
    }
    const waited = Date.now() - pendingJump.at;
    // 先补一发合成点击（有的目录项本来就是普通 DOM 按钮，合成点击有效）
    if (!pendingJump.fellBack && waited > 2000) {
      pendingJump.fellBack = true;
      log('切课没动静，补一发合成点击');
      if (pendingJump.titleEl) fireClick(pendingJump.titleEl);
      return;
    }
    if (waited > CFG.jumpVerifyWait) {
      if (deadItems.indexOf(el) < 0) { deadItems.push(el); log('该条目点不动（大纲行？），拉黑换下一条'); }
      deadItemsAt = Date.now();
      pendingJump = null;
      lastNextAt = 0;                // 立刻允许再切，别干等冷却
      endAt = 0; endTarget = 0;
      activity = '跳过点不动的条目';
      updateBadge();
    }
  }

  function tick() {
    try {
      ensureEnv();
      neuterWarn();
      const docs = collectDocs();

      // 0a) 只在有视频的页面活动（播放页才做事，学堂/主页一律不动）
      if (!docs.some(d => d.querySelector('video'))) return;

      // 0b) 站点的"异常脚本"提示：全体停手，绝不代点确认
      for (const doc of docs) {
        const txt = textOf(doc.body);
        if (/检测到异常脚本|关闭插件后/.test(txt)) {
          if (!tick.halted) { tick.halted = true; log('页面提示异常，停止一切动作'); }
          return;
        }
      }

      // 0c) 登录过期：停手叫人（否则会像今天这样空转两小时）
      const loginMsg = detectLoginWall(docs);
      if (loginMsg) {
        loginWallSeen = true;
        activity = '需登录';
        updateBadge();
        nag(loginMsg);
        return;
      }
      if (loginWallSeen) { loginWallSeen = false; log('登录已恢复，继续'); }

      // 0d) 空闲（没在播：等 08:00 / 已到量 / 播完了在等切课）时给会话续命
      keepWarm(!docs.some((d) => { const v = d.querySelector('video'); return v && !v.paused; }));

      // 0e) 进页面先定位到第一个没看完的课时（当前这节已经看完时才跳）
      if (!seekDone && !overLimit() && !waitForStart() && !docs.some((d) => findQuestionDialog(d))) {
        const doc = (MOOC ? docs.find((d) => d.querySelector('.chapter-item')) : docs.find((d) => d.querySelector('.box-right .list'))) || null;
        if (doc) {
          seekDone = true;
          const act = MOOC ? doc.querySelector('.chapter-item.current') : doc.querySelector('.box-right .list .current_play');
          const actDone = MOOC
            ? !!(act && act.querySelector('.finish-icon'))
            : !!(act && act.querySelector('.time_icofinish'));
          const target = MOOC ? moocFirstUnfinished(doc) : firstUnfinished(doc);
          if (target && (!act || actDone)) {
            if (MOOC) {
              if (!moocEnsureVisible(doc, target)) { seekDone = false; activity = '展开章节'; updateBadge(); return; }
              const titleEl = target.querySelector('.item-box-name') || target;
              log('定位到第一个没看完的课时:', (titleEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24));
              activity = '定位未看完课时';
              updateBadge();
              jumpTo(doc, target, titleEl, '定位');
              return;
            }
            log('定位到第一个没看完的课时:', target.name);
            activity = '定位未看完课时';
            updateBadge();
            jumpTo(doc, target.el, target.titleEl, '定位');
            return;
          }
          // 当前这节已看完、又没有没看完的课时：如果后面只剩测试/标题行，就是这一科全看完了
          // —— 停在这里（不重播、也不去点目录末尾的"平时测试"，那是考试系统、另一套登录）。
          // 后面若还有章节行（折叠着没渲染课时），交给切课逻辑去展开，不在这里下结论。
          if (!target && MOOC && moocAllItems(doc).length) {
            doneAll = true; doneNotified = true;
            log('进页面定位：没有没看完的课时，这一科的视频都看完了');
            nag('这一科的视频都看完了', true, 'all-done');
            activity = '全部看完了'; updateBadge();
            return;
          }
          if (!target && act && actDone) {
            const rows = Array.prototype.slice.call(doc.querySelectorAll('.box-right .list li'));
            const actIdx = rows.indexOf(act);
            const moreAhead = rows.slice(actIdx + 1).some((el) => {
              const t = textOf(el);
              return /font_gray/.test((el.className || '').toString()) || /\d{1,2}:\d{2}/.test(t) || VIDEO_CLS.test((el.className || '').toString());
            });
            if (!moreAhead) {
              doneAll = true; doneNotified = true;
              log('进页面定位：没有没看完的课时，这一科的视频都看完了');
              nag('这一科的视频都看完了', true, 'all-done');
              activity = '全部看完了'; updateBadge();
              return;
            }
          }
        }
      }

      // 1) 弹题优先
      if (CFG.autoAnswer) {
        for (const doc of docs) {
          const dialog = findQuestionDialog(doc);
          if (dialog) { handleQuestion(dialog, doc); return; }
        }
        q = null;
        deferredEl = null;   // 弹题已消失（作答或被关掉），解除"交给人工"的标记
      }

      // 2) 看完提示类弹窗
      for (const doc of docs) handleNotice(doc);

      // 2b) 上一次切课到底切过去了没有？没切成就把那条拉黑，下一轮换下一条
      if (deadItemsAt && Date.now() - deadItemsAt > 180000) { deadItems.length = 0; deadItemsAt = 0; }   // 黑名单 3 分钟作废，避免偶发失败被永久跳过
      if (pendingJump) verifyJump(docs);

      // 2c) 观看计时：只累加真在播的进度增量（答题、切课、缓冲的时间天然不算）
      trackWatch(docs);
      if (WDAY.watched > lastWatchedSeen + 0.5) { lastWatchedSeen = WDAY.watched; lastProgressAt = Date.now(); }

      // 2c2) 进度长时间不动（弹窗挡住/断网/播放器卡死）→ 提醒一次，不空等
      //      但"到量已停 / 没到开播时间"本来就该停在原地——把时钟拨到当下，别把休班算成卡死
      if (overLimit() || waitForStart()) lastProgressAt = Date.now();
      if (CFG.stallMin > 0 && !overLimit() && !waitForStart() && !q && Date.now() - lastProgressAt > CFG.stallMin * 60000) {
        nag('视频 ' + Math.max(1, Math.round((Date.now() - lastProgressAt) / 60000)) + ' 分钟没动，可能掉线或被弹窗挡住了', false, 'stall');
      }

      // 3) 恢复播放 + 播完切下一课（播完先等一会儿，避开"学习上报"时刻）
      if (!q) activity = overLimit() ? '今日已看满 ' + fmtHM(WDAY.watched) : '看视频';
      for (const doc of docs) {
        if (enforceLimit(doc)) continue;   // 今日时长已到：停住视频，不续播也不切课
        resumePlay(doc);
        if (!CFG.autoNext) continue;
        const st = videoState(doc);
        let done = !!(st && st.ended);
        if (!done) {
          // video.ended 抓不到时，用目录里当前课时的完成/百分比判定；但必须在视频停下时才信，
          // 否则重看已完成的课时会被立刻跳走
          const v = doc.querySelector('video');
          const stopped = !v || v.paused || v.ended;
          if (stopped && lessonDone(doc) === true) done = true;
        }
        if (done) {
          if (!endAt) {
            endAt = Date.now();
            if (quickJump) { endTarget = endAt + 1200; quickJump = false; log('展开/滚动后快速重扫'); }
            else endTarget = endAt + jumpGap() + rand();
            log('本节视频已播放完毕，等待后切换');
          }
          const left = Math.ceil((endTarget - Date.now()) / 1000);
          activity = left > 0 ? ('等切课 ' + left + 's') : '切下一课';
          updateBadge();
          if (Date.now() >= endTarget && Date.now() - lastNextAt > CFG.nextCooldown && !pendingJump && !doneAll) {   // 上一次切课还在验证中就不重来（否则会把验证计时重置、永远判不出死条目）
            lastNextAt = Date.now();
            endAt = 0;
            endTarget = 0;
            const moved = nextLesson(doc);
            if (!moved && !doneNotified) {
              doneNotified = true; doneAll = true;
              log('没有更多课时了：这一科的视频都看完了');
              nag('这一科的视频都看完了', true, 'all-done');
              activity = '全部看完了'; updateBadge();
            }
            setTimeout(() => collectDocs().forEach(resumePlay), 2500);
            return;
          }
        } else if (st) {
          endAt = 0;
          endTarget = 0;
        }
      }
      if (doneAll) activity = '全部看完了';
      updateBadge();
    } catch (e) {
      // 出错也要看得见：写进角标，绝不静默失败
      activity = '出错 ' + String((e && e.message) || e).slice(0, 24);
      try { updateBadge(); } catch (e2) { /* 忽略 */ }
      if (CFG.debug) console.log('[zhs] loop error:', e && e.message);
    }
  }

  if (window !== rootWindow()) return;   // 同源多 frame 时只让最顶层实例干活

  // wisdom-mooc 课程页（每日课程）已接入：走下面同一套主流程 —— 目录/切课用 mooc* 函数，
  // 弹题只在免考知识点上自动答（免考 = 掌握度页标注"不计入掌握度"、不进成绩的 16 个知识点）。

  // 被弹到登录中心 = 登录过期了：只提醒、不装作在干活（这里没有视频，tick 也不会跑）
  if (/^(login|passport)\./.test(location.hostname)) {
    log('在登录页：提醒重新登录');
    try { pingHelper(); } catch (e) { /* 忽略 */ }
    nag('登录过期，需要重新登录', true);
    setInterval(() => nag('登录过期，需要重新登录'), 60000);   // nag 自己有 10 分钟去重
    return;
  }

  log('ready');
  loadDay();                             // 观看计时：读今天的进度和上限（跨天自动清零）
  pingHelper();                          // 顺手探一下真鼠标外挂在不在，角标会显示状态
  if (CFG.cookieGuard) guardCookies();
  ensureEnv();
  neuterWarn();
  setTimeout(() => setInterval(tick, CFG.tick), CFG.startDelay);
})();
