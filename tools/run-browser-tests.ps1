<#
  run-browser-tests.ps1 —— 跑全部**浏览器端**测试套件

  ## 为什么单独一个脚本

  这些套件原来散在 %TEMP% 里 —— 系统一清就没了，而且不在版本控制里。
  571 条断言是验证体系的根基，必须跟着仓库走。

  ## 与 run-tests.ps1 的分工

    run-tests.ps1          Kotlin 单测 + 构建守卫（不需要浏览器）
    run-browser-tests.ps1  工具（icarui）的浏览器套件（需要 Edge）

  两者独立：改 Kotlin 只需前者，改工具只需后者。改了两边就都跑。

  ## 断言数守卫（v2.85.0）—— 拦住"断言静默消失"

  套件里的一条断言可以**整条不执行**而套件照样全绿：

  ```js
  if (window.MAX_PARTS) eq(parts.length, window.MAX_PARTS, "…");   // 常量一改名 → 整条消失
  ```

  v2.84.0 人工体检 29 个套件时扫出 6 处这种形态。人工只能扫一次，
  所以这里把**每个套件的最少断言数**记进
  `tools\icarui\tests\expected-counts.json`，每轮跑完**逐个核对**：
  `实际执行的断言数（PASS+FAIL）< 基线` → 红 + 非 0 退出（退出码 4）。

  ⚠️ 数的是 **PASS+FAIL**，不是 PASS。
  用 PASS 的话，"某条断言**失败了**"会被报成"断言**少了一条**"——
  同一个问题说两遍，而且第二遍是错的（它没少，它跑了、没过）。
  断言数守卫拦的是"**没在跑**"；"跑了但没过"由 `FAIL>0` 那条路负责（退出码 1）。

  ### 怎么更新基线（合法地删/改断言时）

  ```powershell
  powershell -ExecutionPolicy Bypass -File tools\run-browser-tests.ps1 -UpdateBaseline
  ```

  跑完全部套件后用**本轮实测值**重写基线，并打印每个套件的增减。
  ⚠️ 不许手改 JSON —— 手改没有 diff 输出，下一个人查不到是谁、为什么放低了基线。
  ⚠️ 有套件 FAIL 时 `-UpdateBaseline` **拒绝**写入（那不是"断言合法地变了"，
  是"套件坏了"——拿坏掉的数当新基线等于把 bug 固化进守卫）。
  ⚠️ 它也不接受 `-Filter`（过滤跑的结果会误删其他套件的基线）。

  ### 守卫自己不会静默跳过

  读不到基线文件 / JSON 坏了 / 基线里某个套件本轮没跑 / 冒出一个不在基线里的新套件
  —— **一律算失败**。这个仓库刚定的规矩：**对不上就是错**。

  ### `-Filter` 下的行为（说清楚，不装看不见）

  `-Filter` 是开发时的方便开关。此时：
    · **仍然**核对"跑了的套件是否低于基线"；
    · **不**核对"基线里的套件是否都跑了"（过滤跑本来就只跑一部分）——
      脚本会**明确打印**这条被放宽了，不会假装全量验过。

  用法：
    .\tools\run-browser-tests.ps1                # 跑全部 + 核对断言基线
    .\tools\run-browser-tests.ps1 -Filter font   # 只跑名字含 font 的
    .\tools\run-browser-tests.ps1 -List          # 只列出会跑哪些
    .\tools\run-browser-tests.ps1 -UpdateBaseline  # 用本轮实测值重写断言基线
#>
param(
    [string]$Filter = "",
    [switch]$List,
    # v2.85.0：用本轮实测值重写 tools\icarui\tests\expected-counts.json。
    # 只在"合法地删/改断言"时用 —— 见文件头「怎么更新基线」。
    [switch]$UpdateBaseline
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

# ===========================================================================
# 断言数基线（v2.85.0）—— 见文件头「断言数守卫」
#
# 在跑之前就把它读出来并校验：基线坏了就没必要花 68 秒跑 29 个套件。
# 而且**读不到 / 解析失败一律算失败**（这个仓库的规矩：对不上就是错），
# 绝不能"没有基线就跳过校验" —— 那等于守卫不存在。
# ===========================================================================
$baselinePath = Join-Path $dir "expected-counts.json"
$baseline = [ordered]@{}   # 套件名 -> 最少断言数（有序：重写基线时保持原文件顺序）
$baselineErr = ""

# 过滤跑只跑一部分套件 —— 拿它的结果重写基线会把**其他套件的基线全删掉**。
# 这是"更新流程"最容易造成静默失守的入口，所以直接拒绝。
if ($Filter -and $UpdateBaseline) {
    Write-Host "❌ -Filter 与 -UpdateBaseline 不能同时用。" -ForegroundColor Red
    Write-Host "   过滤跑只覆盖一部分套件，用它的结果重写基线会把其他套件的基线整段删掉。" -ForegroundColor Yellow
    exit 2
}

if (-not (Test-Path -LiteralPath $baselinePath)) {
    $baselineErr = "文件不存在"
} else {
    try {
        $rawBase = Get-Content -LiteralPath $baselinePath -Raw -Encoding UTF8
        $jsonBase = $rawBase | ConvertFrom-Json
        $map = $jsonBase.minAssertions
        if ($null -eq $map) { throw "缺少 minAssertions 字段" }
        foreach ($prop in $map.PSObject.Properties) {
            $v = 0
            if (-not [int]::TryParse([string]$prop.Value, [ref]$v) -or $v -le 0) {
                throw "套件 $($prop.Name) 的 minAssertions 不是正整数（'$($prop.Value)'）"
            }
            $baseline[$prop.Name] = $v
        }
        if ($baseline.Count -eq 0) { throw "minAssertions 是空的" }
    } catch {
        $baselineErr = $_.Exception.Message
        $baseline = [ordered]@{}
    }
}

if ($baselineErr) {
    if ($UpdateBaseline) {
        Write-Host "⚠️  旧基线不可用（$baselineErr）—— -UpdateBaseline 会整体重写它。" -ForegroundColor DarkYellow
    } else {
        Write-Host "❌ 断言基线不可用：$baselinePath" -ForegroundColor Red
        Write-Host "   原因：$baselineErr" -ForegroundColor DarkRed
        Write-Host "   按失败处理（对不上就是错）—— 缺基线就不校验，那这道守卫等于不存在。" -ForegroundColor Yellow
        Write-Host "   首次建立 / 整体重建：.\tools\run-browser-tests.ps1 -UpdateBaseline" -ForegroundColor Yellow
        exit 4
    }
}

# 跑之前清一遍测试浏览器的残留（**只清本项目自己的**，不碰用户的浏览器）
$killer = Join-Path $PSScriptRoot "kill-test-browsers.ps1"
if (Test-Path $killer) { & powershell -ExecutionPolicy Bypass -File $killer -Kill 2>&1 | Out-Null }

Write-Host ""
Write-Host "===== 浏览器测试套件（$($suites.Count) 个）=====" -ForegroundColor Cyan

if ($Filter) {
    Write-Host "  ⚠️ -Filter “$Filter” 模式：只跑 $($suites.Count) 个套件。" -ForegroundColor DarkYellow
    Write-Host "     断言数守卫仍然核对“跑了的套件是否低于基线”，" -ForegroundColor DarkYellow
    Write-Host "     但**不**核对“基线里的套件是否都跑了” —— 过滤跑本来就只跑一部分。" -ForegroundColor DarkYellow
    Write-Host "     要完整核对请不加 -Filter 再跑一次。" -ForegroundColor DarkYellow
}

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
$measured = [ordered]@{}   # 套件名 -> 本轮实测 PASS（断言数基线核对用，v2.85.0）
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
        # ⚠️ 记的是 **PASS+FAIL = 实际执行了几条断言**，不是 PASS。
        #
        # 用 PASS 会把"某条断言**失败了**"也算成"断言**少了一条**" ——
        # 同一个问题报两次，而且第二次的说法是错的（它没少，它跑了、没过）。
        # 断言数守卫要拦的是"**没在跑**"；失败由 FAIL>0 那条路负责。
        $measured[$s.BaseName] = $p + $f
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

# ===========================================================================
# 断言数核对（v2.85.0）—— 见文件头「断言数守卫」
#
# 到这里为止，$measured 是"本轮每个套件实测跑了多少条断言"。
# 下面把它和基线逐条对。**这个守卫是这一版的重点** ——
# 套件 FAIL=0 只说明"跑了的断言都过了"，不说明"该跑的断言都跑了"。
# ===========================================================================

if ($UpdateBaseline) {
    # ⚠️ 有套件 FAIL 时**拒绝**写基线。
    # 那不是"断言合法地变了"，是"套件坏了" —— 拿坏掉的实测值当新基线，
    # 等于把 bug 固化进守卫，下一轮就再也拦不住了。
    if ($totalFail -gt 0) {
        Write-Host ""
        Write-Host "❌ -UpdateBaseline 已放弃：本轮有 $totalFail 条 FAIL。" -ForegroundColor Red
        Write-Host "   失败套件：$($bad -join ', ')" -ForegroundColor Red
        Write-Host "   先把套件修绿。拿坏掉的实测值当新基线 = 把 bug 固化进守卫。" -ForegroundColor Yellow
        exit 1
    }
    if ($measured.Count -eq 0) {
        Write-Host ""
        Write-Host "❌ -UpdateBaseline 已放弃：一个套件的实测值都没拿到。" -ForegroundColor Red
        Write-Host "   用它重写基线会得到一份**空基线**（那等于关掉守卫）。" -ForegroundColor Yellow
        exit 4
    }

    # 保持原有键序（老名字在前），新出现的套件追加在后面。
    $newMin = [ordered]@{}
    foreach ($k in $baseline.Keys) { if ($measured.Contains($k)) { $newMin[$k] = $measured[$k] } }
    foreach ($k in $measured.Keys) { if (-not $newMin.Contains($k)) { $newMin[$k] = $measured[$k] } }

    Write-Host ""
    Write-Host "===== 重写断言数基线 =====" -ForegroundColor Cyan
    $changed = 0
    foreach ($k in $newMin.Keys) {
        $old = $null
        if ($baseline.Contains($k)) { $old = $baseline[$k] }
        if ($null -eq $old) {
            Write-Host ("  + {0,-26} 新增  {1}" -f $k, $newMin[$k]) -ForegroundColor Yellow
            $changed++
        } elseif ($old -ne $newMin[$k]) {
            $arrow = if ($newMin[$k] -gt $old) { "↑" } else { "↓" }
            Write-Host ("  {0} {1,-26} {2} → {3}" -f $arrow, $k, $old, $newMin[$k]) -ForegroundColor Yellow
            $changed++
        }
    }
    foreach ($k in $baseline.Keys) {
        if (-not $newMin.Contains($k)) {
            Write-Host ("  - {0,-26} 已删除（本轮没跑）" -f $k) -ForegroundColor Yellow
            $changed++
        }
    }
    Write-Host ("  合计 {0} 个套件 / 下限之和 {1}；本次变动 {2} 项。" -f `
        $newMin.Count, (($newMin.Values | Measure-Object -Sum).Sum), $changed)

    # 手写 JSON —— 不用 ConvertTo-Json：PS 5.1 的输出格式不受控，
    # 而且这里的**说明文字就是守卫的一部分**（告诉下一个人怎么更新），
    # 放在脚本里当唯一来源，才不会和守卫本身漂开。
    function Esc-Json([string]$s) { return $s.Replace('\', '\\').Replace('"', '\"') }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('{')
    [void]$sb.AppendLine('  "version": 1,')
    [void]$sb.AppendLine('  "what": "' + (Esc-Json '浏览器套件的**最少断言数**基线（每个套件名 → 实际执行的断言条数下限，即 PASS+FAIL）。由 tools/run-browser-tests.ps1 在每轮全量跑完后逐个核对。') + '",')
    [void]$sb.AppendLine('  "why": [')
    [void]$sb.AppendLine('    "' + (Esc-Json '这些套件里的断言可以**静默消失**：断言被 `if (某个常量) eq(...)` 包住，常量一改名整条断言就不执行了，而套件照样打印 PASS=<n> FAIL=0 —— 绿得看不出来。') + '",')
    [void]$sb.AppendLine('    "' + (Esc-Json 'v2.84.0 人工体检 29 个套件时扫出 6 处这种形态（已修）。人工扫只能做一次；这份基线把它变成每轮机器核对。') + '",')
    [void]$sb.AppendLine('    "' + (Esc-Json 'TOTAL 也拦不住：断言少几条不影响 FAIL=0，TOTAL 只是跟着变小。') + '",')
    [void]$sb.AppendLine('    "' + (Esc-Json '⚠️ 数的是 PASS+FAIL（= 执行了几条），不是 PASS：用 PASS 的话，一条断言**失败**会被报成"断言少了一条" —— 同一个问题说两遍，而且第二遍是错的。') + '"')
    [void]$sb.AppendLine('  ],')
    [void]$sb.AppendLine('  "howToUpdate": [')
    [void]$sb.AppendLine('    "' + (Esc-Json '**合法地删/改断言**（某个功能下线了、某条断言被合并了）→ 用下面这条命令重建，它会打印每个套件的增减：') + '",')
    [void]$sb.AppendLine('    "' + (Esc-Json '  powershell -ExecutionPolicy Bypass -File tools\run-browser-tests.ps1 -UpdateBaseline') + '",')
    [void]$sb.AppendLine('    "' + (Esc-Json '⚠️ 不许手改本文件来绕过守卫 —— 手改没有 diff 输出，下一个人查不到是谁、为什么放低了基线。') + '",')
    [void]$sb.AppendLine('    "' + (Esc-Json '⚠️ 有套件 FAIL 时 -UpdateBaseline 拒绝写入；它也不接受 -Filter（过滤跑会误删其他套件的基线）。') + '",')
    [void]$sb.AppendLine('    "' + (Esc-Json '**新增套件**：必须同时更新基线（不自动加入）。理由：自动加入等于让新套件的下限 = 它第一次跑出来的数，而那个数本身可能就是“断言被包住了”的结果 —— 强制人工看一眼“这个套件怎么只有 3 条断言”，正是这道守卫想让人做的事。') + '",')
    [void]$sb.AppendLine('    "' + (Esc-Json '**删除/改名套件**：同样必须更新基线。基线里有、本轮没跑的名字 = 红（否则套件被悄悄改名 = 覆盖静默蒸发）。') + '"')
    [void]$sb.AppendLine('  ],')
    [void]$sb.AppendLine('  "minAssertions": {')
    $keys = @($newMin.Keys)
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $comma = if ($i -lt $keys.Count - 1) { ',' } else { '' }
        [void]$sb.AppendLine('    "' + (Esc-Json $keys[$i]) + '": ' + $newMin[$keys[$i]] + $comma)
    }
    [void]$sb.AppendLine('  }')
    [void]$sb.AppendLine('}')
    # 无 BOM 的 UTF-8（与仓库其它 .json 一致；Node / PS 都能读）
    [System.IO.File]::WriteAllText($baselinePath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "  已写入：$baselinePath" -ForegroundColor Green
    exit 0
}

$problems = New-Object System.Collections.ArrayList

# ① 跑了的套件：断言数不得低于基线。
foreach ($name in $measured.Keys) {
    if (-not $baseline.Contains($name)) {
        [void]$problems.Add("新增套件 $name（实测断言 $($measured[$name]) 条）**不在基线里**")
    } elseif ($measured[$name] -lt $baseline[$name]) {
        [void]$problems.Add("$name  断言 $($measured[$name]) 条 < 基线 $($baseline[$name]) 条（少 $($baseline[$name] - $measured[$name]) 条）")
    }
}

# ② 基线里的套件必须都跑了 —— 套件被删/改名同样是"覆盖静默蒸发"。
#    只在全量跑时核对：-Filter 本来就只跑一部分（上面已明确提示）。
if (-not $Filter) {
    foreach ($name in $baseline.Keys) {
        if (-not $measured.Contains($name)) {
            [void]$problems.Add("基线里的 $name **本轮没跑**（套件被删或改名了？）")
        }
    }
}

Write-Host ""
Write-Host "===== 断言数基线核对 =====" -ForegroundColor Cyan
if ($problems.Count -eq 0) {
    $floor = 0
    foreach ($name in $measured.Keys) { if ($baseline.Contains($name)) { $floor += $baseline[$name] } }
    Write-Host ("  {0} 个套件全部达到下限（实测断言 {1} 条，下限合计 {2} 条）✅" -f `
        $measured.Count, $totalPass, $floor) -ForegroundColor Green
} else {
    foreach ($p in $problems) { Write-Host "  ❌ $p" -ForegroundColor Red }
    Write-Host ""
    Write-Host "  套件可能还是全绿，但**有断言没在跑** —— 这正是这道守卫要拦的形态。" -ForegroundColor Yellow
    Write-Host "  确认是合法地删/改断言之后：" -ForegroundColor Yellow
    Write-Host "    .\tools\run-browser-tests.ps1 -UpdateBaseline" -ForegroundColor Yellow
    Write-Host "  （不许手改 JSON —— 手改没有 diff 输出，下一个人查不到是谁放低了基线）" -ForegroundColor DarkGray
}

if ($totalFail -gt 0) {
    Write-Host ""
    Write-Host "失败套件：$($bad -join ', ')" -ForegroundColor Red
    exit 1
}
if ($problems.Count -gt 0) {
    Write-Host ""
    Write-Host "断言数守卫不通过 ❌（退出码 4 = 有断言没在跑，与套件失败 1 区分开）" -ForegroundColor Red
    exit 4
}
Write-Host "全部通过 ✅" -ForegroundColor Green
exit 0
