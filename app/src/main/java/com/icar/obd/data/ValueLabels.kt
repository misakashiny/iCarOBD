package com.icar.obd.data

import org.json.JSONArray

/**
 * **数值 → 文字 的映射表**（`valueLabels`）。
 *
 * ## 解决什么问题（P9「非数值 PID 模型」，方向 A）
 *
 * PID 模型是 `min~max` 的**连续数值**，但车上有一类数据**不是数**：
 * 挡位（`P / R / N / 1..6`）、驾驶模式、故障等级。它们既不是连续量，
 * 也不该为它们把数据模型改成"文本型 PID"（那要动格式、两侧解析、渲染、告警）。
 *
 * 方向 A 的做法：**值仍然是一个数**（挡位就是 0..8），**显示时查一张映射表**。
 * 于是：
 *
 * - 数据模型不动 —— 采集、告警阈值、动画、指针角度**全部照旧按数值走**
 * - 只有**读数文本**换成表里的字符串
 * - 映射表**跟着设计文件走**（存进节点的 `valueLabels`），
 *   所以同一份设计在哪台设备上显示都一样
 *
 * ## 为什么不用"文本型 PID"
 *
 * 见 `docs/主题设计大纲.md` §2.87 的三个方向对比。要点：
 * 布尔（指示灯亮/灭）**根本不需要映射表** —— `min=0, max=1, warnHigh=0.5`
 * 就已经能驱动既有的三态图（0 → 正常，1 → 严重）。
 * 真正需要映射的只有**枚举**（挡位这类"数值有意义但要有名字"的）。
 * 所以这一层做窄一点，只解决枚举显示。
 *
 * ## 语义（**必须与工具侧 `valueLabelFor()` 逐字一致**）
 *
 * | 情况 | 结果 |
 * |---|---|
 * | `valueLabels` 为空 / 全空串 | **不用映射**（返回 null，调用方走原来的数字格式化） |
 * | 值是 NaN / null | 返回 null（调用方显示 `--`） |
 * | `round(value)` 越界 | **夹到 `0..size-1`**（不报错、也不是不显示） |
 *
 * ⚠️ **用 `round` 而不是 `toInt`**：`4.999` 是"第 5 挡"。
 * `toInt()` 会截成 4 —— 指针已经指到第 5 挡的位置而读数写 4。
 * 这类"差一格"的错最难发现：**两者都不报错，只有盯着看才发现**。
 */
object ValueLabels {

    /** 最多几项映射（防止手改文件写出几万项） */
    const val MAX = 32

    /**
     * 查表。**没有映射表时返回 null** —— 调用方据此回落到数字格式化。
     *
     * 所以"没设过"与"设成了空表"行为一致，**不需要迁移**。
     */
    fun labelFor(labels: List<String>?, value: Float?): String? {
        if (value == null || value.isNaN()) return null
        if (!isUsable(labels)) return null
        val i = Math.round(value).coerceIn(0, labels!!.size - 1)
        return labels[i]
    }

    /**
     * 有没有**可用**的映射表。
     *
     * 判据是"至少有一项非空"而不是"数组非空" —— 用户清空文本框会留下
     * `["","",""]` 这种空表，那等于没设，不该让读数变成空字符串。
     */
    fun isUsable(labels: List<String>?): Boolean =
        !labels.isNullOrEmpty() && labels.any { it.isNotEmpty() }

    /** 解析 `valueLabels`；超过 [MAX] 截断（**不报错**，与工具侧一致） */
    fun parse(arr: JSONArray?): MutableList<String> {
        val out = mutableListOf<String>()
        if (arr == null) return out
        for (i in 0 until minOf(arr.length(), MAX)) out.add(arr.optString(i, ""))
        return out
    }

    /** 写回 JSON。**空表不写字段** —— 旧版本读不到 = 不用映射，语义一致 */
    fun toJson(labels: List<String>?): JSONArray? {
        if (!isUsable(labels)) return null
        val a = JSONArray()
        labels!!.forEach { a.put(it) }
        return a
    }
}
