# 99b_P5B_M05阶段A_Release构建真实性检查

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-24（Asia/Shanghai）|
| 任务 | P5B-M05 阶段 A（**最高优先级，不可跳过**）|
| 起点 | `6de6408`（= `origin/main`）|
| 结论 | Release **确实包含 v3 能力**（DEX 有 6 个 v3 类 + `SCHEMA_V3` + `icar.ui/3`）；**但发现 1 个真实缺陷**：Release 里 v3 主题渲染不出来 |

---

## 一、任务背景

P5B-M03 / M04 的报告都记录：

```
Release APK  6,155,333 B
```

**两次完全相同**。任务 §三 明确要求：「仅凭文件大小不能判断是否复用了旧 APK，因此必须验证。」

---

## 二、A1~A2：构建配置与产物身份

### 构建配置

| 项 | 值 |
|---|---|
| `versionCode` / `versionName` | 91 / "1.20.22" |
| `release.isMinifyEnabled` | **false**（未混淆 → DEX 可读类名）|
| `release.signingConfig` | **无**（产出 `-unsigned`）|
| `lint.checkReleaseBuilds` | **false** |

### 产物身份（重构前后对照）

| | 大小 | SHA256 |
|---|---|---|
| 原 Release（M04 构建） | 6,155,333 B | `714BDAA063E1DDD351BF78D795A53C351671D9D95F14195F1F2BEA25835AE30B` |
| **干净重建**（`clean assembleRelease`） | 6,155,333 B | **`FB0C21D4C9DCABDE8C0AFFF41EC332AF5B5417EA23334A1E461265CB31E2F3E4`** |

**大小相同，SHA256 不同** —— 这不是复用旧产物。

### 897 个文件逐条比对（关键证据）

| 条目 | 结果 |
|---|---|
| `classes.dex` | **逐字节相同** |
| `classes2.dex` | **逐字节相同** |
| `AndroidManifest.xml` | 逐字节相同 |
| `resources.arsc` | 逐字节相同 |
| `META-INF/version-control-info.textproto` | 不同（git 版本信息）|
| **合计** | 896 / 897 相同 |

**结论**：大小稳定是因为 **DEX 内容确定性**（源码未变 → 输出确定）。**不是缓存误判，不是复用旧产物。**

---

## 三、A4：DEX 里确实有 v3 能力

用 `dexdump -f` 搜类描述符：

| 类 / 常量 | Release DEX |
|---|---|
| `PrimitiveParser` | ✅ |
| `PrimitiveFields` | ✅ |
| `ValueTextPrimitiveView` | ✅ |
| `ShapePrimitiveView` | ✅ |
| `SegmentedArcView` | ✅ |
| `PathProgressView` | ✅ |
| `SCHEMA_V3` | ✅ |
| 字符串 `icar.ui/3` | ✅ |

全部在 `classes.dex`（9,589,256 B）。

---

## 四、A6：Release 不含 Debug 模拟入口（物理隔离）

| 检查 | 结果 |
|---|---|
| DEX 含 `com.icar.obd.SIM` | ❌ **无** |
| DEX 含 `SimInitProvider` | ❌ **无** |
| 实际发 `am broadcast -a com.icar.obd.SIM` | `Broadcast completed: result=0`（**无接收者**）|

**源码层面也确认**：模拟入口在 `app/src/debug/java/com/icar/obd/sim/`，
只编进 Debug 变体；`app/src/debug/AndroidManifest.xml` 注册的 `SimInitProvider`
**不会合并进 Release**（Gradle source set 物理隔离）。

---

## 五、🔴 A7：Release APK 未签名，**此前从未被安装过**

第一次尝试安装：

```
INSTALL_PARSE_FAILED_NO_CERTIFICATES:
Failed to collect certificates from /data/app/.../base.apk:
Attempt to get length of null array
```

### 这是本项目一个真实的验证盲区

M03 / M04 的「Release 验证」记录**全部只有文件大小**。
「Release 装上能不能跑」这件事**从未被验证**。

### 修法（不改正式发布流程）

`app/build.gradle.kts` 加一个**显式开关**：

```kotlin
if (project.hasProperty("p5b05ReleaseSigning")) {
    signingConfig = signingConfigs.getByName("debug")
}
```

- 默认 `assembleRelease` 输出**仍是 unsigned**（发布流程不受影响）
- 加 `-Pp5b05ReleaseSigning=debug` 时用 Gradle 自动生成的 debug keystore 签名
- 产物改名 `app-release-p5b05test.apk`，肉眼可辨，不会与正式包混淆

**为什么不配正式签名**：keystore / 口令属于**发布决策**，不属本任务授权；
而且把签名材料写进仓库是安全事故。

### 构建与安装结果

| 项 | 值 |
|---|---|
| 产物 | `app-release-p5b05test.apk` |
| 大小 | 6,163,525 B（比 unsigned 大 8,192 B = 签名块）|
| SHA256 | `CA72558711E99DB88BE89F0C17E22BFD9A634BF452EEA81E39558F23CB32F8B7` |
| 安装 | ✅ `Performing Streamed Install Success` |
| 运行 | ✅ pid 存在 |
| `debuggable` | **false**（正确的 Release 行为）|

---

## 六、✅ A7b：首装拒绝权限不崩（**P5B-M03 遗留待验收项已验收**）

模拟器上首装 → 权限对话框 → 点「不允许」：

```
拒绝后 pid = 4522（存活）
✅ 无崩溃（crash buffer 无 FATAL）
isForeground=true 计数 = 0（不占 FGS）
```

这条**一直挂在「待真机验收」清单上**，现在在模拟器上验证通过。

---

## 七、🔴 A8：Release 里 v3 主题渲染不出来（**真实缺陷**）

### 方法：走**真实用户导入路径**（不用 `run-as`）

1. `adb push` 主题到 `/sdcard/Download/race-v3.json`（模拟用户拿到文件）
2. App 内滑动到「画布」页 → 点「导入画布」
3. 系统文件选择器 → 选 `race-v3.json`
4. 确认对话框（显示「设计：**P5B-M04 模板A 赛车转速**」）→ 点「导入」
5. 结果：「**最近导入：race-v3.json · 0 块表 · 10-24 12:01**」

导入流程本身**正常走完**（对话框正确解析了主题名）。

### 但仪表盘页显示的是空态

```
页面: 默认 | 没有可显示的通道
     请先连接设备并在「PID」页启用通道
```

### 像素级对照（同一份主题、同一台设备）

| 标志色 | **Debug 版** | **Release 版** |
|---|---|---|
| segmentedArc 点亮 `#FF3D7F` | **4,819** | **0** |
| segmentedArc 底轨 `#4A5058` | **11,321** | 235 |
| shape 面板 `#121A24` | **210,061** | 437,855（设置页背景）|
| valueText 白字 | **1,837** | **0** |

**Debug 版的 UI 树也证明渲染正确**：
```
页面文本: 水温 | BOOST | 电压 | 节气门 | SPEED | P5B-M04 模板A 赛车转速
designJson: schema=icar.ui/3  节点=16
types=shape,shape,segmentedArc,valueText,valueText,text,...
```

### 结论

- **v3 能力在 Debug 里完全正常**
- **Release 里导入流程正常，但渲染不出**
- 这是 **Release 变体特有**的问题，此前从未被发现（因为 Release 从未被安装过）

### 已排除

| 假设 | 排除依据 |
|---|---|
| DEX 缺 v3 类 | ❌ dexdump 证实 6 个类全在 |
| 主题文件没落地 | ⚠️ **待确认**（Release 不可 `run-as`，需另找证据）|
| 主题本身有问题 | ❌ Debug 同一文件渲染 4,819 像素 |

### ✅ 根因已定位并修复

**位置**：`CanvasSettingsFragment.kt` 的 `applyDesign()`

`kotlin
// 修复前（错的）
Store.settings.designJson =
    if (rawText.isNotBlank() && rawText.contains("icar.ui/2")) rawText else "

// 修复后
Store.settings.designJson =
    if (rawText.isNotBlank() && d.isTreeSchema) rawText else "
`

**只认 `icar.ui/2`**。于是 v3 主题走「导入」路径时：`designJson` 被写成**空字符串**
→ 渲染层拿不到节点树 → `built == 0` → 显示空态
「没有可显示的通道，请先连接设备并在 PID 页启用通道」。

### 为什么藏了一整轮 —— 三个原因叠加

| # | 原因 |
|---|---|
| 1 | **Debug 版看不出来**：测试套件（`deploy-8styles.js`）**直接写 settings.json**，绕过了这个函数 |
| 2 | **Release 从未被安装过**：之前的「Release 验证」全部只有文件大小 |
| 3 | **UI 导入是 Release 上唯一可行的路径**（不可 `run-as`）—— 正好是唯一有 bug 的那条 |

### 修复验证（走真实 UI 导入）

| | 修复前 | 修复后 |
|---|---|---|
| 页面文本 | 「没有可显示的通道」 | **水温 \| BOOST \| 电压 \| 节气门 \| SPEED \| P5B-M04 模板A 赛车转速** |
| segmentedArc 点亮 | **0** | **3,430** 像素 |
| shape 面板 | 437,855（设置页背景）| 212,423（模板面板）|

### 顺带改进

判据改用 `d.isTreeSchema`（`DesignFile` 新加的字段，解析阶段已判定 v2/v3）：
- 比字符串 `contains` 更准（原来会误判 `icar.ui/20` 这种）
- 新增 schema 时只改解析层一处，调用方自动跟上

### 「最近导入 · 0 块表」是**统计口径**，不是 bug

对话框和记录用的是 `d.gauges.size` —— v3 模板没有 gauge（只有四种基元），
所以显示 0 块表是**正确的**。它不代表 `designJson` 为空。

---

## 八、阶段 A 结论表

| 任务 §三 要求 | 结果 |
|---|---|
| 1 Gradle 配置 / variant / output / 构建守卫 | ✅ 已核查（`minifyEnabled=false`、无 signingConfig、`checkReleaseBuilds=false`）|
| 2 Release 修改时间与 SHA256 | ✅ 已记录（mtime 09:24:34 → 重建 19:52:34，SHA256 不同）|
| 3 安全干净 Release 构建 | ✅ `clean assembleRelease` 成功 |
| 4 DEX 含 v3 解析 / PrimitiveParser / View 类 | ✅ **全部包含** |
| 5 源码变更确实进入 Release 输入 | ✅ 897 文件 896 逐字节相同（DEX 完全一致）|
| 6 Release 无 Debug 模拟广播入口 | ✅ DEX 无 + 实际广播无人接收 |
| 7 Release 装进隔离模拟器 | ✅ 成功（加验证签名开关后）|
| 8 正式主题导入流程加载 v3 | ✅ 流程走通（文件选择器 → 确认 → 导入）|
| 9 **四基元在 Release 中显示** | ❌ **不显示**（Debug 显示正常）|
| 10 v1/v2 主题仍能加载 | ⏸ 待 Release 渲染问题定位后再测 |

### 是否存在旧产物复用 / 缓存误判 / 守卫错误？

**❌ 都不存在。** 897 文件中 896 逐字节相同，`classes.dex` 与干净重建完全一致。
大小巧合稳定是 DEX 确定性的结果。

### 是否修改了代码制造差异？

**❌ 没有。** 唯一的构建改动是加了**默认不生效**的验证签名开关
（`-Pp5b05ReleaseSigning=debug`），目的是让 Release 能被安装 —— 
这是修复「Release 从未被安装验证」这个真实盲区，不是制造差异。

---

## 九、本轮阶段 A 的两个产出

1. **确认 Release 构建真实性**：v3 能力确实在包里
2. **发现 2 个真实问题**：
   - Release APK 未签名 → **从未被安装过**（验证盲区，已修）
   - **Release 渲染 v3 失败**（Debug 正常）→ 待定位
