package com.icar.obd.data

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import com.icar.obd.R
import java.util.concurrent.ConcurrentHashMap

/**
 * 低延迟音效播放器（SoundPool）。
 *
 * 转向灯「咔嗒」声对延迟敏感，MediaPlayer 每次起播有几十毫秒延迟，
 * 因此统一走 SoundPool 预加载。
 *
 * 音效名与 res/raw 文件的映射集中在这里；新增音效只需：
 *   1) 把 wav/ogg 放进 app/src/main/res/raw/
 *   2) 在 [SOUNDS] 里登记一行
 */
class AudioPlayer(context: Context) {

    private val pool: SoundPool = SoundPool.Builder()
        .setMaxStreams(4)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        )
        .build()

    private val ids = ConcurrentHashMap<String, Int>()

    /** 音效名 → raw 资源 id */
    private val sounds = linkedMapOf(
        "tick_left" to R.raw.tick_left,
        "tick_right" to R.raw.tick_right,
        "warn" to R.raw.warn,
        "beep" to R.raw.beep
    )

    @Volatile
    var enabled: Boolean = true

    init {
        sounds.forEach { (name, res) ->
            runCatching {
                val sid = pool.load(context.applicationContext, res, 1)
                ids[name] = sid
            }.onFailure { AppLog.w(AppLog.M_AUDIO, "音效加载失败", "name=$name ${it.message}") }
        }
        AppLog.i(AppLog.M_AUDIO, "音效已登记", sounds.keys.joinToString(","))
    }

    /**
     * 播放一次。名字不存在时回退到 beep，并记日志便于排查拼写错误。
     *
     * @param volume 音量 `0~1`（默认 1），越界会被夹进范围
     * @param rate   **播放速率** `0.5~2.0`（默认 1）。
     *
     *   ⚠️ SoundPool 的 `rate` 会**同时改变时长和音高** —— 调大是"更快、更尖"的
     *   咔嗒声，调小是"更慢、更闷"。转向灯那种继电器"嗒"声，1.4 左右比 1.0 更像。
     *   这也是它为什么要跟音量分成两个参数。
     */
    fun play(name: String, volume: Float = 1f, rate: Float = 1f, force: Boolean = false) {
        // force=true 是给**试听**用的：那是用户明确按下的动作，
        // 不该因为"音效总开关关着"就静默不响 —— 用户会以为按钮坏了。
        if (!enabled && !force) return
        val key = name.trim().lowercase()
        var sid = ids[key]
        if (sid == null) {
            AppLog.w(AppLog.M_AUDIO, "未登记的音效，回退 beep", "name=$name")
            sid = ids["beep"] ?: return
        }
        val v = volume.coerceIn(0f, 1f)
        val r = rate.coerceIn(0.5f, 2f)
        runCatching { pool.play(sid, v, v, 1, 0, r) }
            .onFailure { AppLog.e(AppLog.M_AUDIO, "播放失败", "name=$name ${it.message}") }
    }

    fun availableSounds(): List<String> = sounds.keys.toList()

    fun release() {
        runCatching { pool.release() }
    }
}
