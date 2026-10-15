package com.icar.obd.data

import com.icar.obd.obd.SegmentRotation

/**
 * **CAN 探测页的展示文案**（v1.20.22）—— 纯函数，JVM 单测覆盖。
 *
 * ## 为什么单独一份
 *
 * 这一页的状态行、解码汇总、导入结果对话框**都是普通 `TextView` /
 * `MaterialAlertDialogBuilder.setMessage`**：Android 只按字面显示，
 * **不解析任何标记**。原先这些字符串里带着从规格文档抄来的 Markdown 粗体
 * （`**未绑定…**` 这种），于是用户看到的就是一串星号 —— 既不粗体，
 * 又把句子的重点拆得七零八落（"解码：3 个 ID 里\*\*没有一个\*\*绑定了…"）。
 *
 * 抽成纯函数的三个理由：
 * 1. 能在 JVM 里断言"哪个状态该说什么话、且**不含星号**"
 *    （`ui/CanSnifferActivity` 一碰 Android 就跑不了）；
 * 2. 让"安全含义"变成可回归的断言，而不是散在 800 行 Activity 里的字面量；
 * 3. 文案只拼字符串、没有集合拷贝，可以放心挂在每轮刷新的状态行路径上。
 *
 * ## ⚠️ 只改"显示用的标记"，不改安全含义
 *
 * 这里**刻意不引入**任何 Markdown 渲染器：普通 TextView 就该收纯文本。
 * 下列语义在去星号时必须原样留住（每条都对应一次"被骗"）：
 *  - 未绑定 PID 的 ID **只显示原始 hex、不猜值**；
 *  - 候选（`enabled=false`）**没经过验证**，不能长得像已确认的值；
 *  - 重复帧**只计数**；
 *  - 全部条目未通过时 **PID 列表没有任何变化**。
 */
object CanSnifferText {
    const val HELP = "先保持目标状态采一次，再只改变一个动作、用同一范围采第二次。对比得到的是候选位，还需要多次核对。\n\n导出观察表看ID统计，导出原始帧看时间和字节；信号模板可在电脑填写后导入。\n\n没有绑定监听型PID的ID只显示原始数据；候选未启用，不能当作已确认的车辆信号。"

    /**
     * 常驻监听开着时状态行最该说的那句话。
     *
     * 与 `ui/view/MonitorWarnBar.TEXT` 是**同一份文案**：那一条是给仪表盘顶部
     * 横幅用的，这里这一条是给探测页状态行用的。两处写同一句话是有意的
     * （同一屏上两个说法打架过一次），所以单测里把这句话钉住。
     */
    const val MONITOR_PAUSED_TEXT = "监听中 · 轮询已暂停（转速/水温暂停更新）"

    /**
     * 状态行需要的最小状态。
     *
     * ⚠️ 刻意**不复用** `CanSniffer.Status`：那个文件 `import android.os.Handler`，
     * 在 JVM 单测里一碰就 `NoClassDefFoundError`。这里只带**这一行真正用到的字段**，
     * 由调用方从 `CanSniffer.status` 映射过来 —— 映射错了是编译错误，不会静默。
     */
    data class Status(
        val phase: Phase,
        val message: String = "",
        val elapsedMs: Long = 0L,
        val frameCount: Int = 0,
        val idCount: Int = 0,
        val dropped: Int = 0,
        /** 本次是不是分段轮换（= `CanSniffer.Status.rotation != null`） */
        val rotating: Boolean = false,
        /** `FrameMonitor.running` —— 常驻监听是否正在跑 */
        val monitorRunning: Boolean = false,
        /** 轮换勾选框（`cbRotate`）是否勾上 */
        val rotateChecked: Boolean = false
    )

    /** 与 `CanSniffer.Phase` 一一对应的展示用阶段（见 [Status] 为什么另立一份） */
    enum class Phase { IDLE, PREPARING, CAPTURING, FINISHING, DONE, FAILED }

    /**
     * 状态行的正文（`tvSniffStatus` 的上半段）。
     *
     * 每个分支的措辞都是踩过的坑，别顺手"优化"：
     *  - 常驻监听开着时说"轮询让位"，而不是"未开始" —— 否则用户以为监听也没在跑；
     *  - 勾了轮换但还没开始时先报时长，免得按普通探测的 10 秒去等；
     *  - 轮换中**不在这里重复段号/剩余时间** —— 那是进度行（`tvSniffRotate`）的活。
     */
    fun statusLine(s: Status): String = when (s.phase) {
        Phase.IDLE ->
            if (s.monitorRunning) {
                MONITOR_PAUSED_TEXT +
                    "\n常驻监听在跑，单次探测要等它停掉之后才能开始。"
            } else if (s.rotateChecked) {
                "分段轮换扫描：8 段，约 80 秒采集时间，切换与收尾另计。\n" +
                    "只覆盖11位ID（ATCM700），29位ID请用单次采集。"
            } else {
                "未开始。采集广播帧时暂停轮询；重复帧只计数。\n" +
                    "选范围后开始，首次排查可以留空不过滤。"
            }
        Phase.PREPARING -> s.message
        Phase.CAPTURING ->
            if (s.rotating) {
                "轮换监听中… ${s.elapsedMs / 1000}s · ${s.frameCount} 帧（本段） / ${s.idCount} 个 ID（本段）" +
                    if (s.dropped > 0) " · 原始流已丢弃 ${s.dropped} 条" else ""
            } else {
                "监听中… ${s.elapsedMs / 1000}s · ${s.frameCount} 帧 / ${s.idCount} 个 ID" +
                    if (s.dropped > 0) " · 原始流已丢弃 ${s.dropped} 条" else ""
            }
        Phase.FINISHING -> s.message
        Phase.DONE -> s.message + "\n保持同一范围再采一次，用「对比上次采集」找候选变化位。"
        Phase.FAILED -> s.message
    }

    /**
     * 解码汇总（挂在状态行下面，`decodeSummary()`）。
     *
     * ⚠️ **`bound == 0` 这一支是安全文案，不是普通提示**：用户刚在 PID 页建过
     * 监听型条目，回到这一页却是一屏 hex —— 两件事对不上，他会去怀疑公式写错了。
     * 所以必须明说"没有一个绑定、只能显示原始 hex、不猜值"。
     *
     * @param idCount 本页聚合到的 ID 数（0 = 还没有结果，整段不显示）
     * @param boundIdCount 其中绑定了监听型 PID 的个数
     */
    fun decodeSummary(idCount: Int, boundIdCount: Int): String {
        if (idCount <= 0) return ""
        return if (boundIdCount == 0) {
            "$idCount 个 ID，尚未绑定监听型PID，只显示原始 hex（不猜值）。"
        } else {
            "$idCount 个 ID，其中$boundIdCount 个已绑定监听型PID，显示解码值；其余只显示原始 hex。候选未启用、没经过验证。"
        }
    }

    /**
     * 信号表导入结果对话框的正文（`showImportResult`）。
     *
     * ⚠️ 保留的三条含义：
     *  - 校验结论**必须显示出来**（静默拒绝会让人以为"导进去了但没生效"）；
     *  - `accepted == 0` 时明说 **PID 列表没有任何变化**；
     *  - 收下的条目若全是候选，明说 **未启用**，要去 PID 页手动打开 ——
     *    不能让它读起来像"已经能取到值了"。
     */
    fun importResult(fileName: String, res: SignalTableCsv.Result): String {
        val sb = StringBuilder()
        sb.append("文件：").append(fileName).append('\n')
        sb.append("数据行 ").append(res.totalRows)
            .append(" · 收下 ").append(res.accepted)
            .append(" · 硬错误 ").append(res.errors.size)
            .append(" · 软警告 ").append(res.warnings.size).append('\n')
        if (res.accepted == 0) {
            sb.append("\n一条都没通过，PID 列表没有任何变化。\n")
        }
        val section = { title: String, list: List<SignalTableCsv.Problem>, max: Int ->
            if (list.isNotEmpty()) {
                sb.append('\n').append(title).append("（").append(list.size).append("）\n")
                list.take(max).forEach {
                    sb.append("第 ").append(it.row).append(" 行：").append(it.message).append('\n')
                }
                if (list.size > max) sb.append("… 还有 ").append(list.size - max).append(" 条\n")
            }
        }
        section("硬错误 · 这些行被拒绝", res.errors, 12)
        section("软警告 · 已收下，请核对", res.warnings, 8)
        if (res.accepted > 0) {
            sb.append('\n').append("已写入 PID 列表（监听型）。")
            sb.append(
                if (res.pids.any { it.enabled })
                    "「已确认」的条目已启用 —— 到本页开「常驻监听」就能取到值。"
                else
                    "这些条目都是「候选」→ 「未启用」，要在「PID」页手动打开。"
            )
        }
        return sb.toString()
    }
}
