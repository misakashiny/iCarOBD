<#
  release-git.ps1 —— 发一个大版本 = 一条命令（v1.15.0 起）

  ## 用途

  把「提交 + 打标签 + 推送」三步合成一步。版本号**从 `app/build.gradle.kts` 读**，
  不让你手打（手打迟早和实际版本对不上）。

  ## 用法

    .\tools\release-git.ps1 -Message "修了仪表盘在横屏下的列数"        # 正式发版
    .\tools\release-git.ps1 -Message "..." -DryRun                    # 只看会做什么
    .\tools\release-git.ps1 -Message "..." -SkipTests                 # 跳过回归（不推荐）

  ## 它会做什么

    ① 读 app/build.gradle.kts 里的 versionName（比如 1.15.0）
    ② 检查工作区有没有没提交的东西、标签是不是已经存在
    ③ 跑 tools/run-all.ps1（除非 -SkipTests）
    ④ git add -A → commit → tag vX.Y.Z → push（含标签）
    ⑤ 提示你去 Releases 页面传 APK

  ## 为什么 APK 要手动传

  仓库里不含 APK（见 .gitignore 的说明）—— 每个版本 6.7 MB，
  留在 git 历史里删不掉。Releases 附件不占仓库体积，且能单独下载历史版本。
#>
param(
    [Parameter(Mandatory = $true)][string]$Message,
    [switch]$DryRun,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    ✅ $t" -ForegroundColor Green }
function Bad($t) { Write-Host "    ❌ $t" -ForegroundColor Red }

# ---- ① 版本号 ----
Step 1 '读版本号'
$gradle = Join-Path $root 'app/build.gradle.kts'
if (-not (Test-Path $gradle)) { Bad "找不到 $gradle"; exit 1 }
$txt = [System.IO.File]::ReadAllText($gradle, [System.Text.UTF8Encoding]::new($false))
$m = [regex]::Match($txt, 'versionName\s*=\s*"([\d.]+)"')
if (-not $m.Success) { Bad 'app/build.gradle.kts 里没找到 versionName'; exit 1 }
$ver = $m.Groups[1].Value
$tag = "v$ver"
Ok "versionName = $ver  →  标签 $tag"

# ---- ② 前置检查 ----
Step 2 '前置检查'
if (-not (Test-Path (Join-Path $root '.git'))) { Bad '这里不是 git 仓库'; exit 1 }
$dirty = git status --porcelain
if (-not $dirty) { Bad '工作区没有改动 —— 没什么可发的（改完代码再跑）'; exit 1 }
Ok "有 $($dirty.Count) 处改动待提交"

$existing = git tag -l $tag
if ($existing) { Bad "标签 $tag 已存在 —— 要么改 versionName，要么删掉旧标签"; exit 1 }
Ok "标签 $tag 还没用过"

$remote = git remote
if (-not $remote) { Write-Host '    ⚠️ 还没配 remote（会只做本地提交，不推送）' -ForegroundColor Yellow }

# ---- ③ 回归 ----
if ($SkipTests) {
    Write-Host "`n[3] 跳过回归（-SkipTests）" -ForegroundColor Yellow
} else {
    Step 3 '跑全量回归（tools/run-all.ps1）'
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-all.ps1')
    if ($LASTEXITCODE -ne 0) { Bad '回归没过 —— **不发版**。修完再跑。'; exit 1 }
    Ok '回归全过'
}

# ---- ④ 提交 / 标签 / 推送 ----
Step 4 '提交 + 打标签'
if ($DryRun) {
    Write-Host "    （-DryRun，只列不改）" -ForegroundColor DarkGray
    git status --short | Select-Object -First 15 | ForEach-Object { "      $_" }
    Write-Host "      将要执行: git add -A ; git commit -m `"$tag`: $Message`" ; git tag -a $tag ; git push --follow-tags"
    exit 0
}

git add -A
git commit -q -m "$tag`: $Message"
if ($LASTEXITCODE -ne 0) { Bad '提交失败'; exit 1 }
Ok "已提交：$tag`: $Message"

git tag -a $tag -m "$tag`: $Message"
Ok "已打标签 $tag"

if ($remote) {
    Step 5 '推送'
    git push --follow-tags
    if ($LASTEXITCODE -ne 0) { Bad '推送失败（多半是认证）—— 提交和标签已在本地，认证修好后重跑 git push --follow-tags'; exit 1 }
    Ok '已推送到 GitHub'
} else {
    Write-Host "`n[5] 跳过推送（没配 remote）" -ForegroundColor DarkGray
    Write-Host '    配好之后执行： git remote add origin <你的仓库URL> ; git push --follow-tags'
}

# ---- ⑤ 提醒 ----
Write-Host ''
Write-Host '────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host "别忘了：把 dist\ 下的 APK 传到 GitHub Releases 的 $tag" -ForegroundColor Yellow
Write-Host '        （仓库里不含 APK —— 见 .gitignore 的说明）' -ForegroundColor DarkGray
