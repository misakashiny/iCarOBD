package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * P5B-M04：`icar.ui/3` 四种**高级基元**的节点解析。
 *
 * ## 为什么单独成文件、单独成对象
 *
 * 第一版把这些函数塞进 `DesignNode.companion object`，结果触发了一个很怪的编译错误：
 * `DashRenderer.kt` 报「`CanvasRebuildPolicy` 是 internal，不可访问」——
 * 而那个对象跟本文件毫无关系。二分定位确认是本文件的改动导致的，
 * 但结构、括号、修饰符全都正常。
 *
 * **教训**：往一个 1000 行的既有类里加大段新逻辑，出问题时的排查成本极高。
 * 单独成文件后：
 *   · `DesignNode` 只加一个 `prim: PrimitiveFields?` 字段 + 四个 when 分支
 *   · 解析逻辑可以单独编译、单独单测
 *   · 出问题时一眼能定位到文件
 *
 * ## 与规范的关系
 *
 * 每个函数的字段都与 [docs/01_专题/98_P5B_M04_v3主题格式规范.md] 的字段表**逐一对应**。
 * **改字段必须同时改规范文档 + 编辑器 schema.js + 跨语言比对套件。**
 *
 * ## 设计原则
 *
 *   · 所有数值夹到合法区间（无效数据不崩）
 *   · 非致命问题 → `out.warnings`；致命问题 → `errors` + 返回 false
 *   · **不新增独立数据采集入口** —— 只存"绑哪个 PID"，取值由 View 走 VehicleBus
 */
object PrimitiveParser {

    /** 自由路径点数的**资源上限**（任务 §九 明确要求）*/
    const val MAX_POINTS = 64

    // ================================================================
    // valueText
    // ================================================================

    fun parseValueText(o: JSONObject, path: String, out: PrimitiveFields): Boolean {
        out.pid = DesignFile.resolvePid(o.optString("pid", ""))
        out.decimals = o.optInt("decimals", 0).coerceIn(0, 3)
        out.unit = o.optString("unit", "")
        out.prefix = o.optString("prefix", "")
        out.suffix = o.optString("suffix", "")
        out.valueLabels = o.optJSONArray("valueLabels")?.let { arr ->
            (0 until arr.length()).map { arr.optString(it, "") }
        }
        out.size = o.optDouble("size", 28.0).toFloat().coerceIn(1f, 200f)
        out.unitSize = o.optDouble("unitSize", 12.0).toFloat().coerceIn(1f, 100f)
        out.align = o.optInt("align", 1).coerceIn(0, 2)
        out.color = parseColor(o.optString("color", "#FFFFFF"), 0xFFFFFFFF.toInt())
        out.warnColor = parseColor(o.optString("warnColor", "#FFB020"), 0xFFFFB020.toInt())
        out.criticalColor = parseColor(o.optString("criticalColor", "#FF4D4F"), 0xFFFF4D4F.toInt())
        out.noDataColor = parseColor(o.optString("noDataColor", "#7A8088"), 0xFF7A8088.toInt())
        out.warnHigh = if (o.has("warnHigh")) o.optDouble("warnHigh", 0.0).toFloat() else null
        out.criticalHigh = if (o.has("criticalHigh")) o.optDouble("criticalHigh", 0.0).toFloat() else null
        return true
    }

    // ================================================================
    // shape
    // ================================================================

    fun parseShape(o: JSONObject, path: String, out: PrimitiveFields, w: Float, h: Float): Boolean {
        val k = o.optString("kind", ShapeKind.RECT)
        out.kind = if (k in ShapeKind.ALL) k else ShapeKind.RECT
        if (out.kind != k) {
            out.warnings.add("$path.kind = $k 不认识（认：${ShapeKind.ALL.joinToString("/")}）—— 已回落 rect")
        }
        out.fill = parseColorOrNone(o.optString("fill", "#3DD6FF"))
        out.stroke = parseColorOrNone(o.optString("stroke", "none"))
        out.strokeWidth = o.optDouble("strokeWidth", 0.0).toFloat().coerceIn(0f, 100f)
        // 圆角上限 = 短边一半（与工具侧 clampCorner 一致）
        val maxCorner = minOf(Math.abs(w), Math.abs(h)) / 2f
        val cr = o.optDouble("cornerRadius", 12.0).toFloat().coerceAtLeast(0f)
        out.cornerRadius = cr.coerceAtMost(maxCorner)
        if (cr > maxCorner) {
            out.warnings.add("$path.cornerRadius = $cr 超出短边一半（$maxCorner），已夹取")
        }
        out.innerRatio = o.optDouble("innerRatio", 0.6).toFloat().coerceIn(0.05f, 0.95f)
        out.points = parsePoints(o.optJSONArray("points"), MAX_POINTS, path, out.warnings)
        out.rotationDeg = o.optDouble("rotationDeg", 0.0).toFloat()
        return true
    }

    // ================================================================
    // segmentedArc
    // ================================================================

    fun parseSegmentedArc(
        o: JSONObject, path: String, out: PrimitiveFields, errors: MutableList<String>
    ): Boolean {
        out.pid = DesignFile.resolvePid(o.optString("pid", ""))
        out.minVal = o.optDouble("minVal", 0.0).toFloat()
        out.maxVal = o.optDouble("maxVal", 100.0).toFloat()
        if (out.maxVal <= out.minVal) {
            errors.add("$path 的量程非法：min=${out.minVal} ≥ max=${out.maxVal}")
            return false
        }
        out.startAngle = o.optDouble("startAngle", 150.0).toFloat()
        out.sweepAngle = o.optDouble("sweepAngle", 240.0).toFloat().coerceIn(-360f, 360f)
        out.segmentCount = o.optInt("segmentCount", 24).coerceIn(1, 360)
        out.gapAngle = o.optDouble("gapAngle", 2.0).toFloat().coerceIn(0f, 90f)
        out.thickness = o.optDouble("thickness", 12.0).toFloat().coerceIn(0.5f, 200f)
        out.activeColor = parseColor(o.optString("activeColor", "#FF3D7F"), 0xFFFF3D7F.toInt())
        out.inactiveColor = parseColor(o.optString("inactiveColor", "#4A5058"), 0xFF4A5058.toInt())
        out.noDataColor = parseColor(o.optString("noDataColor", "#FF4D4F"), 0xFFFF4D4F.toInt())
        out.radiusRatio = o.optDouble("radiusRatio", 0.42).toFloat().coerceIn(0.05f, 0.5f)
        out.zoneColors = parseZoneColors(o.optJSONArray("zoneColors"))
        return true
    }

    // ================================================================
    // pathProgress
    // ================================================================

    fun parsePathProgress(
        o: JSONObject, path: String, out: PrimitiveFields, errors: MutableList<String>
    ): Boolean {
        out.pid = DesignFile.resolvePid(o.optString("pid", ""))
        out.minVal = o.optDouble("minVal", 0.0).toFloat()
        out.maxVal = o.optDouble("maxVal", 100.0).toFloat()
        if (out.maxVal <= out.minVal) {
            errors.add("$path 的量程非法：min=${out.minVal} ≥ max=${out.maxVal}")
            return false
        }
        val rawPts = o.optJSONArray("points")
        val n = rawPts?.length() ?: 0
        // 资源上限：**拒绝**而不是静默截断（静默截断会让用户以为曲线就这么短）
        if (n > MAX_POINTS) {
            errors.add("$path.points 有 $n 个点，超过上限 $MAX_POINTS —— 请拆分或精简曲线")
            return false
        }
        out.points = parsePoints(rawPts, MAX_POINTS, path, out.warnings)
        if (out.points.size < 2) {
            errors.add("$path.points 至少需要 2 个有效点（实际 ${out.points.size}）")
            return false
        }
        out.curve = o.optInt("curve", 0).coerceIn(0, 1)
        out.thickness = o.optDouble("thickness", 6.0).toFloat().coerceIn(0.5f, 100f)
        out.activeColor = parseColor(o.optString("activeColor", "#3DD6FF"), 0xFF3DD6FF.toInt())
        out.inactiveColor = parseColor(o.optString("inactiveColor", "#2A3038"), 0xFF2A3038.toInt())
        out.gradientTo = parseColorOrNone(o.optString("gradientTo", "none"))
        out.fillEnabled = o.optBoolean("fill", false)
        out.fillColor = parseColor(o.optString("fillColor", "#3300C8FF"), 0x3300C8FF)
        out.forward = o.optBoolean("forward", true)
        return true
    }

    // ================================================================
    // 公共小工具
    // ================================================================

    /** 归一化点数组（滤 NaN/Inf，夹 0..1）*/
    private fun parsePoints(
        arr: JSONArray?, limit: Int, path: String, warnings: MutableList<String>
    ): List<FloatArray> {
        if (arr == null) return emptyList()
        val out = ArrayList<FloatArray>(arr.length())
        for (i in 0 until minOf(arr.length(), limit)) {
            val p = arr.optJSONObject(i) ?: continue
            val x = p.optDouble("x", Double.NaN).toFloat()
            val y = p.optDouble("y", Double.NaN).toFloat()
            if (!x.isFinite() || !y.isFinite()) {
                warnings.add("$path.points[$i] 坐标非法（x=$x y=$y）—— 已跳过")
                continue
            }
            out.add(floatArrayOf(x.coerceIn(0f, 1f), y.coerceIn(0f, 1f)))
        }
        return out
    }

    /** 解析 `#RRGGBB` / `#AARRGGBB`；`"none"` → 0（透明）*/
    fun parseColorOrNone(s: String): Int =
        if (s.isBlank() || s.equals("none", true)) 0 else parseColor(s, 0)

    /** 解析颜色；失败返回 fallback（不抛）*/
    fun parseColor(s: String, fallback: Int): Int {
        val t = s.trim()
        if (t.isEmpty()) return fallback
        return try {
            when {
                t.startsWith("#") && t.length == 9 -> t.substring(1).toLong(16).toInt()
                t.startsWith("#") && t.length == 7 -> (0xFF000000L or t.substring(1).toLong(16)).toInt()
                else -> fallback
            }
        } catch (e: NumberFormatException) {
            fallback
        }
    }

    /** 解析分区色（`[{at,color}]`，按 `at` 升序）*/
    private fun parseZoneColors(arr: JSONArray?): List<Pair<Float, Int>> {
        if (arr == null) return emptyList()
        val out = ArrayList<Pair<Float, Int>>(arr.length())
        for (i in 0 until arr.length()) {
            val z = arr.optJSONObject(i) ?: continue
            val at = z.optDouble("at", Double.NaN).toFloat()
            if (!at.isFinite()) continue
            out.add(Pair(at.coerceIn(0f, 1f), parseColor(z.optString("color", "#FFFFFF"), 0xFFFFFFFF.toInt())))
        }
        return out.sortedBy { it.first }
    }
}
