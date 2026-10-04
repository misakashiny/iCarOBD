<#
.SYNOPSIS
    iCarOBD 实车验证取证脚本 —— 对应 迭代清单.md 的 P0-1 ~ P0-4。

.DESCRIPTION
    上车后（适配器插 OBD 口、点火开关拧到 ON、平板已装 v1.4.0+）运行本脚本。
    它把「下一步该做什么」所需的证据一次性收齐：

      0. 设备与 App 版本
      1. 崩溃 / ANR（编译通过 ≠ 能运行）
      2. 拉取应用内日志（比 logcat 有用得多，含完整 TX/RX）
      3. 关键证据：GATT 表 / AT 命令与超时 / 初始化结果 / 轮询与规则 / 扫描器
      4. 依据 GATT 表给出判定与下一步

    判定原则沿用项目文档：**判据必须落到可观测的事实上**，
    不要凭「没崩」就认为通过。

    ⚠️ 读日志前请确保最后一次操作已过去 2~3 秒：AppLog 是 **400ms 批量落盘**，
    刚点完按钮立刻读会漏掉最新几行（本机实测踩过，一度误判成「没记日志」）。

.PARAMETER Serial
    adb 设备序列号，默认 7e7d7bb4（小米平板 5）。用 `adb devices` 查。

.PARAMETER Save
    额外把取证报告写到 tools/oncar-report-<时间戳>.txt（便于直接发给下一个接手者）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\oncar-check.ps1
    powershell -ExecutionPolicy Bypass -File tools\oncar-check.ps1 -Serial 7e7d7bb4 -Save
#>
[CmdletBinding()]
param(
    [string]$Serial = '7e7d7bb4',
    [string]$Adb = 'C:\Android\Sdk\platform-tools\adb.exe',
    [switch]$Save,
    [int]$MaxTxLines = 40
)

$ErrorActionPreference = 'Continue'
$Pkg = 'com.icar.obd'
$script:Report = New-Object System.Collections.Generic.List[string]

function Say {
    param([string]$Text, [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
    $script:Report.Add($Text)
}
function Head {
    param([string]$T)
    Say ''
    Say ('=' * 70) 'DarkCyan'
    Say "  $T" 'Cyan'
    Say ('=' * 70) 'DarkCyan'
}
function Sub { param([string]$T) Say ''; Say "-- $T" 'White' }

function FirstMatchIndex {
    param([string[]]$Lines, [string]$Pattern)
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match $Pattern) { return $i }
    }
    return -1
}

# ------------------------------------------------------------------ 0. 设备
Head '0. 设备'
if (-not (Test-Path $Adb)) {
    Say "[x] 找不到 adb：$Adb" 'Red'
    exit 2
}
& $Adb start-server 2>&1 | Out-Null
$devOut = & $Adb devices 2>&1
if (-not ($devOut -match [regex]::Escape($Serial))) {
    Say "[x] 未找到设备 $Serial。当前已连接：" 'Red'
    $devOut | ForEach-Object { Say "    $_" }
    exit 2
}
$model = ((& $Adb -s $Serial shell getprop ro.product.model 2>$null) -join '').Trim()
$rel = ((& $Adb -s $Serial shell getprop ro.build.version.release 2>$null) -join '').Trim()
$sdk = ((& $Adb -s $Serial shell getprop ro.build.version.sdk 2>$null) -join '').Trim()
Say ("  设备 {0}：{1}  Android {2} (SDK {3})" -f $Serial, $model, $rel, $sdk) 'Green'

# ------------------------------------------------------------ 1. 安装状态
Head '1. App 安装状态'
$pkgDump = & $Adb -s $Serial shell dumpsys package $Pkg 2>$null
if (-not $pkgDump) {
    Say "[x] 未安装 $Pkg" 'Red'
    Say '    装机：adb install -r -d dist/iCarOBD-debug-v1.4.0.apk' 'DarkYellow'
    exit 2
}
$verName = 'unknown'
if (($pkgDump -join "`n") -match 'versionName=([^\s]+)') { $verName = $Matches[1] }
Say "  已安装 $Pkg  versionName=$verName" 'Green'
if ($verName -notmatch '^1\.(3\.[1-9]|[4-9]\.)') {
    Say "  [!] 预期 >= 1.3.1（含 BLE 写入修复、GATT 表转储、公式引擎修复），当前是 $verName" 'Yellow'
}

# ------------------------------------------------------------ 2. 崩溃与 ANR
Head '2. 崩溃与 ANR（编译通过 ≠ 能运行）'
$crash = @(& $Adb -s $Serial logcat -d -b crash 2>$null | Where-Object { $_ -and $_.Trim() -ne '' })
if ($crash.Count -gt 0) {
    Say "[!] crash buffer 非空（$($crash.Count) 行）—— 先解决它，其它结论都不可信" 'Red'
    $crash | Select-Object -Last 40 | ForEach-Object { Say "    $_" 'DarkYellow' }
} else {
    Say '  [ok] crash buffer 为空' 'Green'
}
$anr = @(& $Adb -s $Serial logcat -d -b main -t 4000 2>$null | Select-String -Pattern 'ANR in')
if ($anr.Count -gt 0) {
    Say "[!] 近 4000 行主日志里检测到 ANR：$($anr.Count) 条" 'Red'
    $anr | Select-Object -First 5 | ForEach-Object { Say "    $_" 'DarkYellow' }
} else {
    Say '  [ok] 近 4000 行主日志无 ANR' 'Green'
}

# ------------------------------------------------------------ 3. 拉取日志
Head '3. 拉取应用内日志'
$listing = @(& $Adb -s $Serial shell run-as $Pkg ls files/log 2>$null |
    ForEach-Object { $_.Trim() } | Where-Object { $_ })
$logs = @($listing | Where-Object { $_ -match '^obd-\d{8}\.log$' } | Sort-Object)
if ($logs.Count -eq 0) {
    Say '[x] 取不到 files/log/obd-*.log' 'Red'
    Say '    可能原因：装的是 release 包（run-as 需要 debuggable），或 App 还没启动过。' 'DarkYellow'
    exit 3
}
Say "  可用：$($logs -join ', ')"
$newest = $logs[-1]
Say "  取最新：$newest" 'Green'

$prevEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$raw = & $Adb -s $Serial exec-out run-as $Pkg cat "files/log/$newest" 2>$null
try { [Console]::OutputEncoding = $prevEnc } catch { }
$lines = @(($raw -join "`n") -split "`r?`n")
Say "  日志行数：$($lines.Count)"

# ------------------------------------------------------------ 4. 关键证据
Head '4. 关键证据'
$writableProps = @()

Sub '4.1 GATT 表（P0-1 —— 整条链路的咽喉）'
$i0 = FirstMatchIndex $lines 'GATT 表开始'
$i1 = FirstMatchIndex $lines 'GATT 表结束'
if ($i0 -ge 0 -and $i1 -gt $i0) {
    $gatt = $lines[$i0..$i1]
    $gatt | ForEach-Object { Say "    $_" }
    foreach ($l in @($gatt | Where-Object { $_ -match 'CHR ' })) {
        if ($l -match 'props=(\S+)') { $writableProps += $Matches[1] }
    }
    $w = @($writableProps | Where-Object { $_ -match 'W' })
    if ($w.Count -gt 0) {
        Say "  [ok] 找到 $($w.Count) 个可写特征：$($w -join ', ')" 'Green'
        if (@($w | Where-Object { $_ -match 'Wn' }).Count -gt 0) {
            Say '       含 Wn（write-without-response）→ v1.3.0 的写类型自适应应已生效，看 4.2' 'Green'
        } else {
            Say '       只有 W（write-with-response）→ 若仍超时，查日志里的 writeTypeUsed' 'Yellow'
        }
    } else {
        Say '  [x] 整张表没有任何可写特征 → 该适配器可能不是 BLE 透传' 'Red'
    }
} else {
    Say '  [x] 日志里没有 GATT 表 —— 说明还没连接过适配器（连接成功后会自动转储）' 'Yellow'
}

Sub '4.2 AT 命令与响应（P0-2）'
# 必须锚定 [OBD] 模块：SYS 模块另有一条「初始化完成，等待 UI 拉起前台服务」，
# 那是 App 级初始化、不是 ELM327 初始化 —— 松散匹配会把「没点初始化」误报成「初始化通过」。
$tx = @($lines | Where-Object { $_ -match '\]\[OBD\]\[\w\] TX \|' })
$rx = @($lines | Where-Object { $_ -match '\]\[OBD\]\[\w\] RX \|' })
$touts = @($lines | Where-Object { $_ -match '\]\[OBD\]\[\w\] 超时无响应 \|' })
$rxColor = if ($rx.Count -gt 0) { 'Green' } else { 'Red' }
Say ("  TX={0}   RX={1}   超时无响应={2}" -f $tx.Count, $rx.Count, $touts.Count) $rxColor
if ($tx.Count -gt 0) {
    Say '  --- TX（前若干条）---'
    $tx | Select-Object -First $MaxTxLines | ForEach-Object { Say "    $_" }
}
if ($rx.Count -gt 0) {
    Say '  --- RX（前若干条）---'
    $rx | Select-Object -First $MaxTxLines | ForEach-Object { Say "    $_" }
}
$init = @($lines | Where-Object { $_ -match '\]\[OBD\]\[\w\] 初始化完成 \|' })
if ($init.Count -gt 0) {
    $okLine = @($init | Where-Object { $_ -match 'ok=true' })
    if ($okLine.Count -gt 0) { Say "  [ok] 初始化通过：$($okLine[-1])" 'Green' }
    else { Say "  [x] 初始化未通过：$($init[-1])" 'Red' }
} else {
    Say '  [!] 日志里没有「初始化完成」—— 可能还没点「初始化 ELM327」' 'Yellow'
}

Sub '4.3 真实数值与轮询（P0-3）'
$cooldown = @($lines | Where-Object { $_ -match '冷却' })
$trig = @($lines | Where-Object { $_ -match '规则触发' })
$dataLines = @($lines | Where-Object { $_ -match '\[DATA\]' })
Say ("  PID 进入冷却行数={0}   规则触发行数={1}   DATA 模块行数={2}" -f
    $cooldown.Count, $trig.Count, $dataLines.Count)
if ($trig.Count -gt 0) {
    $trig | Select-Object -First 10 | ForEach-Object { Say "    $_" 'Green' }
}

Sub '4.4 扫描器（P0-4）'
$scan = @($lines | Where-Object { $_ -match '\[SCAN\]' })
Say "  SCAN 模块日志行数=$($scan.Count)"
$scan | Select-Object -Last 25 | ForEach-Object { Say "    $_" }

# ------------------------------------------------------------ 5. 判定
Head '5. 判定与下一步'
if ($crash.Count -gt 0) {
    Say '  [!] 先解决崩溃，其它结论都不可信。' 'Red'
} elseif ($i0 -lt 0) {
    Say '  → 还没连上适配器：到「连接」页扫描并连接，等「已就绪」后重跑本脚本。' 'Yellow'
} elseif (@($writableProps | Where-Object { $_ -match 'W' }).Count -eq 0) {
    Say '  → GATT 表里没有任何可写特征：该适配器不是 BLE 透传，走 P1-1 实现 SppTransport。' 'Red'
} elseif ($touts.Count -gt 0 -and $rx.Count -eq 0) {
    Say '  → 有可写特征但一个字节都收不到：把 4.1 的 GATT 表整段导出，' 'Red'
    Say '     据此确定正确的特征与写类型（这正是 v1.3.0 要复验的点）。' 'Red'
} elseif ($init.Count -eq 0) {
    Say '  → 写入路径看起来通了：回 App 点「初始化 ELM327」，再重跑本脚本。' 'Yellow'
} else {
    Say '  → 数据链路已通：继续 P0-3（仪表真实数值）与 P0-4（扫描器命中 > 0）。' 'Green'
}
Say ''
Say '  提醒：霓虹主题的辉光效果（glow）只在有真实数值时绘制，一直没目视验证过 —— 顺带看一眼。' 'DarkGray'

if ($Save) {
    $out = Join-Path $PSScriptRoot ("oncar-report-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $script:Report | Set-Content -Path $out -Encoding UTF8
    Write-Host ''
    Write-Host "报告已写入：$out" -ForegroundColor Green
}
