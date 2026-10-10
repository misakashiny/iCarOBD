package com.icar.obd.ui.view

import com.icar.obd.data.NodeState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阈值爆闪逻辑（v1.8.0）。
 *
 * 这里钉的是两件最容易写错、又最难手测的事：
 *  **迟滞**（数值在阈值附近抖动时不能乱闪）和**时间相位**（闪频要稳）。
 */
class AlertPulseTest {

    private val W = 6500f       // 转速警告阈值
    private val C = 7200f       // 危险阈值

    // ================================================================ 等级判定

    @Test
    fun `未达阈值不报警`() {
        assertEquals(AlertPulse.NONE, AlertPulse.level(3000f, W, C, AlertPulse.NONE))
    }

    @Test
    fun `达到警告阈值进入 WARN`() {
        assertEquals(AlertPulse.WARN, AlertPulse.level(6500f, W, C, AlertPulse.NONE))
        assertEquals(AlertPulse.WARN, AlertPulse.level(6800f, W, C, AlertPulse.NONE))
    }

    @Test
    fun `达到危险阈值进入 CRITICAL`() {
        assertEquals(AlertPulse.CRITICAL, AlertPulse.level(7200f, W, C, AlertPulse.NONE))
        assertEquals(AlertPulse.CRITICAL, AlertPulse.level(8000f, W, C, AlertPulse.WARN))
    }

    @Test
    fun `null 与 NaN 都不报警`() {
        assertEquals(AlertPulse.NONE, AlertPulse.level(null, W, C, AlertPulse.WARN))
        assertEquals(AlertPulse.NONE, AlertPulse.level(Float.NaN, W, C, AlertPulse.CRITICAL))
    }

    @Test
    fun `没有警告阈值时永不报警`() {
        assertEquals(AlertPulse.NONE, AlertPulse.level(9999f, null, C, AlertPulse.NONE))
    }

    @Test
    fun `只有一档时也能工作`() {
        assertEquals(AlertPulse.WARN, AlertPulse.level(100f, 100f, null, AlertPulse.NONE))
        assertEquals(AlertPulse.NONE, AlertPulse.level(50f, 100f, null, AlertPulse.NONE))
    }

    // ================================================================ 迟滞

    @Test
    fun `迟滞 进入用原阈值 退出用降下来的阈值`() {
        // 6500 × 0.97 = 6305
        val release = AlertPulse.releaseOf(W)
        assertEquals(6305f, release, 0.5f)

        // 从 NONE 上来：6499 还不报
        assertEquals(AlertPulse.NONE, AlertPulse.level(6499f, W, C, AlertPulse.NONE))
        // 已经在 WARN：降到 6400（低于 6500 但高于 6305）**仍然报**
        assertEquals(AlertPulse.WARN, AlertPulse.level(6400f, W, C, AlertPulse.WARN))
        // 掉到 6305 以下才解除
        assertEquals(AlertPulse.NONE, AlertPulse.level(6300f, W, C, AlertPulse.WARN))
    }

    @Test
    fun `在阈值附近抖动不会来回跳`() {
        // 这是迟滞存在的**唯一理由**：真实转速在 6500 上下抖是常态
        var lvl = AlertPulse.NONE
        val samples = listOf(6490f, 6510f, 6495f, 6505f, 6480f, 6520f, 6470f, 6530f)
        for (v in samples) lvl = AlertPulse.level(v, W, C, lvl)
        assertEquals("抖了一轮之后应当稳定在 WARN，而不是被最后一个小值打回 NONE", AlertPulse.WARN, lvl)
    }

    @Test
    fun `没有迟滞会怎样 —— 反证`() {
        // 同一串样本，但每帧都当"第一次判定"（prev 传 NONE）——
        // 于是**最后一个低于阈值的样本**会把它打回 NONE，这就是抖动。
        var lvl = AlertPulse.NONE
        val samples = listOf(6490f, 6510f, 6495f, 6505f, 6480f, 6520f, 6470f, 6530f, 6460f)
        for (v in samples) lvl = AlertPulse.level(v, W, C, AlertPulse.NONE)
        assertEquals("不传 prev 就会被最后那个 6460 打回 NONE —— 这正是迟滞要解决的问题", AlertPulse.NONE, lvl)
    }

    @Test
    fun `危险档也有迟滞`() {
        val releaseC = AlertPulse.releaseOf(C)
        assertEquals(AlertPulse.CRITICAL, AlertPulse.level(releaseC + 1f, W, C, AlertPulse.CRITICAL))
        assertEquals("掉出危险档应当退回 WARN（不是 NONE）", AlertPulse.WARN, AlertPulse.level(releaseC - 1f, W, C, AlertPulse.CRITICAL))
    }

    @Test
    fun `阈值很小时绝对兜底生效`() {
        // 相对比例在 0.5 这种量级上会失效（0.5 × 0.03 = 0.015），必须靠绝对兜底
        val r = AlertPulse.releaseOf(0.5f)
        assertTrue("退出阈值必须明显低于进入阈值，否则等于没有迟滞", r <= 0.5f - 0.4f)
    }

    @Test
    fun `零或负阈值直接不报警`() {
        assertEquals(AlertPulse.NONE, AlertPulse.level(100f, 0f, null, AlertPulse.NONE))
        assertEquals(AlertPulse.NONE, AlertPulse.level(100f, -5f, null, AlertPulse.NONE))
    }

    // ================================================================ 爆闪时间

    @Test
    fun `方波按时序开关`() {
        // 周期 200ms，占空比 0.5 → 前 100ms 亮
        assertEquals(1f, AlertPulse.square(0, 200, 0.5f), 1e-6f)
        assertEquals(1f, AlertPulse.square(99, 200, 0.5f), 1e-6f)
        assertEquals(0f, AlertPulse.square(100, 200, 0.5f), 1e-6f)
        assertEquals(0f, AlertPulse.square(199, 200, 0.5f), 1e-6f)
        // 下一轮重新亮
        assertEquals(1f, AlertPulse.square(200, 200, 0.5f), 1e-6f)
    }

    @Test
    fun `方波是硬开关 不是渐变`() {
        val vals = (0 until 200 step 10).map { AlertPulse.square(it.toLong(), 200, 0.5f) }.toSet()
        assertEquals("方波只应有 0 和 1 两个取值", setOf(0f, 1f), vals)
    }

    @Test
    fun `脉冲平滑且首尾归零`() {
        assertEquals(0f, AlertPulse.pulse(0, 600), 1e-6f)
        assertEquals(1f, AlertPulse.pulse(300, 600), 1e-3f)
        assertEquals(0f, AlertPulse.pulse(600, 600), 1e-6f)
        // 中段应当有中间值（证明是渐变不是硬开关）
        val mid = AlertPulse.pulse(150, 600)
        assertTrue("脉冲中段应当是中间值，实际 $mid", mid > 0.1f && mid < 0.9f)
    }

    @Test
    fun `脉冲值域始终落在 0 到 1 之间`() {
        for (t in 0L until 1200L step 7) {
            val v = AlertPulse.pulse(t, 600)
            assertTrue("t=$t v=$v", v >= 0f && v <= 1f)
        }
    }

    @Test
    fun `周期为 0 时不崩且不闪`() {
        assertEquals(0f, AlertPulse.square(1234, 0, 0.5f), 1e-6f)
        assertEquals(0f, AlertPulse.pulse(1234, 0), 1e-6f)
    }

    @Test
    fun `两档用不同节奏 —— 一眼能看出严重程度`() {
        // ⚠️ 不能数"值变了几次"：pulse 是连续函数，每帧都在变（会数出几百次），
        //    square 只有两个取值（只数出几十次），那样比出来的是"平滑 vs 硬开关"，
        //    不是"闪得快不快"。要数**上升沿**：值从 <0.5 越过 0.5 的次数。
        fun risesPerSec(level: Int, spanMs: Long): Int {
            var n = 0
            var prevAbove = false
            for (t in 0L..spanMs step 5) {
                val above = AlertPulse.intensity(level, t) >= 0.5f
                if (above && !prevAbove) n++
                prevAbove = above
            }
            return n
        }
        val crit = risesPerSec(AlertPulse.CRITICAL, 3000)
        val warn = risesPerSec(AlertPulse.WARN, 3000)
        assertTrue("危险档每秒闪 $crit 次，警告档 $warn 次 —— 危险档必须更快", crit > warn)
        // 大致量级：危险档 400ms 周期 → 3 秒约 7~8 次；警告档 600ms → 约 5 次
        assertTrue("危险档闪频应在 6~9 次/3秒，实际 $crit", crit in 6..9)
        assertTrue("警告档闪频应在 4~6 次/3秒，实际 $warn", warn in 4..6)
    }

    // ================================================================ 闪烁频率红线（WCAG 2.3.1）
    //
    // ## 为什么这是**守卫**而不是普通用例
    //
    // WCAG 2.3.1 Three Flashes or Below Threshold（Level A）原文：
    //   *"Web pages do not contain anything that flashes more than
    //     three times in any one second period..."*
    //
    // 修复前实测：危险档是 `square(nowMs, 200, 0.5f)` = **5 Hz 硬方波**，超红线 67%。
    // 这个用例**直接数上升沿**来断言，而不是断言"周期常量等于 400" ——
    // 后者在有人把 duty 改成 0.25（一轮亮两次）时照样会绿。

    @Test
    fun `危险档闪烁频率不得超过每秒三次 —— WCAG 2_3_1 红线`() {
        var rises = 0
        var prevAbove = false
        // 数 10 秒的上升沿，换算成 Hz —— 比数 1 秒稳（不受取整影响）
        for (t in 0L..10_000L step 1) {
            val above = AlertPulse.intensity(AlertPulse.CRITICAL, t) >= 0.5f
            if (above && !prevAbove) rises++
            prevAbove = above
        }
        val hz = rises / 10.0
        assertTrue(
            "WCAG 2.3.1 要求每秒不超过三次，实测危险档 ${"%.2f".format(hz)} Hz（$rises 次/10秒）",
            hz <= 3.0
        )
    }

    @Test
    fun `警告档闪烁频率也不得超过每秒三次`() {
        var rises = 0
        var prevAbove = false
        for (t in 0L..10_000L step 1) {
            val above = AlertPulse.intensity(AlertPulse.WARN, t) >= 0.5f
            if (above && !prevAbove) rises++
            prevAbove = above
        }
        val hz = rises / 10.0
        assertTrue("警告档实测 ${"%.2f".format(hz)} Hz，也必须 ≤3 Hz", hz <= 3.0)
    }

    @Test
    fun `染色与爆闪的相位必须一致`() {
        // tintMix 与 intensity 各自写了一遍周期。若有人只改一处，
        // "变色"和"闪"就会错开相位 —— 症状是"闪的时候没变色"，很难手测出来。
        for (t in 0L..2400L step 7) {
            val bright = AlertPulse.intensity(AlertPulse.CRITICAL, t) >= 0.5f
            val tinted = AlertPulse.tintMix(AlertPulse.CRITICAL, t) > 0.5f
            assertEquals("t=$t 时 intensity=$bright 与 tintMix=$tinted 的相位不一致", bright, tinted)
        }
    }

    @Test
    fun `闪烁周期下限常量与数据层同源且合规`() {
        // 下限的**唯一真源**在数据层（那是设计文件的契约），
        // 工具侧 `window.MIN_BLINK_MS` 由 verify-crosslang.js 比对。
        assertEquals("数据层下限变了但这里没跟着改", 400, NodeState.MIN_BLINK_MS)
        assertTrue(
            "NodeState.MIN_BLINK_MS=${NodeState.MIN_BLINK_MS}ms → ${1000 / NodeState.MIN_BLINK_MS} Hz，超 WCAG 2.3.1 的 3 Hz",
            1000.0 / NodeState.MIN_BLINK_MS <= 3.0
        )
        // 危险档必须真的用上了这个下限（而不是各写各的）
        var rises = 0
        var prevAbove = false
        // ⚠️ 用 `until` 而不是 `..` —— 闭区间会把 t = 4 个周期那一刻**也算进来**，
        //    多出一个上升沿（首周期 t=0 已经算了一个）。这个 off-by-one 实测抓到过。
        for (t in 0L until (NodeState.MIN_BLINK_MS * 4L) step 1) {
            val above = AlertPulse.intensity(AlertPulse.CRITICAL, t) >= 0.5f
            if (above && !prevAbove) rises++
            prevAbove = above
        }
        // 4 个周期应当有 4 个上升沿（t=0 / 400 / 800 / 1200）
        assertEquals("危险档在 ${NodeState.MIN_BLINK_MS * 4}ms 内应有 4 个上升沿（= 用上了下限）", 4, rises)
    }

    @Test
    fun `不报警时强度恒为 0`() {
        for (t in 0L..2000L step 37) {
            assertEquals(0f, AlertPulse.intensity(AlertPulse.NONE, t), 1e-6f)
            assertEquals(0f, AlertPulse.tintMix(AlertPulse.NONE, t), 1e-6f)
        }
    }

    @Test
    fun `危险档整体比警告档更醒目`() {
        // ⚠️ 不能断言"危险档最暗 ≥ 警告档最亮" —— 那等于要求危险档**从不熄灭**，
        //    就不是爆闪了。爆闪本来就有"灭"的那一半。
        //    两个等级不会同时出现在一个表上，所以不需要逐时刻比较。
        //    正确的契约是：**峰值更高、均值更高**。
        fun samples(level: Int, spanMs: Long) =
            (0L..spanMs step 5).map { AlertPulse.tintMix(level, it) }

        val crit = samples(AlertPulse.CRITICAL, 600)
        val warn = samples(AlertPulse.WARN, 600)

        assertTrue("危险档峰值(${crit.max()}) 必须高于警告档峰值(${warn.max()})",
            crit.max() > warn.max())
        assertTrue("危险档均值(${crit.average()}) 必须高于警告档均值(${warn.average()})",
            crit.average() > warn.average())
        assertTrue("危险档即使熄灭时也要保留底色，否则会完全看不见", crit.min() > 0.2f)
    }

    // ================================================================ 颜色

    @Test
    fun `颜色混合两端正确`() {
        val a = 0xFF102030.toInt()
        val b = 0xFFA0B0C0.toInt()
        assertEquals(a, AlertPulse.mix(a, b, 0f))
        assertEquals(b, AlertPulse.mix(a, b, 1f))
    }

    @Test
    fun `颜色混合中点正确`() {
        val m = AlertPulse.mix(0xFF000000.toInt(), 0xFFFFFFFF.toInt(), 0.5f)
        assertEquals(0x7F, (m shr 16) and 0xFF)
        assertEquals(0x7F, (m shr 8) and 0xFF)
        assertEquals(0x7F, m and 0xFF)
    }

    @Test
    fun `混合比例被夹住`() {
        val a = 0xFF000000.toInt()
        val b = 0xFFFFFFFF.toInt()
        assertEquals(a, AlertPulse.mix(a, b, -3f))
        assertEquals(b, AlertPulse.mix(a, b, 9f))
    }

    @Test
    fun `换透明度保留 RGB`() {
        val c = AlertPulse.alpha(0xFF123456.toInt(), 0x80)
        assertEquals(0x80, (c shr 24) and 0xFF)
        assertEquals(0x123456, c and 0xFFFFFF)
    }

    @Test
    fun `透明度被夹在合法范围内`() {
        assertEquals(0, (AlertPulse.alpha(0xFFFFFFFF.toInt(), -10) shr 24) and 0xFF)
        assertEquals(255, (AlertPulse.alpha(0xFFFFFFFF.toInt(), 999) shr 24) and 0xFF)
    }

    @Test
    fun `混合后的颜色始终不透明`() {
        for (t in 0..10) {
            val m = AlertPulse.mix(0x00112233, 0x00445566, t / 10f)
            assertEquals("混合结果必须是不透明的，否则仪表会出现半透明鬼影", 0xFF, (m shr 24) and 0xFF)
        }
    }

    @Test
    fun `不同比例给出不同颜色`() {
        val a = 0xFF000000.toInt()
        val b = 0xFFFFFFFF.toInt()
        assertNotEquals(AlertPulse.mix(a, b, 0.2f), AlertPulse.mix(a, b, 0.8f))
    }

    // ================================================================ 下限报警（v1.10.1）
    //
    // 下限进 alertLevel 是「统一两套报警概念」那一步的核心：
    // 原来下限只让 `warn=true`（染色），不产生 alertLevel，于是颜色和爆闪
    // 各有一套判定。这里钉住的是**统一之后行为不变**：
    // 下限仍然只染色、不爆闪。

    private val LOW = 11.5f      // 电压下限

    @Test
    fun `低于下限进入 WARN_LOW`() {
        assertEquals(AlertPulse.WARN_LOW, AlertPulse.levelWithLow(11.0f, null, null, LOW, AlertPulse.NONE))
    }

    @Test
    fun `正常值不报警`() {
        assertEquals(AlertPulse.NONE, AlertPulse.levelWithLow(13.8f, null, null, LOW, AlertPulse.NONE))
    }

    @Test
    fun `上限优先于下限`() {
        // 量程写错或数据异常时可能同时越过两端；「过高」才是要立刻反应的场景
        assertEquals(
            AlertPulse.CRITICAL,
            AlertPulse.levelWithLow(8000f, W, C, LOW, AlertPulse.NONE)
        )
        assertEquals(
            AlertPulse.WARN,
            AlertPulse.levelWithLow(7000f, W, C, LOW, AlertPulse.NONE)
        )
    }

    @Test
    fun `下限为 null 或 0 时不生效`() {
        // warnLow = 0 是"没设"的常见写法。若当成有效阈值，
        // 任何正常值（电压 13.8 > 0）都不会触发，但负值会 —— 语义混乱
        assertEquals(AlertPulse.NONE, AlertPulse.levelWithLow(5f, null, null, null, AlertPulse.NONE))
        assertEquals(AlertPulse.NONE, AlertPulse.levelWithLow(5f, null, null, 0f, AlertPulse.NONE))
        assertEquals(AlertPulse.NONE, AlertPulse.levelWithLow(-3f, null, null, 0f, AlertPulse.NONE))
    }

    @Test
    fun `下限也有迟滞`() {
        // ⚠️ 方向与上限**相反**：进入 = 11.5，退出 = 11.5 + 0.5 ≈ 12.0
        // （照抄上限的 releaseOf 会让退出阈值落到进入阈值下面，于是永远进不去）
        val release = AlertPulse.releaseHighOf(LOW)
        assertTrue("下限的退出阈值必须高于进入阈值，否则等于没有迟滞", release > LOW)

        // 从 NONE 下来：11.6 还不报（高于 11.5）
        assertEquals(AlertPulse.NONE, AlertPulse.levelWithLow(11.6f, null, null, LOW, AlertPulse.NONE))
        // 已经在 WARN_LOW：升到 11.8（高于 11.5 但低于 12.0）**仍然报**
        assertEquals(
            AlertPulse.WARN_LOW,
            AlertPulse.levelWithLow(11.8f, null, null, LOW, AlertPulse.WARN_LOW)
        )
        // 升过 12.0 才解除
        assertEquals(
            AlertPulse.NONE,
            AlertPulse.levelWithLow(release + 0.01f, null, null, LOW, AlertPulse.WARN_LOW)
        )
    }

    @Test
    fun `下限在阈值附近抖动不会来回跳`() {
        var lvl = AlertPulse.NONE
        // 在 11.5 上下抖 —— 这正是电压表的日常
        val samples = listOf(11.6f, 11.4f, 11.7f, 11.3f, 11.8f, 11.2f, 11.9f, 11.1f)
        for (v in samples) lvl = AlertPulse.levelWithLow(v, null, null, LOW, lvl)
        assertEquals("抖一轮后应稳定在 WARN_LOW", AlertPulse.WARN_LOW, lvl)
    }

    @Test
    fun `下限报警不参与爆闪`() {
        // 这是「行为不变」的关键断言：下限只染色。
        // 爆闪的语义是"立刻松油门/靠边"，数值偏低不需要这种紧迫感，
        // 硬要闪反而会让驾驶员对爆闪脱敏。
        for (t in 0L..1200L step 100L) {
            assertEquals(
                "WARN_LOW 在任何时刻的爆闪强度都必须是 0",
                0f,
                AlertPulse.intensity(AlertPulse.WARN_LOW, t),
                1e-6f
            )
            assertEquals(
                "WARN_LOW 在任何时刻的染色比例都必须是 0",
                0f,
                AlertPulse.tintMix(AlertPulse.WARN_LOW, t),
                1e-6f
            )
        }
    }

    @Test
    fun `上限报警仍然爆闪 —— 反证`() {
        // 反向确认：不能因为"下限不闪"把上限也一起弄没了。
        // 取一个必然亮的相位（方波周期 200ms 占空 0.5 → 前 100ms 亮）
        assertEquals(1f, AlertPulse.intensity(AlertPulse.CRITICAL, 0L), 1e-6f)
        assertTrue("WARN 是平滑脉冲，峰值必须大于 0", AlertPulse.intensity(AlertPulse.WARN, 300L) > 0f)
    }

    @Test
    fun `从下限切到上限时迟滞不会互相解锁`() {
        // 两个阈值各用各的迟滞。若共用 prev，从 WARN_LOW 切到上限时会
        // 误用下限的放宽阈值，两个阈值附近都开始抖
        var lvl = AlertPulse.WARN_LOW
        // 电压回到 12.5（明确高于下限的退出阈值 12.0）→ 解除
        lvl = AlertPulse.levelWithLow(12.5f, W, C, LOW, lvl)
        assertEquals(AlertPulse.NONE, lvl)
        // 再冲上限 → 按**原阈值**进入（不能被下限的 prev 影响）
        lvl = AlertPulse.levelWithLow(W, W, C, LOW, lvl)
        assertEquals(AlertPulse.WARN, lvl)
    }

    @Test
    fun `null 与 NaN 在有下限时也不报警`() {
        assertEquals(AlertPulse.NONE, AlertPulse.levelWithLow(null, W, C, LOW, AlertPulse.WARN_LOW))
        assertEquals(AlertPulse.NONE, AlertPulse.levelWithLow(Float.NaN, W, C, LOW, AlertPulse.WARN))
    }
}
