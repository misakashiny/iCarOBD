package com.icar.obd.ui

import android.os.Bundle
import android.text.method.LinkMovementMethod
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.google.android.material.button.MaterialButton
import com.icar.obd.R

/**
 * **知识库**（v1.20.2 新建 / v1.20.3 改成导航 tab + 标签筛选）。
 *
 * ## 为什么要有它
 *
 * 日志页会打出 `7F 11 13`、`NO DATA`、`有值 20/25`、`ATCRA09A`、`changed=13` 这类东西。
 * 它们**在项目内部都有明确含义**（很多还是踩坑换来的），但看的人得先翻三份文档。
 * 结果就是：明明日志已经说了原因，人还是不知道下一步该干什么。
 *
 * 所以这一页只做一件事：**把术语和"怎么探测 / 怎么分析"就地讲清楚**，
 * 并且尽量给出**本项目实测的数字**（不是通用科普）。
 *
 * ## 为什么是 Fragment 而不是 Activity
 *
 * 用户要求："知识库不是在日志里进入、而是直接增加个 tab 标签、知识库"。
 * 所以它现在是导航栏里的一个 tab，由 `MainActivity.switchTo` 用 hide/show 管。
 *
 * ## 为什么内容是 Kotlin 列表而不是 XML
 *
 * 这份东西的价值在于**改起来快**。每加一条术语应该只加一行；
 * 写成 XML 就是几十个 TextView 标签，以后没人愿意动（"反正能跑"）。
 *
 * 格式约定：正文用纯文本 + `·` 分条 + 全角空格缩进 —— **不做 Markdown 渲染**，
 * 免得为了一页说明引入一套渲染器。
 */
class KnowledgeFragment : Fragment() {

    private data class Section(val title: String, val body: String)

    private lateinit var llSections: LinearLayout
    private lateinit var etFilter: EditText
    private lateinit var tvFilterHint: TextView
    private lateinit var chipTags: com.google.android.material.chip.ChipGroup
    private val cards = ArrayList<Pair<Section, View>>()

    /** 当前选中的标签；[TAG_ALL] = 不筛 */
    private var tag = TAG_ALL

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_knowledge, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        llSections = view.findViewById(R.id.llSections)
        etFilter = view.findViewById(R.id.etFilter)
        tvFilterHint = view.findViewById(R.id.tvFilterHint)
        chipTags = view.findViewById(R.id.chipTags)

        buildTagChips()
        buildSections()
        etFilter.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) = applyFilter(s?.toString().orEmpty())
        })
        applyFilter("")
    }

    /**
     * 标签筛选条（v1.20.3）。
     *
     * 用户要求："给知识库增加个标签区分、可以筛选标签查看知识，
     * 如这个文档讲的是 obd 的、就给个 obd 标签"。
     *
     * 标签**按节索引映射**（见 [TAG_MAP]），不写进正文 ——
     * 正文是"文档性质的代码"，改它的时候不该还要顺手维护标签。
     */
    private fun buildTagChips() {
        chipTags.removeAllViews()
        (listOf(TAG_ALL) + TAGS).forEach { t ->
            chipTags.addView(
                com.google.android.material.chip.Chip(requireContext()).apply {
                    text = t
                    isCheckable = true
                    isChecked = t == TAG_ALL
                }
            )
        }
        // ⚠️ **不要**在 chip 上挂 OnCheckedChangeListener / OnClickListener（v1.20.3 实测）：
        // `ChipGroup(singleSelection=true)` 为了管单选，会在 `onViewAdded` 时给每个 chip
        // 装自己的 OnCheckedChangeListener —— **先挂的会被它覆盖**。
        // 症状：点了 CAN，chip 的 `checked` 确实变成了 true，但我的回调一次都没进，
        // 提示行还停在"共 13 节"（查了半天才发现是监听被顶掉了）。
        // 正确做法是用 ChipGroup 自己的这个 API。
        chipTags.setOnCheckedStateChangeListener { group, checkedIds ->
            val id = checkedIds.firstOrNull()
            tag = if (id == null) TAG_ALL else {
                group.findViewById<com.google.android.material.chip.Chip>(id)?.text?.toString() ?: TAG_ALL
            }
            applyFilter(etFilter.text?.toString().orEmpty())
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun buildSections() {
        SECTIONS.forEachIndexed { idx, s ->
            val card = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundResource(R.drawable.bg_card)
                setPadding(dp(14), dp(12), dp(14), dp(12))
            }
            // 标题行：标题 + 该节的标签（小字、暗色）
            card.addView(TextView(requireContext()).apply {
                text = s.title
                setTextColor(ContextCompat.getColor(requireContext(), R.color.accent))
                textSize = 14f
            })
            val tags = tagsOf(idx)
            if (tags.isNotEmpty()) {
                card.addView(TextView(requireContext()).apply {
                    text = tags.joinToString(" · ") { "#$it" }
                    setTextColor(ContextCompat.getColor(requireContext(), R.color.text_dim))
                    textSize = 10.5f
                    setPadding(0, dp(3), 0, 0)
                })
            }
            card.addView(TextView(requireContext()).apply {
                text = s.body
                setTextColor(ContextCompat.getColor(requireContext(), R.color.text_secondary))
                textSize = 12.5f
                setLineSpacing(dp(4).toFloat(), 1f)
                setPadding(0, dp(8), 0, 0)
                movementMethod = LinkMovementMethod.getInstance()
            })
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
            llSections.addView(card, lp)
            cards.add(s to card)
        }
    }

    private fun applyFilter(q: String) {
        val key = q.trim().lowercase()
        var shown = 0
        cards.forEachIndexed { idx, (s, v) ->
            val tagHit = tag == TAG_ALL || tagsOf(idx).contains(tag)
            val textHit = key.isEmpty() ||
                s.title.lowercase().contains(key) || s.body.lowercase().contains(key)
            val hit = tagHit && textHit
            v.visibility = if (hit) View.VISIBLE else View.GONE
            if (hit) shown++
        }
        tvFilterHint.text = buildString {
            append("共 ").append(cards.size).append(" 节")
            if (tag != TAG_ALL) append(" · 标签「").append(tag).append("」")
            append(" · 当前显示 ").append(shown).append(" 节")
        }
    }

    /** 某一节的标签。**按索引映射**，正文里不写标签 —— 见 [buildTagChips] 的说明 */
    private fun tagsOf(idx: Int): List<String> = TAG_MAP[idx] ?: emptyList()

    private companion object {

        const val TAG_ALL = "全部"

        /** 标签词表。加新标签时记得给相关节在 [TAG_MAP] 里挂上 */
        val TAGS = listOf("基础", "OBD", "CAN", "ELM327", "探测", "分析", "术语")

        /**
         * 节索引 → 标签。索引与 [SECTIONS] 的顺序一一对应。
         *
         * ⚠️ 在 [SECTIONS] **中间插一节**时要顺手改这里（否则标签会错位）。
         * 之所以不用"在正文里写标签"，是因为正文是"文档性质的代码"，
         * 改术语时不该还要维护标签；而错位的后果只是筛错，不是崩。
         */
        val TAG_MAP: Map<Int, List<String>> = mapOf(
            0 to listOf("基础"),
            1 to listOf("OBD", "术语"),
            2 to listOf("CAN", "术语"),
            3 to listOf("ELM327", "术语"),
            4 to listOf("OBD", "探测"),
            5 to listOf("CAN", "分析"),
            6 to listOf("CAN", "分析"),
            7 to listOf("CAN", "分析"),
            8 to listOf("OBD", "分析"),
            9 to listOf("OBD", "术语"),
            10 to listOf("CAN", "探测"),
            11 to listOf("术语"),
            12 to listOf("基础"),
        )

        /**
         * 全部内容。
         *
         * ⚠️ **写的时候刻意带上本项目的实测数字**（344 帧/秒、2.1Hz、20/25…）——
         * 通用科普在网上到处都是，值钱的是"**这台设备 + 这辆车**量出来是多少"。
         */
        val SECTIONS: List<Section> = listOf(

            Section(
                "0. 先看这个：数据从哪来（三条链路）",
                """
                ① 主动请求（轮询）—— 发 `01 0C` 这样的请求，ECU 应答。
                　 标准 PID、厂家 Mode 22 都走这条。**受轮询节奏限制**，一条一条排队。
                ② 广播帧（监听）—— 别的模块自己在总线上周期性喊，你只能听。
                　 转向灯、车门、刹车这类**不在标准 OBD 里**的信号只存在于这里。
                　 代价：ELM327 半双工，**监听期间轮询必须停**（转速/水温会冻住）。
                ③ 模拟信号 —— 不接车也能调试（「连接 → 模拟信号」）。

                三条链路最终都写进同一张表（VehicleBus），所以**规则、仪表、CSV
                完全不用关心数据是从哪来的**。
                """.trimIndent()
            ),

            Section(
                "1. OBD-II 与 PID 是什么",
                """
                PID = Parameter ID，一个"问哪个参数"的编号。
                请求帧 = `模式 + PID`，例如 `01 0C` = 「Mode 01，要发动机转速」。

                · Mode 01 —— 标准实时数据（`01 0C` 转速、`01 05` 水温…），**全世界通用**
                · Mode 02 —— 冻结帧（故障发生那一刻的快照）
                · Mode 03 —— 读故障码（DTC）
                · Mode 09 —— 车辆信息（`09 02` VIN、`09 04` 标定 ID）
                · Mode 22 —— **厂家自定义**，PID 是 2 字节（`22 1234`）。
                　 想读厂家的东西基本都靠它 —— 但没有公开手册，只能扫。

                应答长这样：`41 0C 1A F8` = `41`（= 01 + 0x40，表示"应答的是 01"）+ `0C`
                + 数据 `1A F8`。公式 `be16(A,B)/4` → 转速。
                数据里的 `A` `B` `C`… 就是**第 1、2、3… 个数据字节**。
                """.trimIndent()
            ),

            Section(
                "2. CAN 总线：ID、DLC、广播帧",
                """
                CAN 是车上模块之间通信的总线，500 kbps（本项目实测适配器报 A0/A6 自动协商）。
                每一帧 = **CAN ID + 最多 8 字节数据**。

                · **CAN ID**：谁发的 / 这是什么报文。11 位（`0x000~0x7FF`）叫标准帧，
                　 29 位叫扩展帧。本项目的 `header` 字段填的就是它（如 `09A`）。
                · **DLC**：Data Length Code，这一帧实际有几个字节。
                　 ⚠️ **不是所有帧都是 8 字节**。DLC 不够时后面的字节**不存在** ——
                　 补零去凑长度会解出**看起来很像真的错值**。
                · **广播帧 vs 请求应答**：OBD 请求走 `7DF` 广播、应答回 `7E8`；
                　 而转向灯那种是某个模块**自己周期发**的（本项目实测 `0x09A` 约 2.1 Hz）。
                · **周期**决定你能看见什么：一个 2 Hz 的闪烁信号，如果你每秒只采到 1 帧，
                　 它会被完全抹平（见下面「采样率」一节）。
                """.trimIndent()
            ),

            Section(
                "3. ELM327 与常用 AT 命令",
                """
                ELM327 是 OBD 适配器里的"翻译芯片"：你把 ASCII 命令发过去，它转成总线电平。
                `AT` 开头的命令都是**配置它自己**，不是发给车。

                · `ATZ` 复位 / `ATE0` 关回显 / `ATH1` 显示 CAN 头（**监听时必须开**）
                · `ATS1` 空格分隔 / `ATL1` 换行
                · `ATSP0` 协议自动 / `ATDPN` 查当前协议（本项目实车锁定在 `A6`）
                · `ATSH 7E0` **把后续请求发给指定模块**（发动机 7E0 / 变速箱 7E1 / 仪表 720…）
                　 ⚠️ 它是**粘性**的：设了之后所有请求都往那儿发，切回广播要显式发 `ATSH 7DF`
                · `ATCRA 09A` 只放行这一个 ID（**单 ID 过滤，最省**）
                · `ATCM 700` + `ATCF 100` 掩码 + 过滤器：放行 `0x100~0x1FF` 一整段
                · `ATMA` 被动监听（**半双工：开着它就不能发请求**）
                · `ATAR` / `ATCM 000` / `ATCF 000` 清过滤器 —— ⚠️ 本项目实测**三条都回 OK 却清不掉**，
                　 唯一确定有效的是 `ATZ` 全复位。
                """.trimIndent()
            ),

            Section(
                "4. 怎么探测 PID（主动）",
                """
                「PID」页 → 扫描器。原理是三步：

                ① **问支持位图**：发 `01 00`，ECU 回 4 字节位图，告诉你"01~20 里我支持哪几个"。
                　 位图链：`01 20` 告诉你 21~40，`01 40` 告诉你 41~60…（本项目扫到 `01 C0`）
                ② **收敛范围**：只扫位图说支持的，跳过黑名单（已知会让适配器卡死的号）
                ③ **逐条试**：每个号发一次，看有没有合法应答。默认 150ms 间隔 / 1500ms 超时

                **为什么慢**：一条 150ms + 超时，50 多个号就是十几秒到几十秒。
                间隔调小会压垮适配器（它是单线程的，半双工）。

                **"这台车不支持"怎么判定**：只有 ECU **明确回否定响应**（`7F <服务> <NRC>`）
                才算不支持；**超时、总线错不算**（那是通信问题，不是车的问题）。
                本项目会在连续失败 N 次后把那条标灰并退出轮询，避免一直制造噪音。

                读不到的常见 NRC：`0x11` 服务不支持 / `0x12` 子功能不支持 / `0x13` 报文长度错
                / `0x22` 条件不满足 / `0x31` 请求超范围。
                """.trimIndent()
            ),

            Section(
                "5. 怎么分析 CAN（被动）—— 采样率是前提",
                """
                「PID」页 → CAN 探测。或「CAN 探测」页开常驻监听。

                ⚠️ **第一条铁律：采样率是前提，不是细节。**
                判断"能不能看见一个信号"之前，先算：
                ```
                适配器实际帧率 ÷ 目标 ID 的广播频率 = 你每秒能采到几帧
                ```
                本项目实车实测：
                · 不过滤：总共只漏出约 **77 帧/秒**，摊到 80 个 ID 上 → **每个 ID 每秒 1 帧**
                　 结果：`0x09A` 20 秒只采到 4~5 帧，1.4 Hz 的转向灯闪烁被**完全抹平**
                　 （`changed` 一直是 0，看起来像"这个 ID 不动"）
                · 单 ID 过滤（`ATCRA09A`）：`0x09A` 从 0.7 帧/秒 → **20 帧/秒**
                · 段过滤（`ATCM700+ATCF000`）：总帧数 77/秒 → **344 帧/秒**

                **所以：想看清一个信号，就把它单独放行。**

                过滤器三档（本项目按监听信号自动选）：
                · 只有一个 ID → `ATCRA<id>`（最省）
                · 多个 ID 落在同一 `0x100` 段 → `ATCM700 + ATCF<段>`
                · 跨多个段 → **不加过滤器**（会打一条警告）—— 这是最坏情况，注意 ANR 风险
                """.trimIndent()
            ),

            Section(
                "6. 聚合表里那三列怎么读（count / changed / values）",
                """
                探测结束后每个 ID 一行：

                · `count` —— 收到多少帧。**大 = 这个 ID 在周期广播**（静止的 ID 很少）
                · `changed` —— 数据变化过几次。**这才是"活不活"的判据**
                　 count 大而 changed 小 → 周期广播但内容恒定（例如状态心跳）
                　 changed 大 → 内容在跳，**值得查**
                · `values` —— 出现过的**不同取值**（最多记 8 个）
                　 ⚠️ 为什么不能只看最后一帧：周期信号可能正好停在"暗"相位。
                　 本项目实车就卡在这 —— `0x09A` 已知跟着转向灯跳，
                　 但左转、右转两次的 `last` 都是 `00`，**光看 last 分不出左右**。
                　 看 `values` 才发现两次各自只有 2 个取值，且只差一位（`04` / `08`）。

                判断"某一位是不是某个开关"的套路：
                ① 先确认这个 ID 在周期广播（count 大）
                ② 操作那个开关（拨转向灯 / 踩刹车 / 开门），再采一次
                ③ 对比两次的 `values`：**只有一位在变的**，就是它
                """.trimIndent()
            ),

            Section(
                "7. 「对比基准」怎么用（把找信号从人工差分变成点两下）",
                """
                「CAN 探测」页 → 先采一次作为**基准**，再操作一个动作，再采一次 → 自动差分。

                输出的是"两次之间哪些 ID 的哪些位变了"。这正是第 6 节那套套路的自动化版本：
                你不需要自己记住上一次的 hex。

                适用场景：
                · 找转向灯 / 刹车 / 车门 / 挡位这种**开关量** —— 最有效
                · 找"某个数值跟着什么变" —— 有效，但要注意数值是连续量，
                　 差分出来的是"变了"，不是"对应关系"

                ⚠️ 差分只说明"**相关**"，不说明"就是这个"。要确认必须**重复一次**：
                同样的动作，同样的位跳 —— 那才算钉住。
                """.trimIndent()
            ),

            Section(
                "8. 为什么「没有值」—— 现象 → 原因对照",
                """
                · `NO DATA` —— 适配器发了请求但没等到应答。多半是：这个 PID 车不支持 /
                　 模块头不对（该发 `ATSH` 却发了广播）/ 协议还没锁定
                · `SEARCHING...` / `STOPPED` —— 协议自动搜索没完成就开始轮询。
                　 本项目现在会**等 `ATDPN` 不再是 `A0`** 再开始
                · `7F <服务> <NRC>` —— ECU **明确拒绝**（见第 4 节的 NRC 表）。
                　 这是最有信息量的失败，别当成"无有效响应"吞掉
                · `有值 0/25` —— 一条都没成功。先看上面几条失败原因，别急着换 PID
                · `有值 20/25` —— 链路是通的，差的 5 个是这台车真的没有
                · 仪表显示 `--` —— 值无效或还没收到。**"无效"和"没收到"是两回事**：
                　 原始值是全 1（如 255）通常表示"这个传感器不存在"，不是 255 摄氏度
                · 数据冻住不动 —— 半双工：**开着常驻监听时轮询是停的**，这是设计如此
                """.trimIndent()
            ),

            Section(
                "9. 本项目的公式语言（把字节变成物理量）",
                """
                变量 `A`~`Z` = 应答/帧里的第 1、2、3… 个**数据字节**（0~255）。

                · 四则运算 + 括号：`A * 0.1 - 48`
                · `bit(C,2)` —— 取第 3 字节的第 2 位（0 起）。**转向灯就是这么写的**
                · `be16(A,B)` 大端两字节 / `le16(A,B)` 小端 / `s16(A,B)` 有符号 16 位
                · `bits(v, start, len)` —— 从 v 里取一段位。非字节对齐的信号用它
                · `map(值, k1,v1, k2,v2 …)` —— 查表。**取最接近的 key**（不是精确相等），
                　 用于挡位、状态字这种离散量
                · `signed(A)` 把单字节当有符号 / `min max abs round floor ceil sqrt`

                例：`0x09A` 第 3 字节 bit2 = 左转 → 公式就写 `bit(C,2)`。

                ⚠️ 公式里**没有"无效值"的概念**。原始值全 1 时公式照样算出个数
                （255 - 48 = 207℃）—— 所以"无效"必须由**另外的规则**兜（见知识库末节）。
                """.trimIndent()
            ),

            Section(
                "10. 监听型 PID（source = monitor）与它的代价",
                """
                普通 PID 是"我发请求、ECU 应答"；**监听型 PID** 是"从广播帧里取值"。
                配置方式：`header` 填 CAN ID（如 `09A`）、`mode` 填 `MON`、公式照写。

                为什么必须单列一类：广播帧**不能主动请求**（没人应答你），
                只能开 `ATMA` 被动听。所以它们不进轮询队列。

                代价（**这是硬件限制，不是实现选择**）：
                · `ATMA` 期间**轮询暂停** → 转速/水温冻在最后一个值
                · 退出监听要 `ATZ` 全复位（过滤器清不掉，见第 3 节）
                · 不过滤时每秒上千帧要解析 → 有主线程压力（本项目为此 ANR 过一次）

                所以：**监听型 PID 适合"少数几个必须的开关量"，不适合大批量。**
                """.trimIndent()
            ),

            Section(
                "11. 术语速查",
                """
                · **PID** 参数编号（Parameter ID）
                · **DLC** 这一帧实际有几个数据字节（Data Length Code）
                · **ECU** 车上的控制模块（发动机/变速箱/ABS…）
                · **NRC** 否定响应码，ECU 拒绝请求时给的原因
                · **DTC** 故障码
                · **广播帧** 模块自己周期发的帧，没人请求它
                · **半双工** 同一时刻只能收或发 —— ELM327 的硬限制
                · **采样率** 每秒能采到多少帧。**决定你能看见什么，是前提不是细节**
                · **量程（min/max）** 仪表弧长/条长的映射范围，不是传感器精度
                · **报警阈值（warnLow/warnHigh）** 超了才变色/爆闪
                · **派生通道** 由别的量算出来的值（如 `calc_l100` 百公里油耗）
                · **参考线** 画布上的对齐网格，只是视觉辅助
                · **设计文件（icar.ui/1、/2）** 电脑端主题工具产出的布局文件；
                　 v2 是节点树（图片/分组/文字/仪表 + 旋转 + 状态系统）
                """.trimIndent()
            ),

            Section(
                "12. 一句话记住三件事",
                """
                ① **采样率是前提**：看不见一个信号，先算你每秒采到几帧，别先怀疑信号不存在。
                ② **相关不等于因果**：差分出来"变了"只说明相关，同样的动作**重复一次**才算钉住。
                ③ **无效值不是数值**：全 1 的原始值通常表示"传感器不存在"，
                　 别让它变成一个看起来很像真的读数。
                """.trimIndent()
            )
        )
    }
}
