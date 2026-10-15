---
title: "git 提交到错误分支后，别急着 revert"
slug: "git-wrong-branch"
description: "用 git reset --soft 一步回到提交之前，改动还在暂存区里，比重做一遍快得多。"
date: 2026-10-15
draft: false
tags: ["Git", "小技巧"]
categories:
    - 学习笔记
---

## 场景

刚写完一个功能，顺手 `git commit`，然后发现：**提交到 main 上了**，本该在 feature 分支。

第一反应往往是 `git revert`，但那会多出一次「撤销的提交」，历史很脏。

## 做法

```bash
# 撤销最近一次 commit，但保留改动在暂存区
git reset --soft HEAD~1

# 切到正确的分支，重新提交
git switch feature/login
git commit -m "feat: 登录页"
```

`--soft` 的意思是：**只把 HEAD 指针往回挪**，暂存区和工作区都不动。所以撤销后 `git status` 里那些文件还是绿色的 `staged` 状态，直接在新分支 `commit` 就行。

## 三种 reset 的区别

| 参数 | HEAD | 暂存区 | 工作区 | 什么时候用 |
| --- | --- | --- | --- | --- |
| `--soft` | 回退 | 保留 | 保留 | 提交错分支，想原样搬家 |
| `--mixed`（默认） | 回退 | 清空 | 保留 | 想重新挑文件提交 |
| `--hard` | 回退 | 清空 | **丢弃** | 确认改动不要了 |

## 记住一点

`--soft` 和 `--mixed` 是安全的，改动不会丢；**只有 `--hard` 会真的删掉代码**，用之前先 `git stash` 或者确认一遍。
