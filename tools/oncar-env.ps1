<#
.SYNOPSIS
    iCarOBD 上车环境自检（本机专用）。

.DESCRIPTION
    本机（DSH 笔记本）与 docs/上车监控清单.md 里写的环境有出入，本脚本抹平差异并自检。

      | 项           | 旧文档                                                    | 本机实际                            |
      |--------------|-----------------------------------------------------------|-------------------------------------|
      | JDK          | C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot | C:\Android\jdk21（本机不是管理员）  |
      | Android SDK  | C:\Android\Sdk                                            | 一致（5 个组件已装齐）              |
      | 工程路径     | D:\AI Dsh\车机项目\iCarOBD                                 | C:\Users\大青虫\Desktop\iCarOBD     |
      | 构建路径     | D:\icarobd（ASCII 目录联接）                               | 一致                                |

    ⚠️ **本机 PowerShell 执行策略默认禁止运行 .ps1**（所有 Scope 都是 Undefined
    → 生效策略为 Restricted），所以必须这样调：

        powershell -ExecutionPolicy Bypass -File tools\oncar-env.ps1
        powershell -ExecutionPolicy Bypass -File tools\oncar-env.ps1 -Prep

    **不要**用 `. .\tools\oncar-env.ps1` 点源 —— 本机执行策略会拒绝，报
    「在此系统上禁止运行脚本」。而且 `JAVA_HOME` / `ANDROID_HOME` 已经写进
    **用户级环境变量**，新开的终端会自动带上，本来也不需要点源。

    （已经在开着的终端里 —— 包括当前 DSH 会话 —— 要手动补一句：
     `$env:JAVA_HOME='C:\Android\jdk21'; $env:ANDROID_HOME='C:\Android\Sdk'`）

.PARAMETER Prep
    额外做上车前动作：锁方向（accelerometer_rotation=0）+ 清空 crash 缓冲。

.PARAMETER Serial
    adb 设备序列号，默认 7e7d7bb4（小米平板 5 / elish）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\oncar-env.ps1
    powershell -ExecutionPolicy Bypass -File tools\oncar-env.ps1 -Prep
#>
[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$Prep,
    [string]$Serial = '7e7d7bb4'
)

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- 本机实测路径
$JdkHome = 'C:\Android\jdk21'
$SdkHome = 'C:\Android\Sdk'
$Adb     = Join-Path $SdkHome 'platform-tools\adb.exe'
$Ascii   = 'D:\icarobd'

$script:Problems = 0

function Info { param($m, $c = 'Gray') if (-not $Quiet) { Write-Host $m -ForegroundColor $c } }
function Ok   { param($m) Info "  [ok] $m" 'Green' }
function Warn { param($m) Info "  [!]  $m" 'Yellow' }
function Bad  { param($m) Info "  [x]  $m" 'Red'; $script:Problems++ }

if (-not $Quiet) {
    Write-Host ''
    Write-Host '===== iCarOBD 上车环境 =====' -ForegroundColor Cyan
}

# ------------------------------------------------------------------ 1. 环境变量
# 只影响本进程；持久值在用户级环境变量里（本脚本会核对两者是否一致）
if (Test-Path $JdkHome) { $env:JAVA_HOME = $JdkHome }
else { Bad "找不到 JDK：$JdkHome（编译要用；只看日志可以不管）" }

$env:ANDROID_HOME     = $SdkHome
$env:ANDROID_SDK_ROOT = $SdkHome
$env:ADB              = $Adb

if (Test-Path $JdkHome) {
    $jv = (& "$JdkHome\bin\java.exe" -version 2>&1 | Select-Object -First 1)
    Ok "JAVA_HOME = $JdkHome   ($jv)"
}

$uJdk = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
if ($uJdk -eq $JdkHome) { Ok "用户级 JAVA_HOME 已写入（新开的终端自动带上）" }
else { Warn "用户级 JAVA_HOME 是 '$uJdk'，预期 '$JdkHome' —— 新终端里可能要手动设" }

# ------------------------------------------------------- 2. 中文路径 → ASCII 联接
# 工程路径含中文会让 JVM 启动器解码坏 -cp、NDK 也容易出问题。
# 项目文档的做法就是在 D:\ 下建一个纯 ASCII 的目录联接，工程本身不动。
if (Test-Path $Ascii) {
    Ok "ASCII 联接就绪：$Ascii"
} else {
    Warn "缺少 ASCII 联接 $Ascii —— 编译/单测要先建它："
    Warn "  New-Item -ItemType Junction -Path $Ascii -Target (Resolve-Path .).Path"
}

# ------------------------------------------------------------------ 3. Android SDK
if (-not (Test-Path $Adb)) {
    Bad "找不到 adb：$Adb"
} else {
    Ok "adb = $Adb"
    foreach ($p in @('platform-tools','platforms\android-35','build-tools\35.0.0','ndk\29.0.14206865','cmake\3.31.6')) {
        if (Test-Path (Join-Path $SdkHome $p)) { Ok "SDK 组件 $p" }
        else { Warn "SDK 组件缺失 $p（只在重新编译时需要）" }
    }
}

# --------------------------------------------------------------- 4. 设备与平板
if (Test-Path $Adb) {
    & $Adb start-server 2>&1 | Out-Null
    $devs = @(& $Adb devices 2>&1 | Select-Object -Skip 1 | Where-Object { $_ -match '\S' })
    if ($devs.Count -eq 0) {
        Bad '没有设备连着 —— 平板数据线插好了吗？'
    } else {
        $devs | ForEach-Object { Info "      $_" }
        if (($devs -join "`n") -match [regex]::Escape($Serial)) {
            if (($devs -join "`n") -match "$([regex]::Escape($Serial))\s+unauthorized") {
                Bad "平板 $Serial 是 unauthorized —— 在平板屏幕上点「允许 USB 调试」"
            } else {
                Ok "目标平板 $Serial 在线"
                $pkg = (& $Adb -s $Serial shell dumpsys package com.icar.obd 2>$null | Select-String 'versionName=' | Select-Object -First 1) -join ''
                if ($pkg -match 'versionName=(\S+)') { Ok "已安装版本 $($Matches[1])" }
                else { Warn '这台设备上还没装 com.icar.obd' }
            }
        } else {
            Warn "目标平板 $Serial 不在列表里（列表里可能有模拟器；命令都要带 -s $Serial）"
        }
    }
}

# ------------------------------------------------------------- 5. 上车前动作
if ($Prep) {
    if (-not (Test-Path $Adb)) { Bad '-Prep 需要 adb' }
    else {
        Info ''
        # 锁方向：转屏会让 Fragment 重建、验证链断掉（上车监控清单 §5.2）
        & $Adb -s $Serial shell settings put system accelerometer_rotation 0 2>&1 | Out-Null
        Ok '已锁方向（accelerometer_rotation=0）—— 收车记得改回 1'
        & $Adb -s $Serial logcat -b crash -c 2>&1 | Out-Null
        Ok '已清空 crash 缓冲'
    }
}

if (-not $Quiet) {
    Write-Host ''
    if ($script:Problems -eq 0) { Write-Host '环境就绪。' -ForegroundColor Green }
    else { Write-Host "有 $script:Problems 处要处理（见上面的 [x]）。" -ForegroundColor Yellow }
    Write-Host ''
}

exit $script:Problems
