package com.icar.obd.data

/**
 * 内置 PID 库。
 *
 * 分三类：
 *  1) Mode 01 标准 OBD —— 任何车都支持，直接可用
 *  2) 派生通道（mode=CALC）—— 由其它 PID 实时算出来
 *  3) 厂家 PID 模板（mode 22）—— 标记为「未验证」，默认关闭，
 *     等你用内置扫描器在阿特兹上确认后改一下 PID 号与公式即可
 *
 * 厂家 PID 的 PID 号是猜不得的。这里只给「公式骨架 + 用法说明」，
 * 真正的 PID 号请用 PID 扫描器扫出来再填。
 */
object BuiltInPids {

    // ---- 标准 Mode 01 ----
    private fun std(
        pid: String, name: String, formula: String, unit: String,
        min: Float, max: Float, warnLow: Float? = null, warnHigh: Float? = null,
        enabled: Boolean = true, interval: Int = 0, group: String = "标准 OBD",
        note: String = ""
    ) = PidDefinition(
        id = "std_$pid", name = name, mode = "01", pid = pid, formula = formula, unit = unit,
        minVal = min, maxVal = max, warnLow = warnLow, warnHigh = warnHigh,
        enabled = enabled, builtIn = true, intervalMs = interval, group = group, note = note
    )

    /** 派生通道：mode=CALC，pid 作为 key，由 DerivedChannels 计算 */
    private fun calc(
        key: String, name: String, unit: String, min: Float, max: Float,
        warnHigh: Float? = null, group: String = "派生"
    ) = PidDefinition(
        id = key, name = name, mode = "CALC", pid = key, formula = "A", unit = unit,
        minVal = min, maxVal = max, warnHigh = warnHigh,
        enabled = true, builtIn = true, group = group, note = "由其它通道实时计算"
    )

    val STANDARD: List<PidDefinition> = listOf(
        std("0C", "发动机转速", "((A*256)+B)/4", "rpm", 0f, 8000f, warnHigh = 6500f, interval = 0,
            note = "最基础的通道，所有车都支持"),
        std("0D", "车速", "A", "km/h", 0f, 260f, warnHigh = 120f),
        std("05", "冷却液温度", "A-40", "℃", -40f, 215f, warnLow = 60f, warnHigh = 105f,
            note = "阿特兹正常工作约 85~95℃"),
        std("42", "控制模块电压", "((A*256)+B)/1000", "V", 0f, 20f, warnLow = 11.8f, warnHigh = 15.2f,
            note = "怠速约 13.5~14.5V，低于 11.8V 说明电瓶/发电机有问题"),
        std("04", "发动机负荷", "A*100/255", "%", 0f, 100f),
        std("11", "节气门开度", "A*100/255", "%", 0f, 100f),
        std("0F", "进气温度", "A-40", "℃", -40f, 215f, warnHigh = 70f),
        std("10", "空气流量 MAF", "((A*256)+B)/100", "g/s", 0f, 655f),
        std("06", "短期燃油修正 STFT", "(A-128)*100/128", "%", -100f, 100f, warnLow = -15f, warnHigh = 15f),
        std("07", "长期燃油修正 LTFT", "(A-128)*100/128", "%", -100f, 100f, warnLow = -15f, warnHigh = 15f),
        std("5E", "燃油消耗率", "((A*256)+B)*0.05", "L/h", 0f, 100f,
            note = "不是所有车都支持；不支持时可用派生通道「瞬时油耗」"),
        std("0B", "进气歧管压力 MAP", "A", "kPa", 0f, 255f),
        std("2F", "燃油液位", "A*100/255", "%", 0f, 100f, warnLow = 15f),
        std("46", "环境温度", "A-40", "℃", -40f, 215f),
        std("5C", "机油温度", "A-40", "℃", -40f, 215f, warnHigh = 130f),
        std("33", "大气压力", "A", "kPa", 0f, 255f),
        std("0E", "点火提前角", "(A-128)/2", "°", -64f, 63f),
        std("49", "油门踏板位置 D", "A*100/255", "%", 0f, 100f),
        std("1F", "启动后运行时间", "(A*256)+B", "s", 0f, 65535f),
        std("21", "故障灯后里程", "(A*256)+B", "km", 0f, 65535f),
    )

    val DERIVED: List<PidDefinition> = listOf(
        calc("calc_l100", "瞬时油耗", "L/100km", 0f, 40f, warnHigh = 15f),
        calc("calc_lh", "燃油流量", "L/h", 0f, 60f),
        calc("calc_boost", "增压压力", "kPa", -100f, 300f),
        calc("calc_km", "本次里程", "km", 0f, 9999f),
        // G 值三兄弟：数据源是平板加速度计（首选）或车速差分（回退），
        // 由 data/GForceSource 写入 VehicleBus。见 HANDOVER「G力值」一节。
        calc("calc_gforce", "综合G值", "G", 0f, 2f),
        calc("calc_gx", "横向G值", "G", -2f, 2f),
        calc("calc_gy", "纵向G值", "G", -2f, 2f),
    )

    /**
     * 厂家 PID 模板（默认关闭）。
     * 这些是「结构示例」，PID 号必须与你的车对得上才有意义。
     * 找到真实 PID 后：复制一条 → 改 PID 号/公式 → 用编辑器测试 → 启用。
     */
    val MANUFACTURER_TEMPLATES: List<PidDefinition> = listOf(
        PidDefinition(
            id = "tpl_atf", name = "示例-变速箱油温 ATF", protocol = "CAN", mode = "22", pid = "1234",
            formula = "((A*256)+B)*0.1-40", unit = "℃", minVal = -40f, maxVal = 180f,
            warnHigh = 120f, enabled = false, builtIn = true, group = "厂家模板(未验证)",
            note = "PID 号 1234 为占位示例。请用 PID 扫描器在阿特兹上扫 Mode 22 找到真实 PID 后修改。"
        ),
        PidDefinition(
            id = "tpl_left_turn", name = "示例-左转向信号", protocol = "CAN", mode = "22", pid = "2201",
            formula = "bit(A,0)", unit = "", minVal = 0f, maxVal = 1f,
            enabled = false, builtIn = true, group = "厂家模板(未验证)",
            note = "转向灯不在标准 OBD 里。需扫描 BCM 广播帧找到开关量位。找到后配合规则引擎播放 tick 音效。"
        ),
        PidDefinition(
            id = "tpl_right_turn", name = "示例-右转向信号", protocol = "CAN", mode = "22", pid = "2202",
            formula = "bit(A,1)", unit = "", minVal = 0f, maxVal = 1f,
            enabled = false, builtIn = true, group = "厂家模板(未验证)",
            note = "同上，右转向一般在同一个字节的相邻位。"
        ),
        PidDefinition(
            id = "tpl_steer_angle", name = "示例-方向盘转角", protocol = "CAN", mode = "22", pid = "2300",
            formula = "signed(A)*256+B", unit = "°", minVal = -720f, maxVal = 720f,
            enabled = false, builtIn = true, group = "厂家模板(未验证)",
            note = "占位示例，需实测确认字节序与符号位。"
        ),
    )

    fun all(): List<PidDefinition> = STANDARD + DERIVED + MANUFACTURER_TEMPLATES
}
