package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * **一次规则触发只能有一处提示**（v1.20.21 的回归）。
 *
 * ## 被修掉的故障
 *
 * 用户原话：「还有弹出提示的时候是**两个弹出提示**、我只需要灵动岛的版本」。
 *
 * `ObdController.handleAction` 的 `"toast"` 分支原来同时调了：
 *   · `toast(msg)`    → `Toast.makeText` —— 屏幕中下部一个系统 Toast
 *   · `emitAlert(...)` → `MainActivity.onAlert` → 灵动岛 —— 屏幕顶部一个胶囊
 *
 * 两个都真的弹。**"两个提示"这件事在真机上只看得出"弹了两次"，
 * 看不出是谁弹的** —— 所以这条约束必须落在纯逻辑层（[RuleAlertRouting]）上，
 * 而不是靠装机时数一数。
 *
 * ## 为什么还要一条"源码级"用例
 *
 * [RuleAlertRouting] 只能证明**表**是对的。真正会再犯的地方是
 * `handleAction` 里有人**绕过表**又加一句 `toast(msg)` —— 那正是原来的写法。
 * 所以最后一条用例直接读 `ObdController.kt`，把那个分支的**代码**
 * （剥掉注释后）扫一遍。
 */
class RuleAlertRoutingTest {

    // ---------------------------------------------------------------- 出口表

    @Test
    fun `toast 动作只有灵动岛一个出口`() {
        assertEquals(listOf(AlertChannel.ISLAND), RuleAlertRouting.channelsFor("toast"))
        assertTrue(RuleAlertRouting.usesIsland("toast"))
    }

    @Test
    fun `notify 动作只有系统通知一个出口`() {
        assertEquals(listOf(AlertChannel.SYSTEM_NOTIFICATION), RuleAlertRouting.channelsFor("notify"))
        assertFalse("通知不该顺手也弹灵动岛", RuleAlertRouting.usesIsland("notify"))
    }

    /**
     * 🔴 **本类最重要的一条** —— v1.20.20 及以前这里是真的。
     *
     * 它不针对某一个动作类型，而是**对所有类型**成立：
     * 只要有一个类型同时走灵动岛与系统 Toast，"一次弹两个"就回来了。
     */
    @Test
    fun `没有任何动作类型同时走灵动岛和系统 Toast`() {
        val all = listOf("sound", "toast", "log", "gauge", "vibrate", "notify", "", "weird", "TOAST", " Toast ")
        all.forEach { t ->
            assertFalse(
                "动作类型 '$t' 同时有灵动岛与系统 Toast 两个出口 —— 用户会看到两个提示",
                RuleAlertRouting.usesIsland(t) && RuleAlertRouting.usesSystemToast(t)
            )
        }
        // 顺带把"系统 Toast 这个出口对规则动作完全关着"钉死
        all.forEach { t ->
            assertFalse("规则动作 '$t' 不许走系统 Toast", RuleAlertRouting.usesSystemToast(t))
        }
    }

    @Test
    fun `每个动作类型的可视出口不超过一个`() {
        listOf("sound", "toast", "log", "gauge", "vibrate", "notify", "", "weird").forEach { t ->
            val n = RuleAlertRouting.channelsFor(t).size
            assertTrue("动作类型 '$t' 有 $n 个可视出口（约定 ≤ 1）", n <= 1)
        }
    }

    @Test
    fun `只有 toast 与 notify 有可视出口`() {
        // 这几个的效果在别处：sound 只有声音、log 只写日志、gauge 改仪表颜色、
        // vibrate 只有振动。它们**不该**顺带弹任何东西。
        listOf("sound", "log", "gauge", "vibrate", "", "weird").forEach { t ->
            assertTrue("动作类型 '$t' 不该有可视出口", RuleAlertRouting.channelsFor(t).isEmpty())
        }
    }

    @Test
    fun `动作类型大小写与空白容错`() {
        // 存量的规则 JSON 里 type 是人写的，历史上出现过 " Toast " 这种写法
        assertEquals(listOf(AlertChannel.ISLAND), RuleAlertRouting.channelsFor("  TOAST  "))
        assertEquals(listOf(AlertChannel.SYSTEM_NOTIFICATION), RuleAlertRouting.channelsFor("Notify"))
    }

    // ---------------------------------------------------------------- 文案

    @Test
    fun `灵动岛文案带统一前缀`() {
        assertEquals("⚠ 水温过高", RuleAlertRouting.islandText("水温过高"))
        assertTrue("前缀是「这是一条提示」的标记", RuleAlertRouting.ISLAND_PREFIX.isNotBlank())
    }

    @Test
    fun `动作文案为空时回退规则名`() {
        assertEquals("高水温告警", RuleAlertRouting.messageOf("", "高水温告警"))
        assertEquals("高水温告警", RuleAlertRouting.messageOf("   ", "高水温告警"))
        assertEquals("自定义文案", RuleAlertRouting.messageOf("自定义文案", "高水温告警"))
    }

    @Test
    fun `预览文案两个都空时给示例而不是空胶囊`() {
        // `IslandNotice.show` 对空文案是**直接 return**（不弹一个空胶囊）。
        // 所以"没填内容 + 点 ▶"如果不给示例，用户会以为按钮坏了。
        assertEquals(RuleAlertRouting.DEFAULT_PREVIEW, RuleAlertRouting.previewText("", ""))
        assertEquals(RuleAlertRouting.DEFAULT_PREVIEW, RuleAlertRouting.previewText("  ", "  "))
        assertEquals("电瓶电压偏低", RuleAlertRouting.previewText("电瓶电压偏低", "规则名"))
        assertEquals("规则名", RuleAlertRouting.previewText("", "规则名"))
        assertNotNull(RuleAlertRouting.DEFAULT_PREVIEW)
        assertTrue(RuleAlertRouting.DEFAULT_PREVIEW.isNotBlank())
    }

    // ---------------------------------------------------------------- 源码级回归

    /**
     * 定位 `ObdController.kt`（单测工作目录在不同调用方式下不一样，见 `ThemeStudioSampleTest`）。
     * ⚠️ 找不到就**失败**，不跳过 —— 跳过会让这条回归静默不跑。
     */
    private fun obdControllerSource(): File {
        val rel = "src/main/java/com/icar/obd/obd/ObdController.kt"
        val candidates = listOf(
            File(rel),                       // 从 app/ 跑（Gradle 的默认工作目录）
            File("../$rel"),                 // 从工程根跑
            File(System.getProperty("user.dir"), rel),
            File(System.getProperty("user.dir"), "../$rel"),
        )
        return candidates.firstOrNull { it.isFile } ?: throw AssertionError(
            "找不到 ObdController.kt —— 试过这些路径：\n" +
                candidates.joinToString("\n") { "  " + it.absolutePath } +
                "\n当前工作目录：${System.getProperty("user.dir")}\n" +
                "请在工程目录下运行 tools/run-tests.ps1。\n" +
                "⚠️ 这里刻意**不**跳过：跳过等于这条回归这一轮没跑。"
        )
    }

    /**
     * 剥掉注释。
     *
     * 判据必须是**代码**：那条分支的注释里**故意**写着 `toast(msg)` 来告诉后来者
     * "原来就是这么错的、别再加回来"。不剥注释的话，一段劝阻性的注释
     * 会把这条用例变成假的红。
     */
    private fun stripComments(src: String): String {
        val noBlock = Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL).replace(src, " ")
        return noBlock.lines().joinToString("\n") { it.substringBefore("//") }
    }

    @Test
    fun `规则提示动作不再直接弹系统 Toast —— 源码级回归`() {
        val src = obdControllerSource().readText()
        assertTrue(
            "ObdController.kt 里找不到 `\"toast\" ->` 分支 —— 用例的定位前提坏了，先修用例",
            src.contains("\"toast\" ->")
        )
        val branch = stripComments(src).substringAfter("\"toast\" ->").substringBefore("\"log\" ->")
        assertTrue("分支定位异常（截出来只有 ${branch.length} 字符）", branch.length in 20..4000)
        assertFalse(
            "`\"toast\"` 分支里又出现了 toast(...) —— 那正是 v1.20.20 及以前" +
                "「一次规则弹两个提示」的写法（系统 Toast + 灵动岛）。" +
                "规则提示只能走 emitAlert（灵动岛）。\n分支原文：\n$branch",
            Regex("\\btoast\\s*\\(").containsMatchIn(branch)
        )
        assertTrue(
            "`\"toast\"` 分支必须走 RuleAlertRouting（出口表的唯一消费者）",
            branch.contains("RuleAlertRouting")
        )
        assertTrue("`\"toast\"` 分支必须真的发灵动岛", branch.contains("emitAlert("))
    }
}
