<#
  install-hooks.ps1 —— 装 git 钩子（v2.26.0）

  ## 为什么

  `run-all.ps1` 已经能跑全部验证，但**靠人记得跑**。这个脚本把
  `check-build-guard.ps1` 挂到 pre-commit 上 —— 它是**秒级**的静态检查，
  适合每次提交都跑。

  浏览器套件（~194 秒）**故意不挂** —— 每次提交等三分多钟，人就会开始用
  `--no-verify` 绕过，那比不挂还糟。它们留给 run-all.ps1。

  用法：
    .\tools\install-hooks.ps1          # 装
    .\tools\install-hooks.ps1 -Remove  # 卸
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$gitDir = Join-Path $root '.git'

if (-not (Test-Path $gitDir)) {
    Write-Host "这里不是 git 仓库（找不到 $gitDir）—— 钩子没地方装。" -ForegroundColor Yellow
    Write-Host "（本项目的 .gitignore 是准备好的，但仓库本身还没初始化。）"
    exit 0
}

$hooks = Join-Path $gitDir 'hooks'
New-Item -ItemType Directory -Force -Path $hooks | Out-Null
$target = Join-Path $hooks 'pre-commit'

if ($Remove) {
    if (Test-Path $target) { Remove-Item $target -Force; Write-Host "已卸掉 pre-commit 钩子" -ForegroundColor Green }
    else { Write-Host "本来就没有" -ForegroundColor DarkGray }
    exit 0
}

# 钩子里存的是**相对路径**推导，换机器/换目录都不用改
$body = @'
#!/bin/sh
# 由 tools/install-hooks.ps1 生成 —— 不要手改（改那个脚本再重装）
# 只跑秒级的静态守卫；浏览器套件留给 run-all.ps1
root="$(git rev-parse --show-toplevel)"
powershell -ExecutionPolicy Bypass -File "$root/tools/check-build-guard.ps1" || {
  echo ""
  echo "构建守卫失败 —— 提交已阻止。"
  echo "确需绕过：git commit --no-verify"
  exit 1
}
'@

# 写 LF 行尾（git 钩子在 Windows 上对 CRLF 敏感）
[System.IO.File]::WriteAllText($target, ($body -replace "
", "
"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已装 pre-commit 钩子：每次提交跑 check-build-guard.ps1（秒级）" -ForegroundColor Green
Write-Host "浏览器套件（~194 秒）故意不挂 —— 见脚本头的说明。"
