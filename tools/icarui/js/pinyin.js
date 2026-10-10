/**
 * **汉字 → 拼音**（v2.51.0）。
 *
 * ## 为什么只有 368 个字
 *
 * 这不是通用字库 —— 它是从**现有控件名 / 素材名 / 分类名**里
 * 提取出来的**实际用到的字**（脚本扫出来的）。
 * 全字库要几百 KB，而这里只要几 KB。
 *
 * ## 代价
 *
 * **以后新增的控件/素材名字里如果有生字，那个字就搜不到拼音。**
 * 这是有意的取舍 —— 但必须留个提醒，否则以后会当成 bug 查半天。
 *
 * 加字的办法：往下面的字符串里追加 `字:pinyin`，用空格分隔。
 */
(function () {
  const RAW = "三:san 上:shang 下:xia 不:bu 丝:si 两:liang 严:yan 个:ge 主:zhu 义:yi 乐:le 五:wu 人:ren 仪:yi 件:jian 任:ren 位:wei 低:di 体:ti 何:he 佛:fo 侧:ce 保:bao 信:xin 倒:dao 值:zhi 像:xiang 充:chong 光:guang 全:quan 八:ba 六:liu 关:guan 其:qi 典:dian 养:yang 内:nei 冕:mian 冠:guan 凹:ao 刀:dao 分:fen 切:qie 划:hua 列:lie 别:bie 到:dao 制:zhi 刷:shua 刹:sha 刻:ke 前:qian 割:ge 力:li 加:jia 动:dong 助:zhu 匙:chi 区:qu 半:ban 单:dan 占:zhan 卡:ka 危:wei 压:ya 叉:cha 双:shuang 发:fa 变:bian 口:kou 可:ke 右:you 号:hao 叹:tan 后:hou 向:xiang 含:han 告:gao 品:pin 器:qi 噪:zao 囊:nang 四:si 图:tu 圆:yuan 圈:quan 均:jun 块:kuai 垂:chui 型:xing 基:ji 塞:sai 填:tian 备:bei 外:wai 大:da 失:shi 头:tou 子:zi 字:zi 它:ta 安:an 定:ding 实:shi 容:rong 宽:kuan 对:dui 导:dao 小:xiao 层:ceng 属:shu 巡:xun 左:zuo 已:yi 带:dai 常:chang 平:ping 应:ying 底:di 度:du 座:zuo 建:jian 开:kai 式:shi 引:yin 弧:hu 强:qiang 形:xing 径:jing 徽:hui 心:xin 态:tai 总:zong 息:xi 意:yi 感:gan 成:cheng 手:shou 打:da 扫:sao 报:bao 拉:la 拖:tuo 括:kuo 拼:pin 持:chi 挂:gua 指:zhi 挡:dang 捕:bu 损:sun 据:ju 接:jie 控:kong 描:miao 提:ti 撞:zhuang 放:fang 故:gu 数:shu 整:zheng 文:wen 斜:xie 方:fang 无:wu 日:ri 旧:jiu 时:shi 星:xing 晕:yun 景:jing 暖:nuan 暗:an 月:yue 期:qi 未:wei 机:ji 材:cai 条:tiao 板:ban 枪:qiang 柴:chai 标:biao 栏:lan 样:yang 格:ge 桂:gui 框:kuang 椅:yi 横:heng 次:ci 正:zheng 段:duan 每:mei 比:bi 气:qi 水:shui 池:chi 汽:qi 油:you 波:bo 注:zhu 测:ce 涡:wo 深:shen 清:qing 渐:jian 温:wen 游:you 滑:hua 满:man 滤:lv 灯:deng 点:dian 烁:shuo 热:re 燃:ran 片:pian 版:ban 牌:pai 牙:ya 牵:qian 状:zhuang 环:huan 玻:bo 珀:po 琥:hu 璃:li 用:yong 电:dian 白:bai 百:bai 监:jian 盖:gai 盗:dao 盘:pan 盲:mang 直:zhi 盾:dun 瞬:shun 短:duan 础:chu 碰:peng 碳:tan 磨:mo 示:shi 程:cheng 空:kong 窗:chuang 竖:shu 签:qian 箭:jian 箱:xiang 粒:li 粗:cu 系:xi 素:su 红:hong 纤:xian 纵:zong 纹:wen 线:xian 组:zu 细:xi 经:jing 统:tong 续:xu 维:wei 绿:lv 缺:que 网:wang 置:zhi 翼:yi 耗:hao 联:lian 背:bei 胎:tai 胶:jiao 自:zi 航:hang 舱:cang 色:se 节:jie 荷:he 菱:ling 蓝:lan 虚:xu 螺:luo 行:xing 表:biao 装:zhuang 视:shi 角:jiao 警:jing 计:ji 议:yi 记:ji 设:she 识:shi 话:hua 调:tiao 负:fu 败:bai 足:zu 车:che 轨:gui 转:zhuan 轮:lun 轴:zhou 辅:fu 边:bian 达:da 过:guo 近:jin 进:jin 远:yuan 连:lian 适:shi 通:tong 速:su 道:dao 部:bu 释:shi 里:li 重:zhong 量:liang 金:jin 针:zhen 钉:ding 钟:zhong 钥:yao 铆:mao 铭:ming 锋:feng 锥:zhui 镜:jing 长:chang 门:men 闪:shan 间:jian 防:fang 阵:zhen 限:xian 除:chu 险:xian 隐:yin 隔:ge 障:zhang 集:ji 雨:yu 雪:xue 雷:lei 雾:wu 霜:shuang 青:qing 非:fei 面:mian 音:yin 页:ye 预:yu 颗:ke 题:ti 飞:fei 饰:shi 驱:qu 高:gao 齿:chi 龙:long";
  const MAP = {};
  RAW.split(/\s+/).forEach(function (p) {
    const i = p.indexOf(":");
    if (i > 0) MAP[p.slice(0, i)] = p.slice(i + 1);
  });

  window.PINYIN = MAP;

  /**
   * 把一个名字转成**拼音串**（全拼连写 + 首字母）。
   *
   * 返回 `{ full, initials }`：
   *   `碳纤维` → `{ full: "tanxianwei", initials: "txw" }`
   *
   * 非汉字原样拼进去（小写），这样 `圆表A` → full `yuanbiaoa`、initials `yba`。
   * 查不到拼音的字**跳过**（不塞占位符），否则 initials 会多出莫名的字母。
   */
  window.pinyinOf = function (text) {
    const s = String(text || "");
    let full = "", initials = "";
    for (const ch of s) {
      const py = MAP[ch];
      if (py) { full += py; initials += py[0]; }
      else if (/[a-zA-Z0-9]/.test(ch)) { full += ch.toLowerCase(); initials += ch.toLowerCase(); }
      // 其它字符（空格 / 标点 / 查不到的字）跳过
    }
    return { full: full, initials: initials };
  };

  /**
   * **拼音匹配**：`q` 是否命中 `text`。
   *
   * 支持三种输入（都大小写不敏感）：
   *   `tanxianwei`  全拼
   *   `txw`         首字母
   *   `碳纤维`      原文（调用方本来就会测，这里顺带也测一下）
   *
   * ⚠️ **首字母匹配要求 q 全是字母** —— 否则输入 `圆` 会拿它去比 initials，
   * 而 `圆` 不在 initials 里，白跑一趟。
   */
  window.matchPinyin = function (text, q) {
    if (!q) return true;
    const needle = String(q).toLowerCase().replace(/\s+/g, "");
    if (!needle) return true;
    const s = String(text || "");
    if (s.toLowerCase().indexOf(needle) >= 0) return true;   // 原文（含英文名）
    const py = window.pinyinOf(s);
    if (py.full.indexOf(needle) >= 0) return true;
    if (/^[a-z]+$/.test(needle) && py.initials.indexOf(needle) >= 0) return true;
    return false;
  };
})();
