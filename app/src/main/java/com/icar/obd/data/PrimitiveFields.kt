package com.icar.obd.data

/**
 * P5B-M04：`icar.ui/3` 四种**高级基元**节点共用的字段容器。
 *
 * ## 为什么用一个共享容器而不是四个独立类
 *
 * 四种节点的字段**大量重叠**（PID、量程、颜色、点数组、厚度…）。
 * 四个独立类会产生四份几乎相同的解析代码，而解析代码是**最容易两端不一致**的地方。
 *
 * 用共享容器 + 每 type 一个 `parseXxx()` 纯函数（见 `DesignNode.parseValueText` 等），
 * 好处是：
 *   · 字段默认值只写一份
 *   · 无效值夹取只写一份
 *   · 单测可以逐个 parse 函数打
 *
 * ## 与正式契约的关系
 *
 * 本类的每个字段都对应 [98_P5B_M04_v3主题格式规范] 里的一张表。
 * **改字段必须同时改规范文档、编辑器 `schema.js`、以及跨语言比对套件。**
 */
data class PrimitiveFields(
    // ---- 数据绑定（valueText / segmentedArc / pathProgress 共用）
    /** 解析后的 PID id（空 = 不绑定）*/
    var pid: String = "",
    /** 量程（segmentedArc / pathProgress 用）*/
    var minVal: Float = 0f,
    var maxVal: Float = 100f,

    // ---- valueText
    var decimals: Int = 0,
    var unit: String = "",
    var prefix: String = "",
    var suffix: String = "",
    var valueLabels: List<String>? = null,
    var size: Float = 28f,
    var unitSize: Float = 12f,
    var align: Int = 1,
    var color: Int = 0xFFFFFFFF.toInt(),
    var warnColor: Int = 0xFFFFB020.toInt(),
    var criticalColor: Int = 0xFFFF4D4F.toInt(),
    var noDataColor: Int = 0xFF7A8088.toInt(),
    var warnHigh: Float? = null,
    var criticalHigh: Float? = null,

    // ---- shape
    var kind: String = ShapeKind.RECT,
    var fill: Int = 0xFF3DD6FF.toInt(),
    var stroke: Int = 0,
    var strokeWidth: Float = 0f,
    var cornerRadius: Float = 12f,
    var innerRatio: Float = 0.6f,
    var rotationDeg: Float = 0f,

    // ---- segmentedArc
    var startAngle: Float = 150f,
    var sweepAngle: Float = 240f,
    var segmentCount: Int = 24,
    var gapAngle: Float = 2f,
    var thickness: Float = 12f,
    var activeColor: Int = 0xFFFF3D7F.toInt(),
    var inactiveColor: Int = 0xFF4A5058.toInt(),
    var zoneColors: List<Pair<Float, Int>> = emptyList(),
    var radiusRatio: Float = 0.42f,

    // ---- pathProgress
    /** 归一化控制点（x/y ∈ 0..1），最多 [DesignNode.MAX_POINTS] 个 */
    var points: List<FloatArray> = emptyList(),
    var curve: Int = 0,
    var gradientTo: Int = 0,
    var fillEnabled: Boolean = false,
    var fillColor: Int = 0x3300C8FF,
    var forward: Boolean = true,

    /** 解析过程中的**非致命**问题（夹取、回落等）*/
    val warnings: MutableList<String> = ArrayList(),
) {
    /** 有数据绑定吗 */
    val hasBinding: Boolean get() = pid.isNotEmpty()

}

/** `shape` 的 6 种图形（与编辑器原型同一套名字）*/
object ShapeKind {
    const val RECT = "rect"
    const val ROUND_RECT = "roundRect"
    const val CIRCLE = "circle"
    const val RING = "ring"
    const val LINE = "line"
    const val POLYLINE = "polyline"

    val ALL = listOf(RECT, ROUND_RECT, CIRCLE, RING, LINE, POLYLINE)
}
