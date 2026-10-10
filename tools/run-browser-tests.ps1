<#
  run-browser-tests.ps1 —— 跑全部**浏览器端**测试套件

  ## 为什么单独一个脚本

  这些套件原来散在 %TEMP% 里 —— 系统一清就没了，而且不在版本控制里。
  571 条断言是验证体系的根基，必须跟着仓库走。

  ## 与 run-tests.ps1 的分工

    run-tests.ps1          Kotlin 单测 + 构建守卫（不需要浏览器）
    run-browser-tests.ps1  工具（icarui）的浏览器套件（需要 Edge）

  两者独立：改 Kotlin 只需前者，改工具只需后者。改了两边就都跑。

  用法：
    .\tools\run-browser-tests.ps1                # 跑全部
    .\tools\run-browser-tests.ps1 -Filter font   # 只跑名字含 font 的
    .\tools\run-browser-tests.ps1 -List          # 只列出会跑哪些
#>
param(
    [string]$Filter = "",
    [switch]$List
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root "tools\icarui\tests"

if (-not (Test-Path $dir)) {
    Write-Host "找不到测试目录：$dir" -ForegroundColor Red
    exit 1
}

# 每个套件独立进程 —— 互不影响（一个崩了不影响别的）
$suites = Get-ChildItem $dir -Filter "verify-*.js" | Sort-Object Name
if ($Filter) { $suites = $suites | Where-Object { $_.Name -like "*$Filter*" } }

if ($List) {
    Write-Host "会跑 $($suites.Count) 个套件："
    $suites | ForEach-Object { Write-Host "  $($_.Name)" }
    exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "找不到 node —— 这些套件需要 Node.js" -ForegroundColor Red
    exit 1
}

# 跑之前清一遍测试浏览器的残留（**只清本项目自己的**，不碰用户的浏览器）
$killer = Join-Path $PSScriptRoot "kill-test-browsers.ps1"
if (Test-Path $killer) { & powershell -ExecutionPolicy Bypass -File $killer -Kill 2>&1 | Out-Null }

Write-Host ""
Write-Host "===== 浏览器测试套件（$($suites.Count) 个）=====" -ForegroundColor Cyan

# ⚠️ **内联清理，不要再 spawn 一个 PowerShell**（v2.45.0）。
#
# 原来每个套件都调一次 `& powershell -File kill-test-browsers.ps1 -Kill`，
# 实测**单次 2.9 秒**（PS 5.1 里 `Get-Process` 取不到 CommandLine，
# 只能走 `Get-CimInstance Win32_Process`，而每次都要**新建一个进程去建 CIM 会话**）。
# 22 个套件 × 2.9s ≈ **64 秒**纯浪费。
#
# 内联之后是同一个进程里的连续 CIM 调用 —— 会话复用，只有第一次慢。
#
# 判定条件与 kill-test-browsers.ps1 **完全一致**（那个脚本仍然保留，供手动用）：
#   只看 profile 路径形如 *\Temp\edge-*（用通配匹配，兼容 8.3 短名）
#   用户自己的 Edge 在 ...\Microsoft\Edge\User Data，不含 \Temp\，**一个都不会动**
function Kill-TestBrowsers {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue
        $n = 0
        foreach ($p in $procs) {
            $cl = [string]$p.CommandLine
            $dir = ""
            $m = [regex]::Match($cl, '--user-data-dir=(?:"([^"]+)"|([^\s"]+))')
            if ($m.Success) {
                if ($m.Groups[1].Success) { $dir = $m.Groups[1].Value } else { $dir = $m.Groups[2].Value }
            }
            if ($dir.Length -gt 0 -and $dir -like "*\Temp\edge-*") {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                $n++
            }
        }
        return $n
    } catch { return 0 }
}

$totalPass = 0; $totalFail = 0; $bad = New-Object System.Collections.ArrayList
$sw = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($s in $suites) {
    $out = & node $s.FullName 2>&1
    $retried = $false

    # ⚠️ **套件级重试一次**（v2.26.0）。
    #
    # 为什么需要：这些套件在**单独跑时 6/6 全过**，只在连着跑时偶发
    # "Inspected target navigated or closed"。已经做了三件事——
    #   · 每套件跑完清理 Edge（子进程会继承 --user-data-dir 存活）
    #   · eval 层对瞬时 CDP 错误重试 3 次
    #   · 把固定 sleep 换成就绪轮询
    # 频率从"经常"降到约 1/5，但没根除 —— 剩下的像是 Edge 进程间的
    # 资源竞争，不在我们代码的可控范围内。
    #
    # 所以退一步：失败就**重跑一次**。**但如实标注**（下面的"重试"列），
    # 不假装第一次就过了 —— 否则哪天真的坏了，会被当成"又是偶发"。
    $first = ($out | Select-String -Pattern '^PASS=(\d+)\s+FAIL=(\d+)' | Select-Object -Last 1)
    if ($first -and [int]$first.Matches[0].Groups[2].Value -gt 0) {
        Write-Host "       ↻ 失败，重跑一次…" -ForegroundColor DarkYellow
        [void](Kill-TestBrowsers)
        Start-Sleep -Milliseconds 300
        $out = & node $s.FullName 2>&1
        $retried = $true
    }

    # ⚠️ **跑完立刻清这一个套件的 Edge**（v2.26.0 修偶发失败）。
    #
    # 症状：套件单独跑全过，连着跑偶尔报红，重跑又过。
    #
    # 原因：套件里 `proc.kill()` 只杀**父进程**，而 Edge 会派生一堆
    # gpu/renderer/utility 子进程，它们**继承 `--user-data-dir`** 并继续存活。
    # 下一个套件启动时，这些残留进程还在抢磁盘/内存，偶发拖慢到超时。
    #
    # 原来只在整轮前后各清一次 —— 中间那些残留一直堆着。
    [void](Kill-TestBrowsers)

    # ⚠️ **等残留 Edge 真正清空**，不要用固定延迟（v2.26.0）。
    #
    # 清理脚本是按 `*\Temp\edge-*` **全局**匹配的 —— 它分不清
    # "上一个套件的残留"和"下一个套件刚启动的进程"。
    # 固定 sleep 250ms 的话，如果清理还没跑完、下一个套件已经启动，
    # 就会**把新启动的 Edge 一起杀掉** → 那个套件报
    # "Inspected target navigated or closed"（实测就是这个症状）。
    #
    # 轮询到真的没有残留为止（上限 6 秒，避免卡死）。
    $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw2.Elapsed.TotalSeconds -lt 1) {
        $left = @(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -and $_.CommandLine -like "*\Temp\edge-*"
        })
        if ($left.Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
    }
    # 再给文件锁一点释放时间（Edge 退出后 profile 目录的 lockfile 不会立刻消失）
    Start-Sleep -Milliseconds 80
    $line = ($out | Select-String -Pattern '^PASS=(\d+)\s+FAIL=(\d+)' | Select-Object -Last 1)
    if ($line) {
        $p = [int]$line.Matches[0].Groups[1].Value
        $f = [int]$line.Matches[0].Groups[2].Value
        $totalPass += $p; $totalFail += $f
        $color = if ($f -eq 0) { 'Green' } else { 'Red' }
        Write-Host ("  {0,-26} PASS={1,-4} FAIL={2}{3}" -f $s.BaseName, $p, $f, $(if ($retried) { "  ↻重试过" } else { "" })) -ForegroundColor $color
        if ($f -gt 0) {
            [void]$bad.Add($s.BaseName)
            # 把失败项打出来，省得再去翻
            $out | Select-String -Pattern '❌' | Select-Object -First 5 |
                ForEach-Object { Write-Host "       $($_.Line.Trim())" -ForegroundColor DarkRed }
        }
    } else {
        Write-Host ("  {0,-26} 没拿到结果（脚本崩了？）" -f $s.BaseName) -ForegroundColor Red
        [void]$bad.Add($s.BaseName)
        $out | Select-Object -Last 3 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkRed }
        $totalFail++
    }
}

$sw.Stop()
Write-Host '-----'
Write-Host ("TOTAL PASS={0}  FAIL={1}  用时 {2:N0}s" -f $totalPass, $totalFail, $sw.Elapsed.TotalSeconds)

# 跑完再清一次（套件自己会 proc.kill()，但异常退出时可能留残留）
if (Test-Path $killer) { & powershell -ExecutionPolicy Bypass -File $killer -Kill 2>&1 | Out-Null }

if ($totalFail -gt 0) {
    Write-Host ""
    Write-Host "失败套件：$($bad -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "全部通过 ✅" -ForegroundColor Green
exit 0
