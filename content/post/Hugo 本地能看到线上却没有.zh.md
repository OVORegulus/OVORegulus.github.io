---
title: "Hugo 本地能看到、线上却没有？检查 draft"
slug: "hugo-draft-check"
description: "hugo server 默认会把草稿也渲染出来，而 hugo 构建时不会——这是最常见的『本地正常线上少一篇』。"
date: 2026-10-15
draft: false
tags: ["Hugo", "排错"]
categories:
    - 学习笔记
---

## 现象

`hugo server` 预览时文章好好的，推到线上就没了。不是缓存问题，也不是同步失败。

## 原因

Hugo 对草稿的处理在两种模式下**默认值不一样**：

| 命令 | 草稿（`draft: true`） |
| --- | --- |
| `hugo server` | **渲染**（默认开启 `--buildDrafts`） |
| `hugo`（构建） | **跳过** |

也就是说，只要 front matter 里有 `draft: true`，本地看得见、线上一定没有。

## 怎么确认

```bash
# 构建时把草稿也打出来，验证是不是草稿问题
hugo --buildDrafts
```

如果加了 `--buildDrafts` 文章就出现，那 100% 是草稿标记没去掉。

## 顺手记一下

发布时把 front matter 改掉就行：

```yaml
draft: false
```

另外 `hugo server` 从 Hugo 0.123 起**默认就渲染草稿**，所以本地预览永远「过于乐观」，别拿它当发布前的最终检查。
