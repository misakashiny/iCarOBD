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

    /**
     * **用户指定音频文件**的已加载缓存：URI 字符串 → SoundPool id。
     *
     * ## 为什么要单独一张表
     *
     * 内置音效是 `res/raw` 资源 id，编译期就定死了；用户选的文件是
     * `content://` URI，**要运行时打开**（SAF 给的 URI 不能当路径用）。
     * 两者加载方式不同，混在一张表里会让"找不到就回退 beep"的逻辑变味。
     *
     * ⚠️ `SoundPool.load` 是**异步**的：load 返回 id 时音频还没解码完，
     * 此时 `play` 不会响。这是 SoundPool 的固有行为 —— 所以第一次触发
     * 可能没声音，**第二次起才稳定**（缓存命中后不再重新 load）。
     * 不额外做等待：等它反而会把规则触发的实时性拖坏。
     */
    private val fileIds = ConcurrentHashMap<String, Int>()

    /** 最近一次文件加载失败的原因（给 UI 显示，避免"选了没反应"） */
    @Volatile
    var lastFileError: String? = null
        private set

    private val appContext: Context = context.applicationContext

    @Volatile
    var enabled: Boolean = true

    init {
        sounds.forEach { (name, res) ->
            runCatching {
                val sid = pool.load(appContext, res, 1)
                ids[name] = sid
            }.onFailure { AppLog.w(AppLog.M_AUDIO, "音效加载失败", "name=$name ${it.message}") }
        }
        AppLog.i(AppLog.M_AUDIO, "音效已登记", sounds.keys.joinToString(","))
    }

    /**
     * 这个 spec 是"用户指定的音频文件"而不是内置音效名吗？
     *
     * **判据只有一份**：[RuleAction.isAudioFileSpec] —— 编辑器和播放器必须用
     * 同一套判断，否则会出现"编辑器当成文件、播放器当成名字"这类
     * **从现象上完全看不出**的分叉。
     */
    private fun isFileSpec(spec: String): Boolean = RuleAction.isAudioFileSpec(spec)

    /** 按需打开用户选的文件并加载；失败返回 null 并记下原因 */
    private fun loadFile(spec: String): Int? {
        lastFileError = null
        val afd = runCatching { appContext.contentResolver.openAssetFileDescriptor(android.net.Uri.parse(spec), "r") }
            .getOrElse {
                lastFileError = "打不开文件：${it.message}"
                AppLog.w(AppLog.M_AUDIO, "音频文件打不开", "spec=$spec ${it.message}")
                return null
            }
        if (afd == null) {
            lastFileError = "打不开文件（contentResolver 返回 null）"
            AppLog.w(AppLog.M_AUDIO, "音频文件打不开", "spec=$spec 返回 null")
            return null
        }
        return runCatching {
            val sid = pool.load(afd, 1)
            runCatching { afd.close() }
            if (sid == 0) {
                lastFileError = "SoundPool 拒绝加载（格式不支持？）"
                AppLog.w(AppLog.M_AUDIO, "音频文件加载被拒", "spec=$spec")
                null
            } else {
                fileIds[spec] = sid
                AppLog.i(AppLog.M_AUDIO, "已加载用户音频", "spec=$spec id=$sid")
                sid
            }
        }.getOrElse {
            lastFileError = "加载失败：${it.message}"
            AppLog.e(AppLog.M_AUDIO, "音频文件加载失败", "spec=$spec ${it.message}")
            null
        }
    }

    /**
     * 播放一次。名字不存在时回退到 beep，并记日志便于排查拼写错误。
     *
     * @param name **内置音效名**（`beep` / `tick_left` / …）**或用户指定的音频文件 URI**
     *   （`content://…`）。带 URI scheme 或 `/` 的按文件处理，见 [isFileSpec]。
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
        val spec = name.trim()

        val sid: Int? = if (isFileSpec(spec)) {
            fileIds[spec] ?: loadFile(spec)
        } else {
            ids[spec.lowercase()]
        }

        if (sid == null) {
            if (!isFileSpec(spec)) {
                AppLog.w(AppLog.M_AUDIO, "未登记的音效，回退 beep", "name=$name")
            }
            // 文件加载失败时**不再回退 beep** —— 用户明确选了文件，
            // 用别的声音顶替会让他以为"选的文件就是这声"。
            // 失败原因记在 lastFileError 里，由编辑器显示。
            if (isFileSpec(spec)) return
            val fallback = ids["beep"] ?: return
            playId(fallback, volume, rate)
            return
        }
        playId(sid, volume, rate)
    }

    private fun playId(sid: Int, volume: Float, rate: Float) {
        val v = volume.coerceIn(0f, 1f)
        val r = rate.coerceIn(0.5f, 2f)
        runCatching { pool.play(sid, v, v, 1, 0, r) }
            .onFailure { AppLog.e(AppLog.M_AUDIO, "播放失败", "sid=$sid ${it.message}") }
    }

    fun availableSounds(): List<String> = sounds.keys.toList()

    fun release() {
        runCatching { pool.release() }
    }
}
