package com.icar.obd.data

/**
 * **燃油那两条同义 PID 的合并**（v1.20.13）—— 用户原话：「燃油可以合并」。
 *
 * ## 先读代码：这两条到底是什么关系（**不是凭名字猜的**）
 *
 * | id | 名字 | 来源 | 谁在用它 |
 * |---|---|---|---|
 * | `std_5E` | 燃油消耗率 (L/h) | **输入**：Mode 01 PID `5E`，车上的真实读数 | `VehicleBus.Derived.computeAll` 里的 `fuelRate` |
 * | `calc_lh` | 燃油流量 (L/h) | **派生输出**：`Derived.computeAll` 算出来写进总线 | `calc_l100`（瞬时油耗）、`calc_avg_l100`（平均油耗）、`calc_range`（续航）都读它 |
 *
 * 而 `VehicleBus.Derived.computeAll` 的优先级是**写死的**：
 *
 * ```kotlin
 * val lh = when {
 *     fuelRate != null && fuelRate > 0f -> fuelRate          // ① 车支持 01 5E → 直接用它
 *     maf != null && maf > 0.5f -> (maf * G_S_TO_L_H)         // ② 否则由空气流量 MAF 推算
 *     else -> null
 * }
 * if (lh != null) put(PidValue("calc_lh", lh, "calc", now, true))
 * ```
 *
 * 也就是说 **`calc_lh` 是一个"超集"通道**：车支持 `01 5E` 时它的值就是 `01 5E` 的值，
 * 不支持时它是 MAF 推算值。**两者在数值上不等价**（车不支持 5E 时 `std_5E` 根本没值、
 * `calc_lh` 有值），所以"删掉其中一条"是错的 —— 那正是任务里说的"合并不安全"。
 *
 * ## 结论：**保留两个 id，只在列表里不重复显示**
 *
 * 这是任务里给的两条路里的第二条（"保留 id 但列表不重复显示"）。选它的理由：
 *
 *  1. **老配置的仪表不变空** —— `dash.json` / 设计文件里可能绑着 `std_5E`
 *     （设计文件的别名表里 `obd.fuel_rate → std_5E`、`calc.fuel_hourly → calc_lh`
 *     **两个别名都存在**），删任何一个 id 都会让一部分老仪表显示 `--`。
 *  2. **数值语义不变** —— `VehicleBus.Derived` 与 `ObdEngine` 读的都是
 *     `Store.allPids()`，而 [filterForList] **只作用于显示层**，
 *     所以 `01 5E` 该轮询还是轮询、`calc_lh` 该算还是算。
 *  3. **平均油耗 / 续航不受影响** —— 它们读的是 `calc_lh`，而它一条都没动。
 *
 * ## 列表里留下谁：**`calc_lh`**（[KEEP_ID]）
 *
 * 判据是任务里的那句"车支持 `01 5E` 就用它；不支持就算出来"——
 * **这句话描述的行为就是 `calc_lh`**。反过来留 `std_5E` 的话，
 * 在一台不支持 `01 5E` 的车（**本项目的阿特兹就是这样**，见 `接手大纲` §1
 * 那 5 个不支持的 PID）上，列表里那一行会永远显示 `--`，
 * 而同一个量的推算值明明就在旁边算着 —— 那是最糟的一种"看起来坏了"。
 *
 * ## ⚠️ 三条不许破的约定
 *
 * 1. **不许改 `Store.allPids()`** —— 它是轮询（`ObdEngine.reload`）、模拟器
 *    （`SignalSimulator`）、派生通道的共同来源。过滤只能发生在**拿去做列表**的那一步
 *    （`PidFragment` / 仪表编辑器 / 规则编辑器）。这一条有单测钉着。
 * 2. **不许删任何一条**（内置条目永远不给用户删，`PidDedup` 也刻意不判内置之间的重复）。
 * 3. **编辑器里"当前已经绑定的 id"必须保留**（[filterForList] 的 `keep` 参数）——
 *    见下面那段。
 *
 * ## 为什么 `filterForList` 要一个 `keep` 参数（**这是个真陷阱，不是保险**）
 *
 * 仪表编辑器（`DashCanvasPageFragment.showEditDialog`）与规则编辑器
 * （`RuleEditorActivity.addConditionRow`）都是这个写法：
 *
 * ```kotlin
 * val pi = pids.indexOfFirst { it.id == existing.pidId }
 * if (pi >= 0) spPid.setSelection(pi)        // 找不到就不设 → spinner 停在 0 号
 * ...
 * existing.pidId = pids[spPid.selectedItemPosition].id   // 保存 → **绑到 0 号**
 * ```
 *
 * 0 号是「发动机转速」。所以只要把一个**绑着 `std_5E` 的老仪表**打开一次、
 * 点一下「确定」，它就会**静默变成转速表** —— 而用户不会想到是"列表过滤"干的。
 * 传 `keep = setOfNotNull(existing.pidId)` 之后，那一行在编辑器里照旧出现
 * （它此时不是"重复选项"，而是"你的当前选择"），于是这条路被堵死。
 */
object PidMerge {

    /**
     * 合并后**留在列表里**的那一条：`calc_lh 燃油流量(L/h)`。
     *
     * 它是超集通道（车支持 `01 5E` → 用车的；不支持 → MAF 推算），
     * 所以任何车上它都有值。理由见类注释。
     */
    const val KEEP_ID = "calc_lh"

    /** 被折叠的那一条：`std_5E 燃油消耗率(L/h)`。**仍然在轮询、仍然能被引用** */
    const val FOLDED_ID = "std_5E"

    /** 所有被折叠的 id（以后再有同类合并往这里加，调用方一行都不用改） */
    val FOLDED_IDS: Set<String> = setOf(FOLDED_ID)

    /** 这一条是不是"已并入别人、列表里不再单列" */
    fun isFolded(id: String?): Boolean = id != null && FOLDED_IDS.contains(id)

    /**
     * 给**列表**用的过滤：把被折叠的条目去掉，但 [keep] 里的 id 一律保留。
     *
     * @param keep 当前**已经绑定**的 id（仪表 / 规则条件）。传进来的一律保留 ——
     *   理由见类注释那段"真陷阱"。PID 管理页不需要传（那里没有"当前选择"）。
     * @return 一条都没被折叠时**原样返回同一个 list 实例**（不白拷一份）
     */
    fun filterForList(
        all: List<PidDefinition>,
        keep: Collection<String> = emptyList(),
    ): List<PidDefinition> {
        if (all.none { isFolded(it.id) }) return all
        return all.filter { !isFolded(it.id) || keep.contains(it.id) }
    }

    /**
     * 列表里那一行（[KEEP_ID]）要显示的**合并说明**。
     *
     * ⚠️ **纯文本，不许出现 Markdown 标记**：PID 行是 `TextView` 直接显示字符串，
     * 写 `**合并**` 用户看到的就是带星号的原文（v1.20.11 在知识库页踩过同一个坑，
     * `PidDedup.confirmMessage` 也是同一条约定）。有单测钉着。
     */
    fun mergeNote(): String =
        "已合并「燃油消耗率 01 5E」：车支持 01 5E 就用它，不支持则由空气流量 MAF 推算"

    /** 一行给日志/报告用的说明 */
    fun describe(): String =
        "$FOLDED_ID 已并入 $KEEP_ID：列表不再单列，轮询与派生引用一个都没动"
}
