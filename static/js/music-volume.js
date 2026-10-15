/*!
 * 播放器音量控制（独立文件）
 *
 * 交互：
 *   - 点击喇叭：静音 / 取消静音（记住静音前的音量，取消时恢复）
 *   - 鼠标移上去 / 键盘聚焦：滑出音量条，拖动实时改音量
 *   - 拖动过程中不会因为鼠标移开而收起
 *
 * 与 music-player.js 的分工：
 *   本文件只负责 audio.volume / audio.muted；
 *   播放/暂停/切歌等由 music-player.js 负责。
 *   播放器需要同步图标状态时调用 root.mpVolume.sync()。
 */
(function () {
    'use strict';

    var root = document.getElementById('music-player');
    if (!root) return;

    var audio = root.querySelector('audio');
    var wrap = root.querySelector('[data-mp="volwrap"]');
    var btn = root.querySelector('[data-mp="mute"]');
    var range = root.querySelector('[data-mp="volume"]');
    if (!audio || !wrap || !btn) return;

    var lastVolume = 0.5;      // 静音前的音量，用于取消静音时恢复
    var dragging = false;

    var api = {
        /**
         * 把图标与滑条的显示同步到 audio 的真实状态。
         * @param {boolean} [notifyParent] 是否回调 music-player.js（默认 true）
         */
        sync: function (notifyParent) {
            var muted = !!audio.muted || audio.volume === 0;
            root.classList.toggle('is-muted', muted);
            btn.classList.toggle('is-muted', muted);
            if (range && !dragging) {
                range.value = String(Math.round((audio.muted ? 0 : audio.volume) * 100));
            }
            if (notifyParent !== false && typeof root.mpOnVolumeChange === 'function') {
                root.mpOnVolumeChange();
            }
        },

        /** 取消静音（供播放器在「点击任意处解锁声音」时调用） */
        unmute: function () {
            if (!audio.muted && audio.volume > 0) return;
            audio.muted = false;
            if (audio.volume === 0) audio.volume = lastVolume || 0.5;
            api.sync();
        },

        isMuted: function () {
            return !!audio.muted || audio.volume === 0;
        },

        volume: function () {
            return audio.muted ? 0 : audio.volume;
        },

        /** 设置音量，0 视为静音 */
        setVolume: function (v) {
            v = Math.min(1, Math.max(0, v));
            if (v > 0) lastVolume = v;
            audio.volume = v;
            audio.muted = v === 0;
            api.sync();
        },

        /** 静音 / 取消静音切换 */
        toggleMute: function () {
            if (api.isMuted()) {
                api.unmute();
            } else {
                lastVolume = audio.volume;
                audio.muted = true;
                api.sync();
            }
        }
    };

    /* ---------------- 事件 ---------------- */

    btn.addEventListener('click', function (e) {
        e.preventDefault();
        api.toggleMute();
    });

    // 悬停滑出音量条（CSS 也做了 hover，这里额外加 class 以便拖动时保持展开）
    wrap.addEventListener('mouseenter', function () {
        wrap.classList.add('is-open');
    });
    wrap.addEventListener('mouseleave', function () {
        if (!dragging) wrap.classList.remove('is-open');
    });
    // 键盘用户：聚焦到滑条时保持展开
    wrap.addEventListener('focusin', function () {
        wrap.classList.add('is-open');
    });
    wrap.addEventListener('focusout', function () {
        if (!dragging) wrap.classList.remove('is-open');
    });

    if (range) {
        range.addEventListener('pointerdown', function () { dragging = true; });
        range.addEventListener('pointerup', function () {
            dragging = false;
            wrap.classList.remove('is-open');
        });
        // 键盘左右键改音量时也要同步
        range.addEventListener('keyup', function () {
            api.setVolume(parseInt(range.value, 10) / 100);
        });

        // input 事件在拖动过程中持续触发
        range.addEventListener('input', function () {
            var v = parseInt(range.value, 10) / 100;
            if (v > 0) lastVolume = v;
            audio.volume = v;
            audio.muted = v === 0;
            root.classList.toggle('is-muted', v === 0);
            btn.classList.toggle('is-muted', v === 0);
        });

        // 拖动结束落定
        range.addEventListener('change', function () {
            api.setVolume(parseInt(range.value, 10) / 100);
        });
    }

    /* ---------------- 初始化 ---------------- */

    // 初始值：优先用滑条上已有的 value（服务端渲染时设过），否则 0.5
    if (range) {
        var initial = parseInt(range.value, 10);
        if (isFinite(initial)) audio.volume = Math.min(1, Math.max(0, initial / 100));
    }
    lastVolume = audio.volume > 0 ? audio.volume : 0.5;
    api.sync(false);

    // 暴露给 music-player.js 调用
    root.mpVolume = api;
})();
