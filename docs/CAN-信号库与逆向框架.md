# CAN 信号库与逆向框架

> **这份文档回答一个问题**：网上找来的 DBC（`MINI_R59_N18_P4_CAN_2026-10-06.dbc`）那种做法，
> 能不能让 iCarOBD 更好地"抓取分析全部数据"？
>
> **结论**：**方法值得抄，格式不值得引入。** 而且"抓全部"这个目标本身在 ELM327 上做不到 ——
> 瓶颈在硬件，不在数据格式。真正该补的是**信号库 + 三个运行时语义**，不是 DBC 解析器。
>
> **执行规格见 [`下一步-CAN信号库实现规格.md`](下一步-CAN信号库实现规格.md)** ——
> 那边**所有待定项都已定**（顺序 / 轮换参数 / 库存哪 / 候选默认 / 导出格式 / BOM 修复），
> 要动手时直接照它做，不用再回来问。
>
> 状态：**只记录、不动代码**（2026-10-06）。四阶段方案见 §5，待定事项见 §7。

---

## 1. 那份 DBC 是什么

不是 OEM 库。文件自己写着：

> *Project subset for MINI R59 Cooper S N18 1.6T automatic, **P4 passive gauge**.
> NOT a complete OEM vehicle DBC.*

5 条报文 / 11 个信号，**只有 3 个是 `Adopted`**（可信）：`0x1D0` 水温、`0x2C7` 油温 + `MGP_Ref`。

| ID | 信号 | DBC 定义 | 角色 |
|---|---|---|---|
| `0x1D0` | CoolantTemp | `0\|8@1+ (1,-48)` | **Adopted** |
| | OldOilTemp_Candidate | `8\|8@1+ (1,-48)` | Candidate |
| | Baro_Candidate | `24\|8@1+ (0.002,0.598)` | Candidate |
| `0x1D1` | Pressure1_Candidate | `7\|16@0+ (0.1,0)` | Candidate |
| `0x2C0` | Pressure2_Candidate | `23\|16@0+ (0.1,0)` | Candidate |
| `0x2C7` | OilTemp | `0\|8@1+ (1,-50)` | **Adopted** |
| | OilPressure_Race_Candidate | `25\|7@1+ (0.1,0)` | Candidate |
| | MGP_Ref | `32\|8@1+ (0.002×8,-1)` | **Adopted** |
| `0x545` | OlderOilTemp_Candidate | `32\|8@1+ (1,-48)` | Candidate |

### 真正的干货是它发明的 5 个项目属性

| 属性 | 含义 | 默认 |
|---|---|---|
| `SignalRole` | 可信度 `Adopted` / `Candidate` | Candidate |
| `FieldMinDLC` | **解码这个信号至少需要几字节**（不许补零） | — |
| `ProjectInvalidRaw` | 全 1 原始值 = 无效（**项目约定，不是 OEM 惯例**） | — |
| `DisplayTimeoutMs` | **多久没帧就不许再显示** | 2000 |
| `ActualDLCVerified` | 报文长度**是否真量过**（只有 `0x1D0`=1） | 0 |

而且它**明说这只是一半**：

> *DBC alone cannot enforce missing frames, actual DLC or a 2000ms freshness limit.
> **A decoder must apply FieldMinDLC, ProjectInvalidRaw and DisplayTimeoutMs externally.***

### 还有两点态度值得学

- **拒绝编造**：「AFR/Lambda、爆震、进气温度、燃油压力在本子集里没有可用绑定，**故意不造信号**」
- **明确划界**：「那两个老油温候选**不许**用来替代 `0x2C7` 的油温」

---

## 2. 为什么"格式不值得引入"

**运行时只能有一个权威。** 项目已经因为"两份权威"栽过三次：

| 事件 | 病根 |
|---|---|
| v1.17.7 普通/性能/自定义都不显示表盘 | `designJson` 与 `customGauges` 两份都自称权威 |
| v1.19.9 `tpl_left_turn` 改名 | 规则指向了一个已不存在的 id，**静默失效** |
| v1.20.1 `原类型=自定义仪表` | 日志读的是被同步过的字段 |

所以：

```
编辑期（人 / 导入 / 探测）              运行时（唯一权威）           三个消费者
 证据 · 角色 Adopted/Candidate         PidDefinition(source=monitor)
 位定义 start|len@order       ──物化──▶   header   = CAN ID        ┌─ FrameMonitor
 FieldMinDLC / InvalidRaw / 超时          formula  = 自动生成       ├─ CAN 探测页解码
                                        + invalidRaw + minDlc      └─ 仪表 / 规则 / CSV
                                          + ttlMs
```

这与项目里已有的两条路**完全同构**：`DashLayout.Preset` → `customGauges`、`DesignFile` → settings。
**不新造第二套运行时模型。**

### 而且 11 个信号**全都能用现有公式语言写出来**

`be16` / `bits` / `le16` 已经够用，**公式语言零缺口**：

| 信号 | 公式 |
|---|---|
| CoolantTemp `0\|8@1+` | `A - 48` |
| Baro `24\|8@1+` | `C * 0.002 + 0.598` |
| Pressure1 `7\|16@0+` | `be16(A,B) * 0.1` |
| Pressure2 `23\|16@0+` | `be16(C,D) * 0.1` |
| OilPressure_Race `25\|7@1+` | `bits(D,1,7) * 0.1` |
| MGP_Ref `32\|8@1+` | `E * 0.016 - 1` |

（`A`=byte0 … `E`=byte4；Motorola `@0` 的起始位语义用注释交叉验证过：`7|16@0+`→B0:B1、`23|16@0+`→B2:B3。）

---

## 3. 对不上现有模型的 5 处（要补的就是这 5 个）

| DBC 概念 | 应用现在 | 缺口 |
|---|---|---|
| `FieldMinDLC` | 无 | 短帧时 `Formula.eval` 抛异常被 `runCatching` **静默吞掉** → 表现只是"没值"，查不出是 DLC 不够 |
| `ProjectInvalidRaw` | 无 | **会显示错值**：raw 255 → 水温 207℃ |
| `DisplayTimeoutMs` | **全项目没有任何新鲜度判断** | 广播一停，仪表永远冻在最后一个值 |
| `SignalRole` | 无 | Adopted/Candidate 分不出可信度 |
| `ActualDLCVerified` | 无 | provenance，塞 `note` 即可 |

**好消息**：`PidValue.ok` 已存在，语义正好是"无效 → 仪表显示 `--`"。已核实下游
（`VehicleBus.value()` 与 `DashRenderer`）**都是 `ok` 才给值** → 让超时/无效变成 `ok=false`，
**下游零改动**。

---

## 4. 硬约束（这些决定了"抓全部"做不到）

| 约束 | 事实 | 代码位置 |
|---|---|---|
| **半双工** | `ATMA` 监听期间**轮询必须停**（转速/水温会冻住） | `FrameMonitor` 注释 |
| **一次只有一组过滤器** | 单 ID → `ATCRA`；同段多 ID → `ATCM700`+`ATCF<段>`；**跨段 → 不加过滤器** | `FrameMonitor.filterPlan()` |
| **适配器吞吐上限** | 段过滤实测**总帧数 344/秒**；500 kbps 总线正常负载下每秒上千帧 | `turn-signal-09A.md` |
| **主线程切行** | `onRawChunk` 是 `main.post{}` 到主线程的 → 不过滤时每秒上千次主线程解析 | `BleTransport:605` / `SppTransport:291` |

> ⚠️ **DBC 改变不了任何一条。** 而且**信号写得越多，每个 ID 的采样率越低** ——
> 这正是 `turn-signal-09A.md` 用血换来的那句「**采样率是前提，不是细节**」。
> 那份 MINI 文件自己只写了 5 条报文，也印证了"选一小撮、标清可信度"才是能 work 的策略。

### 还有一个前提：**没有 UI 能造监听型 PID**

`PidEditorActivity` 里只有三条只读提示「这是**监听型** PID，不能主动请求」，
**没有任何地方能设 `source=monitor` / `header`**。所以今天全 app 只有 2 条内置监听 PID（转向灯）。

**这是"看得懂"真正的拦路石，比 DBC 解析器重要得多。**

---

## 5. 四阶段框架

### P1 · 抓得更多 ← 建议先做，风险最低
- **分段轮换扫描**：11 位 ID 共 2048 个，按 `0x100` 分 8 段，每段 N 秒自动换段。
  复用现成的 `ATCM700 + ATCF<段>` 机制（`filterPlan` 已有这段代码，只是把"一次"变成"轮着来"）。
- **帧率闸（必须同时做）**：把切行/解析挪到工作线程，只把结果 post 回主线程。
  轮换必然经过大流量段，不做这条就是主动撞 ANR（2026-10-06 12:06 已经撞过一次）。
- **产出**：一张"整车有哪些 ID 在说话 + 每个 ID 的 count/changed/取值集合"的表 —— 后面所有事的**输入**。
- **不引入任何新数据模型。**

> 它能给的是**聚合级**的"存在 + 变化次数 + 取值集合"，**不是每一帧**。
> 这对"发现"足够，对"分析某信号的时序"不够。真要抓全 → 换适配器（CANable / RPi+MCP2515），
> 那是独立的一条路，与 DBC 正交。

### P0 · 把信号记下来（地基，很小）
- `PidEditorActivity` 补 `source=monitor` + `header`(CAN ID) + 三个新字段的输入口。
- `PidDefinition` 加 3 个字段，**默认值 = 旧行为 → 零迁移**：
  `invalidRaw: Int? = null`、`minDlc: Int = 0`、`ttlMs: Int = 0`
- 现有 `mon_turn_left/right` 就是第一批"已确认"信号 —— **成果不丢**。

### P2 · 看得懂
- 探测页每个帧用 `header` 匹配监听 PID → 直接显示 `0x2C7 → 油温 88℃（候选）`。
- 每条显示：当前值 / 角色 / **DLC 够不够** / **距上次收到多久** / **无效原始值**。
- **不需要新模型**（拿已有 PID 的 `formula` 解帧即可）。

### P3 · 别再被骗
- `PidValue` 加 `ttlMs` → `VehicleBus.get()` 判超时 → `ok=false` → **仪表自动 `--`、规则不误触发**。
- `FrameMonitor` 按 `minDlc` 挡、按 `invalidRaw` 判 `ok=false`。
- 日志必须**可诊断**：`信号无效 | 原因=raw全1 / DLC不足 / 超时`。
  现在是 `runCatching` 静默吞掉 —— 这正是"查不出为什么没值"的根源。

### P4 ·（可选）与社区互通
DBC 导入/导出（导入别人的当参考、导出自己的给社区或用 cantools 交叉验证）；
OBDb 那类**主动请求**数据。

---

## 6. 顺序：**P1 → P0 → P2 → P3**

理由：P1 是唯一"不碰数据模型、马上能多拿到东西"的，而且它的产出**正是 P0 要记的东西**。
没有 P1 先找到候选，P0/P2 就是空转。（P0 极小，可与 P1 并行。）

---

## 7. 待定（定了才开工）

1. 顺序认不认可（P1 先）？
2. 轮换参数：8 段 × 每段几秒？（建议 10 秒，一轮 80 秒，另加换段的 AT 开销）
3. 信号库存哪：建议**先只做 `PidDefinition` + 3 字段**，不引入独立"信号库文件" —— 避免第二份权威。
4. 候选默认关（Adopted 开 / Candidate 关 + 分组「候选(未验证)」）认可吗？
5. 要不要核实社区数据（见 §11）？
6. **探测导出的格式**（见 §10）：是否按"观察表 + 信号表模板"两个文件做？
   信号表模板用 §9 的 24 列、并预填探测到的 ID / DLC / 取值集合？

---

## 8. 另一种格式：把 DBC 拍平成 CSV（宝马 E9x/E8x 参数总表）

网上还有一种是**把 DBC 拍平成电子表格**：`E底盘_bmw_e9x_e8x_参数总表.csv`。
218 个信号 / 46 条报文，17 列。**它和 §1 那份 MINI DBC 是同一类东西（信号定义），只是换了个皮。**

### 机械格式

| 项 | 值 |
|---|---|
| 编码 | UTF-8 **带 BOM**（`EF BB BF`） |
| 换行 | CRLF（219/219） |
| 分隔 | 逗号，**无引号**（值里不含逗号） |
| 规模 | 1 表头 + 218 行 / 46 条报文 |
| 缺值 | 只有 `单位` 空 178/218 |

### 17 列 → DBC 对照

| 表列 | 对应 DBC |
|---|---|
| `报文ID(hex)` / `报文ID(dec)` | `BO_ <id>` —— **dec 列是防手抄错的冗余** |
| `报文名` / `DLC` / `发送节点` | `BO_ <id> <name>: <dlc> <transmitter>` |
| `信号名` | `SG_ <name>` |
| `起始位` / `长度(bit)` / `字节序` / `符号` | `start\|len@order±` |
| `因子` / `偏移` / `最小` / `最大` / `单位` | `(factor,offset) [min\|max] "unit"` |
| `接收节点` | `SG_` 末尾的接收者列表 |
| `字节` | **表格独有的便利列**（B0/B1…）；实测与 `起始位` **100% 自洽** |

### 比 DBC 好的三点

1. **可读可编辑**：Excel 直接改，不用怕 DBC 语法。
2. **`报文ID(dec)` + `字节` 两个冗余列专治手抄错** —— 这个思路值得抄。
3. **`DLC` 是真实的**（2/3/4/5/6/7/8 都出现，不像 MINI 那份统一写 8 当容器）；
   发送节点用**真 ECU 名**（DME 发动机 / EGS 变速箱 / DSC 车身稳定 / CAS 点火 /
   FRMFA 灯光 / GWS 挡杆 / SZL 转向柱 / JBBF 车身 / ACC 巡航 / LDM 纵向动态）。

### 比 DBC **少**的东西（关键）

| 缺什么 | 后果 |
|---|---|
| **无效值约定** | 原始值全 1 会被算成一个**看起来很像真的**数字 |
| **新鲜度 / 超时** | 报文停了，值一直冻着 |
| **可信度 / 证据** | 218 行**一列备注都没有** —— 分不清哪些是实测确认的、哪些是抄来的猜测 |
| **值表（VAL_）** | `ST_SW_LEV_RPM = 2` 是什么意思？表里没答案 |
| **多路复用（M/m）** | 表达不了"选择位 = X 时这段才有意义" |
| **周期(ms)** | 不知道每条报文多久发一次 —— **而这直接决定你能不能采到** |
| **校验/计数算法** | 表里有 **57 条** `Checksum_*`/`Counter_*`（26.1%），却没说怎么算 |

### 体检结果（2026-10-06 实测）

✅ **内部完全自洽**：位重叠 **0 处**（167 条 Intel + 51 条 Motorola 混排仍零冲突）、
`字节` 列 100% 自洽、报文内无重名、**0 条解到帧外**。
→ **它一定是机器从一份正经 DBC 导出的，不是手打的。**

> ⚠️ 判"解到帧外"**不能用线性 `起始位+长度`**：Motorola 是**锯齿位序**。
> 用线性判据会误报（实测报了 2 条，重算真实位集后都是误报：
> `ST_OBD_CTFN_GRB` 实际只占 bit56~60、`setMe_0xFC` 只占 bit24~31，都在帧内）。
> 正确算法见 `FrameMonitor` 那类代码，或本文 §5 的说明。

⚠️ **6 行 `最小 > 最大`**：`0x0B5/0x0B6/0x0B7` 的 `TORQ_TAR_*` 写 `1024 ~ 1023.5`
—— 显然是 `-1024` 漏了负号。

⚠️ **48 行的 `最大` ≠ 2^长度−1** → **`最小/最大` 不是编码范围**
（`Counter_*` 写 14、`Checksum_*` 写 0、1 位的 `AccOn` 写 255）。
> **实操结论：做掩码只能用 `长度(bit)`，不能用 `最大`。** 它更像"合理物理范围"。

📝 有占位名（部分报文还没逆向完）：`Unknown140` / `Unknown_d4` / `NEW_SIGNAL_1/2` /
`setMe_0xFC` / `setMe_0x3FFF`。

📝 长度偏小位域：1bit=45、2bit=38、4bit=48、8bit=42、12bit=20、16bit=20。

### 它最有价值的地方：一份**通用车信号清单**

⚠️ **不能当数据用**（宝马 ≠ 阿特兹，CAN ID 厂家自定义，硬套会给出"看起来很像真的错值"）。
但它列的这些信号是**通用**的，可以直接当"在马自达上要找什么"的对照表：

| 报文 | 信号 | 意义 |
|---|---|---|
| `0x1A0 Speed`(DSC) | VehicleSpeed / MovingForward / LongAcc / LatlAcc / YawRate | 车速 + 纵横向加速度 + 横摆角速度（一条报文全有） |
| `0x0CE WheelSpeeds`(DSC) | Wheel_FL/FR/RL/RR | 四轮速 |
| `0x0AA AccPedal`(DME) | EngineSpeed / AcceleratorPedalPercentage | 转速 + 油门 |
| `0x1F6 TurnSignals`(FRMFA) | LeftTurn / RightTurn / TurnSignalActive | **转向灯** |
| `0x198 GearSelectorSwitch`(GWS) | ShifterPosition / ParkButton / SportButton | 挡位 + 挡杆按钮 |
| `0x130 TerminalStatus`(CAS) | ST_KL_R / ST_KL_15 / ST_KL_50 / KEY_VLD / AccOn | 点火钥匙状态（KL15/KL50 是宝马术语） |
| `0x3B4 PowerBatteryVoltage` | BatteryVoltage | 电压 |
| `0x0C4 SteeringWheelAngle` | SteeringPosition / SteeringSpeed | 方向盘转角与角速度 |

> **一个具体发现**：宝马把转向灯放在**独立报文 `0x1F6`** 里（LeftTurn / RightTurn 各占一位）；
> 而本项目在阿特兹上是**在 `0x09A` 这个通用车身报文里**找到的。
> **形状不同，方法一样** —— 都是"操作那个开关 → 看哪个位在跳"。

---

## 9. 两种格式怎么选，以及建议的信号表列集

| | DBC（§1） | 拍平 CSV（§8） |
|---|---|---|
| 人读/人改 | 差（语法敏感） | **好（Excel 直接改）** |
| 工具生态 | **好**（cantools / CANdb++ / Wireshark / SavvyCAN） | 一般（要自己写解析） |
| 自定义属性 | 支持（`BA_DEF_`） | 只能靠加列 |
| 位序陷阱 | **Motorola 是经典坑** | 同样有，但 `字节` 列能兜一半 |
| 适合当**内部存储** | 否（要写解析器） | **是**（一行一信号，`org.json` 都不用） |
| 适合当**对外交换** | **是**（行业通用） | 一般 |

**建议：内部用 JSON / 拍平表；对外支持 DBC 导入导出。**

### 建议的信号表列集 = 那 17 列 + 这 7 列

那 17 列**够描述"怎么解码"，不够描述"可不可信、什么时候不能用"**。要补：

| 建议加的列 | 为什么 |
|---|---|
| **可信度**（已确认 / 候选） | 表里必然混着猜的，不分级就会把猜测当结论（对应 MINI 那份的 `SignalRole`） |
| **证据**（哪次实测、原始取值） | 出问题能回溯 —— 这是 `turn-signal-09A.md` 那种笔记的价值 |
| **无效原始值** | 否则全 1 变成"看起来很像真的读数"（对应 `ProjectInvalidRaw`） |
| **显示超时(ms)** | 报文停了要变 `--`（对应 `DisplayTimeoutMs`） |
| **周期(ms)** | **决定能不能采到**（采样率是前提） |
| **值表** | 枚举含义（`ST_SW_LEV_RPM=2` 是什么） |
| **多路复用条件** | 有选择位的报文必需 |

> 前 4 列正是 §1 那份 MINI DBC 用 `BA_DEF_` 发明出来的东西 ——
> **两份网络资料合起来才是一份完整的规格**：宝马表给了"怎么解"，MINI DBC 给了"什么时候不许显示"。

---

## 10. 探测导出 ↔ 信号表：把它做成闭环

> 用户问："这个表格的格式可以给 app 的探测日志导出格式用吗？"
>
> **直接答**：**作为"探测日志"不行，作为"信号表"可以** —— 因为两者是**不同的对象**：
> 探测导出是**观察**（我看到总线上有这些 ID、它们在跳），信号表是**结论**（这一位是转向灯）。
> 探测的时候**你还不知道** `起始位/长度/因子`，那几列必然是空的。

### 但可以做成配套的一对，而且闭环

```
① 探测（CAN 探测页）        →  导出「观察表」：canId / dlc / count / changed / values
                                （现有 aggregateCsv + rawCsv 已经就是这个）
② 导出「信号表模板」         →  用 §9 的 24 列，**预填**从探测里自动能得到的：
                                报文ID(hex)/dec、DLC、**该 ID 出现过的取值集合**
                                （其余列留空等人填）
③ 人在 Excel / 电脑上填       →  「这一位是左转」+ 可信度 + 证据
④ 导回 app                  →  变成监听型 PID（source=monitor + header + 公式）
```

**第 ② 步的"预填取值集合"是关键** —— 它正是 `turn-signal-09A.md` 里那个判据：
「操作开关 → 看这个 ID 的取值集合变了哪一位」。把它直接印在模板里，人就不用自己去翻 hex。

### 落地时的三个具体约束

1. **CSV 必须带 UTF-8 BOM**，否则 Windows Excel 按 ANSI 打开，**中文表头会乱码**。
   （§8 那份宝马表带 BOM，说明做它的人也踩过这一下。）
2. **"观察"和"信号表"建议做成两个文件**（或两个导出按钮），
   不要塞进同一个 CSV 用分隔行硬切 —— Excel 里会很难看，程序解析也容易出错。
   （Excel 原生支持多 sheet，但 CSV 不支持；要单文件多表就得上 xlsx，不值。）
3. **导回来的表要校验**：`起始位+长度` 不能超 DLC（按字节序算真实位集，见 §8 的警告）、
   `最小 ≤ 最大`、同一报文内**位不能重叠** —— 这三条正是 §8 那份表被查出来的问题类型。

### 与 §5 四阶段的关系

这一节落在 **P2（看得懂）** 上：探测页现在只给原始 hex 和 `changed` 次数，人看不懂；
有了信号表，同一批数据就能显示成"水温 92℃（候选）"。
而**导出模板 = 把 P1 的产出直接喂给 P0 的录入** —— 不用手抄。

---

## 11. 社区数据线索（**未核实**）

搜到这些，但**本机 `github.com` / `raw.githubusercontent.com` / `jsdelivr` 都被 DNS 解析到非公网 IP，
`web_fetch` 全被挡**，所以内容没核实：

| 线索 | 是什么 | 对应哪一半 |
|---|---|---|
| [OBDb/Mazda-6](https://github.com/OBDb/Mazda-6) | 按车型分的社区信号库（同族还有 Mazda-CX-5 / Porsche-Cayenne / Chevrolet-Equinox-EV…），内容是 "command data" | **主动请求**（轮询） |
| [Trevelopment/mazdatweaks](https://github.com/Trevelopment/mazdatweaks) | 马自达 CAN 改码工具 | 主动请求 |
| [Mazda6Club: TPMS over OBD](https://www.mazda6club.com/threads/accessing-the-tpms-info-using-odb.446406/) | 论坛帖 | 主动请求 |

⚠️ **注意**：这些是**主动请求**那一半 —— 恰好是应用**最成熟**的部分（扫描器 / Mode 22 / `AT SH` / 公式）。
**广播帧那一半社区几乎没有现成数据**，只能自己摸 —— 所以 P1/P2 的价值更高。

---

## 12. 一句话备忘

> 那份 MINI DBC **一个信号都不能用在阿特兹上**（CAN ID 是厂家自定义的，硬套会给出
> **看起来很像真的错值**，比没数据危险）。**只当格式参考。**
