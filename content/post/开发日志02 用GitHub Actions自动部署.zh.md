---
title: "开发日志 #2：用 GitHub Actions 自动部署"
slug: "devlog-02-github-actions"
description: "推一次代码就自动构建并发布到 GitHub Pages，附完整的 workflow 配置和权限踩坑记录。"
date: 2026-10-15
draft: false
tags: ["GitHub Actions", "部署", "开发日志"]
categories:
    - 项目实战
---

## 目标

本地 `git push` 之后，网站自动更新。不需要本地构建，也不要把 `public/` 提交进仓库。

## 原理

```text
push 到 main
   ↓
GitHub Actions 触发
   ↓
checkout（含 submodule）→ 安装 Hugo → hugo --minify
   ↓
把 public/ 上传为 Pages 产物
   ↓
Pages 发布
```

## workflow 配置

`.github/workflows/deploy.yml`：

```yaml
name: Deploy Hugo site

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive   # 主题是 submodule，必须带这句
          fetch-depth: 0

      - name: Setup Hugo
        uses: peaceiris/actions-hugo@v3
        with:
          hugo-version: "0.167.0"
          extended: true          # 用到 SCSS 就必须是 extended 版

      - name: Build
        run: hugo --minify --gc

      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./public

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

## 三个坑

### 1. 主题目录是空的

如果主题是用 `git submodule` 引入的，`actions/checkout` 默认**不会**拉取子模块，构建时直接报主题不存在。

```yaml
with:
  submodules: recursive
```

### 2. 构建报 SCSS 相关错误

普通版 Hugo 不带 SCSS 编译能力。主题用了 `assets/scss/`，就必须用 extended 版本：

```yaml
extended: true
```

### 3. 部署成功但页面 404

去仓库 **Settings → Pages**，把 Source 改成 **GitHub Actions**。默认是「Deploy from a branch」，会和 workflow 冲突。

同时确认 `baseURL` 和实际访问地址一致——`baseURL` 写错会导致 CSS、图片全部 404（因为全是绝对路径）。

## 复盘

配好之后，写文章的流程就只剩一件事：**新建 Markdown，push**。构建、发布、CDN 全都自动。

**最值得记的一点**：`baseURL` 和仓库名必须对得上。`https://<用户名>.github.io/` 这种用户站点，仓库要叫 `<用户名>.github.io`；如果是普通仓库，地址会带仓库名后缀，`baseURL` 也得跟着带。
