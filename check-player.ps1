# 播放器自查脚本
# 用法（在 blog 目录下）： powershell -ExecutionPolicy Bypass -File .\check-player.ps1
# 作用：重新构建并输出「播放器有没有生成、歌单里有哪几首、音频 URL 对不对」

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
Push-Location $root

Write-Host "`n=== 1. assets/audio/ 里有哪些音频文件 ===" -ForegroundColor Cyan
$audioDir = Join-Path $root 'assets\audio'
$audio = @()
if (Test-Path $audioDir) {
    $audio = Get-ChildItem $audioDir -File | Where-Object {
        $_.Extension -match '^\.(mp3|m4a|ogg|oga|opus|flac|wav|aac|weba|webm)$'
    }
}
if ($audio.Count -eq 0) {
    Write-Host "  (没有音频文件) -> 播放器不会显示" -ForegroundColor Yellow
    Write-Host "  请把 mp3 放进: $audioDir" -ForegroundColor Yellow
} else {
    $audio | ForEach-Object {
        Write-Host ("  {0,-40} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB))
    }
}

Write-Host "`n=== 2. 重新构建 ===" -ForegroundColor Cyan
$build = & .\hugo.exe --cleanDestinationDir 2>&1 | Out-String
$err = ([regex]::Matches($build, 'ERROR')).Count
$warn = ([regex]::Matches($build, 'WARN')).Count
Write-Host "  ERROR: $err   WARN: $warn"
if ($warn -gt 0) {
    ($build -split "`n") | Where-Object { $_ -match 'WARN' } | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

Write-Host "`n=== 3. 首页里有没有播放器 ===" -ForegroundColor Cyan
$index = Join-Path $root 'public\index.html'
if (-not (Test-Path $index)) {
    Write-Host "  public\index.html 不存在 —— 构建可能失败了" -ForegroundColor Red
    Pop-Location; exit 1
}
$html = Get-Content $index -Raw
if ($html -match '<li id="music-player"') {
    Write-Host "  有 ✓" -ForegroundColor Green
} else {
    Write-Host "  没有 ✗ —— 说明 assets/audio/ 里没有可识别的音频文件" -ForegroundColor Red
    Pop-Location; exit 1
}

Write-Host "`n=== 4. 歌单内容 ===" -ForegroundColor Cyan
if ($html -match '<span class="mp-count">([^<]*)</span>') {
    Write-Host "  曲目数: $($matches[1])"
}
if ($html -match '(?s)<ol class="mp-list">(.*?)</ol>') {
    $items = [regex]::Matches($matches[1], '(?s)data-src="([^"]*)">\s*<span class="mp-index">\d+</span>\s*<span class="mp-name">([^<]*)</span>')
    foreach ($m in $items) {
        Write-Host ("  曲名: {0}" -f $m.Groups[2].Value)
        Write-Host ("  src : {0}" -f $m.Groups[1].Value) -ForegroundColor DarkGray
    }
}

Write-Host "`n=== 5. 音频文件有没有发布到 public\audio\ ===" -ForegroundColor Cyan
$pub = Join-Path $root 'public\audio'
if (Test-Path $pub) {
    Get-ChildItem $pub -File | ForEach-Object { Write-Host "  $($_.Name)" }
} else {
    Write-Host "  public\audio\ 不存在 ✗" -ForegroundColor Red
}

Write-Host "`n=== 6. 该看哪里 ===" -ForegroundColor Cyan
Write-Host "  播放器在【左侧边栏】最下方 —— 就是「链接」菜单的下面、" -ForegroundColor White
Write-Host "  一个叫「音乐」的小卡片（带绿色竖条和音符图标）。" -ForegroundColor White
Write-Host "  如果你的浏览器还显示旧样子，按 Ctrl+Shift+R 强制刷新。" -ForegroundColor Yellow

Write-Host "`n完成。预览命令: .\hugo.exe server`n" -ForegroundColor Green
Pop-Location
