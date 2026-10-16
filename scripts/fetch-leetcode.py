#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 LeetCode 的提交日历（那个「做题绿点」），生成 Hugo 挂件要用的 data/leetcode.json。

为什么不在前端抓：
  浏览器直连 leetcode.com/cn 会被 CORS 拦掉，而且它前面有 Cloudflare 风控，
  所以改成「构建时抓一次、静态渲染」。CI 里由 .github/workflows/hugo.yml 调用。

用法：
    python3 scripts/fetch-leetcode.py                  # 用户名/站点从 config/_default/params.toml 的 [leetcode] 段读
    python3 scripts/fetch-leetcode.py --username xxx --site cn
    python3 scripts/fetch-leetcode.py --dump-raw raw.json    # 只联网抓、把原始响应存下来
    python3 scripts/fetch-leetcode.py --from-file raw.json   # 不联网，用存下来的响应生成（网络不通时调试用）

⚠️ username 必须填「用户名」，也就是个人主页 URL 里 /u/xxxx/ 的那一段，
   不是昵称。力扣中文站注册时若没自定义用户名，会给一个随机串（形如 frosty-7amportqdf）。

两个站的 schema 完全不同（实测确认，不是猜的）：
    leetcode.com  Query.matchedUser(username:) → submitStats + userCalendar(year:)
    leetcode.cn   日历在另一个端点 /graphql/noj-go/ 的 Query.userCalendar(userSlug:, year:)；
                  已解题数在主端点 /graphql/ 的 Query.userProfileUserQuestionProgress(userSlug:)。
                  中文站没有 matchedUser，拿 .com 的查询去问会直接报
                  'Cannot query field "matchedUser" on type "Query"'。

失败时的行为：**保留**已有的 data/leetcode.json 并以退出码 0 结束，
这样 LeetCode 改风控、账号改名都不会把整个站点部署搞红；日志里会打印失败原因。
需要「失败即报错」时加 --fail-on-error。
"""

import argparse
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

# LeetCode 的日历按 UTC 日切分，但「今天是几号」按北京时间算才符合直觉
CST = timezone(timedelta(hours=8))
WEEKS = 53          # 53 列 × 7 行 ≈ 一年（和 GitHub / LeetCode 一样）
DAYS_PER_WEEK = 7
SITE_HOSTS = {"cn": "leetcode.cn", "us": "leetcode.com"}

QUERY_US = """
query UserCalendar($username: String!, $thisYear: Int, $lastYear: Int) {
  matchedUser(username: $username) {
    username
    submitStats {
      acSubmissionNum { difficulty count submissions }
    }
    thisYear: userCalendar(year: $thisYear) {
      streak
      totalActiveDays
      submissionCalendar
    }
    lastYear: userCalendar(year: $lastYear) {
      submissionCalendar
    }
  }
}
"""

QUERY_CN_CALENDAR = """
query UserCalendar($userSlug: String!, $thisYear: Int, $lastYear: Int) {
  thisYear: userCalendar(userSlug: $userSlug, year: $thisYear) {
    streak
    totalActiveDays
    submissionCalendar
  }
  lastYear: userCalendar(userSlug: $userSlug, year: $lastYear) {
    submissionCalendar
  }
}
"""

QUERY_CN_PROGRESS = """
query UserProgress($userSlug: String!) {
  userProfileUserQuestionProgress(userSlug: $userSlug) {
    numAcceptedQuestions { difficulty count }
  }
}
"""

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


# --------------------------------------------------------------------------- 配置

def read_config(path="config/_default/params.toml"):
    """从 params.toml 的 [leetcode] 段读 username / site（不依赖 tomllib，兼容老 Python）。"""
    cfg = {}
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print("· 读不到 %s（%s），改用命令行参数" % (path, e), file=sys.stderr)
        return cfg

    try:                                    # Python 3.11+ 有 tomllib，最可靠
        import tomllib
        cfg = tomllib.loads(text).get("leetcode", {}) or {}
        return {k: v for k, v in cfg.items() if isinstance(v, str)}
    except Exception:
        pass

    # 退路：只认 [leetcode] 段里的简单字符串键
    m = re.search(r"(?ms)^\[leetcode\]\s*$(.*?)(?=^\[|\Z)", text)
    if m:
        for k, v in re.findall(r'(?m)^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"', m.group(1)):
            cfg[k] = v
    return cfg


# --------------------------------------------------------------------------- 抓取

def friendly(errors, username):
    """把 GraphQL 那些天书报错翻译成人话。"""
    msg = "; ".join(e.get("message", "") for e in errors)
    if "must not be null" in msg or "does not exist" in msg:
        return ("查不到用户 %r —— 要填个人主页 URL 里 /u/xxxx/ 那段的「用户名」，"
                "不是昵称（昵称在力扣里可以是任意中文或英文）" % username)
    return msg


def post(base, path, query, variables, username, cookies=None):
    """POST 一个 GraphQL 查询，返回解析后的 JSON。"""
    opener, headers = cookies or new_session(base, username)
    payload = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    last_err = None
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(base + path, data=payload, headers=headers, method="POST")
            with opener.open(req, timeout=30) as r:
                body = json.loads(r.read().decode("utf-8"))
            if body.get("errors"):
                raise RuntimeError(friendly(body["errors"], username))
            return body
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                raw = json.loads(e.read().decode("utf-8", "replace"))
                if raw.get("errors"):
                    raise RuntimeError(friendly(raw["errors"], username))
                detail = json.dumps(raw)[:200]
            except RuntimeError:
                raise
            except Exception:
                pass
            last_err = "HTTP %s %s %s" % (e.code, e.reason, detail)
        except RuntimeError:
            raise
        except Exception as e:
            last_err = "%s: %s" % (type(e).__name__, e)
        if attempt == 1:
            time.sleep(2)
    raise RuntimeError(last_err or "未知错误")


def new_session(base, username):
    """建一个带 cookie 的会话：先访问一次个人页拿 csrftoken。

    LeetCode 的部分接口会校验 csrftoken，直接裸 POST 容易被 Cloudflare 拦。
    """
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    headers = {
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Content-Type": "application/json",
        "Origin": base,
        "Referer": "%s/u/%s/" % (base, username),
    }
    try:
        req = urllib.request.Request("%s/u/%s/" % (base, username),
                                     headers={"User-Agent": BROWSER_UA,
                                              "Accept-Language": headers["Accept-Language"]})
        with opener.open(req, timeout=25) as r:
            r.read()
    except Exception as e:
        print("· 预热请求失败（继续尝试 GraphQL）：%s" % e, file=sys.stderr)

    csrf = next((c.value for c in jar if c.name.lower() == "csrftoken"), "")
    if csrf:
        headers["x-csrftoken"] = csrf
    return opener, headers


def fetch(username, site):
    """联网抓取，返回一个统一的中间结构（之后两个站共用同一套加工逻辑）。"""
    if site not in SITE_HOSTS:
        raise RuntimeError("站点只能是 cn 或 us，收到 %r" % site)
    base = "https://%s" % SITE_HOSTS[site]
    session = new_session(base, username)
    now = datetime.now(CST)

    if site == "us":
        body = post(base, "/graphql/", QUERY_US, {
            "username": username, "thisYear": now.year, "lastYear": now.year - 1,
        }, username, session)
        mu = (body.get("data") or {}).get("matchedUser") or {}
        if not mu:
            raise RuntimeError(friendly([{"message": "does not exist"}], username))
        return {
            "username": mu.get("username") or username,
            "solved": solved_from_ac(mu.get("submitStats")),
            "calendar": merge_calendars(mu.get("lastYear"), mu.get("thisYear")),
        }

    # 中文站：日历在 noj-go 端点
    cal = post(base, "/graphql/noj-go/", QUERY_CN_CALENDAR, {
        "userSlug": username, "thisYear": now.year, "lastYear": now.year - 1,
    }, username, session)
    data = cal.get("data") or {}
    if not data.get("thisYear") and not data.get("lastYear"):
        raise RuntimeError(friendly([{"message": "does not exist"}], username))

    # 中文站：已解题数在主端点（拿不到也不致命，就当 0）
    solved = {"total": 0, "easy": 0, "medium": 0, "hard": 0}
    try:
        prog = post(base, "/graphql/", QUERY_CN_PROGRESS, {"userSlug": username}, username, session)
        node = ((prog.get("data") or {}).get("userProfileUserQuestionProgress") or {})
        for item in node.get("numAcceptedQuestions") or []:
            key = str(item.get("difficulty", "")).lower()
            if key in solved:
                solved[key] = int(item.get("count") or 0)
        solved["total"] = solved["easy"] + solved["medium"] + solved["hard"]
    except Exception as e:
        print("· 已解题数没取到（不影响日历）：%s" % e, file=sys.stderr)

    return {
        "username": username,
        "solved": solved,
        "calendar": merge_calendars(data.get("lastYear"), data.get("thisYear")),
    }


# --------------------------------------------------------------------------- 加工

def parse_calendar(raw):
    """submissionCalendar 是 JSON 字符串：{'1735689600': 3, ...}（UTC 零点时间戳 -> 当天提交数）。

    注意它只包含「有提交的日子」，不是 365 个条目。
    """
    if not raw:
        return {}
    if isinstance(raw, str):
        raw = json.loads(raw or "{}")
    return {int(k): int(v) for k, v in raw.items()}


def merge_calendars(*nodes):
    """把去年/今年的日历拼起来（后面的覆盖前面的）。"""
    out = {}
    for node in nodes:
        if isinstance(node, dict):
            out.update(parse_calendar(node.get("submissionCalendar")))
    return out


def solved_from_ac(submit_stats):
    """国际站：submitStats.acSubmissionNum 里 difficulty 是 All/Easy/Medium/Hard。"""
    solved = {"total": 0, "easy": 0, "medium": 0, "hard": 0}
    for item in ((submit_stats or {}).get("acSubmissionNum") or []):
        key = str(item.get("difficulty", "")).lower()
        n = int(item.get("count") or 0)
        if key == "all":
            solved["total"] = n
        elif key in solved:
            solved[key] = n
    if not solved["total"]:
        solved["total"] = solved["easy"] + solved["medium"] + solved["hard"]
    return solved


def day_ts(day):
    """某一天的 UTC 零点时间戳（LeetCode 日历用的就是这种 key）。"""
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())


def current_streak(calendar, today):
    """从今天往回数连续提交天数。

    不能直接用接口给的 streak：实测它给的是「上一段连续」——某用户 10-08~10-14 连续
    7 天、10-15 断了、10-16 又提交，接口 streak=7，而个人主页写的是「连续提交: 1」。
    主页那个才是从今天往回数的，所以这里自己算。

    今天还没提交时从昨天开始数（当天还没结束，不该算断）。
    """
    d = today
    if day_ts(d) not in calendar:
        d -= timedelta(days=1)
    n = 0
    while day_ts(d) in calendar:
        n += 1
        d -= timedelta(days=1)
    return n


def build_cells(calendar, today, weeks=WEEKS):
    """把「时间戳 -> 次数」摊成 weeks×7 个格子（按列排：先一列 7 天，再下一列）。

    列从周日开始（和 LeetCode 自己的日历一致），最后一列是本周，
    今天之后的格子标 l=-1（前端画成透明）用于补齐。
    """
    last_sunday = today - timedelta(days=(today.weekday() + 1) % 7)   # 本周的周日
    first_sunday = last_sunday - timedelta(weeks=weeks - 1)

    cells = []
    for i in range(weeks * DAYS_PER_WEEK):
        day = first_sunday + timedelta(days=i)
        if day > today:
            cells.append({"d": day.isoformat(), "c": 0, "l": -1})     # 未来：补齐用
            continue
        c = calendar.get(day_ts(day), 0)
        cells.append({"d": day.isoformat(), "c": c, "l": 0})

    # 分档：0 次=0，其余按非零次数的四分位切成 1~4 档（和 GitHub 的算法思路一样，
    # 保证再稀疏的数据也能用满 4 个色阶）
    nz = sorted(c["c"] for c in cells if c["c"] > 0)
    if nz:
        def quantile(p):
            return nz[min(len(nz) - 1, int(len(nz) * p))]
        q1, q2, q3 = quantile(0.25), quantile(0.50), quantile(0.75)
        for c in cells:
            if c["l"] == -1:      # 未来日期保持 -1（前端画成透明），别被下面的分档覆盖掉
                continue
            if c["c"] <= 0:
                c["l"] = 0
            elif c["c"] <= q1:
                c["l"] = 1
            elif c["c"] <= q2:
                c["l"] = 2
            elif c["c"] <= q3:
                c["l"] = 3
            else:
                c["l"] = 4
    return cells


def build_payload(username, site, raw, today=None):
    today = today or datetime.now(CST).date()
    # 注意：日历的 key 是时间戳。联网抓来的是 int，但从 --from-file 读回来会变成
    # str（JSON 的键只能是字符串），这里统一转回 int，否则查哪一天都查不到。
    calendar = {int(k): int(v) for k, v in (raw.get("calendar") or {}).items()}
    cells = build_cells(calendar, today)

    return {
        "username": raw.get("username") or username,
        "site": site,
        "updated": datetime.now(CST).strftime("%Y-%m-%d %H:%M"),
        "streak": current_streak(calendar, today),
        "activedays": len(calendar),
        "yeartotal": sum(c["c"] for c in cells if c["c"] > 0),
        "maxday": max([c["c"] for c in cells] or [0]),
        "solved": raw.get("solved") or {"total": 0, "easy": 0, "medium": 0, "hard": 0},
        "weeks": WEEKS,
        "cells": cells,
    }


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="抓取 LeetCode 提交日历 -> data/leetcode.json")
    ap.add_argument("--username", default=os.environ.get("LEETCODE_USERNAME", ""),
                    help="个人主页 URL 里 /u/xxxx/ 那段（用户名，不是昵称）")
    ap.add_argument("--site", default=os.environ.get("LEETCODE_SITE", ""), choices=["", "cn", "us"])
    ap.add_argument("--out", default="data/leetcode.json")
    ap.add_argument("--config", default="config/_default/params.toml")
    ap.add_argument("--from-file", help="不联网，直接用保存的原始响应生成")
    ap.add_argument("--dump-raw", help="只联网抓取原始响应并存到这个文件（不生成 leetcode.json）")
    ap.add_argument("--fail-on-error", action="store_true", help="抓取失败时以退出码 1 结束")
    args = ap.parse_args()

    cfg = read_config(args.config)
    username = args.username or cfg.get("username", "")
    site = (args.site or cfg.get("site", "") or "cn").strip().lower()

    def bail(msg):
        print("⚠️  %s" % msg, file=sys.stderr)
        if os.path.exists(args.out):
            print("   保留已有的 %s，构建继续。" % args.out, file=sys.stderr)
        else:
            print("   还没有 %s，本次挂件不会显示。" % args.out, file=sys.stderr)
        return 1 if args.fail_on_error else 0

    if not username and not args.from_file:
        return bail("没有配置 LeetCode 用户名（config/_default/params.toml 的 [leetcode] username，或 --username）")
    if site not in SITE_HOSTS:
        return bail("站点只能是 cn 或 us，收到 %r" % site)

    try:
        if args.from_file:
            with open(args.from_file, encoding="utf-8") as f:
                raw = json.load(f)
            # 允许存两种形状：{username, solved, calendar} 或 GraphQL 原始响应
            if "calendar" not in raw:
                data = raw.get("data") or raw
                mu = data.get("matchedUser")
                if mu:
                    raw = {"username": mu.get("username") or username,
                           "solved": solved_from_ac(mu.get("submitStats")),
                           "calendar": merge_calendars(mu.get("lastYear"), mu.get("thisYear"))}
                else:
                    raw = {"username": username,
                           "solved": solved_from_ac(data.get("submitStats")),
                           "calendar": merge_calendars(data.get("lastYear"), data.get("thisYear"))}
            print("· 使用本地响应文件 %s（未联网）" % args.from_file)
        else:
            print("· 抓取 %s@%s …" % (username, site))
            raw = fetch(username, site)

        if args.dump_raw:
            with open(args.dump_raw, "w", encoding="utf-8") as f:
                json.dump(raw, f, ensure_ascii=False, indent=2, sort_keys=True)
                f.write("\n")
            print("✅ 原始响应已存到 %s（日历 %d 天）" % (args.dump_raw, len(raw.get("calendar") or {})))
            return 0

        payload = build_payload(username, site, raw)
    except Exception as e:
        return bail("抓取/解析失败：%s" % e)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    print("✅ 已更新 %s：%s@%s 连续 %d 天 / 累计 %d 天 / 近一年 %d 次提交 / 已解 %d 题（单日最多 %d 次）"
          % (args.out, payload["username"], site, payload["streak"], payload["activedays"],
             payload["yeartotal"], payload["solved"]["total"], payload["maxday"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
