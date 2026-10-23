package com.icar.obd.service

import org.junit.Assert.*
import org.junit.Test

/**
 * P5A-M01 阶段 G：**前台服务启动降级**逻辑的回归测试。
 *
 * ## 为什么需要这个文件
 *
 * 本轮发现一个**真实崩溃**：Android 14（targetSDK 34）对
 * `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` 有双重要求 ——
 * manifest 声明（已有）**且**持有 `BLUETOOTH_CONNECT`/`BLUETOOTH_SCAN` 之一。
 *
 * 用户第一次装 App 点「不允许」→ 第二条件不满足 → `startForeground()` 抛
 * `SecurityException` → 在 `Service.onCreate()` 里没人接 → **进程 FATAL**。
 *
 * 实测复现：撤销权限后启动，crash buffer 出现 2 条 FATAL EXCEPTION。
 *
 * ## 本测试测什么 / 不测什么
 *
 * `ObdService` 本身继承 `android.app.Service`，JVM 单测里造不出来（需要 Robolectric）。
 * 所以这里把**降级决策**抽成纯函数来测：
 *   · `shouldUseTypedForeground(sdkInt)` —— 该不该带类型
 *   · `planForegroundFallback(typedFailed)` —— 带类型失败后怎么办
 *
 * 这样即使没有 Android 环境，也能钉住"**失败要降级，不能崩**"这个关键语义。
 * 真正的端到端由 `verify-p5a01-sim-chain.js` 的 C10（crash buffer 无 FATAL）覆盖。
 */
class ForegroundServiceDegradeTest {

    // ---------------------------------------------------------------- 类型选择

    @Test
    fun `Android14 及以上才需要带 CONNECTED_DEVICE 类型`() {
        // Build.VERSION_CODES.UPSIDE_DOWN_CAKE == 34
        assertFalse("API 33 不该带类型", ObdService.shouldUseTypedForeground(33))
        assertTrue("API 34 应带类型", ObdService.shouldUseTypedForeground(34))
        assertTrue("API 35 应带类型", ObdService.shouldUseTypedForeground(35))
    }

    // ---------------------------------------------------------------- 降级决策

    @Test
    fun `带类型启动失败时必须降级到无类型 而不是放弃`() {
        val plan = ObdService.planForegroundFallback(typedFailed = true)
        assertEquals(
            "带类型失败 → 应降级为无类型 startForeground",
            ForegroundPlan.UNTYPED,
            plan
        )
    }

    @Test
    fun `带类型成功时不需要降级`() {
        val plan = ObdService.planForegroundFallback(typedFailed = false)
        assertEquals(
            "带类型成功 → 保持原样",
            ForegroundPlan.NONE,
            plan
        )
    }

    // ---------------------------------------------------------------- 关键语义

    @Test
    fun `降级路径绝不能是抛出或放弃`() {
        // 这是本轮缺陷的核心：原来是"直接抛"，修复后是"降级"。
        // 用穷举把三种计划枚举一遍，确认没有任何一种代表"崩"。
        val all = ForegroundPlan.values()
        assertTrue("计划枚举不应为空", all.isNotEmpty())
        assertTrue(
            "计划里不应存在 THROW / CRASH 之类语义",
            all.none { it.name.contains("THROW") || it.name.contains("CRASH") }
        )
        // 降级结果必须是可执行的一种（NONE 或 UNTYPED 或 STOP_SELF）
        val afterFail = ObdService.planForegroundFallback(true)
        assertTrue(
            "失败后必须给出可执行的计划（$afterFail）",
            afterFail == ForegroundPlan.UNTYPED ||
                afterFail == ForegroundPlan.STOP_SELF
        )
    }

    // ---------------------------------------------------------------- 二次失败

    @Test
    fun `无类型再失败时退回普通服务 不崩`() {
        val plan = ObdService.planSecondFallback(untypedFailed = true)
        assertEquals(
            "无类型也失败 → 放弃前台（转普通服务），App 仍可用",
            ForegroundPlan.STOP_SELF,
            plan
        )
        val ok = ObdService.planSecondFallback(untypedFailed = false)
        assertEquals("无类型成功 → 无需再降级", ForegroundPlan.NONE, ok)
    }
}
