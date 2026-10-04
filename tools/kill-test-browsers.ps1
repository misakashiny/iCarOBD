<#
  kill-test-browsers.ps1 —— 只结束**本项目的无头测试浏览器**

  ## 为什么需要这个脚本（一个真实的教训）

  我（AI）在跑无头浏览器测试前用过这么一条命令来"清缓存"：

      Get-Process msedge | Stop-Process -Force        # 千万别这么写

  它会把**用户自己的 Edge 窗口全部杀掉**。实测那次机器上有 13 个 Edge 进程，
  全部属于用户，我的测试进程是 0 个 —— 那条命令唯一的实际效果就是把用户的
  浏览器干掉，而且反复干掉了好多次。

  两个错：
    1. 杀进程和"清 profile 缓存"根本不是一回事 —— 清缓存应该删目录
    2. Get-Process msedge 会返回所有 Edge 进程（含用户的），
       而 Edge 是多进程架构，杀光就等于关掉所有窗口

  ## 判定条件

  只看一个特征：**profile 路径形如 *\Temp\edge-***（不区分大小写）。

  为什么这样就够：
    - 用户自己的 Edge profile 在 ...\Microsoft\Edge\User Data，不含 \Temp\
    - edge- 前缀是本项目所有测试脚本的命名约定
    - **子进程也必须一起收**：只有主进程带 --headless，
      gpu/renderer/utility 子进程只带 --user-data-dir ——
      只杀主进程会留下一堆孤儿

  ## 两个已经踩过的坑

  1. **不能用 GetTempPath() 去比路径前缀**：它返回长名
     （C:\Users\Administrator\...），而命令行里可能是 8.3 短名
     （C:\Users\ADMINI~1\...）—— StartsWith 会失败，一个都匹配不上。
     用 -like '*\Temp\edge-*' 就没这个问题。
  2. **不能要求 --headless**：子进程没有这个参数。

  用法：
    .\tools\kill-test-browsers.ps1           列出会被杀掉的（默认不动手）
    .\tools\kill-test-browsers.ps1 -Kill     真的杀掉
#>
param([switch]$Kill)

$ErrorActionPreference = 'Stop'

$targets = New-Object System.Collections.ArrayList
$otherCount = 0

$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    $cl = [string]$p.CommandLine
    $dir = ''
    $m = [regex]::Match($cl, '--user-data-dir=(?:"([^"]+)"|([^\s"]+))')
    if ($m.Success) {
        if ($m.Groups[1].Success) { $dir = $m.Groups[1].Value } else { $dir = $m.Groups[2].Value }
    }

    # 关键：用通配匹配而不是 StartsWith —— 兼容 8.3 短名
    $isMine = $false
    if ($dir.Length -gt 0) {
        if ($dir -like '*\Temp\edge-*') { $isMine = $true }
    }

    if ($isMine) {
        $kind = '主进程'
        if ($cl -match '--type=([a-z-]+)') { $kind = $Matches[1] }
        [void]$targets.Add([pscustomobject]@{
            PID     = $p.ProcessId
            Profile = (Split-Path $dir -Leaf)
            Kind    = $kind
        })
    } else {
        $otherCount++
    }
}

Write-Host "无头测试进程（本项目的）: $($targets.Count) 个" -ForegroundColor Cyan
foreach ($t in $targets) {
    Write-Host ("   PID {0,-8} {1,-14} {2}" -f $t.PID, $t.Kind, $t.Profile)
}
Write-Host "其它 Edge 进程（**不动**）: $otherCount 个" -ForegroundColor DarkGray

if ($targets.Count -eq 0) {
    Write-Host "没有需要清理的测试进程。" -ForegroundColor Green
    exit 0
}

if (-not $Kill) {
    Write-Host ""
    Write-Host "以上是会被杀掉的进程（当前是列出模式，没有动手）。" -ForegroundColor Yellow
    Write-Host "要真的清理：  .\tools\kill-test-browsers.ps1 -Kill" -ForegroundColor Yellow
    exit 0
}

$killed = 0
foreach ($t in $targets) {
    # 先确认还活着：杀掉主进程后子进程往往已经随之退出，
    # 直接 Stop-Process 会报 "Cannot find a process"，那是噪音不是失败
    if (-not (Get-Process -Id $t.PID -ErrorAction SilentlyContinue)) { continue }
    try {
        Stop-Process -Id $t.PID -Force -ErrorAction Stop
        $killed++
    } catch {
        Write-Host "   PID $($t.PID) 结束失败：$($_.Exception.Message)" -ForegroundColor Red
    }
}
Write-Host "已结束 $killed 个测试进程（其余 $($targets.Count - $killed) 个已随主进程退出）。用户自己的 Edge 进程一个都没动。" -ForegroundColor Green