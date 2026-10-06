<#
.SYNOPSIS
    iCarOBD 实车日志速读 —— 一条命令把要看的东西全打出来（不必再人工念 TX/RX）。

.DESCRIPTION
    上车时直接跑：

        powershell -ExecutionPolicy Bypass -File tools\oncar-digest.ps1

    默认打五段：判据 / 扫描器 / PID 测试 / 轮询趋势 / 崩溃。只想看一段就加开关：

        -Key     判据行（CCCD、初始化、协议锁定、写入被拒、超时）
        -Scan    扫描器会话（位图块、supported、命中清单）
        -Tests   PID 测试请求（TX / RX / ok）
        -Poll    轮询汇总趋势（有值 N/M）
        -Crash   崩溃 / ANR / 进程被杀
        -Tail    日志末尾 N 行（-N，默认 30）
        -Save    另存一份日志到 stage\oncar-evidence\

    ⚠️ **数据来源全部是应用日志**。`BleTransport.onRawBytes` 与 `ElmSession.request`
    把每条 TX/RX 都写到 V 级；如果 `AppLog.minLevel` 被调高，TX/RX 就不再落盘，
    这个脚本会看不到东西 —— 所以**别把日志级别调高于 V**。

.NOTES
    与 `oncar-check.ps1` 的分工：那个是"上车后一次性取证 + 按 GATT 表下判定"，
    这个**偏"随时快速看一眼"**，输出短、可反复跑、按视角切片。
#>
[CmdletBinding()]
param(
    [string]$Serial = '7e7d7bb4',
    [string]$Adb = 'C:\Android\Sdk\platform-tools\adb.exe',
    [switch]$Key,
    [switch]$Scan,
    [switch]$Tests,
    [switch]$Poll,
    [switch]$Crash,
    [switch]$Tail,
    [int]$N = 30,
    [switch]$Save
)

$ErrorActionPreference = 'Continue'
$Pkg = 'com.icar.obd'

if (-not (Test-Path $Adb)) { Write-Host "[x] 找不到 adb：$Adb" -ForegroundColor Red; exit 2 }

# 没指定任何段 = 全打
$all = -not ($Key -or $Scan -or $Tests -or $Poll -or $Crash -or $Tail)
if ($all) { $Key = $Scan = $Tests = $Poll = $Crash = $true }

function Section([string]$t, [string]$c = 'Cyan') {
    Write-Host ''
    Write-Host ('=' * 66) -ForegroundColor DarkCyan
    Write-Host "  $t" -ForegroundColor $c
    Write-Host ('=' * 66) -ForegroundColor DarkCyan
}

# ---------------------------------------------------------------- 设备与版本
Section '0. 设备'
$dev = (& $Adb devices 2>&1) -join "`n"
if ($dev -notmatch [regex]::Escape($Serial)) {
    Write-Host "[x] 未找到设备 $Serial。当前：" -ForegroundColor Red
    $dev | ForEach-Object { Write-Host "    $_" }
    exit 2
}
Write-Host ("  设备 {0}   设备时间 {1}" -f $Serial,
    (((& $Adb -s $Serial shell date '+%H:%M:%S' 2>&1) -join '').Trim())) -ForegroundColor Green
Write-Host ("  App pid  {0}" -f (((& $Adb -s $Serial shell pidof $Pkg 2>&1) -join '').Trim()))

$day = (((& $Adb -s $Serial shell date +%Y%m%d 2>&1) -join '').Trim())
$raw = & $Adb -s $Serial exec-out run-as $Pkg cat "files/log/obd-$day.log" 2>$null
if (-not $raw) { Write-Host "[x] 取不到 files/log/obd-$day.log（App 没启动过？装的是 release 包？）" -ForegroundColor Red; exit 3 }
$lines = @(($raw -join "`n") -split "`r?`n")
Write-Host ("  日志 obd-{0}.log  {1} 行" -f $day, $lines.Count) -ForegroundColor Green

$boot = ($lines | Select-String 'iCar OBD 启动' | Select-Object -Last 1)
if ($boot) { Write-Host ("  最近一次启动  {0}" -f $boot.Line) -ForegroundColor Green }

if ($Save) {
    $out = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'stage\oncar-evidence') "digest-obd-$day.log"
    New-Item -ItemType Directory -Path (Split-Path $out -Parent) -Force | Out-Null
    [System.IO.File]::WriteAllLines($out, $lines, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "  已另存：$out" -ForegroundColor DarkGray
}

# ------------------------------------------------------------------ 1. 判据
if ($Key) {
    Section '1. 判据行'
    $pat = 'CCCD 写入完成|CCCD 回调丢失|选定特征|GATT 表开始|初始化完成 \||协议已锁定|协议未锁定|写入被拒|已停止轮询|链路可能不可用'
    $hit = @($lines | Select-String $pat)
    if ($hit.Count -eq 0) { Write-Host '  （一条都没有）' -ForegroundColor Yellow }
    else { $hit | Select-Object -Last 12 | ForEach-Object { Write-Host "  $($_.Line)" } }

    $to = @($lines | Select-String '超时无响应')
    Write-Host ''
    Write-Host ("  超时无响应：{0} 条" -f $to.Count) -ForegroundColor $(if ($to.Count -eq 0) { 'Green' } else { 'Yellow' })
    if ($to.Count -gt 0) { $to | Select-Object -First 3 | ForEach-Object { Write-Host "    首 $($_.Line)" } }
}

# ------------------------------------------------------------------ 2. 扫描器
if ($Scan) {
    Section '2. 扫描器会话'
    $idx = @()
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '\[SCAN\].*开始扫描') { $idx += $i } }
    if ($idx.Count -eq 0) { Write-Host '  （没有扫描记录）' -ForegroundColor Yellow }
    foreach ($s in $idx) {
        # 位图块日志在「开始扫描」之前
        $b = $s - 1
        while ($b -ge 0 -and $lines[$b] -notmatch '\[SCAN\]') { $b-- }
        Write-Host ''
        Write-Host '  --- 一次扫描 ---' -ForegroundColor White
        $j = [Math]::Max(0, $s - 12)
        while ($j -le $s) { if ($lines[$j] -match '\[SCAN\]') { Write-Host "  $($lines[$j])" -ForegroundColor DarkGray }; $j++ }
        $e = $s
        while ($e -lt $lines.Count -and $lines[$e] -notmatch '\[SCAN\].*扫描结束') { $e++ }
        $pids = @()
        for ($k = $s; $k -le [Math]::Min($e, $lines.Count - 1); $k++) {
            if ($lines[$k] -match '命中 \| req=\S+ ([0-9A-F]{2})') { $pids += $Matches[1] }
        }
        if ($e -lt $lines.Count) { Write-Host "  $($lines[$e])" -ForegroundColor Green }
        Write-Host ("  命中 {0} 条: {1}" -f $pids.Count, ($pids -join ' ')) -ForegroundColor Cyan
    }
}

# --------------------------------------------------------------- 3. PID 测试
if ($Tests) {
    Section '3. PID 测试请求（手动「发送测试请求」的）'
    $t = @($lines | Select-String 'PID 测试 \|')
    if ($t.Count -eq 0) { Write-Host '  （没有）' -ForegroundColor Yellow }
    else { $t | Select-Object -Last $N | ForEach-Object { Write-Host "  $($_.Line)" } }
}

# ------------------------------------------------------------------ 4. 轮询
if ($Poll) {
    Section '4. 轮询趋势'
    $p = @($lines | Select-String '轮询汇总')
    if ($p.Count -eq 0) { Write-Host '  （还没有轮询汇总）' -ForegroundColor Yellow }
    else {
        $p | Select-Object -Last 12 | ForEach-Object {
            if ($_.Line -match '^\[([\d:.]+)\].*有值 (\d+)/(\d+)') {
                Write-Host ("  {0}   有值 {1}/{2}" -f $Matches[1], $Matches[2], $Matches[3])
            } else { Write-Host "  $($_.Line)" }
        }
        Write-Host ''
        Write-Host ("  「首次拿到数值」共 {0} 条" -f @($lines | Select-String '首次拿到数值').Count)
        $cold = @($lines | Select-String '连续失败进入冷却')
        if ($cold.Count -gt 0) {
            Write-Host '  一直拿不到值的 PID：' -ForegroundColor Yellow
            $cold | ForEach-Object { if ($_.Line -match 'id=(\S+) name=(\S+)') { "$($Matches[1])/$($Matches[2])" } } |
                Sort-Object -Unique | ForEach-Object { Write-Host "    $_" }
        }
    }
}

# ------------------------------------------------------------------ 5. 崩溃
if ($Crash) {
    Section '5. 崩溃 / ANR'
    $c = @(& $Adb -s $Serial logcat -d -b crash 2>&1 | Where-Object { $_ -match 'icar' })
    if ($c.Count -eq 0) { Write-Host '  [ok] crash buffer 空' -ForegroundColor Green }
    else { $c | Select-Object -First 25 | ForEach-Object { Write-Host "  $_" } }
    Write-Host ''
    $anr = @(& $Adb -s $Serial logcat -d -b events 2>&1 | Select-String 'am_anr|am_kill.*icar|am_proc_died.*icar')
    if ($anr.Count -eq 0) { Write-Host '  [ok] 没有 ANR / 被杀记录' -ForegroundColor Green }
    else { $anr | Select-Object -Last 8 | ForEach-Object { Write-Host "  $($_.Line)" } }
}

# ------------------------------------------------------------------ 6. 末尾
if ($Tail) {
    Section "6. 日志末尾 $N 行"
    $lines | Select-Object -Last $N | ForEach-Object { Write-Host "  $_" }
}

Write-Host ''

exit 0
