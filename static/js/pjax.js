/*!
 * PJAX —— 局部分页导航
 *
 * 目的：点站内链接时不再整页刷新，只替换「右栏 + <main> 内部」，
 *       **左侧边栏保持不动**，于是侧边栏里的背景音乐播放器（<audio>）
 *       永远不会被销毁，音乐在页面切换时不中断。
 *
 * 设计要点：
 *   1. 替换范围刻意排除 .left-sidebar —— 播放器、主菜单、暗色模式开关都在里面，
 *      它们连同事件监听一起原样保留，所以换页后不需要重新绑定，也不会出现重复监听。
 *   2. 主题的 Stack.init() 每次换页后重跑一次，负责新内容里的
 *      代码复制按钮、目录高亮、锚点平滑滚动、分页跳转。
 *      （它可以安全重跑：内部绑定的元素都在左侧边栏或新内容里，不会叠加监听。）
 *   3. /search/ 页面有自己的 search.tsx（靠 load 事件初始化，PJAX 后不会重跑），
 *      因此把搜索页排除，走整页跳转。
 *   4. 不做渐进增强兜底时的破坏：任何异常都回退到 location.href 整页跳转。
 *      脚本加载失败时，页面上没有任何东西被改过，链接照常工作。
 */
(function () {
    'use strict';

    // 浏览器能力不足就别启用，保持原生多页导航
    if (!window.history || !window.history.pushState || !window.fetch || !window.DOMParser) return;

    var SEL_MAIN = 'main.main';
    var SEL_RIGHT = '.right-sidebar';
    var SEL_TITLE = 'title';

    // 这些路径不参与 PJAX（各自依赖自己的脚本，换页后无法重新初始化）
    // 目前为空：搜索页有自己的 search.js，已通过 setupSearch() 在换页后重新初始化。
    var SKIP_PATHS = [];

    var swapping = false;
    var swapCount = 0;      // 已完成的 PJAX 换页次数（守卫据此判断是否为首次整页加载）

    /* 给 Stack.init 装上「只放行一次全局监听」的守卫。
       为什么需要：Stack.init() 里的 setupScrollspy() 每次都会
       window.addEventListener('scroll'/'resize', ...)，PJAX 反复换页会不断累积，
       越用越卡。其余几项（code-copy / smoothAnchors / paginationJump）
       都只绑定在新内容里的元素上，元素被替换后自然回收，不累积，所以可以照常重跑。

       在脚本加载时就安装（而不是等第一次换页），避免中途有人替换 window.Stack
       导致包装被丢掉 —— 测试里就踩过这个。 */
    function installStackInitGuard() {
        var S = window.Stack;
        if (!S || typeof S.init !== 'function' || S.__pjaxGuarded) return false;
        var orig = S.init;
        S.init = function () {
            /* 用「是否已经发生过 PJAX 换页」来判断，而不是「第几次调用」。
               原因：守卫可能抢在主题核心包首次 init() 之前装上，
               若按调用次数算，会把正常整页加载的那次误判成重复，白丢掉 scrollspy。
               首次整页加载时 swapCount 为 0 → 完整执行；换页之后才跳过全局监听。 */
            if (!swapCount) return orig.apply(this, arguments);
            var realAdd = window.addEventListener;
            window.addEventListener = function (type) {
                if (type === 'scroll' || type === 'resize') return;   // 跳过重复的全局监听
                return realAdd.apply(window, arguments);
            };
            try { return orig.apply(this, arguments); }
            finally { window.addEventListener = realAdd; }
        };
        S.__pjaxGuarded = true;
        return true;
    }

    installStackInitGuard();
    // 核心包的 load 回调可能晚于本脚本执行，稍后再试一次
    setTimeout(function () { installStackInitGuard(); }, 0);
    window.addEventListener('load', function () { installStackInitGuard(); });

    /** 判断一个 URL 是否适合 PJAX 接管 */
    function canHandle(url) {
        if (url.origin !== location.origin) return false;              // 外站
        if (url.pathname === location.pathname && url.search === location.search) return false; // 同一页（交给原生处理 hash）
        if (!/^https?:$/.test(url.protocol)) return false;             // mailto: 等
        if (/\.(png|jpe?g|gif|svg|webp|avif|pdf|zip|mp3|mp4|xml|json|txt)$/i.test(url.pathname)) return false; // 资源文件
        for (var i = 0; i < SKIP_PATHS.length; i++) {
            if (url.pathname.indexOf(SKIP_PATHS[i]) === 0) return false;
        }
        return true;
    }

    /** 用 fetch 拿到目标页并交换内容；失败返回 false（调用方回退整页跳转） */
    function load(url, push) {
        if (swapping) return;
        swapping = true;

        fetch(url.href, {
            headers: { 'X-Requested-With': 'PJAX' },
            credentials: 'same-origin'
        })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');

                var newMain = doc.querySelector(SEL_MAIN);
                var curMain = document.querySelector(SEL_MAIN);
                // 目标页缺关键结构就别乱换，直接整页跳转
                if (!newMain || !curMain) { location.href = url.href; return; }

                // 交换主流内容（页脚在 main 内部，一并更新）
                curMain.innerHTML = newMain.innerHTML;

                // 右栏（归档/分类/标签云/TOC）也随页面变化
                var newRight = doc.querySelector(SEL_RIGHT);
                var curRight = document.querySelector(SEL_RIGHT);
                if (newRight && curRight) {
                    curRight.innerHTML = newRight.innerHTML;
                }

                // 标题与各类 meta，尽量与整页加载保持一致
                var newTitle = doc.querySelector(SEL_TITLE);
                if (newTitle) document.title = newTitle.textContent;
                ['canonical', 'og:title', 'og:url', 'og:description', 'description'].forEach(function (key) {
                    var sel = key === 'canonical' ? 'link[rel="canonical"]'
                        : (key === 'description' ? 'meta[name="description"]' : 'meta[property="' + key + '"]');
                    var n = doc.querySelector(sel), c = document.querySelector(sel);
                    if (n && c) c.setAttribute(key === 'canonical' ? 'href' : 'content', n.getAttribute(key === 'canonical' ? 'href' : 'content'));
                });

                /* 菜单高亮：左侧边栏不替换，所以要手动同步。
                   注意不要自己按路径推断 —— 文章页 URL 是 /p/xxx/，菜单项却是 /post/，
                   主题是靠 Hugo 的 IsMenuCurrent（按 section 归属）判断的。
                   正确做法：直接读目标页侧边栏里已经是 current 的那一项，照搬过来。 */
                syncMenuHighlight(doc);

                if (push) {
                    history.pushState({ pjax: true, url: url.href }, '', url.href);
                }

                // 回到顶部（目标带锚点时留给浏览器处理）
                if (!url.hash) window.scrollTo(0, 0);

                /* 通知主题重新初始化新内容（代码复制按钮、目录高亮、锚点、分页跳转）。
                   为什么需要守卫：Stack.init() 里的 setupScrollspy() 每次都会
                   window.addEventListener('scroll'/'resize', ...)，多次调用会不断累积，
                   越用越卡。其余几项（code-copy / smoothAnchors / paginationJump）
                   都只绑定在新内容里的元素上，元素被替换后自然回收，不累积。 */
                window.__pjaxSwapping = true;
                try {
                    if (window.Stack && typeof window.Stack.init === 'function') {
                        if (!window.Stack.__pjaxGuarded) installStackInitGuard();
                        window.Stack.init();
                    }
                } finally {
                    window.__pjaxSwapping = false;
                }

                // 给第三方脚本（如播放器）一个换页钩子
                document.dispatchEvent(new CustomEvent('pjax:done', { detail: { url: url.href, doc: doc } }));

                /* 搜索页需要特别照顾：主题的 search.js 把初始化挂在 window 的 load 事件上，
                   而 PJAX 换页不会再触发 load。做法是把该脚本重新注入一次，
                   再手动派发一个 load 事件（PJAX 从不整页重载，所以不会误触发别的逻辑）。 */
                setupSearch(url, doc);

                swapCount++;      // 标记「已经换过页」，之后 Stack.init() 会跳过重复的全局监听
            })
            .catch(function (err) {
                // 任何失败都不让用户卡住：退回整页跳转
                if (window.console && console.warn) console.warn('[pjax] 失败，改为整页跳转:', err);
                location.href = url.href;
            })
            .then(function () { swapping = false; });
    }

    /**
     * 同步左侧边栏的「当前页」高亮。
     * @param {Document} doc 刚解析出来的目标页
     *
     * 左侧边栏被排除在替换范围之外（为了保住播放器），所以高亮不会自己更新。
     * 这里从目标页的侧边栏读取「哪些菜单项是 current」，按位置照搬到当前页面。
     * 之所以不按路径推断：文章页是 /p/xxx/，菜单项是 /post/，
     * 主题用的是 Hugo 的 IsMenuCurrent（按 section 归属），前端无法简单复刻。
     */
    function syncMenuHighlight(doc) {
        var curItems = document.querySelectorAll('#main-menu > li');
        var newItems = doc.querySelectorAll('#main-menu > li');
        if (!curItems.length || !newItems.length) return;
        var n = Math.min(curItems.length, newItems.length);
        for (var i = 0; i < n; i++) {
            var shouldBeCurrent = newItems[i].classList.contains('current');
            if (shouldBeCurrent) curItems[i].classList.add('current');
            else curItems[i].classList.remove('current');
        }
    }

    /**
     * 搜索页换页后的初始化。
     *
     * 背景：Search 类的监听器是绑在具体元素上的（input.addEventListener / list.innerHTML），
     * 而这些元素正好位于被替换的 <main> 里，所以必须重新构造一次。
     * 主题的 search.js 自己监听 window 的 load 事件，而 PJAX 不会再触发 load，
     * 因此这里重新注入脚本 + 手动派发一次 load。
     */
    function setupSearch(url, doc) {
        if (url.pathname.indexOf('/search/') !== 0) return;

        // 目标页里搜索脚本的真实地址（文件名带指纹，不能写死）
        var src = null;
        var list = doc.querySelectorAll('script[src]');
        for (var i = 0; i < list.length; i++) {
            var s = list[i].getAttribute('src') || '';
            if (/search[.\-][\w]*\.js$/.test(s) || /\/search\.js$/.test(s)) { src = s; break; }
        }
        // 换页时目标页里可能已经不含该脚本（第二次进入搜索页），退回到文档里已有的那个
        if (!src) {
            var existing = document.querySelectorAll('script[src]');
            for (var j = 0; j < existing.length; j++) {
                var e2 = existing[j].getAttribute('src') || '';
                if (/search[.\-][\w]*\.js$/.test(e2) || /\/search\.js$/.test(e2)) { src = e2; break; }
            }
        }
        if (!src) return;

        // 带 unique 参数重新请求：浏览器会重新执行脚本，但又不会重复堆积执行
        var sep = src.indexOf('?') >= 0 ? '&' : '?';
        var el = document.createElement('script');
        el.src = src + sep + 'pjax=1';
        el.defer = false;
        document.body.appendChild(el);

        // 脚本执行时注册了 load 监听，这里补一次触发
        setTimeout(function () {
            try {
                window.dispatchEvent(new Event('load'));
            } catch (err) { /* 老浏览器忽略 */ }
        }, 0);
    }

    /* ---------------- 拦截点击 ---------------- */

    document.addEventListener('click', function (e) {
        // 修饰键 / 中键 / 右键：交给浏览器（新标签页打开等）
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (e.target && e.target.closest && e.target.closest('a[target],a[download],[data-no-pjax]')) return;

        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a || !a.href) return;

        var url;
        try { url = new URL(a.href); } catch (err) { return; }
        if (!canHandle(url)) return;

        e.preventDefault();
        load(url, true);
    }, false);

    // 后退/前进
    window.addEventListener('popstate', function () {
        var url;
        try { url = new URL(location.href); } catch (e) { return; }
        // 历史记录里的页面按同规则加载；不满足条件就让浏览器自己处理
        if (url.origin === location.origin) load(url, false);
        else location.reload();
    });

    window.__pjax = { load: load, canHandle: canHandle };
})();
