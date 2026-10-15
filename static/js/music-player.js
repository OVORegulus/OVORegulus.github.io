/*!
 * 背景音乐播放器 —— 侧边栏
 *
 * 行为说明：
 *   1. 进页面时尝试「静音自动播放」。带声音的自动播放会被所有现代浏览器拦截，
 *      静音播放是唯一能被允许的方式。
 *   2. 自动播放成功后，在播放器下方显示提示，访客点一下即可解除静音。
 *   3. 若连静音自动播放都被拦截，则回退为「访客点击播放按钮才开始」。
 *   4. 访客手动暂停后，本次会话不再自动续播（记住选择）。
 */
(function () {
    'use strict';

    var root = document.getElementById('music-player');
    if (!root) return;

    var audio = root.querySelector('audio');
    var titleEl = root.querySelector('.mp-title');
    var artistEl = root.querySelector('.mp-artist');
    var seekEl = root.querySelector('[data-mp="seek"]');
    var seekFill = root.querySelector('.mp-seek-fill');
    var curEl = root.querySelector('.mp-cur');
    var durEl = root.querySelector('.mp-dur');
    var hintEl = root.querySelector('[data-mp="hint"]');
    var muteBtn = root.querySelector('[data-mp="mute"]');
    var toggleBtn = root.querySelector('[data-mp="toggle"]');
    var listBtn = root.querySelector('[data-mp="list"]');
    var listEl = root.querySelector('.mp-list');
    var trackBtns = Array.prototype.slice.call(root.querySelectorAll('[data-mp="track"]'));

    var autoplay = root.dataset.autoplay !== 'false';
    var loopMode = root.dataset.loop || 'all';     // all | one | none
    var current = -1;
    var userPaused = false;                        // 访客主动暂停过
    var unlocked = false;                          // 声音是否已解锁
    var restoring = false;                         // 正在做跨页面恢复（此期间的 pause 不算访客行为）
    var pendingSeek = 0;                           // 跨页面恢复时要跳到的秒数（等元数据就绪再设）
    // 本标签页标识；真实浏览器里各标签页天然独立，测试时可注入以区分实例
    var tabId = (typeof globalThis !== 'undefined' && globalThis.__mpTabId)
        ? globalThis.__mpTabId
        : 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    /* ---------------- 跨页面状态保存 ----------------
       Hugo 是静态站点，点链接就是整页重新加载，<audio> 必然重建，
       所以音乐无法真的「不中断」，只能在这一页离开前把状态写下来、
       在下一页加载后接着播。

       存储位置：
         localStorage  —— 关掉浏览器再回来也能接着听；
                          但超过 STATE_MAX_AGE 的旧状态会被丢弃，
                          免得隔了一天打开博客突然自动放歌。
         sessionStorage —— 音乐播放器解锁状态（只在本标签页会话内有效）
    */
    var STATE_KEY = 'mp-state';
    var UNLOCK_KEY = 'mp-unlocked';
    var STATE_MAX_AGE = 12 * 60 * 60 * 1000;       // 12 小时

    function readStore(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function writeStore(key, val) {
        try { window.localStorage.setItem(key, val); } catch (e) { /* 隐私模式忽略 */ }
    }
    function readSession(key) {
        try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
    }
    function writeSession(key, val) {
        try { window.sessionStorage.setItem(key, val); } catch (e) { /* 忽略 */ }
    }

    function loadState() {
        var raw = readStore(STATE_KEY);
        if (!raw) return null;
        var s;
        try { s = JSON.parse(raw); } catch (e) { return null; }
        if (!s || typeof s !== 'object') return null;
        if (typeof s.t === 'number' && Date.now() - s.t > STATE_MAX_AGE) return null;   // 太旧，忽略
        return s;
    }

    /** 把当前播放状态写进 localStorage，供下一个页面恢复 */
    function saveState() {
        if (current < 0) return;
        if (leaving) return;              // 已经在卸载：暂停事件不算访客意图，别写脏状态
        // 已经放到结尾的曲子，下次从头开始（否则会瞬间 ended）
        var t = audio.currentTime || 0;
        if (audio.duration && audio.duration - t < 1.2) t = 0;
        writeStore(STATE_KEY, JSON.stringify({
            track: current,
            time: Math.max(0, t),
            paused: userPaused,
            muted: audio.muted,
            volume: audio.volume,
            unlocked: unlocked,
            t: Date.now()
        }));
    }

    /* ---------------- 工具 ---------------- */

    function fmt(sec) {
        if (!isFinite(sec) || sec < 0) return '0:00';
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function setHint(text) {
        if (!hintEl) return;
        hintEl.textContent = text || '';
        hintEl.hidden = !text;
    }

    function markPlaying(on) {
        root.classList.toggle('is-playing', !!on);
        // 只改类名，不直接改 audio.muted，避免播放时把静音状态覆盖掉
        if (audio.muted) root.classList.add('is-muted');
        else root.classList.remove('is-muted');
        // 声音已解锁（有声播放中）→ 记住，下一个页面可尝试带声音续播
        if (on && !audio.muted) writeSession(UNLOCK_KEY, '1');
    }

    function setActive(i) {
        trackBtns.forEach(function (b, idx) {
            b.classList.toggle('is-active', idx === i);
        });
    }

    /* ---------------- 播放控制 ---------------- */

    /**
     * 切到第 i 首。
     * @param {boolean} andPlay 是否立即播放
     * @param {boolean} [muted] 起播时是否先静音（自动起播传 true，用户点击传 false）
     */
    function load(i, andPlay, muted) {
        if (i < 0 || i >= trackBtns.length) return;
        current = i;
        var btn = trackBtns[i];
        audio.src = btn.dataset.src;
        audio.load();

        var name = btn.querySelector('.mp-name');
        var by = btn.querySelector('.mp-by');
        if (titleEl) titleEl.textContent = name ? name.textContent : '未在播放';
        if (artistEl) artistEl.textContent = by ? by.textContent : '';
        setActive(i);
        if (durEl) durEl.textContent = '0:00';
        if (seekFill) seekFill.style.width = '0';

        saveState();          // 切歌立刻落盘，防止用户马上点走链接

        if (andPlay) play(muted);
    }

    /**
     * 播放。
     * @param {boolean} [muted] 是否先静音再播。
     *   自动化起播必须静音（否则会被浏览器拦截）；
     *   但**用户主动点播放/切歌时绝不能静音** —— 那会把刚解锁的声音又按回去，
     *   表现为「点了播放却一直没声音」。
     */
    function play(muted) {
        if (muted) audio.muted = true;
        var p = audio.play();
        if (p && typeof p.catch === 'function') {
            p.catch(function () {
                if (!audio.muted) {
                    /* 有声播放被自动播放策略拦下（跨页面恢复时可能发生）。
                       回退：改成静音接着播，并把「已解锁」复位 ——
                       否则访客再点播放键时 unlock() 会因为 unlocked=true 直接 return，
                       声音永远出不来。 */
                    unlocked = false;
                    audio.muted = true;
                    root.classList.remove('is-unmuted');
                    root.classList.add('is-muted');
                    if (muteBtn) muteBtn.classList.add('is-muted');
                    if (root.mpVolume) root.mpVolume.sync(false);
                    setHint('点击开启声音');
                    play(true);
                    return;
                }
                // 连静音播放都被拒绝：等访客自己点
                markPlaying(false);
                setHint('点击播放按钮开始');
            });
        }
    }

    function toggle() {
        if (current < 0) { load(0, false); return; }
        if (audio.paused) { userPaused = false; play(false); }
        else { userPaused = true; audio.pause(); }
        saveState();
    }

    function next(auto) {
        if (!trackBtns.length) return;
        var i = current + 1;
        if (i >= trackBtns.length) {
            if (loopMode === 'none' && auto) { markPlaying(false); return; }
            i = 0;
        }
        // 自动续播（本曲放完）时沿用当前静音状态
        load(i, true, true);
    }

    function prev() {
        if (!trackBtns.length) return;
        var i = current - 1;
        if (i < 0) i = trackBtns.length - 1;
        load(i, true, !unlocked);
    }

    /* ---------------- 声音解锁 ---------------- */

    // 音量/静音由 music-volume.js 负责，这里只做转发，避免两处各写一套音量状态
    function vol() {
        return root.mpVolume || null;
    }

    function isMuted() {
        var v = vol();
        if (v) return v.isMuted();
        return !!audio.muted || audio.volume === 0;
    }

    function unlock() {
        if (unlocked) return;
        unlocked = true;
        var v = vol();
        if (v) v.unmute();
        else { audio.muted = false; if (audio.volume === 0) audio.volume = 0.5; }
        setHint('');
        root.classList.remove('is-muted');
        root.classList.add('is-unmuted');
        if (muteBtn) muteBtn.classList.remove('is-muted');
        if (typeof updateFab === 'function') updateFab();
        // 记住「访客已解锁声音」：下一个页面才能尝试带声音续播
        writeSession(UNLOCK_KEY, '1');
        saveState();
        broadcast();      // 现在本页开始出声了，其他标签页应让位
    }

    /* 音量变化时由 music-volume.js 回调，用来同步浮动按钮和提示 */
    root.mpOnVolumeChange = function () {
        if (isMuted()) {
            unlocked = false;
            root.classList.remove('is-unmuted');
            setHint('已静音，点击喇叭开启');
        } else {
            setHint('');
        }
        if (typeof updateFab === 'function') updateFab();
    };

    /* ---------------- 事件绑定 ---------------- */

    root.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('[data-mp]') : null;
        if (!el) return;
        var act = el.dataset.mp;

        // 先记下「本次点击前是否处于让位状态」，下面的复位会把它清掉
        var wasYielded = yielded;

        /* 访客在本页明确操作了 → 撤销「让位」状态，并把「开始出声时刻」刷成现在：
           这样本页重新出声时不仅能再次广播，还能在「谁先播谁赢」的仲裁里取胜。
           同时复位 unlocked —— 让位时本页被静音了，若 unlocked 仍为 true，
           unlock() 会直接 return 而不会解除静音、也不会广播接管出声权。 */
        if (act === 'toggle' || act === 'next' || act === 'prev' || act === 'track') {
            yielded = false;
            leaving = false;
            playStartedAt = Date.now();
            if (audio.muted) unlocked = false;
        }

        if (act === 'toggle') {
            /* 让位状态下这次点击的意图是「我要在这里听」→ 直接接管开始播，
               而不是把「让位时造成的暂停」再切换一次（那会变成一动不动的暂停）。 */
            if (wasYielded) {
                userPaused = false;
                unlock();
                play(false);
            } else {
                unlock();
                toggle();
            }
        }
        else if (act === 'next') { unlock(); next(false); }
        else if (act === 'prev') { unlock(); prev(); }
        /* 用户点击切歌：绝不静音（unlock 刚解锁，静音会把声音按回去） */
        else if (act === 'track') { unlock(); load(parseInt(el.dataset.index, 10), true, false); }
        else if (act === 'list') {
            var open = listEl && listEl.classList.toggle('is-open');
            el.setAttribute('aria-expanded', open ? 'true' : 'false');
            el.setAttribute('aria-label', open ? '收起歌单' : '展开歌单');
        }
        /* 音量键（data-mp="mute"）的静音切换由 music-volume.js 自己处理，
           这里不要重复处理，否则一次点击会静音又被立刻取消。 */
    });

    audio.addEventListener('play', function () { markPlaying(true); });
    audio.addEventListener('pause', function () {
        markPlaying(false);
        // 只有「访客主动暂停」才改变续播意图；跳转页面导致的暂停不算
        if (!restoring) { userPaused = true; saveState(); }
    });
    audio.addEventListener('loadedmetadata', function () {
        // 跨页面恢复：元数据就绪后才能设置播放位置
        if (pendingSeek > 0) {
            try {
                var d = audio.duration;
                audio.currentTime = (d && pendingSeek > d - 1) ? 0 : pendingSeek;
            } catch (e) { /* 某些浏览器在元数据前设置会抛错，忽略 */ }
            pendingSeek = 0;
        }
        if (curEl) curEl.textContent = fmt(audio.currentTime);
        if (durEl) durEl.textContent = fmt(audio.duration);
        saveState();
    });
    // 音量/静音变化只需保存状态；是否广播交给 play/pause 与 unlock 显式处理，
    // 避免「刚把 muted 设回 false、音频还没真的开播」就发出假的 playing 信号。
    audio.addEventListener('volumechange', saveState);
    // 播放过程中不需要每帧写盘，隔一会儿落一次即可
    setInterval(function () { if (!audio.paused) saveState(); }, 5000);
    audio.addEventListener('ended', function () {
        if (loopMode === 'one') { audio.currentTime = 0; play(false); }
        else next(true);
    });
    audio.addEventListener('timeupdate', function () {
        if (!audio.duration) return;
        var pct = (audio.currentTime / audio.duration) * 100;
        if (seekFill) seekFill.style.width = pct + '%';
        if (curEl) curEl.textContent = fmt(audio.currentTime);
        if (seekEl) seekEl.setAttribute('aria-valuenow', String(Math.round(pct)));
    });
    audio.addEventListener('error', function () {
        if (current < 0) return;
        // 文件缺失或格式不支持：跳过这一首，避免整个播放器卡住
        setHint('这首加载失败，已跳过');
        if (trackBtns.length > 1) next(true);
    });

    if (seekEl) {
        seekEl.addEventListener('click', function (e) {
            if (!audio.duration) return;
            var r = seekEl.getBoundingClientRect();
            var ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            audio.currentTime = ratio * audio.duration;
        });
    }

    /* ---------------- 跨标签页互斥 ----------------
       场景：用「在新标签页打开」的方式点文章（或 Ctrl/中键点击）时，
       旧标签页并不会卸载，它还在继续播放；新标签页又开始播 ——
       两个页面各自出声，听感就是「前后两端同时播放 / 重音」。

       做法：同一浏览器下若已有标签页在播同一首歌，本页自动让位（暂停并静音），
       只留一个出声。这样不管你是普通跳转还是新标签页打开都不会重音。
       用 BroadcastChannel；不支持的老浏览器退化为「什么都不做」，不影响其它功能。
    */
    var MP_CHANNEL = 'music-player';
    var chan = null;
    try { if (typeof BroadcastChannel === 'function') chan = new BroadcastChannel(MP_CHANNEL); } catch (e) { chan = null; }

    var lastOtherAudible = 0;              // 最近一次收到其他标签页「正在出声」的时间
    var yielded = false;                   // 本页是否已让位
    var leaving = false;                   // 本页正在离开（pagehide 之后），此时不再写状态
    var isReady = false;                   // 初始化完成前不广播，避免发出「假出声」信号
    var playStartedAt = 0;                 // 本页这次开始出声的时刻，用来仲裁「谁先播谁赢」

    /** 让位：暂停并静音，但不把「访客主动暂停」写进状态，否则会污染续播意图 */
    function yieldToOtherTab() {
        if (yielded) return;
        yielded = true;
        // 标记这次 pause 是「让位」而非访客操作，避免污染续播意图
        leaving = true;
        try { audio.pause(); } catch (e) { /* 忽略 */ }
        leaving = false;
        audio.muted = true;
        root.classList.remove('is-unmuted');
        root.classList.add('is-muted');
        if (muteBtn) muteBtn.classList.add('is-muted');
        if (root.mpVolume) root.mpVolume.sync(false);
        setHint('已在另一个页面播放');
        if (typeof updateFab === 'function') updateFab();
        // 广播自己已让位，其他标签页据此可以把「出声权」接管过去
        broadcast();
    }

    /**
     * 广播本页状态。
     *   'playing' —— 本页正在出声（其他标签页应当让位）
     *   'pending' —— 本页已起播但还没解锁，是静音的（不构成出声权，别人无需让位）
     *   'paused'  —— 本页没在播
     * 只认「真的在出声」，才能避免「静音起播的新页把正在放歌的旧页赶走」。
     */
    function broadcast() {
        if (!chan || !isReady) return;
        var state = audio.paused ? 'paused' : (audio.muted ? 'pending' : 'playing');
        chan.postMessage({ state: state, from: tabId, started: playStartedAt, t: Date.now() });
    }

    if (chan) {
        chan.addEventListener('message', function (ev) {
            var d = ev && ev.data;
            if (!d || d.from === tabId) return;          // 忽略自己发的

            if (d.state === 'playing') {
                /* 别的标签页正在出声，而本页也在出声 → 必须决出一个赢家，
                   否则两边互相让位变成「都不出声」（真实踩过这个坑）。

                   仲裁规则：**后开始播的胜出**（started 是对方开始播放的时间戳）。
                   符合直觉：访客刚点了播放的那个页面应该赢。
                   之前的反规则（先播的赢）会让旧标签页永远压着新标签页，导致
                   「在新标签页点播放也没用」。

                   另外**赢家不要反复宣告**：曾用「赢了就重播一次」的写法，
                   结果旧标签页每次赢都重新广播，把刚接管出声权的新标签页永久压回去。 */
                lastOtherAudible = Date.now();
                var meAudible = !audio.paused && !audio.muted;
                if (meAudible && !yielded) {
                    var myStart = playStartedAt || 0;
                    var theirStart = d.started || 0;
                    // 本页更晚开始 → 本页胜出，保持出声；否则让位
                    if (myStart < theirStart) yieldToOtherTab();
                }
            } else if (d.state === 'pending' || d.state === 'paused') {
                /* 对方已让位/暂停 → 本页可以放心继续。 */
                lastOtherAudible = 0;
            } else if (d.type === 'query') {
                // 新页面在问「有没有人在出声」
                if (!audio.paused && !audio.muted && !yielded) {
                    chan.postMessage({ state: 'playing', from: tabId, started: playStartedAt, t: Date.now() });
                }
            }
        });

        // 每次状态变化都广播，让其他标签页知道该不该让位
        audio.addEventListener('play', function () {
            if (!playStartedAt) playStartedAt = Date.now();   // 记下本次「开始出声」的时刻
            broadcast();
        });
        // 刚加载时先问一句，让正在出声的标签页回一声，本页据此决定是否要静音
        chan.postMessage({ type: 'query', from: tabId, t: Date.now() });
        /* 这里**故意不做**延时让位判定。
           原因：若同时存在「收到消息就让位」和「延时再判定」两处逻辑，
           新标签页会先按消息让位、随后自己播起来，再被延时判定叫停 ——
           结果两个页面都不出声（双输）。统一只在收到 playing 消息时让位。 */
    }

    /* 访客第一次与页面交互时，补一次唤醒（应对自动播放被拦截） */
    function armUnlockOnce() {        var once = function () {
            document.removeEventListener('pointerdown', once);
            document.removeEventListener('keydown', once);
            if (audio.paused && !userPaused && current >= 0) play(!unlocked);
            else if (current < 0 && autoplay && !userPaused) load(0, true, !unlocked);
        };
        document.addEventListener('pointerdown', once);
        document.addEventListener('keydown', once);
    }

    /* ---------------- 初始化 ---------------- */

    // 音量/静音状态归 music-volume.js 管，这里只在它加载前先给个安全默认值，
    // 并保证「静音」以便浏览器允许自动播放（有声自动播放一定会被拦截）。
    audio.volume = 0.5;
    audio.muted = true;
    root.classList.add('is-muted');
    if (muteBtn) muteBtn.classList.add('is-muted');

    /* ---------- 小屏浮动提示按钮 ---------- */
    /* 小屏下播放器被折叠进汉堡菜单，访客看不到「点击开启声音」，
       所以用这个浮动按钮代替：点它即解除静音。 */
    var fab = document.getElementById('music-player-fab');
    var menu = document.getElementById('main-menu');

    function updateFab() {
        if (!fab) return;
        var menuOpen = !!(menu && menu.classList.contains('show'));
        // 已经解锁声音、或菜单展开（此时播放器本体可见）时不显示
        var show = !unlocked && !menuOpen && !!audio.muted;
        fab.classList.toggle('is-visible', show);
    }

    if (fab) {
        fab.addEventListener('click', function () {
            unlock();
            // 用户点击：不要静音
            if (current < 0) load(0, true, false);
            else if (audio.paused) { userPaused = false; play(false); }
            updateFab();
        });
    }

    // 汉堡按钮展开/收起菜单时同步浮动按钮
    var toggleMenuBtn = document.getElementById('toggle-menu');
    if (toggleMenuBtn) {
        toggleMenuBtn.addEventListener('click', function () {
            setTimeout(updateFab, 0);
        });
    }

    /* ---------------- 跨页面恢复 ----------------
       读取上一个页面存下的状态：听到哪首、第几秒、是否静音、是否主动暂停。
       浏览器策略：同一个标签页里访客已经交互过（点过播放/解锁过声音），
       导航到同源新页面时通常允许继续自动播放；万一被拦，就退回静音播放。
    */
    var state = loadState();
    var wasUnlocked = readSession(UNLOCK_KEY) === '1' || (state && state.unlocked);

    if (!trackBtns.length) {
        root.style.display = 'none';
        return;
    }

    /* PJAX 换页时不要做任何恢复 —— 播放器元素根本没被销毁，
       音乐正在播；若照常「恢复」就会把音轨重载回 0 秒，音乐反而断了。
       （PJAX 只替换右栏与 <main> 内部，左侧边栏原样保留。） */
    if (window.__pjaxSwapping) {
        // 只把初始状态同步好即可，音频保持原样继续播
        if (root.mpVolume) root.mpVolume.sync(false);
        return;
    }

    var start = 0;
    if (state && typeof state.track === 'number' && state.track >= 0 && state.track < trackBtns.length) {
        start = state.track;
    }

    // 是否应该接着播：访客上次是「正在听」而不是「主动按了暂停」
    var resumePlaying = autoplay && !(state && state.paused);

    if (state) {
        userPaused = !!state.paused;
        unlocked = !!state.unlocked || wasUnlocked;
        pendingSeek = state.time > 0 ? state.time : 0;
    }

    if (resumePlaying) {
        restoring = true;                 // 恢复期间 audio 的 pause 事件不算访客行为

        if (wasUnlocked) {
            /* 上个页面已解锁过声音 → 尝试带声音接着播。
               策略：先解除静音，直接以「当前静音状态」起播（load 的 muted 传 false）。
               若被浏览器自动播放策略拦下，catch 里回退成静音播放 + 提示点击，
               并且把 unlocked 复位为 false —— 否则访客再点也没法解锁。 */
            var v = vol();
            if (v) v.unmute(); else { audio.muted = false; if (audio.volume === 0) audio.volume = 0.5; }
            root.classList.remove('is-muted');
            root.classList.add('is-unmuted');
            if (muteBtn) muteBtn.classList.remove('is-muted');
            if (root.mpVolume) root.mpVolume.sync(false);
            setHint('');

            load(start, true, false);
        } else {
            audio.muted = true;
            setHint('点击开启声音');
            load(start, true, true);
        }
        armUnlockOnce();
    } else {
        // 不自动续播（访客上次主动暂停了，或关闭了自动播放）
        // 但「已解锁」这件事要连 audio.muted 一起恢复 ——
        // 只设 unlocked 标记而不解除静音，会导致访客点播放时 unlock() 因为
        // unlocked=true 直接 return，声音永远出不来。
        if (wasUnlocked) {
            var v2 = vol();
            if (v2) v2.unmute(); else audio.muted = false;
            root.classList.remove('is-muted');
            root.classList.add('is-unmuted');
            if (muteBtn) muteBtn.classList.remove('is-muted');
        }
        load(start, false);
        setHint(state && state.paused ? '点击播放' : '点击开启声音');
        armUnlockOnce();
    }

    // 恢复流程结束（play/pause 事件跑完后清标记，避免把真实暂停误判为跳转所致）
    setTimeout(function () { restoring = false; }, 0);

    /* 离开页面前一定落盘：pagehide/beforeunload 比 visibilitychange 更可靠。
       注意顺序：先把状态写下来，再置 leaving —— 否则 leaving 会把这次保存挡掉。
       bfcache 恢复（返回上一页）时也会触发 pagehide，所以同时监听 pageshow 复位。 */
    function onLeave() {
        saveState();
        leaving = true;
    }
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') saveState();
    });
    window.addEventListener('pageshow', function () { restoring = false; leaving = false; });

    // 初始化浮动按钮状态（小屏上让访客能发现「点击播放音乐」）
    updateFab();

    /* 若 music-volume.js 已经先执行完（它是 defer，通常在本文件之后），
       把初始静音状态回灌一次，保证喇叭图标/滑条与真实状态一致。
       notifyParent=false：不要在这里改提示文字，上面刚设好。 */
    if (root.mpVolume) root.mpVolume.sync(false);

    /* 初始化完成，从这里开始才允许广播跨标签页状态。
       之前的一切 audio.muted 改动都属于「准备阶段」，不代表本页在出声。 */
    isReady = true;

    // 若本页此刻确实在出声，广播一次让其他标签页知道该让位
    broadcast();
})();
