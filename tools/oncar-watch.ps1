<#
.SYNOPSIS
    iCarOBD 上车实时监控（"窗口 A"）—— 每 2 秒刷一次应用内日志尾部，关键判据行自动上色。

.DESCRIPTION
    对应 docs/上车监控清单.md §3。应用内日志比 logcat 有用得多（含完整 TX/RX），
    所以上车盯的是它，不是 logcat。

    用法：

        . .\tools\oncar-env.ps1             # 先设好 adb 路径（点源）
        .\tools\oncar-watch.ps1             # 默认平板 7e7d7bb4，每 2 秒刷 40 行
        .\tools\oncar-watch.ps1 -Filter     # 只留关键判据行（推荐，车上屏幕小）
        .\tools\oncar-watch.ps1 -Tail 80
        .\tools\oncar-watch.ps1 -Once       # 只取一次快照（写记录表时用）

    退出：Ctrl+C

.NOTES
    ⚠️ AppLog 是 400ms 批量落盘 —— 刚点完按钮立刻读会漏掉最新几行。
    判据行没出现时先等 2~3 秒再看，别急着下结论。
#>
[CmdletBinding()]
param(
    [string]$Serial = '7e7d7bb4',
    [string]$Adb = 'C:\Android\Sdk\platform-tools\adb.exe',
    [int]$Tail = 40,
    [int]$IntervalSec = 2,
    [switch]$Filter,
    [switch]$Once
)

$ErrorActionPreference = 'Continue'
$Pkg = 'com.icar.obd'

if (-not (Test-Path $Adb)) {
    Write-Host "[x] 找不到 adb：$Adb" -ForegroundColor Red
    Write-Host "    先跑： . .\tools\oncar-env.ps1" -ForegroundColor DarkYellow
    exit 2
}

# 判据行（与 docs/上车监控清单.md §4 的判据表一一对应）
$KeyPattern = 'CCCD|ATSH|协议已锁定|协议未锁定|首次拿到数值|轮询汇总|已停止轮询|ECU 拒绝|初始化完成|写入被拒|GATT 表|状态变更|请求无一成功|探测通过但真实 PID 无响应'

function Get-LogLines {
    # 用设备自己的日期，避免笔记本与平板跨零点/时区不一致
    $day = ((& $Adb -s $Serial shell date +%Y%m%d 2>$null) -join '').Trim()
    if ($day -notmatch '^\d{8}$') { $day = Get-Date -Format 'yyyyMMdd' }
    $raw = & $Adb -s $Serial exec-out run-as $Pkg cat "files/log/obd-$day.log" 2>$null
    if (-not $raw) { return @() }
    return @(($raw -join "`n") -split "`r?`n" | Where-Object { $_ -ne '' })
}

function Write-Judged {
    param([string]$Line)
    $color = 'Gray'
    if     ($Line -match 'CCCD 写入完成')            { $color = 'Green' }
    elseif ($Line -match 'CCCD 回调丢失')            { $color = 'Red' }
    elseif ($Line -match '写入被拒|BLE 写入持续失败') { $color = 'Red' }
    elseif ($Line -match '已停止轮询|链路可能不可用')  { $color = 'Yellow' }
    elseif ($Line -match 'ECU 拒绝')                 { $color = 'Yellow' }
    elseif ($Line -match '初始化完成')               { $color = if ($Line -match 'ok=true') { 'Green' } else { 'Yellow' } }
    elseif ($Line -match '协议已锁定')               { $color = 'Green' }
    elseif ($Line -match '轮询汇总')                 { $color = 'Cyan' }
    elseif ($Line -match '首次拿到数值')             { $color = 'Green' }
    Write-Host $Line -ForegroundColor $color
}

$snapshot = 0
while ($true) {
    $snapshot++
    Clear-Host
    Write-Host ("==== {0}  [{1}]  第 {2} 次刷新 ====" -f (Get-Date -Format 'HH:mm:ss'), $Serial, $snapshot) -ForegroundColor Cyan
    if ($Filter) { Write-Host '(只显示关键判据行)' -ForegroundColor DarkGray }

    $lines = Get-LogLines
    if ($lines.Count -eq 0) {
        Write-Host ''
        Write-Host "[!] 读不到 files/log/obd-*.log" -ForegroundColor Yellow
        Write-Host "    可能：App 还没启动过 / 装的是 release 包（run-as 需要 debuggable）/ 设备没连上" -ForegroundColor DarkYellow
    } else {
        Write-Host ("日志 {0} 行，显示末尾 {1} 行" -f $lines.Count, $Tail) -ForegroundColor DarkGray
        Write-Host ''
        $sel = if ($Filter) { @($lines | Select-String -Pattern $KeyPattern | Select-Object -Last $Tail | ForEach-Object { $_.Line }) }
               else        { @($lines | Select-Object -Last $Tail) }
        foreach ($l in $sel) { Write-Judged $l }
    }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSec
}
