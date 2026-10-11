package com.icar.obd.data

import com.icar.obd.R

/**
 * 一个内置预设音效。
 *
 * @param id       **机器名**（存进规则 JSON 的 `p1`，也是 `res/raw/<id>.wav` 的文件名）。
 *                 只允许小写字母与下划线 —— Android 的资源名规则。
 * @param label    **给人看的名字**。它会被拼进规则描述（"播放音效 叮咚（双音）"），
 *                 所以必须能独立成句，不许出现 `sound1` / `preset_a` 这类名字。
 * @param category 语义分组（"轻提示 / 成功 / 失败 / 警告 / 严重 / 转向"），
 *                 编辑器按它给用户分类，不参与任何逻辑。
 * @param hint     一句话说明"什么时候该用它"（编辑器列表里的小字）
 */
data class SoundPreset(
    val id: String,
    val label: String,
    val category: String,
    val hint: String,
    /** `res/raw` 资源 id。**唯一一处**"音效名 → 资源"的映射 */
    val resId: Int
)

/**
 * 规则可选的**预设音效**清单（v1.20.21）。
 *
 * ## 为什么要有它
 *
 * 用户原话：「规则里增加更多的预设音效」。
 *
 * 之前只有四个（`tick_left` / `tick_right` / `warn` / `beep`），而且编辑器里
 * **没有任何选择入口** —— `p1` 是一个自由文本框，用户得**手打** `tick_left`
 * 这种机器名才用得上（打错了 `AudioPlayer` 会静默回退 `beep`，现象上完全看不出来）。
 *
 * ## 三条约定
 *
 * ### ① 音频**全部由代码合成**，不下载任何外部文件
 *
 * 生成器是 [`tools/gen_sounds.py`](../../../../../tools/gen_sounds.py)（纯标准库，
 * 正弦/方波 + 指数包络）。理由有两条：**版权**（来路不明的音频不能用）和
 * **可复现**（重跑脚本就能重新得到逐字节相同的 wav）。
 *
 * ### ② 每个文件 ≤ 20 KB
 *
 * 采样率 22050Hz / 16bit / 单声道 → **44 字节/毫秒**。
 * 所以"时长 ≤ 440ms"就是这条约束的全部内容（有单测逐个量文件大小）。
 * 转向灯那两个咔嗒声例外：它们必须 44100Hz（咔嗒的"咔"在 11kHz 以上还有能量，
 * 降采样会变闷），但它们只有 55ms，本来就不到 2.5 KB。
 *
 * ### ③ 这张表是**唯一权威**
 *
 * `AudioPlayer` 的加载表由 [ALL] 推导出来（不再手写第二份 `linkedMapOf`）——
 * 两份表分叉过的地方，本项目已经栽过好几次。新增音效只要：
 *   1) 在 `tools/gen_sounds.py` 里加一条合成 + 重跑脚本；
 *   2) 在这里加一行。
 */
object SoundPresets {

    /**
     * 全部预设，**顺序即编辑器列表顺序**（按"多常用"排，转向灯在最前 ——
     * 它是本项目唯一实车验证过的音效）。
     */
    val ALL: List<SoundPreset> = listOf(
        SoundPreset(
            "tick_left", "左转向咔嗒", "转向",
            "继电器式短脉冲，低一点；转向灯规则的默认音", R.raw.tick_left
        ),
        SoundPreset(
            "tick_right", "右转向咔嗒", "转向",
            "同上但高一点，便于听辨左右", R.raw.tick_right
        ),
        SoundPreset(
            "beep", "提示「哔」", "轻提示",
            "单声短促，最不打扰；未登记的名字也会回退到它", R.raw.beep
        ),
        SoundPreset(
            "ding", "轻提示「叮」", "轻提示",
            "钟状单音，比 beep 悦耳；适合「值到阈值了」这类知会", R.raw.ding
        ),
        SoundPreset(
            "dingdong", "叮咚（双音）", "轻提示",
            "门铃式两音，辨识度最高；适合「到家/到站」这类事件", R.raw.dingdong
        ),
        SoundPreset(
            "success", "成功「上行」", "成功",
            "两音上行（C5→G5），听感是「完成了」", R.raw.success
        ),
        SoundPreset(
            "fail", "失败「下行」", "失败",
            "两音下行（G4→C4），听感是「没成」", R.raw.fail
        ),
        SoundPreset(
            "warn", "警告（三声）", "警告",
            "三声急促告警；内置规则「高水温告警」用的就是它", R.raw.warn
        ),
        SoundPreset(
            "alert", "严重告警（低音双响）", "严重",
            "低频方波双响，最刺耳；留给「必须马上处理」", R.raw.alert
        )
    )

    /** 按 id 查（大小写与首尾空白都容错）。查不到返回 null —— 调用方据此判断"不是预设" */
    fun byId(id: String): SoundPreset? {
        val k = id.trim().lowercase()
        if (k.isEmpty()) return null
        return ALL.firstOrNull { it.id == k }
    }

    /** 给人看的名字；不是预设时返回 null（调用方回退到显示原始 id） */
    fun labelOf(id: String): String? = byId(id)?.label

    /** 全部机器名（编辑器「选音效」对话框、文档、单测共用） */
    val ids: List<String> get() = ALL.map { it.id }

    /** 分组后的清单（编辑器按 [SoundPreset.category] 分段显示） */
    fun grouped(): List<Pair<String, List<SoundPreset>>> =
        ALL.groupBy { it.category }.map { it.key to it.value }
}
