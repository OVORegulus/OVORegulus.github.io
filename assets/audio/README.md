# 背景音乐

## 怎么加歌（只需一步）

把音频文件丢进这个目录就行：

```
assets/audio/01-示例音频.mp3
assets/audio/02-night-drive.mp3
assets/audio/03_lofi_study.mp3
```

侧边栏的播放器会**自动扫描**这里的所有音频文件生成歌单，不用改任何配置文件。

**文件名就是曲名**，并且会自动处理：

| 文件名 | 显示为 |
| --- | --- |
| `01-示例音频.mp3` | 示例音频 |
| `02-night-drive.mp3` | night drive |
| `03_lofi_study.mp3` | lofi study |

- 开头的 `01-`、`02-` 这类序号会被自动去掉（但**用它可以控制歌单顺序**，按文件名排序）
- `-` 和 `_` 会变成空格

## 想自定义曲名或歌手

在 `config/_default/params.toml` 里针对某个文件写一条覆盖即可，其他文件照旧自动扫描：

```toml
[[musicPlayer.playlist]]
    src    = "audio/02-night-drive.mp3"
    name   = "Night Drive"
    artist = "某个歌手"
```

`src` 写成 `audio/<文件名>`。如果文件名写错了（目录里没这个文件），
构建时会打印一条 **WARN** 提醒你，不会静默失效。

## 支持的格式

`mp3` `m4a` `ogg` `oga` `opus` `flac` `wav` `aac` `weba` `webm`

> 建议用 **mp3**：`.wav` 是未压缩的，体积会大很多（同样时长大约是 mp3 的 10 倍）。

## 注意事项

- 文件名**不要用空格和 `#`、`?`、`&`**，否则 URL 会出问题（中文名可以，会自动编码）
- 音频文件会一起进入 `public/`，体积大时注意仓库大小
- 歌多了播放器的歌单区最高约 130px，超出会内部滚动
- 想完全手写歌单、不用自动扫描：把 `params.toml` 里的 `autoDiscover` 设为 `false`

## 关于自动播放

带声音的自动播放会被**所有现代浏览器**拦截（Chrome / Edge / Safari / Firefox 都一样），
所以进入页面时是**静音自动播放**并显示「点击开启声音」提示，访客点一下才有声。
小屏（<768px）下播放器折叠在汉堡菜单里，会额外显示一个浮动的「点击播放音乐」按钮。
