<#
  check-build-guard.ps1 —— 构建守卫

  ## 为什么需要它

  同一个错误**犯了两次**：
    v1.10.4  用 `Set-Content` 改 build.gradle.kts → 换行被吃掉 → abiFilters 失效 → 4 个 ABI 全编
    v1.11.0  又犯一次，APK 从 6.72 MB 涨到 9.44 MB

  「把教训记在 CHANGELOG 里」不够 —— 记了两次还是犯。所以要**机器检查**。

  ## 检查什么

  1. `build.gradle.kts` 里 `abiFilters` 还在（且没被注释掉）
  2. 版本号与 APK 文件名一致
  3. 构建产物里 `lib/` 只有**一个** ABI
  4. APK 体积没暴涨（超过阈值就报警 —— 多 ABI 是最常见原因）
  5. 源码文件没有丢 UTF-8 BOM（.ps1）或行数骤降（可能被 Set-Content 破坏）

  跑法：
    .\tools\check-build-guard.ps1                 # 检查已构建的 APK
    .\tools\check-build-guard.ps1 -Apk <路径>      # 指定 APK
#>
param(
    [string]$Apk = "",
    [int]$MaxMb = 8
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$fails = New-Object System.Collections.ArrayList
$warns = New-Object System.Collections.ArrayList

function Fail($m) { [void]$fails.Add($m); Write-Host "  ❌ $m" -ForegroundColor Red }
function Warn($m) { [void]$warns.Add($m); Write-Host "  ⚠️  $m" -ForegroundColor Yellow }
function Pass($m) { Write-Host "  ✅ $m" -ForegroundColor Green }

Write-Host "`n=== 1. build.gradle.kts ===" -ForegroundColor Cyan
$gradle = Join-Path $root "app\build.gradle.kts"
if (-not (Test-Path $gradle)) { Fail "找不到 $gradle" }
else {
    $txt = [System.IO.File]::ReadAllText($gradle)

    # abiFilters 必须存在且**没被注释掉**
    $line = ($txt -split "`n") | Where-Object { $_ -match 'abiFilters' } | Select-Object -First 1
    if (-not $line) { Fail "build.gradle.kts 里没有 abiFilters —— 会把所有 ABI 都编进去" }
    elseif ($line.TrimStart().StartsWith("//")) { Fail "abiFilters 被注释掉了：$($line.Trim())" }
    else { Pass "abiFilters 存在：$($line.Trim())" }

    # 换行数量（Set-Content -NoNewline 会把它们吃掉）
    $n = ($txt -split "`n").Count
    if ($n -lt 40) { Fail "build.gradle.kts 只有 $n 行 —— 像是被 Set-Content -NoNewline 破坏了" }
    else { Pass "build.gradle.kts $n 行（正常）" }

    $ver = [regex]::Match($txt, 'versionName\s*=\s*"([^"]+)"')
    $code = [regex]::Match($txt, 'versionCode\s*=\s*(\d+)')
    if ($ver.Success) { Pass "versionName = $($ver.Groups[1].Value)" + $(if ($code.Success) { "  versionCode = $($code.Groups[1].Value)" }) }
    else { Warn "读不到 versionName" }
}

Write-Host "`n=== 2. APK 产物 ===" -ForegroundColor Cyan
if (-not $Apk) {
    $cand = Join-Path $root "dist"
    if (Test-Path $cand) {
        $Apk = (Get-ChildItem $cand -Filter *.apk | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    }
    if (-not $Apk) { $Apk = Join-Path $root "app\build\outputs\apk\debug\app-debug.apk" }
}
if (-not (Test-Path $Apk)) {
    Warn "找不到 APK（$Apk）—— 跳过产物检查"
} else {
    $sizeMb = [math]::Round((Get-Item $Apk).Length / 1MB, 2)
    $name = Split-Path $Apk -Leaf
    Pass "APK: $name  $sizeMb MB"
    if ($sizeMb -gt $MaxMb) {
        Fail "APK $sizeMb MB 超过阈值 $MaxMb MB —— 最常见原因是**多编了 ABI**（LVGL 有 192 个 .c 文件）"
    } else {
        Pass "体积在阈值内（≤ $MaxMb MB）"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
    try {
        # ⚠️ 不要用 `($_.FullName -split '/')[1]` —— 实测被当成**字符串索引**，
        # 结果是 "a" 而不是 "arm64-v8a"。正则捕获稳。
        # ⚠️ 必须用 @() 包住：PowerShell 会把**单元素管道结果解包成字符串**，
        # 那样 $abis 是 "arm64-v8a" 而不是数组，$abis[0] 就成了第一个字符 "a"
        # （实测踩到：守卫自己报"只编了一个 ABI：a"）。
        $abis = @($zip.Entries | Where-Object { $_.FullName -like "lib/*/*.so" } |
            ForEach-Object { if ($_.FullName -match '^lib/([^/]+)/') { $Matches[1] } } |
            Where-Object { $_ } | Sort-Object -Unique)
        if ($abis.Count -eq 0) { Warn "APK 里没有 .so —— 原生库没打进去？" }
        elseif ($abis.Count -eq 1) { Pass "只编了一个 ABI：$($abis[0])" }
        else { Fail "编了 $($abis.Count) 个 ABI：$($abis -join ', ') —— abiFilters 没生效" }
    } finally { $zip.Dispose() }

    # 文件名里的版本要和 gradle 一致
    if ($ver.Success -and $name -match 'v([\d.]+)') {
        if ($Matches[1] -ne $ver.Groups[1].Value) {
            Warn "APK 文件名写的是 v$($Matches[1])，而 gradle 是 $($ver.Groups[1].Value)"
        } else { Pass "APK 文件名版本与 gradle 一致" }
    }
}

Write-Host "`n=== 3. 源码文件完整性 ===" -ForegroundColor Cyan
# .ps1 带中文必须有 UTF-8 BOM，否则 PowerShell 5.1 按 GBK 解码 → 假语法错误
$psFiles = Get-ChildItem (Join-Path $root "tools") -Filter *.ps1 -Recurse
foreach ($f in $psFiles) {
    $b = [System.IO.File]::ReadAllBytes($f.FullName)
    $hasBom = $b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF
    $hasCjk = $false
    try { $hasCjk = ([System.IO.File]::ReadAllText($f.FullName) -match '[\u4e00-\u9fff]') } catch {}
    if ($hasCjk -and -not $hasBom) { Fail "$($f.Name) 含中文但没有 UTF-8 BOM —— PowerShell 5.1 会按 GBK 解码报假语法错误" }
}
# ---- canvas.js 里的裸色值（v2.59.0）
#
# 为什么：工具的界面配色分两层（大纲 §2.66）：
#   · **设计内容层**（仪表弧、刻度、指针、文字、画布底色）→ 要跟设计主题走
#   · **工具 UI 层**（选中框、手柄、序号、框选、参考线）→ 固定色，**不该跟主题**
#
# 所以"canvas.js 里有裸色值"本身不是错，**落在哪一层**才是关键。
#
# ⚠️ **过滤逻辑在探针那一侧（Node），不在这里。**
# 试过在 PowerShell 里 Where-Object 过滤，踩了两个坑：
#   1. 嵌套 Where-Object 里的 $_ 会**遮蔽**外层的 $_
#   2. PS 5.1 的 ConvertFrom-Json 对顶层数组有怪癖 ——
#      实测"15 条被当成 1 条"（.fn 变成了数组）
# 所以这里只做一件事：**看探针最后一行是不是 []**。
#
$colorProbe = Join-Path $PSScriptRoot "guard-color-probe.js"
if (Test-Path $colorProbe) {
  $colorOut = & node $colorProbe 2>$null
  $colorSummary = ($colorOut | Select-Object -First 1)
  $colorLast = ($colorOut | Select-Object -Last 1)
  if ($colorLast -eq "[]") {
    Pass "canvas.js 裸色值都在白名单里（$colorSummary）"
  } elseif ($colorLast) {
    Fail "canvas.js 有裸色值不在白名单：$colorLast"
  } else {
    Write-Host "  (跳过裸色值检查 —— 探针没输出)" -ForegroundColor DarkGray
  }
} else {
  Write-Host "  (跳过裸色值检查 —— 找不到 guard-color-probe.js)" -ForegroundColor DarkGray
}

# ---- 控件绑的 PID 是否真实存在（v2.61.0）
#
# 为什么：所有仪表控件的 make() 都是
#   const info = window.BUILTIN_PIDS[window.resolvePid(d.pid)] || {};
#   min: info.min !== undefined ? info.min : 0,
#   max: info.max !== undefined ? info.max : 100,
# **查不到就用 0~100 兜底** —— 没有报错、没有警告，
# 控件能加能拖能显示，只是**语义完全不对**。
#
# 实测（v2.61.0 首次跑）：40 个绑 PID 的控件里 **28 个绑的是不存在的 PID**。
# 用户的第 ① 项（G力值 → obd.gforce）和第 ③ 项（挡位 → obd.gear）
# **都是这个根因**。
#
# ⚠️ **当前按"警告"处理，不 Fail** —— 28 处是存量债务，
# 一上来就 Fail 会让守卫长期是红的，反而没人看。
# 等把这 28 个补完（或确认该删）之后，改成 Fail。
#
$pidProbe = Join-Path $PSScriptRoot "guard-pid-probe.js"
if (Test-Path $pidProbe) {
  $pidOut = & node $pidProbe 2>$null
  $pidSummary = ($pidOut | Select-Object -First 1)
  $pidLast = ($pidOut | Select-Object -Last 1)
  if ($pidLast -eq "[]") {
    Pass "控件绑的 PID 都存在（$pidSummary）"
  } elseif ($pidLast) {
    Warn "控件绑了不存在的 PID —— $pidSummary"
  } else {
    Write-Host "  (跳过 PID 检查 —— 探针没输出)" -ForegroundColor DarkGray
  }
} else {
  Write-Host "  (跳过 PID 检查 —— 找不到 guard-pid-probe.js)" -ForegroundColor DarkGray
}

if ($fails.Count -eq 0) { Pass "$($psFiles.Count) 个 .ps1 文件编码都正常" }

Write-Host "`n=== 4. 素材引用完整性 ===" -ForegroundColor Cyan
# 控件模板与内置素材清单里引用的每个 assets/ 路径都必须**真实存在**。
#
# 为什么值得检查：path 打错字不会报错 —— 拖出来只是一个紫框大 X，
# 而用户根本不会想到是"文件名拼错了"。这类问题靠人眼审不出来。
$studio = Join-Path $root "tools\theme-studio"
if (-not (Test-Path $studio)) {
    Warn "找不到 $studio —— 跳过素材检查"
} else {
    $refs = New-Object System.Collections.Generic.HashSet[string]

    # (a) builtin.js 里的 path 字段
    $builtin = Join-Path $studio "assets\builtin-index.js"
    if (Test-Path $builtin) {
        $txt = [System.IO.File]::ReadAllText($builtin)
        foreach ($m in [regex]::Matches($txt, '"path"\s*:\s*"(assets/[^"]+)"')) {
            [void]$refs.Add($m.Groups[1].Value)
        }
        Pass "builtin.js 里引用 $($refs.Count) 个素材路径"
    } else {
        Fail "缺少 assets/builtin.js —— 内置素材清单不存在（跑 node gen-assets.js）"
    }

    # (b) presets.js 里控件模板硬编码的路径（"assets/....png"）
    $presets = Join-Path $studio "js\presets.js"
    if (Test-Path $presets) {
        $txt = [System.IO.File]::ReadAllText($presets)
        $hit = 0
        foreach ($m in [regex]::Matches($txt, '"(assets/[^"]+\.png)"')) {
            $hit++
            [void]$refs.Add($m.Groups[1].Value)
        }
        # ⚠️ 报"匹配到几个"而不是"新增几个"：presets.js 的路径多半是
        # builtin.js 的子集，报"新增 0 个"会让人以为检查没生效（踩过）。
        Pass "presets.js 匹配到 $hit 个素材路径（合计去重后 $($refs.Count) 个）"
    } else {
        Fail "缺少 js/presets.js"
    }

    # (b2) **presets.js 里的路径必须也在 builtin.js 里**
    #
    # 为什么：控件模板用 ensureBuiltinAsset(path) 登记素材，而它是从
    # BUILTIN_ASSETS 里查 data URL 的。路径只在 presets.js 里存在、不在
    # builtin.js 里的话，登记出来的素材**没有 data** → 画布被污染 →
    # 「导出 PNG」直接抛 SecurityError。文件在磁盘上也照样是这个结果。
    $builtinPaths = @{}
    if (Test-Path $builtin) {
        foreach ($m in [regex]::Matches([System.IO.File]::ReadAllText($builtin), '"path"\s*:\s*"(assets/[^"]+)"')) {
            $builtinPaths[$m.Groups[1].Value] = $true
        }
    }
    if (Test-Path $presets) {
        $presetOnly = New-Object System.Collections.ArrayList
        foreach ($m in [regex]::Matches([System.IO.File]::ReadAllText($presets), '"(assets/[^"]+\.png)"')) {
            $rp = $m.Groups[1].Value
            if (-not $builtinPaths.ContainsKey($rp)) { [void]$presetOnly.Add($rp) }
        }
        if ($presetOnly.Count -eq 0) {
            Pass "presets.js 引用的素材**都在 builtin.js 里**（登记时能拿到内嵌 data）"
        } else {
            Fail "$($presetOnly.Count) 个素材只在 presets.js 里、不在 builtin.js 里（登记后没有 data → 污染画布 → 导出 PNG 会失败）："
            $presetOnly | Select-Object -First 5 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkRed }
            Write-Host "       修法：把这些素材加进 gen-assets.js 后重跑 node gen-assets.js" -ForegroundColor DarkYellow
        }
    }

    # (b3) **素材路径不能重名**
    #
    # 为什么：两个生成器用了同一个文件名时，后写的会**覆盖**先写的，
    # 而清单里两条都在 —— 工具显示两个一模一样的缩略图，其中一个内容是错的。
    # 这类问题**完全静默**（没有报错、没有警告），只能靠机器查。
    #
    # 实测踩到过：icon/range 被 genIcons2 与 gen-assets-more 各定义了一次。
    $pathSeen = @{}
    $dupPaths = New-Object System.Collections.ArrayList
    foreach ($m in [regex]::Matches([System.IO.File]::ReadAllText($builtin), '"path"\s*:\s*"(assets/[^"]+)"')) {
        $rp = $m.Groups[1].Value
        if ($pathSeen.ContainsKey($rp)) { [void]$dupPaths.Add($rp) } else { $pathSeen[$rp] = $true }
    }
    if ($dupPaths.Count -eq 0) {
        Pass "素材路径没有重名（$($pathSeen.Count) 个都是唯一的）"
    } else {
        Fail "$($dupPaths.Count) 个素材路径**重名**（后写的会覆盖先写的，清单里却两条都在）："
        $dupPaths | Select-Object -First 8 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkRed }
        Write-Host "       修法：给其中一个改名（生成器里的 save/mk 第一个参数）" -ForegroundColor DarkYellow
    }

    # (c) 逐个查文件是否存在
    $missing = New-Object System.Collections.ArrayList
    foreach ($r in $refs) {
        $full = Join-Path $studio ($r -replace '/', '\')
        if (-not (Test-Path $full)) { [void]$missing.Add($r) }
    }
    if ($missing.Count -eq 0) {
        Pass "全部 $($refs.Count) 个素材路径都能在磁盘上找到"
    } else {
        Fail "$($missing.Count) 个素材路径**在磁盘上不存在**（拖出来会是紫框大 X）："
        $missing | Select-Object -First 8 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkRed }
    }

    # (d) 反向：磁盘上有 PNG 但清单里没有（可能是忘了重跑 gen-assets.js）
    $onDisk = Get-ChildItem (Join-Path $studio "assets") -Recurse -Filter *.png -ErrorAction SilentlyContinue
    $listed = @{}
    foreach ($r in $refs) { $listed[$r] = $true }
    $orphan = @()
    foreach ($f in $onDisk) {
        $rel = "assets/" + $f.FullName.Substring((Join-Path $studio "assets").Length + 1) -replace '\\', '/'
        if (-not $listed.ContainsKey($rel)) { $orphan += $rel }
    }
    if ($orphan.Count -gt 0) {
        Warn "$($orphan.Count) 个 PNG 在磁盘上但不在清单里（跑 node gen-assets.js 重新生成）"
    } else {
        Pass "磁盘上的 $($onDisk.Count) 个 PNG 都在清单里"
    }
}

# ---- 控件模板的 key 不能重复（v2.35.0）
#
# 为什么：`instantiateControl` 与设计文件都用 key 定位控件。
# 重复时**后一个会静默盖掉前一个** —— 界面上两个格子都显示，
# 但其中一个永远点不出来（实测抓到过 img_plate 被"方形底盘"和"空白铭牌"共用）。
$ctrlDup = @()
try {
  $presetText = [System.IO.File]::ReadAllText((Join-Path $root "tools/theme-studio/js/presets.js"), [System.Text.UTF8Encoding]::new($false))
  $keys = [regex]::Matches($presetText, 'key:\s*"([a-z0-9_]+)"') | ForEach-Object { $_.Groups[1].Value }
  $ctrlDup = $keys | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { "$($_.Name) x$($_.Count)" }
} catch { }
if ($ctrlDup.Count -gt 0) {
  Fail "控件模板 key 重复：$($ctrlDup -join ', ')（重复的 key 会静默盖掉前一个，那个控件永远点不出来）"
} else {
  Pass "控件模板 key 没有重复"
}

Write-Host ""# ---- 破折号不能是单个（v2.36.0）
#
# 为什么：中文破折号是「——」（两个）。单个 `—` 后面紧跟文字是**排版错误**，
# 而且它是我自己反复造成的 —— 用 `t.split(" — ").join("")` 清理杂字符时，
# 会把原本的 ` —— ` 压成 ` —`（一次压坏了 189 处、45 个文件）。
#
# 判据要精确：**正确的** `——把` 里第二个破折号后面也紧跟文字，
# 所以不能简单写 `—[^ ]`，得排除前后已经有破折号的情况。
$dashBad = @()
try {
  $scanDirs = @("tools", "docs")
  $scanFiles = @()
  foreach ($d in $scanDirs) {
    $full = Join-Path $root $d
    if (Test-Path $full) {
      $scanFiles += Get-ChildItem $full -Recurse -Include *.js,*.ps1,*.md,*.kt -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch "node_modules|\.git|archive|stage|builtin-data-" -and $_.Name -ne "check-build-guard.ps1" }
    }
  }
  foreach ($f in $scanFiles) {
    $txt = [System.IO.File]::ReadAllText($f.FullName, [System.Text.UTF8Encoding]::new($false))
    # 单个破折号（前后都不是破折号）后面紧跟非空白
    if ($txt -match "(?<!\u2014)\u2014(?!\u2014)(?=\S)") {
      $rel = $f.FullName.Substring($root.Length).TrimStart("\")
      $dashBad += $rel
    }
  }
} catch { }
if ($dashBad.Count -gt 0) {
  Fail "有单个破折号紧跟文字（应为成对的）：$($dashBad -join ', ')"
} else {
  Pass "破折号都是成对的"
}

Write-Host ""# ---- 控件不能掉进「其它」分类（v2.38.0）
#
# 为什么：控件分类是按 key 前缀规则推导的（CAT_RULES），不是逐个手写的。
# 于是有两种**很安静**的失败：
#   1. 精确匹配漏掉新前缀 —— `^(group|image|text)$` 匹配不上 `box_card`，
#      新控件静默落到「其它」（v2.37.0 实际发生过）
#   2. 规则顺序错 —— 宽泛规则排在具体规则前面会把它吞掉
#      （`img_` 排在 `img_(digit|nums|unit)` 前面，吞掉 18 个数字控件）
#
# 两种情况下控件**都能加、都能拖**，只是分组不对 —— 靠人看是看不出来的。
#
$otherCtrls = @()
$ctrlTotal = 0
try {
  $probePath = Join-Path $env:TEMP "guard-ctrl-probe.js"
  # 仓库根目录要用**绝对路径**并转成正斜杠：探针文件在 %TEMP%，
  # require("./x") 是相对**探针所在目录**解析的，不是 CWD。
  $rootJs = $root.Replace("\", "/")
  $probe = "global.window = global;" +
    "var R = '" + $rootJs + "/tools/theme-studio/';" +
    "require(R + 'js/schema.js');" +
    "require(R + 'js/presets.js');" +
    "require(R + 'assets/builtin-index.js');" +
    "var C = window.BUILTIN_CONTROLS || [];" +
    "var other = C.filter(function (c) { return c.cat === '其它'; }).map(function (c) { return c.key; });" +
    "console.log(JSON.stringify({ total: C.length, other: other }));"
  [System.IO.File]::WriteAllText($probePath, $probe, (New-Object System.Text.UTF8Encoding($false)))
  $raw = & node $probePath 2>$null | Select-Object -Last 1
  Remove-Item $probePath -Force -ErrorAction SilentlyContinue
  if ($raw) {
    $j = $raw | ConvertFrom-Json
    $ctrlTotal = [int]$j.total
    $otherCtrls = @($j.other)
  }
} catch { }
if ($ctrlTotal -eq 0) {
  Write-Host "  (跳过控件分类检查 —— node 或模块加载不可用)" -ForegroundColor DarkGray
} elseif ($otherCtrls.Count -gt 0) {
  Fail "有 $($otherCtrls.Count) 个控件掉进「其它」分类：$($otherCtrls -join ', ')（多半是 CAT_RULES 的精确匹配漏了新前缀）"
} else {
  Pass "$ctrlTotal 个控件都有分类"
}

Write-Host ""
if ($fails.Count -eq 0) {
    $tail = if ($warns.Count) { "（$($warns.Count) 条警告）" } else { "" }
    Write-Host "构建守卫通过 ✅$tail" -ForegroundColor Green
    exit 0
} else {
    Write-Host "构建守卫失败：$($fails.Count) 个问题 ❌" -ForegroundColor Red
    $fails | ForEach-Object { Write-Host "  · $_" -ForegroundColor Red }
    exit 1
}
