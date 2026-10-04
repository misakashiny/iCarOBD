package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.ui.view.BarGaugeView
import com.icar.obd.ui.view.CircularGaugeView
import com.icar.obd.ui.view.Easing
import com.icar.obd.ui.view.GaugeTheme
import org.json.JSONObject
import java.io.File

/**
 * 主题编辑器（v1.5.0 P4-6）。
 *
 * ## 实时编辑
 *
 * 顶部是**实时预览**（圆表 + 两条条形表），改任何字段立刻反映上去 ——
 * 不这样做的话，用户得来回切页面才能看到效果，等于没法调色。
 *
 * ## 字段行为什么是代码生成的
 *
 * 12 个颜色 + 若干滑块写成 XML 是一大坨重复，而且**加一个字段要改两处**。
 * 这里用 [ColorField] 声明「标签 + 取值 + 设值」，界面自动生成。
 *
 * ## 内置主题怎么改
 *
 * 内置三套是只读常量，改不了。所以对内置主题点「保存」会**自动转为另存为**，
 * 生成一个自建副本（`id` 从 [GaugeTheme.CUSTOM_ID_BASE] 起），不会覆盖内置。
 */
class ThemeEditorActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_THEME_ID = "theme_id"

        /** 取色板：内置三套的主题色 + 常用告警色 + 黑白。
         *  用 `longArrayOf` 是因为 `0xFF......` 超出 Int 范围（Kotlin 会当成 Long 字面量）。 */
        private val PRESETS: IntArray = longArrayOf(
            0xFF080A0E, 0xFF0B0B09, 0xFF071018, 0xFF17110D, 0xFF181714, 0xFF0C1B28,
            0xFF322820, 0xFF302D23, 0xFF173343, 0xFF553520, 0xFF4A4530, 0xFF1B4C62,
            0xFFFF8A00, 0xFFE3A83B, 0xFF28D7FF, 0xFF63E5FF, 0xFFE8B84F, 0xFFFFB000,
            0xFFFFE45C, 0xFFFFD57A, 0xFFB8F5FF, 0xFFFFF4DF, 0xFFE7FAFF, 0xFFFFF6DB,
            0xFFD8BFA0, 0xFF9DC7D6, 0xFFD5C8A3, 0xFF806B57, 0xFF5E8493, 0xFF847B61,
            0xFFE53935, 0xFF43A047, 0xFFFDD835, 0xFF8E24AA, 0xFF00ACC1, 0xFFFB8C00,
            0xFFFFFFFF, 0xFF000000
        ).map { it.toInt() }.toIntArray()

        private fun hexOf(color: Int): String = String.format("#%06X", color and 0xFFFFFF)

        private fun parseHex(s: String): Int? {
            val t = s.trim().removePrefix("#")
            val v = t.toLongOrNull(16) ?: return null
            return when (t.length) {
                6 -> (0xFF000000L or v).toInt()
                8 -> v.toInt()
                else -> null
            }
        }
    }

    /** 一个颜色字段：标签 + 取值 + 设值（[GaugeTheme] 不可变，所以「设值」= copy） */
    private class ColorField(
        val label: String,
        val get: (GaugeTheme) -> Int,
        val set: (GaugeTheme, Int) -> GaugeTheme
    )

    private val colorFields = listOf(
        ColorField("背景", { it.background }, { t, v -> t.copy(background = v) }),
        ColorField("卡片底色", { it.surface }, { t, v -> t.copy(surface = v) }),
        ColorField("卡片描边", { it.surfaceEdge }, { t, v -> t.copy(surfaceEdge = v) }),
        ColorField("强调色", { it.accent }, { t, v -> t.copy(accent = v) }),
        ColorField("强调高亮", { it.accentHot }, { t, v -> t.copy(accentHot = v) }),
        ColorField("强调暗部", { it.accentDim }, { t, v -> t.copy(accentDim = v) }),
        ColorField("轨道", { it.track }, { t, v -> t.copy(track = v) }),
        ColorField("刻度", { it.tick }, { t, v -> t.copy(tick = v) }),
        ColorField("指针", { it.needle }, { t, v -> t.copy(needle = v) }),
        ColorField("数值字", { it.value }, { t, v -> t.copy(value = v) }),
        ColorField("标签字", { it.label }, { t, v -> t.copy(label = v) }),
        ColorField("次要字", { it.dim }, { t, v -> t.copy(dim = v) })
    )

    private var original: GaugeTheme = GaugeTheme.builtIns().first()
    private var draft: GaugeTheme = original

    private lateinit var fields: android.view.ViewGroup
    private lateinit var tvTitle: TextView
    private lateinit var pvCircle: CircularGaugeView
    private lateinit var pvBar1: BarGaugeView
    private lateinit var pvBar2: BarGaugeView

    /**
     * 预览表的**卡片容器**。
     *
     * 卡片底画在这一层而不是表上 —— 与 `DashRenderer` / `DashCanvasEditorView`
     * 的做法一致（那边也是 FrameLayout host 带背景）。不套这一层的话，
     * 调「卡片描边」「卡片不透明度」两个滑块**看不到任何变化**。
     */
    private lateinit var pvCardCircle: android.widget.FrameLayout
    private lateinit var pvCardBar1: android.widget.FrameLayout
    private lateinit var pvCardBar2: android.widget.FrameLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_theme_editor)

        fields = findViewById(R.id.themeFields)
        tvTitle = findViewById(R.id.tvThemeTitle)
        pvCircle = findViewById(R.id.pvCircle)
        pvBar1 = findViewById(R.id.pvBar1)
        pvBar2 = findViewById(R.id.pvBar2)
        pvCardCircle = findViewById(R.id.pvCardCircle)
        pvCardBar1 = findViewById(R.id.pvCardBar1)
        pvCardBar2 = findViewById(R.id.pvCardBar2)

        val id = intent.getIntExtra(EXTRA_THEME_ID, Store.settings.gaugeTheme)
        original = GaugeTheme.of(id)
        draft = original

        findViewById<MaterialButton>(R.id.btnThemeSave).setOnClickListener { save() }
        findViewById<MaterialButton>(R.id.btnThemeSaveAs).setOnClickListener { saveAs() }
        findViewById<MaterialButton>(R.id.btnThemeDelete).setOnClickListener { delete() }
        findViewById<MaterialButton>(R.id.btnThemeRevert).setOnClickListener { revert() }
        findViewById<MaterialButton>(R.id.btnThemeExport).setOnClickListener { exportTheme() }
        findViewById<MaterialButton>(R.id.btnThemeImport).setOnClickListener { showImportDialog() }

        buildFields()
        applyDraft()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    // ---------------------------------------------------------------- 字段生成

    private fun buildFields() {
        fields.removeAllViews()

        colorFields.forEach { f ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(8), 0, dp(8))
                isClickable = true
            }
            val swatch = View(this).apply {
                setBackgroundColor(f.get(draft))
                layoutParams = LinearLayout.LayoutParams(dp(44), dp(26))
            }
            val label = TextView(this).apply {
                text = f.label
                setPadding(dp(12), 0, 0, 0)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            row.addView(swatch)
            row.addView(label)
            row.setOnClickListener { pickColor(f, swatch) }
            fields.addView(row)
        }

        fields.addView(sectionTitle("几何"))
        fields.addView(slider("卡片圆角", 0f, 40f, draft.cardRadiusDp) { draft = draft.copy(cardRadiusDp = it) })
        // 0 = 无边框。这是「无边框效果」的入口 —— 描边归零即可，卡片底色仍在
        fields.addView(slider("卡片描边（0 = 无边框）", 0f, 8f, draft.cardStrokeDp) {
            draft = draft.copy(cardStrokeDp = it)
        })
        // 底色也归零就成了「完全透明卡片」，适合叠在背景图上
        fields.addView(slider("卡片不透明度", 0f, 255f, draft.cardAlpha.toFloat()) {
            draft = draft.copy(cardAlpha = it.toInt())
        })
        fields.addView(slider("弧 / 条粗细", 2f, 24f, draft.strokeDp) { draft = draft.copy(strokeDp = it) })
        fields.addView(slider("指针长度", 0.2f, 1f, draft.needleLengthRatio) {
            draft = draft.copy(needleLengthRatio = it)
        })

        fields.addView(sectionTitle("数值动画（v1.10.4）"))

        // 缓动曲线：4 种。改完立刻在预览里看出来（预览表会持续动）
        fields.addView(
            spinnerRow("缓动曲线", Easing.MODE_NAMES, draft.easingMode) { idx ->
                draft = draft.copy(easingMode = idx)
                applyDraft()
            }
        )
        fields.addView(slider("缓动时间常数 τ（ms，越小越快）", 30f, 400f, draft.easingTauMs) {
            draft = draft.copy(easingTauMs = it)
        })
        fields.addView(slider("输入滤波（ms，0 = 不过滤）", 0f, 400f, draft.valueSmoothingMs) {
            draft = draft.copy(valueSmoothingMs = it)
        })
        fields.addView(TextView(this).apply {
            text = "τ 别调太小：数据 5Hz 推送（200ms 一次），τ ≤ 45ms 时指针会在一周期内" +
                "走完 98% 然后「趴」在目标上等下一次 —— 看起来就是一格一格地跳。" +
                "输入滤波专门压数据本身的抖动，与缓动曲线解耦。"
            setTextColor(ContextCompat.getColor(this@ThemeEditorActivity, R.color.text_dim))
            textSize = 11f
            setPadding(0, dp(4), 0, dp(8))
        })

        fields.addView(sectionTitle("指针环"))
        fields.addView(
            MaterialSwitch(this).apply {
                text = "启用外圈刻度环"
                isChecked = draft.defaultRingStyle == GaugeItem.RING_TICK
                setOnCheckedChangeListener { _, on ->
                    draft = draft.copy(
                        defaultRingStyle = if (on) GaugeItem.RING_TICK else GaugeItem.RING_NONE
                    )
                    applyDraft()
                }
            }
        )
        fields.addView(slider("环段数", 8f, 120f, draft.defaultRingSegments.toFloat()) {
            draft = draft.copy(defaultRingSegments = it.toInt())
        })

        fields.addView(sectionTitle("其他"))
        fields.addView(
            MaterialSwitch(this).apply {
                text = "辉光效果"
                isChecked = draft.glow
                setOnCheckedChangeListener { _, on ->
                    draft = draft.copy(glow = on)
                    applyDraft()
                }
            }
        )
    }

    private fun sectionTitle(text: String) = TextView(this).apply {
        this.text = text
        setPadding(0, dp(14), 0, dp(4))
        textSize = 12f
    }

    private fun slider(label: String, min: Float, max: Float, value: Float, onChanged: (Float) -> Unit): View {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(4), 0, dp(4))
        }
        val tv = TextView(this).apply { text = "$label：${fmt(value)}"; textSize = 12f }
        val sb = SeekBar(this).apply {
            this.max = 1000
            progress = (((value - min) / (max - min)) * 1000f).toInt().coerceIn(0, 1000)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar?, p: Int, fromUser: Boolean) {
                    val v = min + (max - min) * p / 1000f
                    tv.text = "$label：${fmt(v)}"
                    onChanged(v)
                    applyDraft()
                }

                override fun onStartTrackingTouch(bar: SeekBar?) {}
                override fun onStopTrackingTouch(bar: SeekBar?) {}
            })
        }
        wrap.addView(tv)
        wrap.addView(sb)
        return wrap
    }

    /**
     * 下拉选择行（v1.10.4）。
     *
     * 抽出来是因为「缓动曲线」是**离散枚举**，用滑块表示不了 ——
     * 而主题编辑器原来的字段行只有滑块和开关两种。
     */
    private fun spinnerRow(
        label: String,
        options: List<String>,
        selected: Int,
        onPicked: (Int) -> Unit
    ): View {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
        }
        wrap.addView(TextView(this).apply {
            text = label
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        wrap.addView(Spinner(this).apply {
            adapter = ArrayAdapter(
                this@ThemeEditorActivity,
                android.R.layout.simple_spinner_dropdown_item,
                options
            )
            setSelection(selected.coerceIn(0, (options.size - 1).coerceAtLeast(0)))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                    onPicked(pos)
                }

                override fun onNothingSelected(p: AdapterView<*>?) {}
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        return wrap
    }

    private fun fmt(v: Float): String =
        if (v == v.toInt().toFloat()) v.toInt().toString() else String.format("%.2f", v)

    // ---------------------------------------------------------------- 预览

    /** 改任何字段后调用：刷新标题、页面底色、卡片底与三块预览表 */
    private fun applyDraft() {
        tvTitle.text = buildString {
            append(draft.title)
            append(if (draft.custom) "（自建）" else "（内置 · 保存时会另存为自建）")
        }
        // 页面底色用主题的 background，卡片底才有对比 —— 否则卡片与背景同色，
        // 「不透明度 / 描边」调了也看不出来
        window.decorView.setBackgroundColor(draft.background)

        // 卡片底：三个预览容器都按当前 draft 重画。
        // 用一个「不覆盖」的 GaugeItem（cardStyle = 跟随主题）拿标准卡片底
        val density = resources.displayMetrics.density
        val card = draft.cardBackgroundFor(null, density)
        listOf(pvCardCircle, pvCardBar1, pvCardBar2).forEach { it.background = card }

        pvCircle.bind(
            GaugeItem(
                pidId = "std_0C", style = GaugeItem.STYLE_CIRCLE,
                minVal = 0f, maxVal = 8000f, warnHigh = 6500f
            ),
            Store.findPid("std_0C"), draft
        )
        pvCircle.update(4200f, null)

        pvBar1.bind(
            GaugeItem(
                pidId = "std_05", style = GaugeItem.STYLE_BAR,
                minVal = -40f, maxVal = 130f, warnHigh = 105f
            ),
            Store.findPid("std_05"), draft
        )
        pvBar1.update(88f, null)

        pvBar2.bind(
            GaugeItem(
                pidId = "std_42", style = GaugeItem.STYLE_BAR,
                minVal = 8f, maxVal = 16f, warnLow = 11.8f
            ),
            Store.findPid("std_42"), draft
        )
        pvBar2.update(13.9f, null)
    }

    // ---------------------------------------------------------------- 取色

    private fun pickColor(f: ColorField, swatch: View) {
        val pad = dp(12)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }
        val hex = EditText(this).apply {
            hint = "#RRGGBB"
            inputType = InputType.TYPE_CLASS_TEXT
            setText(hexOf(f.get(draft)))
            setPadding(pad, pad, pad, pad)
        }
        root.addView(hex)

        val grid = GridLayout(this).apply { columnCount = 8 }
        PRESETS.forEach { color ->
            val v = View(this).apply {
                setBackgroundColor(color)
                layoutParams = GridLayout.LayoutParams().apply {
                    width = dp(32)
                    height = dp(32)
                    setMargins(dp(3), dp(3), dp(3), dp(3))
                }
                setOnClickListener { hex.setText(hexOf(color)) }
            }
            grid.addView(v)
        }
        root.addView(grid)

        AlertDialog.Builder(this)
            .setTitle("选择颜色 · ${f.label}")
            .setView(root)
            .setPositiveButton("确定") { _, _ ->
                val parsed = parseHex(hex.text.toString())
                if (parsed == null) {
                    ObdController.toast("颜色格式应为 #RRGGBB")
                    return@setPositiveButton
                }
                draft = f.set(draft, parsed)
                swatch.setBackgroundColor(parsed)
                applyDraft()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 保存 / 删除

    private fun save() {
        // 内置主题是只读常量，改不了 —— 自动转成「另存为」而不是静默丢弃
        if (!original.custom) {
            saveAs()
            return
        }
        persist()
        ObdController.toast("主题已保存：${draft.title}")
    }

    private fun saveAs() {
        val pad = dp(12)
        val et = EditText(this).apply {
            hint = "主题名称"
            setText(if (original.custom) "${original.title} 副本" else "${original.title} 自定义")
            setPadding(pad, pad, pad, pad)
        }
        val wrap = FrameLayout(this).apply { setPadding(pad, pad, pad, pad); addView(et) }
        AlertDialog.Builder(this)
            .setTitle("另存为自建主题")
            .setMessage("内置主题不会被覆盖，会新建一个可编辑的副本。")
            .setView(wrap)
            .setPositiveButton("保存") { _, _ ->
                val name = et.text.toString().ifBlank { "自定义主题" }
                original = draft.asCustom(GaugeTheme.nextCustomId(), name)
                draft = original
                persist()
                buildFields()
                applyDraft()
                ObdController.toast("已保存为新主题：$name")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 写入 [Store.customThemeJson]（同 id 覆盖）并落盘，同时把当前主题切过去 */
    private fun persist() {
        val keep = Store.customThemeJson.filter { json ->
            runCatching { JSONObject(json).optInt("id", -1) }.getOrDefault(-1) != draft.id
        }
        Store.customThemeJson.clear()
        Store.customThemeJson.addAll(keep)
        Store.customThemeJson.add(draft.toJson().toString())
        Store.saveThemes()

        Store.settings.gaugeTheme = draft.id
        Store.saveSettings()
        AppLog.i(AppLog.M_UI, "主题已保存", "id=${draft.id} title=${draft.title}")
    }

    private fun delete() {
        if (!original.custom) {
            ObdController.toast("内置主题不能删除")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("删除主题")
            .setMessage("确定删除「${original.title}」？")
            .setPositiveButton("删除") { _, _ ->
                Store.customThemeJson.removeAll { json ->
                    runCatching { JSONObject(json).optInt("id", -1) }.getOrDefault(-1) == original.id
                }
                Store.saveThemes()
                if (Store.settings.gaugeTheme == original.id) {
                    Store.settings.gaugeTheme = GaugeTheme.NEON
                    Store.saveSettings()
                }
                AppLog.i(AppLog.M_UI, "主题已删除", "id=${original.id}")
                ObdController.toast("已删除")
                finish()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun revert() {
        draft = original
        buildFields()
        applyDraft()
    }

    // ---------------------------------------------------------------- 单主题导入 / 导出

    /**
     * 导出**单个主题**为 JSON 文件。
     *
     * 与「完整备份」的区别：备份是「回到当时的状态」，用于自己换机；
     * 单主题导出是**分享单位** —— 把一套配色发给别人，别人导入后作为新主题存在，
     * 不会动到他现有的任何东西。
     */
    private fun exportTheme() {
        runCatching {
            val dir = File(getExternalFilesDir(null), "export").apply { mkdirs() }
            val f = File(dir, "theme-${draft.id}-${System.currentTimeMillis()}.json")
            f.writeText(draft.toJson().toString(2))

            val uri = androidx.core.content.FileProvider.getUriForFile(
                this, "$packageName.fileprovider", f
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(send, "导出主题 JSON"))
            f
        }.onSuccess {
            ObdController.toast("已导出：${it.name}")
        }.onFailure {
            ObdController.toast("导出失败：${it.message}")
        }
    }

    private val openThemeFile = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val text = runCatching {
            contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
        }.getOrNull()
        if (text.isNullOrBlank()) {
            ObdController.toast("读取文件失败")
            return@registerForActivityResult
        }
        importTheme(text)
    }

    private fun showImportDialog() {
        val pad = dp(12)
        val et = EditText(this).apply {
            hint = "粘贴主题 JSON"
            setPadding(pad, pad, pad, pad)
            minLines = 5
        }
        val wrap = FrameLayout(this).apply { setPadding(pad, pad, pad, pad); addView(et) }
        AlertDialog.Builder(this)
            .setTitle("导入主题")
            .setMessage("会作为**新主题**加入，不会覆盖或删除你现有的主题。")
            .setView(wrap)
            .setPositiveButton("导入") { _, _ -> importTheme(et.text.toString()) }
            .setNeutralButton("从文件…") { _, _ ->
                openThemeFile.launch(arrayOf("application/json", "text/plain", "*/*"))
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 导入时**强制分配新 id** —— 否则会和本地同 id 主题撞车，把别人的配色覆盖到你的上面 */
    private fun importTheme(text: String) {
        val parsed = runCatching { GaugeTheme.fromJson(JSONObject(text)) }.getOrNull()
        if (parsed == null) {
            ObdController.toast("不是合法的主题 JSON")
            AppLog.w(AppLog.M_UI, "主题导入失败：解析不了")
            return
        }
        val newId = GaugeTheme.nextCustomId()
        original = parsed.asCustom(newId, parsed.title.ifBlank { "导入主题" })
        draft = original
        persist()
        buildFields()
        applyDraft()
        ObdController.toast("已导入主题：${draft.title}")
    }
}
