# P4F-M02 阶段 A：环境与基线确认记录

**日期**：2026-10-21T21:12（Asia/Shanghai）
**任务**：`T-UI-REFACTOR-P4F-M02`

---

## 1. 项目根目录与 Git 状态

| 项 | 值 |
|---|---|
| 根目录 | `D:/AIHarness/P002_ICarOBD` |
| 当前分支 | `main` |
| 本地 HEAD | `de5f0ff1df1198c7f889892c33432a06c0e68c3a` |
| 远程 `origin/main` | `de5f0ff1df1198c7f889892c33432a06c0e68c3a` |
| 一致性 | ✅ **完全一致** |
| 工作区 | ✅ 干净（排除已知私人文件：交接包 zip / 微信图片 / MANIFEST / SHA256SUMS / history.bundle）|

## 2. P4F-M01 提交与推送状态

✅ **已全部提交并推送**（`de5f0ff`）。

## 3. 关键产物存在性核查

| 项 | 结果 |
|---|---|
| Android `TrackView.kt` | ✅ 存在（`D:\icarobd2\app\src\main\java\com\icar\obd\ui\view\TrackView.kt`）|
| `renderBandEditor` | ✅ 存在（`schema-props.js:1257`）|
| `renderPartEditor` | ✅ 存在（`schema-props.js:1314`）|

## 4. 测试与构建命令

| 命令 | 路径 | 存在 |
|---|---|---|
| 浏览器测试 | `tools/run-browser-tests.ps1` | ✅ |
| 构建守卫 | `tools/check-build-guard.ps1` | ✅ |

## 5. 浏览器自动化环境

| 项 | 状态 | 说明 |
|---|---|---|
| Microsoft Edge | ✅ 存在 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| Playwright | ❌ **未安装** | **不引入**（任务要求「不为测试引入庞大的新框架」）|
| Puppeteer | ❌ 未安装 | 同上 |

**结论**：项目现有 **原生 CDP 自动化**（`run-browser-tests.ps1` + 自研 CDP 客户端）已足够，
**不需要也不引入 Playwright/Puppeteer**。

> 本轮新增的 GUI 自动化测试将**复用同一套 CDP 基础设施**，
> 直接操作真实 DOM（点击按钮、读 `<select>` 选项、检查画布像素），
> 而非「检查源码里有没有某个函数」。

## 6. Android SDK / 模拟器 / 设备

| 项 | 状态 | 详情 |
|---|---|---|
| Android SDK | ✅ 存在 | `C:\Android\Sdk` |
| emulator.exe | ✅ 存在 | `C:\Android\Sdk\emulator\emulator.exe` |
| AVD 数量 | **2** | 可用 |
| adb | ✅ 存在 | `C:\Android\Sdk\platform-tools\adb.exe` |
| **连接设备** | ⚠️ **1 台** | `2G0YC1ZF9V0J48` |

### ⚠️ 设备详情（重要）

| 项 | 值 |
|---|---|
| 型号 | **Meta Quest 3**（VR 头显，非手机/平板）|
| Android 版本 | 14 |
| 物理分辨率 | **4128 × 2208** |
| Override 分辨率 | **12384 × 8000** |
| 密度 | 200 dpi |
| **本项目 App** | ❌ **未安装** |

### 对阶段 D 的影响

1. **Quest 3 是 VR 设备**，不是 ICarUI 的目标设备（车载平板）；
2. **App 未安装** —— 若要做视觉验证需先构建并安装 APK；
3. 但**存在 2 个 AVD**，可用于模拟器视觉验证；
4. 任务要求「不得声称普通 JVM 测试通过就等于 TrackView 绘制结果已验证」。

**阶段 D 策略**（后续执行）：
- 优先尝试 **AVD 模拟器**（标准 Android 环境，更接近真实平板）
- Quest 3 可作辅助（VR 设备渲染语义不同，需单独标注）
- **若无法完成，如实记录环境限制，不虚构截图**

---

## 7. 基线数据（待本轮重新核查）

| 项 | 上一轮报告值 | 本轮需核查 |
|---|---|---|
| 浏览器套件 | 67 | ✅ 待跑 |
| 浏览器断言 | 6419 | ✅ 待跑 |
| Android JVM | 1365 项 | ✅ 待跑 |
| Registry 控件 | 69 | ✅ 待核查 |
| GUI 待验收 | 62 项（7 张卡片）| ✅ 待核查 |

> 任务明确：「以上属于上一轮报告数据，**必须重新核查实际仓库和测试结果**，不能当成当前已验证事实。」
