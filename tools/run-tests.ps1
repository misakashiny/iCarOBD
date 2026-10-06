<#
.SYNOPSIS
    跑 iCarOBD 的 JVM 单元测试（迭代清单 P2-1）。

.DESCRIPTION
    ⚠️ 为什么需要这个脚本，而不是直接 `./gradlew testDebugUnitTest`：

    本工程真实路径含空格与中文（`D:\AI Dsh\车机项目\iCarOBD2`），所以构建一律走 ASCII 联结 `D:\icarobd`。
    AGP 会因此拒绝构建，已用 `android.overridePathCheck=true` 放行；
    但**测试任务仍会失败** —— JVM 启动器用系统 ANSI 代码页解码 `-cp` 参数，
    中文路径被解码坏掉，于是 Gradle 把已经编译好的测试类报成
    `ClassNotFoundException: <测试类自身>`（4 个类全是 initializationError）。

    实测结论（2026-10-02）：
      - 同一份代码放到纯 ASCII 路径 → 全部用例通过；
      - 加 `-Dsun.jnu.encoding=UTF-8`（守护进程与测试 worker 都加）→ **无效**，
        因为 argv 在 `-D` 生效之前就已被启动器解码。

    绕法：建一个 ASCII 目录联接（junction）指向工程真实位置，从联接路径跑 Gradle。
    **工程本身不动**，构建产物也仍写在原目录（联接与目标共用同一份文件）。

    v1.10.1 补充：`ProjectDir` 现在可以省略（从脚本位置推断），
    并修掉了「用**绝对路径**调用本脚本时 `$PSScriptRoot` 为空 → `Split-Path` 报错
    → 一个用例都没跑就退出」的坑。

.PARAMETER Link
    ASCII 联接路径，默认 `D:\icarobd`。

.PARAMETER ProjectDir
    工程真实目录，默认取本脚本所在目录的上一级。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\run-tests.ps1
#>
[CmdletBinding()]
param(
    [string]$Link = 'D:\icarobd',
    [string]$ProjectDir = ''
)

$ErrorActionPreference = 'Continue'

# 工程真实目录 = 本脚本所在目录的上一级。
#
# ⚠️ 不能只依赖 `$PSScriptRoot`：从外部用**绝对路径**调本脚本时它会是空串
# （v1.10.1 实测：`Split-Path : Cannot bind argument to parameter 'Path'
# because it is an empty string`，脚本直接退出，一个用例都没跑）。
# 所以按可靠性依次回退：显式传参 → $PSScriptRoot → $MyInvocation.MyCommand.Path。
if (-not $ProjectDir) {
    $scriptDir = ''
    if ($PSScriptRoot) {
        $scriptDir = $PSScriptRoot
    } elseif ($MyInvocation.MyCommand.Path) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    if ($scriptDir) {
        $ProjectDir = Split-Path -Parent $scriptDir
    }
}

if (-not $ProjectDir -or -not (Test-Path $ProjectDir)) {
    Write-Host "[x] 找不到工程目录：'$ProjectDir'" -ForegroundColor Red
    Write-Host "    请显式指定：-ProjectDir `"D:\AI Dsh\车机项目\iCarOBD2`"" -ForegroundColor Yellow
    exit 2
}

if (-not (Test-Path $Link)) {
    New-Item -ItemType Junction -Path $Link -Target $ProjectDir | Out-Null
    Write-Host "[+] 已创建 ASCII 联接：$Link -> $ProjectDir" -ForegroundColor Green
} else {
    Write-Host "[=] 复用已有联接：$Link" -ForegroundColor DarkGray
}

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = 'C:\Android\Sdk' }

Push-Location $Link
# ⚠️ **必须加 `--no-daemon`**（v2.73.0）。
#
# 为什么：Gradle daemon 会**反复卡死**（实测最长 25 分钟无输出）——
# 而它卡住的后果不是"慢"，是**"这半边验证跑不了"**。
#
# 那个后果我在 v2.62 ~ v2.72 之间真实付过代价：
# 因为 Kotlin 测试跑不了，我只跑浏览器套件，于是 Kotlin 侧的 2 条断言
# **被破坏了 6 个版本都没人发现**（详见 CHANGELOG v2.72.0）。
#
# `--no-daemon` 之后实测 **15 秒**跑完 495 个测试。
# 代价是每次都重新起 JVM（慢几秒），换来的是一致能跑完。
#
# ⚠️ 另外：**必须在 ASCII 路径下跑**（本脚本用 `$Link` 联接）。
# 从含空格 + 中文的原始路径跑，会有 25 个测试报 `initializationError`。
& .\gradlew.bat testDebugUnitTest --no-daemon --console=plain
$code = $LASTEXITCODE
Pop-Location

Write-Host ''
$total = 0; $fail = 0
$resDir = Join-Path $Link 'app\build\test-results\testDebugUnitTest'
if (Test-Path $resDir) {
    Get-ChildItem "$resDir\*.xml" | ForEach-Object {
        $raw = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
        if ($raw -match '<testsuite\s+name="([^"]+)"\s+tests="(\d+)"\s+skipped="(\d+)"\s+failures="(\d+)"\s+errors="(\d+)"') {
            $total += [int]$Matches[2]
            $fail += [int]$Matches[4] + [int]$Matches[5]
            Write-Host ("  {0,-44} tests={1,-3} failures={2,-3} errors={3}" -f $Matches[1], $Matches[2], $Matches[4], $Matches[5])
        }
    }
}
Write-Host '-----'
Write-Host ("TOTAL={0}  FAILED={1}" -f $total, $fail)

# ---- 构建守卫
#
# 接在这里而不是"让人记得手动跑"：abiFilters 失效那个坑**犯过两次**
# （Set-Content -NoNewline 吃掉换行 → APK 从 6.7 MB 涨到 9.4 MB），
# 而两次都是"文档里写了但还是忘"。机器检查必须自动跑才有意义。
Write-Host ''
Write-Host '===== 构建守卫 =====' -ForegroundColor Cyan
$guard = Join-Path $PSScriptRoot 'check-build-guard.ps1'
$guardCode = 0
if (Test-Path $guard) {
    & powershell -ExecutionPolicy Bypass -File $guard
    $guardCode = $LASTEXITCODE
} else {
    Write-Host "  ⚠️  找不到 $guard —— 跳过" -ForegroundColor Yellow
}

if ($guardCode -ne 0) {
    Write-Host ''
    Write-Host '构建守卫失败 —— 单测结果不作数，先修构建配置' -ForegroundColor Red
    exit 1
}

exit $code
