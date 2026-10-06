<#
  run-all.ps1 —— 一条命令跑完全部验证

  ## 为什么要它

  验证分两条线，依赖不同：

    run-tests.ps1          Kotlin 单测 + 构建守卫（**不需要浏览器**）
    run-browser-tests.ps1  工具的浏览器套件（**需要 Edge**）

  分开是对的 —— 改 Kotlin 不用等浏览器，改工具不用编 APK。
  但**发版前要跑全部**，记两条命令容易漏一条。这个脚本就是那个"全部"。

  ## 用法

    .\tools\run-all.ps1              # 两条线都跑
    .\tools\run-all.ps1 -SkipBrowser # 只跑 Kotlin（CI 上没有浏览器时）
    .\tools\run-all.ps1 -SkipKotlin  # 只跑浏览器（改了工具、不想等编译时）
    .\tools\run-all.ps1 -KotlinTimeout 900   # 单独放宽某一步的超时

  ## 为什么每步都有超时（v2.42.0）

  Gradle daemon 偶尔会卡死 —— 实测遇到过**卡 20 分钟没输出**。
  那种情况下脚本不会失败，只是**干等**，看起来像"测试很慢"而不是"卡住了"。

  ## 实现上绕开的两个坑（都实际踩过）

  ### 坑 1：路径里有空格与括号

  本仓库路径是 `D:\AI Dsh\车机项目\iCarOBD2`（2026-10-06 从笔记本交接；旧路径 `D:\AI Dsh\车机项目\iCarOBD` 已删）。
  `Start-Process -ArgumentList @("-File", "`"$path`"")` 会把路径**按空格拆开**，
  子进程拿到 `D:\AI` → 报"没有 .ps1 扩展名" → **根本没跑起来**。

  > ⚠️ 症状很有误导性：`HasExited=True` 但 `ExitCode` 是空 ——
  > 看起来像"取不到退出码"，实际是"进程没起来"。

  **办法**：不把目标路径直接交给 Start-Process，而是**写一个包装脚本到 %TEMP%**
  （那里的路径干净），由包装脚本去引用目标。

  ### 坑 2：Start-Process -PassThru 的 ExitCode 读不出来

  把引号修对之后，子进程**确实跑完了**（打印了"全部通过"），
  但 `$p.ExitCode` **仍然是空** —— 连 `WaitForExit()` 也没用。

  **办法**：**不读 ExitCode**。包装脚本跑完目标后，把 `$LASTEXITCODE`
  **写进一个状态文件**，外层读那个文件。

  ## 卡住时的判断步骤

  超时会明确报出来。如果怀疑是环境问题（而不是测试问题），
  **单独跑那一步** —— 不卡就说明是环境，不是测试。

  ```powershell
  # 先杀 Gradle daemon
  Get-Process java | Where-Object { $_.CommandLine -like "*GradleDaemon*" } | Stop-Process -Force
  ```
#>
param(
    [switch]$SkipBrowser,
    [switch]$SkipKotlin,
    # v2.73.0 修好 Gradle 卡死（`--no-daemon`）之后实测：
    #   Kotlin ~16 秒（冷启 37 秒）、浏览器 ~60 秒。
    # 原来的 420/600 是"Gradle 会卡死"那个时代的产物 —— 真卡住时白等 10 分钟。
    # 240 仍有 4~6 倍余量，真卡死照样报得出来。
    [int]$KotlinTimeout = 240,
    [int]$BrowserTimeout = 240
)

$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$fail = New-Object System.Collections.ArrayList

<#
  跑一步，带超时。返回 $true / $false。**不依赖 $p.ExitCode** —— 见文件头的坑 2。
#>
function Invoke-Step {
    param([string]$Script, [string]$Name, [int]$TimeoutSec)

    $path = Join-Path $PSScriptRoot $Script
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "  ❌ 找不到 $Script" -ForegroundColor Red
        return $false
    }

    $id      = [guid]::NewGuid().ToString('N')
    $wrapper = Join-Path $env:TEMP "icarobd-step-$id.ps1"
    $status  = Join-Path $env:TEMP "icarobd-status-$id.txt"

    # 包装脚本内容用**字符串拼接**写，不用 here-string ——
    # here-string 的结束符必须顶格，在缩进代码里很容易写坏。
    $nl   = [Environment]::NewLine
    $body = "& '" + $path + "'" + $nl +
            "Set-Content -LiteralPath '" + $status + "' -Value `$LASTEXITCODE -Encoding ASCII" + $nl
    [System.IO.File]::WriteAllText($wrapper, $body, (New-Object System.Text.UTF8Encoding($true)))

    try {
        # -NoNewWindow 让子进程输出**直通**当前控制台（不然看不到进度）
        $p = Start-Process -FilePath 'powershell' -NoNewWindow -PassThru `
             -ArgumentList "-ExecutionPolicy Bypass -File `"$wrapper`""

        Wait-Process -Id $p.Id -Timeout $TimeoutSec -ErrorAction SilentlyContinue
        $timedOut = -not $p.HasExited

        if ($timedOut) {
            # 连子进程树一起杀 —— 只杀父的话 Gradle/Edge 会留下来
            try { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null } catch { }
        }

        Start-Sleep -Milliseconds 300

        $code = $null
        if (Test-Path -LiteralPath $status) {
            $raw = Get-Content -LiteralPath $status -Raw -ErrorAction SilentlyContinue
            if ($raw -and $raw.Trim() -match '^-?\d+$') { $code = [int]$raw.Trim() }
        }

        if ($timedOut) {
            Write-Host ""
            Write-Host "  ❌ $Name 超过 $TimeoutSec 秒还没结束，已强制终止。" -ForegroundColor Red
            if ($Name -like '*Kotlin*') {
                Write-Host "     多半是 Gradle daemon 卡死。先杀它再重跑：" -ForegroundColor Yellow
                Write-Host '       Get-Process java | Where-Object { $_.CommandLine -like "*GradleDaemon*" } | Stop-Process -Force' -ForegroundColor DarkGray
            }
            Write-Host "     （判断依据：单独跑这一步是否也卡 —— 不卡就说明是环境问题，不是测试问题）" -ForegroundColor DarkGray
            return $false
        }

        if ($null -eq $code) {
            Write-Host "  ⚠️ $Name 结束了但状态文件没写成，按失败处理。" -ForegroundColor Yellow
            Write-Host "     （这不正常 —— 要么包装脚本被改坏，要么 %TEMP% 不可写）" -ForegroundColor DarkGray
            return $false
        }

        return ($code -eq 0)
    }
    finally {
        Remove-Item -LiteralPath $wrapper, $status -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  iCarOBD 全量验证                            ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan

if (-not $SkipKotlin) {
    Write-Host ""
    Write-Host "──── ① Kotlin 单测 + 构建守卫（超时 ${KotlinTimeout}s）────" -ForegroundColor Cyan
    if (-not (Invoke-Step -Script 'run-tests.ps1' -Name 'Kotlin 单测 / 构建守卫' -TimeoutSec $KotlinTimeout)) {
        [void]$fail.Add('Kotlin 单测 / 构建守卫')
    }
} else {
    Write-Host "（跳过 Kotlin）" -ForegroundColor DarkGray
}

if (-not $SkipBrowser) {
    Write-Host ""
    Write-Host "──── ② 工具浏览器套件（超时 ${BrowserTimeout}s）────" -ForegroundColor Cyan
    if (-not (Invoke-Step -Script 'run-browser-tests.ps1' -Name '浏览器套件' -TimeoutSec $BrowserTimeout)) {
        [void]$fail.Add('浏览器套件')
    }
} else {
    Write-Host "（跳过浏览器）" -ForegroundColor DarkGray
}

$sw.Stop()
Write-Host ""
if ($fail.Count -eq 0) {
    Write-Host ("全部通过 ✅   总用时 {0:N0}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    exit 0
} else {
    Write-Host ("失败：{0}   总用时 {1:N0}s" -f ($fail -join ' / '), $sw.Elapsed.TotalSeconds) -ForegroundColor Red
    exit 1
}
