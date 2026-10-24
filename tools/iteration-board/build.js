'use strict';
// Read-only source snapshot. No network, dependencies or business-code edits.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
const git = args => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const status = read('04_交接状态.md');
const task = read('03_当前任务.md');
const plan = read('02_开发计划.md');
const block = status.match(/```iteration-summary\s*\n([\s\S]*?)\n```/);
if (!block) throw new Error('04_交接状态.md 缺少 iteration-summary 摘要；请按 tools/iteration-board/README.md 更新。');
const summary = JSON.parse(block[1]);
for (const field of ['taskId', 'title', 'review', 'before', 'after', 'remaining']) {
  if (typeof summary[field] !== 'string' || !summary[field].trim()) throw new Error('摘要字段缺失：' + field);
}
if (!Array.isArray(summary.verification) || !Array.isArray(summary.docs)) throw new Error('verification/docs 必须为数组');
const taskHeading = task.match(/^## (T[^\s：:]+)[：:]/m);
if (!taskHeading || taskHeading[1] !== summary.taskId) throw new Error('摘要 taskId 与 03_当前任务.md 不一致，拒绝生成过期摘要');

// ---- 文档清单（T-Mgr-P002-BOARD-01 修正）----
// `docs/` 下有 28 份 **旧路径跳转页**（`00-README.md` 这类连字符命名），
// 内容只有一句"文档已迁移"，每份约 500 B。
// 原来它们全被收进"文档与证据"，把真正的正文挤出列表 ——
// 用户要翻很久才能找到要看的文档。
// 现在按内容识别并排除（判据：文件名含连字符 且 正文只提到"已迁移/已整理"）。
const isRedirectStub = (file, text) => {
  if (!/-/.test(path.basename(file))) return false;
  return text.length < 1200 && /文档已迁移|文档已整理/.test(text);
};
const docFiles = [
  ...fs.readdirSync(path.join(root, 'docs')).filter(n => /^\d\d_.*\.md$/.test(n)).map(n => 'docs/' + n),
  ...fs.readdirSync(path.join(root, 'docs/01_专题')).filter(n => n.endsWith('.md')).map(n => 'docs/01_专题/' + n),
  // ⚠️ 验证记录目录原来只收索引，导致最近几轮的验证报告在"文档与证据"里**找不到** ——
  // 而那正是用户最想查的东西（"这轮到底验了什么"）。这里递归收全部 .md。
  ...fs.readdirSync(path.join(root, 'docs/02_验证记录'))
    .filter(n => n.endsWith('.md'))
    .map(n => 'docs/02_验证记录/' + n),
  'docs/03_历史归档/00_归档说明.md',
].filter(f => {
  const full = path.join(root, f);
  if (!fs.existsSync(full)) return true;
  return !isRedirectStub(f, read(f));
});
// 问题清单必须进快照 —— 「后续计划」要从它读待办表
if (!docFiles.includes('docs/03_开发进度与问题清单.md')) docFiles.push('docs/03_开发进度与问题清单.md');
const files = ['03_当前任务.md', '02_开发计划.md', '04_交接状态.md', '01_项目规格.md', 'AGENTS.md', 'README.md', 'tools/iteration-board/README.md', 'tools/icarui/README.md',
  ...docFiles];
for (const d of summary.docs) {
  if (typeof d.file !== 'string' || path.isAbsolute(d.file) || d.file.split(/[\\/]/).includes('..')) throw new Error('非法摘要文件路径');
  if (!files.includes(d.file) && fs.existsSync(path.join(root, d.file))) files.push(d.file);
}
const sources = Object.fromEntries(files.map(file => [file, read(file)]));
const sections = (text, pattern) => [...text.matchAll(/^## (.+)$/gm)].filter(m => pattern.test(m[1])).map((m, i, a) => ({ title: m[1], text: text.slice(m.index, a[i + 1]?.index ?? text.length) }));

// ---- 里程碑（T-Mgr-P002-BOARD-01 修正）----
// 原来用 `/^\d+\./` 抓二级标题，结果把「1. 当前任务索引」「2. 暂缓任务」
// 这类**章节名**当成了计划项，用户看到的"后续计划"全是元数据噪音。
// 现在只认**带状态行**的标题 —— 「状态：…」是计划项的标志，
// 章节名没有状态行，自然被排除。
const milestoneSections = sections(plan, /^[\d.]+\s*/).filter(s => /^状态[：:]/m.test(s.text));
const milestones = milestoneSections.map(s => ({
  title: s.title,
  status: s.text.match(/^状态[：:](.*)$/m)?.[1]?.trim() ?? '待安排',
  text: s.text,
}));

// ---- 版本条目（修正）----
// 原来标题取的是 `## 2026-10`，7 条全叫「2026-10」，页面上无法区分。
// 现在取**下一行的条目标题**（如「App · v1.20.22」），拿不到才退回原标题。
const releases = ['docs/07_版本更新日志.md'].flatMap(file =>
  [...sources[file].matchAll(/^## (\d{4}-\d{2}[^\n]*)\n([\s\S]*?)(?=^## |\s*$)/gm)]
    .slice(0, 6)
    .map(m => {
      const body = m[2] || '';
      // 顶部第一个非空行如果是标题（### 或 **…**），拿来当条目标题
      const inner = body.match(/^\s*(?:###\s*(.+?)\s*$|\*\*(.+?)\*\*\s*$)/m);
      const title = (inner?.[1] || inner?.[2] || m[1]).trim();
      return { title, date: m[1].trim(), text: m[0], file };
    })
);

// ---- 最近几轮（新增）----
// overview 只显示「当前这一张卡」，用户看不到前几轮做了什么。
// 这里从 Git 提交里取最近若干条 `feat|fix|docs(...)` 的**任务级**提交，
// 让"这个项目最近在忙什么"一眼可见。
const recentWork = git(['log', '-20', '--date=short', '--pretty=format:%h | %ad | %s'])
  .split('\n')
  .filter(Boolean)
  .filter(l => /(feat|fix|perf)(\(|:)|^[0-9a-f]{7,} \| \d{4}-\d{2}-\d{2} \| (docs:|chore:)/.test(l))
  .slice(0, 6)
  .map(line => {
    const [hash, date, ...rest] = line.split(' | ');
    return { hash, date, subject: rest.join(' | ') };
  });

// ---- 待办清单（T-Mgr-P002-BOARD-02 新增）----
// 用户问"接下来做什么"时，`02_开发计划.md` 只是索引（当前任务/暂缓/候选/历史），
// **真正的待办表在 docs/03_开发进度与问题清单.md**。这里把它读进来，按优先级分组。
//
// 表格形如：`| App-A2 / P1 | 未完成内容 | 下一步/阻塞 |`
// 优先级取 ID 里 `/` 之后那段（`P0`/`P1`/`P2`/`P3`/`P1-P2`/`后置`）。

// ⚠️⚠️ **白话说人话映射**（T-Mgr-P002-BOARD-03）
//
// 用户原话：「后续计划都说的这么高深、看不太懂」。看板直接把问题清单里的
// 开发术语（`Session 重连代际`、`015E 合法 0`、`LVGL` …）呈现出来，
// 而这些**本来就是用户自己提的需求**，只是被写成了黑话。
//
// 约定：
//  1. **只在本文件里做映射，绝不修改 docs/03 原文** —— 原文是问题唯一权威。
//  2. 每项给 `plain`（一句人话）+ 可选的 `origin`（用户原话）+ `impact`（对用户的影响）。
//  3. **拿不准的一律标「原意待确认」，不编一个听起来合理的解释。**
//  4. 映射按 ID 前缀匹配；新增待办若没配映射，看板**照原样显示并标注「未翻译」**，
//     不会静默丢失 —— 缺翻译是可发现的，不是隐形的。
const PLAIN_TODO = {
  'App-A1-M-P': {
    plain: '车上的转向灯/广播信号，停止监听后屏幕上可能还停在最后一个值',
    impact: '平板上已装新包、本地测试通过，但没接真车实测过。',
  },
  'UI-HUD-01': {
    plain: '仪表动效与导出已完成，还差全局开关',
    impact: '你已能在 PC 工具里编辑动画并在设备上看到；还缺「默认关闭」的安全开关。',
  },
  'App-A1其余': {
    plain: '断线重连后，仪表读数可能不刷新、或刷出旧值',
    impact: '开车途中蓝牙断了再接上，可能出现数值卡住。',
  },
  'App-A2': {
    plain: '油耗、进气量这类读数可能算得不准',
    impact: '仪表上显示的油耗/空燃比数字，可信度还没保证。',
  },
  'App-A3/A4': {
    plain: '同时开扫描和监听时，可能出现抢占或收尾不干净',
    impact: '属安全类缺口；正常单任务使用不受影响。',
  },
  'App-A5': {
    plain: '多画布素材已修：每套画布各记自己的素材目录',
    impact: '原来给画布1 导入素材后切到画布2，画布2 的素材会全部消失；现在各自独立。仍没做"把素材打包进设计文件"那条路，真机多画布切换也还没实测。',
  },
  'App-A6': {
    plain: '导入特别大的设计包时，可能卡住或只导入一半',
    impact: '正常大小的设计没问题；超大包才有风险。',
  },
  'App-A7': {
    plain: 'App 切到后台、或规则/日志长时间跑之后的生命周期问题',
    impact: '长时间开车时才可能遇到。',
  },
  'T11-I、T7与排版': {
    plain: '已逐项查清：其中两件其实早就做好了，一件根本不在 App 里',
    origin: '你在 2026-10-11 提过「小卡片标题重叠」，那条已修好并上平板确认过',
    impact: '查下来发现：缩放和多指【已经实现】、撤销性能是 PC 工具的活儿；真正的缺口是——现在还有 16 个控件（警示灯、厂家模板）在设备上画不出来，而且部分画不出来时【一个字提示都没有】。这个要不要修，等你决定。',
  },
  'App-A8/LVGL': {
    plain: '清理一段已经放弃的旧渲染代码，顺带拆几个大文件',
    impact: '纯内部维护，你看不出差别；好处是以后改起来不容易出错。',
  },
  '真车与SPP': {
    plain: '你 10-11 提的三件事：挡位显示格式、指示灯都是一张图、G 力值仪表',
    origin: '原话：「挡位显示的格式不行」「指示灯…而不是全部都是一个图」「G 力值仪表样式不一样」',
    impact: '这些还没做；挡位现在显示 P R N 1 2 3…（缺 D），19 个警示灯共用同一张警告图。',
  },
  'P4E-02-GUI': {
    plain: '6 个仪表现在能用新属性面板了，但还没请你在浏览器里看过',
    impact: '车速/水温/油量/电压/负荷/油门六块表已经接进新面板，可以改数据源、样式、量程这些。不过面板长什么样、改完画布对不对、导到平板读不读数，这 8 项还得你自己看一眼。',
  },
      'TRACK-APP-001': {
    plain: '条形轨道样式在平板上能看到代码效果了，但还没人在真机上看过',
    impact: '你在电脑上调好的轨道圆角、渐变、刻度、色带，平板端现在有代码在画了。代码写完了、解析也测过了，但**还没人拿真平板看过效果对不对**。需要你在平板上打开看一下（P4F-GUI-004 第 9、10 项）。',
  },
  'P4F-M03-UNDEF-1': {
    plain: '改属性后画面没刷新（已修）',
    impact: '以前在属性面板改完值，有时画布不会立刻跟着变。现在修好了。',
  },
  'P4F-M03-UNDEF-2': {
    plain: '恢复草稿后撤销按钮不亮（已修）',
    impact: '以前从草稿恢复内容后，撤销/重做按钮的可用状态不会更新。现在修好了。',
  },
  'P4F-M03-UNDEF-3': {
    plain: '控件库里看不到素材缩略图（已修）',
    impact: '以前控件库里的素材条目只显示一个占位方块，看不到真实缩略图。现在修好了。',
  },
  'P4F-M04-UNDO': {
    plain: '改完属性点旁边就没法撤销（已修）',
    impact: '以前在属性面板改完数值，如果顺手点一下画布空白处确认，这次修改就**没法撤销**了。现在修好了。',
  },
  'P5A-M01-TRACK-NODATA': {
    plain: '条形轨道不跟着数据动（已修）',
    impact: '以前在编辑器里调好的条形轨道，到了 App 上只是个静态样子 —— 车速变了它也不变。现在修好了，会跟着数据走。',
  },
  'P5A-M01-SIM-DISCONNECT': {
    plain: '模拟数据断开后表还挂着老数字（已修）',
    impact: '测试用的模拟数据断开时，仪表没有变成「--」，还停在最后一个数上。现在修好了。',
  },
  'P5A-M01-SCALE-STRETCH': {
    plain: '平板和宽屏上元素被拉变形',
    impact: '仪表盘在竖屏手机上会被竖着拉长 52%，在车载宽屏上会横着拉宽 125%。这是老版就有的行为，不是新 bug；想要等比显示可以在设计文件里改一个设置。',
  },
  'P5A-M02-PARTS-SCALE': {
    plain: '自己拼的仪表，指针会不见（已修）',
    impact: '用「拆件拼表」做的仪表（表盘/刻度/指针分开的那种），在手机上指针和指针上挂的小装饰会整块消失，只剩一个空表盘。现在修好了。',
  },
  'P5A-M02-SIM-OWNER': {
    plain: '测试用的假数据断了以后表还挂着老数字（已修）',
    impact: '联调用的模拟数据停止后，仪表没有变成「--」，还停在最后一个数上，看起来像真在采数据。现在停了就会回落。',
  },
  'P5A-M02-LAMP-WARNLOW': {
    plain: '电压这类「越低越危险」的指示灯不会亮',
    impact: '现在的状态灯只认「超过多少就报警」，不认「低于多少就报警」。所以电压掉到 11V 以下，灯还是绿的。要不要补，需要你定。',
  },
  'P5A-M02-PARTS-RANGE': {
    plain: '自己拼表时指针可能一直不动',
    impact: '用拆件拼表、而指针没单独指定绑哪个 PID 时，App 会拿表自己的量程来算角度，默认是 0~100。转速 800 早就超了，指针就一直顶在最大位置。做表时把量程填上就好。',
  },
  'P5A-M02-QZ33-ABI': {
    plain: '第二台模拟器装不上 App',
    impact: '安装包只编了 arm64 一种架构（为了省编译时间），另一台 Android 13 模拟器只有 x86 架构，装不上。所以这轮换屏幕比例都在同一台模拟器上做。',
  },
  'P5A-M03-TRACK-BAND-FIT': {
    plain: '彩色渐变的进度条在「等比缩放」下有一条不显示（未修）',
    impact: '有一类进度条是绿-黄-红渐变的那种。在平板/车载宽屏上用「保持比例」缩放时，这条会整条不显示；用「拉伸铺满」就正常。原因还没查到，已记下来优先排查。',
  },
  'P5A-M03-LAMP-LOWDIR': {
    plain: '电压过低灯不亮，要修得改文件格式，等你点头',
    impact: '现在的指示灯只会「超过多少就报警」。电压掉到 11V 以下它还是绿的。要支持「低于多少就报警」，必须在设计文件里加一个新字段；不加就只能维持现状。方案和测试都写好了，等你决定要不要做。',
  },
  'P5A-M03-TRACK-PIXEL-PROBE': {
    plain: '进度条的圆角/刻度这类细节，这轮没测准',
    impact: '进度条的圆角、刻度、分段、发光这些细节在截图里太小了（只剩几十像素），自动比对量不准。所以这轮只记录了测到的数字，没有下「通过」的结论。',
  },
  'P5A-M04-PREVIEW-WRITE': {
    plain: '点「比例预览」会把你的主题尺寸改掉（已修）',
    impact: '以前点一下「车载宽屏」看看效果，主题的设计尺寸就被改成 1280×600 了，还会进草稿、跟着导出。现在只是临时预览，主题数据一个字节都不动，看完点「恢复正式尺寸」就回来。',
  },
  'P5A-M04-RANGE-GUESS': {
    plain: '你自己填的量程可能被程序当成「自动填的」改掉（已修）',
    impact: '以前程序靠「数值刚好等于 PID 默认」来猜这个量程是不是自动填的。如果你手填的正好也是那个数，换数据源时就会被覆盖。现在改成记来源，你手动改过的量程一律保留。',
  },
  'P5A-M04-FILL-NO-RECT': {
    plain: '「铺满裁切」模式下有条轨道测不到（不是坏了）',
    impact: '铺满裁切会把画布放大后裁掉四周，有的轨道跑到屏幕外了，自动化脚本抓不到它的位置。截图证明它其实画出来了，只是没法自动比对。',
  },
  'P5A-M04-LOWDIR-REVERSE': {
    plain: '低值报警主题在旧版 App 上会「正常电压亮红灯」',
    impact: '如果做了「电压过低报警」，旧版 App 不认识这个设置，会反过来判断——13.8V 正常电压也会亮黄灯甚至红灯。所以必须在导出时提醒你设备要升级。方案写好了，等你说要不要做。',
  },
  'P5A-M05-SIM-WATCHDOG-WINDOW': {
    plain: '模拟数据和真车数据可能同时闪 2 秒（已修）',
    impact: '如果真车采集启动时模拟数据还开着，以前要等最多 2 秒才自动关掉，这 2 秒里画面可能来回跳。现在一启动真车采集就立刻关模拟，不再等。',
  },
  'P5A-M05-CONNECT-UI-UNVERIFIED': {
    plain: '连接页新加的说明文字只在电脑上测过，手机还没验',
    impact: '连接页现在会明确告诉你「已连接但还没有数据」「数据已过期」这类状态。这段逻辑在电脑上测了 23 项全过，但模拟器上没能自动点开那一页，需要你在手机上瞄一眼。',
  },
  'P5A-M05-AVD-NAV-BROKEN': {
    plain: '模拟器点不到连接页（已修：双击可呼出导航）',
    impact: '自动测试脚本在模拟器上找不到底部导航栏，所以连不到「连接」那一页。这是测试环境问题，不是 App 的问题，但会一直挡着这类验收。',
  },
  'P5A-M06-OBD-PID-MISATTRIBUTION': {
    plain: '仪表可能显示假数据——别的传感器的回复被当成了这个表的值（已修）',
    impact: '以前有个宽容逻辑：车回了 A 传感器的数据，但请求的是 B，程序照样把这个数算给 B。实测能造出「位图当成 0.0 km/h」「车速当成 838.5 转」这种假数，仪表上看着像真的。现在一律拒绝，并在日志里写「响应 PID 不匹配：请求 0C，收到 0D」。',
  },
  'P5A-M06-MUTEX-E2E': {
    plain: '模拟/真车互斥只验了顺序，没验整条链路',
    impact: '验证了「先关模拟、再开真车采集」这个顺序确实成立，但没能在电脑上真的跑一遍 App 的完整启动流程（那部分需要安卓环境）。需要补一个安卓环境的测试。',
  },
  'P5A-M06-AVD-NAV-SOLVED': {
    plain: '自动测试现在能点开「连接」页了（以前连续两轮点不到）',
    impact: '以前自动测试在模拟器上找不到底部导航栏，所以「连接」页一直没法自动验收。查清后发现不是 Bug——仪表盘页会主动把导航收起来（沉浸模式），双击屏幕就能呼出来。现在连接页的 6 项检查能自动跑了。',
  },
  'P5B-M01-STYLE-PREVIEW': {
    plain: '编辑器里 5 种仪表的样子和真机上不一样（已修）',
    impact: '设计器里点「折线」看到的是随便画的波浪线，真机上其实是根据历史数据画的曲线；点「G力」看到的是普通圆盘，真机上其实是一个点会跟着车移动的 G 值圈。现在编辑器照着真机的样子画了。',
  },
  'P5B-M01-TEXT-FONTSIZE': {
    plain: '拖进来的大标题字号特别小（已修）',
    impact: '点「大标题」拖进画布，字只有 6 号大小，小得几乎看不见——明明预设写的是 30 号。原因是预设的参数名和创建函数对不上，字号被丢掉了。现在 30/20/12/18 都正常了。',
  },
  'P5B-M01-ANDROID-8STYLES': {
    plain: '8 种仪表的真机截图对比还没做成',
    impact: '测试用的主题文件已经成功放进手机了，但 App 打开后没显示出新主题，原因还没查清。已把手机恢复原样。目前这 8 种样式只有电脑上的自动化测试证明画对了，没有真机截图对照。',
  },
  'P5B-M01-SAMPLE-DATA-HONESTY': {
    plain: '参考图里的油温、油压、BOOST、Lambda 目前车上读不到',
    impact: '这四项不是画不出来，而是普通 OBD 接口没有这些数据，需要厂商专用的 CAN 数据表。现在界面上会明确显示「无信号」而不是假数字。要不要接厂商数据表需要你决定。',
  },
  'P5A-M01-FGS-PERMISSION-CRASH': {
    plain: '第一次装 App 时点「不允许」给权限，App 会直接闪退（已修）',
    impact: '安卓 14 要求后台服务必须拿到蓝牙权限才能以前台服务运行。用户点「不允许」时这一步会报错，而代码里没人接这个错，所以 App 一启动就崩。现在改成：拿不到权限就降级成普通服务，App 照常能用，只是没有常驻通知。',
  },
  'P5A-M01-SIM-STEP-NOOP': {
    plain: '模拟数据的「推进 N 步」参数其实没起作用（已修）',
    impact: '自动化测试里有个「前进 N 帧」的参数，用来让模拟值变化。但代码只加了个计数器，没真的重算数值，所以传 0 和传 20 结果完全一样。这导致所有依赖它的自动化验证都是空转的。现在修好了。',
  },
  'P5A-M01-STRETCH-DEFORM': {
    plain: '车载宽屏上仪表会被拉扁/拉长',
    impact: '默认的缩放方式是「宽高各自拉满」，所以屏幕比例和设计比例不一样时就会变形——实测车载宽屏拉了 125%。这不是 bug，是默认策略的取舍。设计文件里写 scaleMode:1 就能等比缩放（留黑边）。问题是用户不知道要改。',
  },
  'P5A-M01-NO-ORIENT-TEST': {
    plain: '横竖屏切换还没做过自动验证',
    impact: '代码里有恢复逻辑，但从来没测过横屏切竖屏之后仪表、轨道、状态灯是不是还正常。',
  },
  'P5A-M01-SIMCHAIN-NOT-IN-CI': {
    plain: '「模拟值→屏幕」这条链的验证还是一次性脚本',
    impact: '这个验证能证明数据真的走到了屏幕上（18 项全过），但它现在不在常规回归里跑。下次改代码不会自动检查它。',
  },
  'P5B-M02-FGS-DEGRADE-NOOP': {
    plain: '上次修的「拒绝权限就崩溃」只修了一半：不崩了，但后台服务其实没起来（已修）',
    impact: '上次用 try/catch 把报错吞掉，看着像好了。实测发现撤销蓝牙权限后前台服务根本没启动成功——因为 Manifest 声明了 connectedDevice 类型，安卓 14 连「不指定类型」的调用也按它校验。后果是不崩了但 App 切到后台可能被系统杀掉。现在改成：没权限时用 dataSync 类型保活，实测服务真的起来了。',
  },
  'P5B-M02-DATA-SOURCE-WRONG': {
    plain: '我之前说「油温、BOOST、燃油压力读不到」，说错了（已修）',
    impact: '查项目自己的 PID 表发现：机油温度是标准 PID 5C 而且本来就支持；燃油压力是标准 0A；BOOST 能用进气压力算出来，代码里早就有。真正没有标准 PID 的只有机油压力和变速箱油温。之前那句话会让用户白放弃三个本来能做的功能。',
  },
  'P5B-M02-8STYLES-FIXED': {
    plain: '编辑器里做的 8 种仪表，终于在手机上能看到样子了（之前两轮都没成）',
    impact: '前两次一直以为是主题没写进去，其实写进去了——但 App 显示的是「画布」里存的那份，不是顶层那份。改对地方之后 8 种全都能看见了。',
  },
  'P5B-M02-OLD-VERSION-TOLERANCE': {
    plain: '新版控件能不能加进正式主题，还差一次旧版 App 的实测',
    impact: '要确认旧版 App 打开含新控件的主题时，是直接跳过不认识的，还是整份打不开。如果是后者，新控件就不能直接加。',
  },
  'P5B-M02-PRIMITIVES-NO-VIEW': {
    plain: '分段圆弧这几个新东西还只在编辑器里有，手机上还没有',
    impact: '按你这轮的要求没往正式格式里写，所以它们还是试验品。电脑上验证过能正确按数据变化，但这不代表手机上也能显示。',
  },
  'P5B-M03-FGS-STOPSELF-CRASH': {
    plain: '我自己修出来的新崩溃：拒绝权限后用错了退出方式（已修）',
    impact: '安卓要求启动前台服务后 5 秒内必须真正启动，否则崩。我以为用 stopSelf 退出就行，实测照样崩。现在改成用普通方式启动服务，由服务自己判断要不要进前台。',
  },
  'P5B-M03-FGS-NO-PERM-NOFGS': {
    plain: '没有蓝牙权限时还占着后台服务名额（已修）',
    impact: '上一版为了让 App 活着，没权限也申请了一个后台服务类型。但那种状态下根本没有任何 OBD 通信，纯属浪费系统配额。现在没权限就不占，App 和看主题完全不受影响。',
  },
  'P5B-M03-FGS-RESUME-RESTORE': {
    plain: '去设置里给了权限、回到 App 后后台服务没恢复（已修）',
    impact: '原来只在「App 被重新启动」时才补起服务，但用户切到设置再切回来不算重启。现在每次回到前台都会检查一次。',
  },
  'P5B-M03-OLD-COMPAT-ANSWER': {
    plain: '旧版 App 遇到新控件会怎样——终于测出来了',
    impact: '结论比预想的好：旧版不会「假装正常打开但少一半内容」，而是直接说「这个 type 我不认识，我只认 gauge/image/text/group」，整个主题拒绝加载、原文件也不动。所以用户会立刻知道要升级，不会误用残缺主题。',
  },
  'P5B-M03-PRIMITIVES-ANDROID': {
    plain: '四种新控件在安卓上已经写好了，但还没接到正式主题里',
    impact: '分段圆环、曲线进度、动态数值、基础图形这四个组件的安卓版本都已经实现并通过几何测试。但按你这轮的要求，没有正式批准之前不往主题格式里写，所以现在还是「能用但看不见」。',
  },
  'P5B-M03-META-REQUIRES-USELESS': {
    plain: '之前想的「用 meta.requires 提醒旧版」这个办法没用',
    impact: '实测旧版根本不读 meta 里的这个字段，写了也不会弹警告。好在旧版本来就会对不认识的控件报错，那个警告已经够用了。',
  },
  'P5B-M03-NEED-V3-APPROVAL': {
    plain: '【需要你决定】要不要新增主题格式版本 3，把这四个新控件正式接进去',
    impact: '现在四种新控件只能在编辑器里用，手机上显示不了。要正式接入就得升主题格式版本（icar.ui/3）。代价是旧版 App 打不开新版主题——但旧版会明确提示「版本不支持」，不会静默出错。',
  },
  'P5B-M04-V3-NESTED-DENIED': {
    plain: '新版主题里，放到「分组」里面的新控件会被判成非法（已修）',
    impact: '分组是整理控件用的。代码在一层一层往下找控件时，忘了把「这份主题是新版」这个信息带下去，于是分组里的新控件被当成旧版主题里的野控件拒掉。',
  },
  'P5B-M04-V3-TOPLEVEL-DENIED': {
    plain: '编辑器存的新版主题，手机上读不出来（已修）',
    impact: '编辑器的主题文件把控件直接放在顶层。安卓那一边解析这条路径时漏传了「这是新版」的标记，于是整份主题里的新控件全被判非法。等于自己存的文件自己读不回。',
  },
  'P5B-M04-EDITOR-V3-READBACK': {
    plain: '编辑器能导出新版主题，却读不回自己刚导出的文件（已修）',
    impact: '导出的文件写着「新版」，但编辑器的读取逻辑只认旧版，于是弹「不支持的版本」——自己的输出自己不认，很别扭。现在加认了。',
  },
  'P5B-M04-CREATENODE-PID-LOST': {
    plain: '新建的新控件会「忘记」绑定哪个数据项（已修）',
    impact: '拖一个分段圆环进来，属性面板里明明写了「绑定转速」，但画布上一直显示无数据。原因是建控件时把绑定字段丢掉了。',
  },
  'P5B-M04-NODETOJSON-FIELDS': {
    plain: '保存时新控件的参数会被丢掉一大半（已修）',
    impact: '比如一个圆环设了「36 段、从 135 度开始、扫 270 度」，保存再打开就全变默认值了。文件里看着有四个控件，但每个都是空壳。',
  },
  'P5B-M04-DEPLOY-ENAMETOOLONG': {
    plain: '主题一大，测试部署工具就崩（已修）',
    impact: '原来是把整份主题塞进一条命令里传给手机，主题超过几十 KB 就超过命令行长度上限。小主题看不出来，模板这种大主题一放就炸。',
  },
  'P5B-M04-UNKNOWN-TYPE-SILENT': {
    plain: '不认识的控件以前会「悄悄消失」，没有提示（已修）',
    impact: '打开一份含未来新控件的主题，那几块地方就空白了，什么提示都没有，用户以为是自己画错了。现在会画一个红色虚线框标「未知控件」。',
  },
  'P5B-M04-NODETYPES-CONTRACT': {
    plain: '「控件类型清单」是两端共用的契约，不能随便往里加东西',
    impact: '这份清单要和安卓那边逐条对得上。新版要加四种控件，直接往里塞会让「旧版只认四种」这件事失效。所以改成按版本分层判断，契约本身一个字没动。',
  },
  'P5B-M04-CROSSLANG-REGEX': {
    plain: '跨端一致性检查的解析器跟不上新写法（已修）',
    impact: '检查工具要从源码里抠出「控件类型清单」。我把清单改成「旧版四种 + 新版四种」的拼接写法后，它一个都抠不出来，于是报「解析到 0 种」——不是程序错，是检查工具没跟上。',
  },
  'P5B-M04-DEVICE-ACCEPTANCE': {
    plain: '【需要真机验收】新版主题和四种新控件还没上真车试过',
    impact: '模拟器上全部通过了，但有几件事只能真机回答：装了不给蓝牙权限会不会崩、真车的机油温度到底支不支持、40 个图形在真手机上卡不卡、安卓 15 的后台服务 6 小时限制。这些不能拿模拟器的结果顶替。',
  },
  'P5B-M03-ANDROID15-UNTESTED': {
    plain: '安卓 15 的新限制没实测过（只有安卓 14 模拟器）',
    impact: '安卓 15 会限制某类后台服务每天只能跑 6 小时。我已经写好超时处理代码，但没法在这个环境里真跑 6 小时验证。所以不能说「安卓 15 长期运行没问题」。',
  },
  'P5B-M02-DEVICE-SUITES-NOT-CI': {
    plain: '新加的三个手机端自动检查，还没放进常规回归',
    impact: '这三个检查（前台服务 / 八样式 / 新控件数据）现在要手动跑。不放进去的话，以后改代码不会自动检查。',
  },
  'P5A-M01-GUI-CARDS': {
    plain: '4 件事需要你自己在手机上确认一下',
    impact: '① 第一次装 App 点「不允许」后能不能正常进 ② 拒绝权限后有没有提示「缺少蓝牙权限」③ 车载宽屏上仪表是否明显变形 ④ 连续跑十几分钟后是否还流畅。这些模拟器证明不了，得真人看。',
  },
  'P5B-M01-PROTO-NOT-WIRED': {
    plain: '新做的分段圆弧、曲线进度等还是试验品，没接进正式主题',
    impact: '这 6 个东西能画出来、也测过了，但按你这轮的要求没有写进正式主题格式（怕影响旧版 App）。接入方案已写好，大约 7 个工作日，第一步要先验证旧版 App 遇到不认识的控件会不会崩。',
  },
  'P5A-M06-D5-PERMISSION-UI': {
    plain: '「没给蓝牙权限」这个提示还没在手机上验过',
    impact: '撤销权限会让系统弹出「应用信息」页，和 App 启动抢前台，自动化点不稳定。这段逻辑在电脑上测了（缺权限会显示「缺少蓝牙权限」），手机上还需要你瞄一眼。',
  },
  'P4F-TRACK-COLOR': {
    plain: '条形轨道的自定义颜色还改不了',
    impact: '轨道能改圆角、渐变、刻度、色带、大小了，但想指定具体颜色（而不是跟主题）暂时没入口。这是很早以前就标着「没做」的功能，不影响现在用。',
  },
  'P4E-LABEL-UNIT': {
    plain: '仪表的「标签/单位/字号/颜色」四项改不了',
    impact: '不是漏做：这四项在老版本里也从来没真正存过，旧面板也没有输入框。要能用得先改文件格式，得单独批准。不影响现在改数据源、量程、外观这些东西。',
  },
  'P4E-01-AUDIT': {
    plain: '仪表控件还没做新属性面板，而且直接改数据源会写坏',
    impact: '现在 6 个仪表（车速/水温/油量/电压/负荷/油门）仍用旧面板。审计发现：如果照抄状态灯那套直接改 PID，会把「用户看的名字」和「内部通道」写乱，仪表读数可能不显示——所以要先修这一步再迁移。',
  },
  'P4R-GUI-001': {
    plain: '还有 5 项要你自己在浏览器里看一眼才算数',
    impact: '图片清晰那一项你已经确认过了；剩下撤销重做、历史坏了怎么兜、两个标签页同时改、坏草稿导出、中文输入法这 5 项，等新功能做完我再一条条请你点。',
  },
  'T-UI-P4R2A-BUDGET': {
    plain: '单张特别大的图片会让撤销历史存不下来',
    impact: '画布当前仍能撤销；关闭后这段历史可能不在，原图和设计草稿不受影响。',
  },
};

/** 按 ID 前缀找映射；先精确匹配，再前缀匹配 */
function plainOf(id) {
  const code = id.split('/')[0].trim();
  if (PLAIN_TODO[code]) return { ...PLAIN_TODO[code], translated: true };
  // 前缀兜底：`App-A3/A4` 这类带斜杠的 ID 会被 split 拆坏，用原文再试一次
  for (const k of Object.keys(PLAIN_TODO)) {
    if (id.startsWith(k)) return { ...PLAIN_TODO[k], translated: true };
  }
  return { translated: false };
}
const prioRank = s => {
  const t = String(s || '').toUpperCase();
  if (t.includes('P0')) return 0;
  if (t.includes('P1')) return 1;
  if (t.includes('P2')) return 2;
  if (t.includes('P3')) return 3;
  return 9; // 后置 / 无标注
};
const prioLabel = s => {
  const t = String(s || '');
  if (/P0/i.test(t)) return 'P0 · 最要紧';
  if (/P1/i.test(t)) return 'P1 · 接下来该做的';
  if (/P2/i.test(t)) return 'P2 · 有空再做';
  if (/P3/i.test(t)) return 'P3 · 内部整理';
  return '后置 · 需要额外条件';
};
const todos = (() => {
  const text = sources['docs/03_开发进度与问题清单.md'] || '';
  // 只扫「BUG与后续优先级」这一节之后的表格行
  const idx = text.indexOf('## BUG与后续优先级');
  const scope = idx >= 0 ? text.slice(idx) : text;
  const out = [];
  for (const line of scope.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!m) continue;
    const id = m[1].trim();
    // 跳过表头与分隔行
    if (/^-+$/.test(id) || id === 'ID/优先级') continue;
    const [, idPart, prioPart = ''] = id.split('/');
    const plain = plainOf(id);
    out.push({
      id,
      code: (idPart || id).trim(),
      priority: (prioPart || '').trim(),
      rank: prioRank(prioPart || id),
      group: prioLabel(prioPart || id),
      pending: m[2].trim(),
      next: m[3].trim(),
      // 白话层（只用于看板显示）
      plain: plain.plain || '',
      origin: plain.origin || '',
      impact: plain.impact || '',
      translated: !!plain.translated,
      // 显式跳过（纯内部改动、用户无感）—— 不算"缺白话"，但页面会标出来
      skip: !!plain.skip,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
})();

// ---- 强制：每条待办必须有白话说明（T-Mgr-P002-BOARD-04）----
//
// ## 为什么这里要 throw 而不是警告
//
// 用户原话：「后续更新的话会更新白话吗」。答案是"靠自觉"—— 那就等于会漏。
// 事实：`PLAIN_TODO` 原本只在 README 里提了一句，不在 AGENTS.md 里，
// **换一个 AI 接手基本必漏**，然后看板又悄悄退回一堆黑话。
//
// 所以这里跟既有做法保持一致：像"摘要 taskId 不一致就拒绝生成"那样，
// **忘了补白话就直接让生成失败**，并一次列出全部缺项 + 怎么补。
// 失败是显性的、可修的；静默退化才是最难发现的。
//
// 唯一例外：用户明确说"这条不用白话"时，在 PLAIN_TODO 里写 `{ skip: true }`。
const missingPlain = todos.filter(t => !t.translated && !t.skip);
if (missingPlain.length) {
  const lines = missingPlain.map(t => '  - ' + t.id + '   （' + t.pending.slice(0, 40) + '…）');
  throw new Error(
    [
      '有 ' + missingPlain.length + ' 条待办缺少白话说明，拒绝生成看板。',
      '',
      '缺少的：',
      ...lines,
      '',
      '怎么补：打开 tools/iteration-board/build.js，在 PLAIN_TODO 里按 ID 加一条：',
      "  '你的ID': { plain: '一句人话：这是什么 + 对用户有什么影响',",
      "              impact: '可选：不修会怎样',",
      "              origin: '可选：用户原话（若这条是用户提的）' },",
      '',
      '确属无需白话（纯内部、用户无感）的，写 { skip: true } 显式跳过。',
      '⚠️ 不要为了让它跑过而编一句听起来合理的解释 —— 拿不准就写「原意待确认」。',
    ].join('\n')
  );
}

// ---- 构建与设备信息（新增）----
// 用户关心的"现在装的是哪个包"，看板此前完全没有。
const build = (() => {
  const apk = path.join(root, 'app/build/outputs/apk/debug/app-debug.apk');
  const gradle = read('app/build.gradle.kts');
  const versionName = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1] || '';
  const versionCode = gradle.match(/versionCode\s*=\s*(\d+)/)?.[1] || '';
  if (!fs.existsSync(apk)) {
    return { exists: false, versionName, versionCode };
  }
  const st = fs.statSync(apk);
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  return {
    exists: true, versionName, versionCode,
    bytes: st.size, mtime: st.mtime.toISOString(), sha256: sha,
    // APK 是否比最后一次提交更新 —— 提醒"改了代码但没重装"
    newerThanHead: st.mtime > new Date(Number(git(['log', '-1', '--format=%ct']).trim()) * 1000),
  };
})();

// ---- 文档分类（新增）----
// 47 份文档平铺一堆，用户找不到重点。按用途分段。
const docGroup = (file) => {
  if (!file.includes('/')) return '协作文件（根目录）';
  if (file.startsWith('docs/01_专题')) return '现行规范与专题';
  if (file.startsWith('docs/02_验证记录')) return '验证记录';
  if (file.startsWith('docs/03_历史归档')) return '历史归档（仅供参考）';
  if (file.startsWith('docs/')) return '项目文档';
  if (file.startsWith('tools/')) return '工具文档';
  return '其他';
};

const data = {
  generated: new Date().toISOString(), summary, sources,
  milestones, releases, recentWork, todos, build,
  docGroups: Object.fromEntries(files.map(f => [f, docGroup(f)])),
  gitStatus: git(['status', '--short']), diffStat: git(['diff', '--stat']),
  commits: git(['log', '-8', '--date=short', '--pretty=format:%h | %ad | %s'])
};
// 清理 < 转义问题：JSON.stringify 已保证合法，这里只防御 U+2028/2029
const payload = JSON.stringify(data).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const template = read('tools/iteration-board/template.html');
if (template.split('/* SNAPSHOT_DATA */').length !== 2) throw new Error('模板数据占位符必须唯一');
fs.writeFileSync(path.join(__dirname, 'index.html'), template.replace('/* SNAPSHOT_DATA */', () => payload));
console.log('迭代看板已更新：' + path.join(__dirname, 'index.html'));
console.log('任务 ' + summary.taskId + ' · ' + summary.review + ' · 原文 ' + files.length + ' 份');
