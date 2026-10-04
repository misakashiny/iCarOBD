/**
 * iCarOBD · LVGL 桥接层
 *
 * ## 这一层干什么
 *
 * 把 LVGL 接到 Android 的 `SurfaceView` 上，让**仪表盘那一屏**由 LVGL 渲染，
 * 其余界面（PID 编辑、规则、日志、设置）继续用 Android View。
 *
 * 数据流：Kotlin 侧 `LvglDashView` 拿到 Surface → `nativeCreate()`；
 * 之后 `VehicleBus` 的值通过 `nativeSetValue()` 推给 LVGL 控件。
 *
 * ## 两个必须知道的坑
 *
 * ### 1. 字节序（红蓝互换）
 *
 * LVGL 的 `lv_color32_t` 内存序是 **B,G,R,A**；Android 的 `RGBA_8888` 是 **R,G,B,A**。
 * 直接 memcpy 会**红蓝互换**。所以 `flush_cb` 里做一次 R/B 交换。
 * `nativeProbePixel` 返回的是 LVGL 序（0xAARRGGBB），Kotlin 侧比对主题色时按这个来。
 *
 * ### 2. 渲染线程
 *
 * `lv_timer_handler()` 必须在固定节奏上被调用，且 `lv_tick_inc()` 要喂时间。
 * 这里自己开一条线程干这事 —— 不要指望 Kotlin 侧每帧 JNI 回调（开销大且容易漏）。
 *
 * ## 为什么有 nativeProbePixel
 *
 * 自动化验证看不了图。有了像素探针就能断言「指针位置的像素 == 主题强调色」，
 * 这是**唯一能自动确认 LVGL 真的画对了**的办法。
 */
#include <jni.h>
#include <android/native_window_jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <time.h>
#include <cstring>
#include <cstdio>
#include <cstdlib>

#include "lvgl.h"
#include "neon_gauge.h"

#define TAG "LvglBridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)

namespace {

ANativeWindow *g_window = nullptr;
int g_width = 0;
int g_height = 0;
bool g_inited = false;

lv_disp_draw_buf_t g_draw_buf;
lv_disp_drv_t g_disp_drv;
lv_indev_drv_t g_indev_drv;

/** 全屏缓冲。用 FULL 刷新模式，LVGL 每次都画满整屏 */
lv_color_t *g_buf = nullptr;

/**
 * **持久**整屏帧缓冲（显示用，已是 RGBA_8888 字节序）。
 *
 * ⚠️ 不要拿 `g_buf` 当帧缓冲 —— 它是 LVGL 的**绘制暂存区**，
 * LVGL 只把**脏区域**渲染进去，未变区域是上一次的残留。
 * 只有这块 `g_frame` 才是「当前屏幕上应该显示什么」。
 */
uint32_t *g_frame = nullptr;

pthread_t g_thread;
volatile bool g_running = false;

// ---- 触摸（由 Kotlin 推入，indev 回调里读）----
volatile int g_touch_x = 0;
volatile int g_touch_y = 0;
volatile bool g_touch_down = false;

// ---- FPS ----
// 自己数，不用 lv_refr_get_fps_avg() —— 那是内部头文件里的函数，
// 依赖它意味着以后升级 LVGL 可能突然编不过。数 flush 次数永远有效。
volatile uint32_t g_flush_count = 0;
volatile uint32_t g_fps = 0;

/**
 * 保护 **LVGL 的一切**。
 *
 * ## 为什么必须有这把锁（这是一个真实崩溃换来的）
 *
 * LVGL 不是线程安全的，它的对象树只能在**渲染线程**上动。
 * 而 JNI 入口（`nativeApplyTheme` / `nativeSetValue`）是从 Kotlin 主线程调的 ——
 * 直接在里面 `lv_obj_clean()` / `lv_meter_set_indicator_end_value()`，
 * 就会和渲染线程的 `lv_timer_handler()` 抢同一棵对象树，**直接 native crash**
 * （实测：`verifyThemeMapping` 恢复主题那一步崩在 libart 的 JNI 调用栈里）。
 *
 * 所以规矩是：
 *  - **JNI 入口只写「待办」**（主题字段 / 待推的数值），加锁保护；
 *  - **渲染线程在锁内统一消费**：先重建（如果需要），再推值，最后 `lv_timer_handler()`；
 *  - 探针也在锁内读帧缓冲，顺带避免撕裂读。
 */
static pthread_mutex_t g_lv_mutex = PTHREAD_MUTEX_INITIALIZER;

/** 待推给控件的数值。固定槽位，避免在 JNI 里做动态分配 */
struct PendingValue {
    char id[24];
    float value;
    bool used;
};
static const int PENDING_SLOTS = 16;
static PendingValue g_pending[16];

/** 主题变了，等渲染线程重建 UI */
static volatile bool g_need_rebuild = false;

// ---- 帧率基准 ----
//
// 没有车、没有模拟器时画面是静止的，fps 恒为 0，**测不出渲染能力**。
// 这个基准把「数据源」与「渲染能力」解耦：全速改值 + 强制立即重绘，
// 回答的是「这块屏 + 这个软件渲染器，满负载下能画多少帧」。
static volatile bool g_bench_active = false;

// 仅用于定位瓶颈：跳过 R/B 交换，看帧率变化。**不是给生产用的**
static volatile bool g_skip_swap = false;

static volatile int g_bench_mode = 0;        // 0=吞吐 1=真实负载(10Hz)
static uint32_t g_bench_last_update = 0;
static uint64_t g_bench_draw_us = 0;         // lv_refr_now 累计
static uint64_t g_bench_post_us = 0;         // ANativeWindow 提交累计

/** 单调微秒时钟，用于耗时拆解 */
static uint64_t now_us() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t) ts.tv_sec * 1000000ull + (uint64_t) (ts.tv_nsec / 1000);
}
static volatile int g_bench_fps = -1;
static uint32_t g_bench_start = 0;
static uint32_t g_bench_until = 0;
static int g_bench_frames = 0;
static int g_bench_phase = 0;

/** 单调毫秒时钟 */
static uint32_t now_ms() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t) (ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

// ---- 仪表绑定 ----
//
// 不用「每块表一个全局指针」—— 那只够写死三块。改成一张**绑定表**：
// 每条 PID → 一组要更新的控件。仪表数量与样式完全由配置决定，
// 与 Android 侧 `DashSpec` 的自由画布语义对齐。
enum BindKind {
    BIND_METER = 0,   // 圆表：指针 + 数值弧 + 数字标签
    BIND_LABEL = 1,   // 只更新文本
    BIND_BAR = 2,     // 进度条 + 文本
    BIND_CHART = 3,   // 折线：按槽位循环写
    BIND_DOT = 4,     // G 值圆点：需要 gx/gy 两条绑定配合
    BIND_NEON = 5,    // 霓虹圆表（neon_gauge，自定义绘制）
};

struct Binding {
    char pid[24];
    int kind;
    lv_obj_t *widget;                 // 承载控件（meter / bar / chart / 容器）
    lv_obj_t *label;                  // 数值文本（可为空）
    lv_meter_indicator_t *needle;
    lv_meter_indicator_t *arc;
    lv_chart_series_t *series;
    float min, max;
    int dot_axis;                     // BIND_DOT：0=gx 1=gy
    int chart_slot;                   // BIND_CHART：当前写到第几个点
};

static const int MAX_BINDINGS = 64;
static Binding g_bindings[MAX_BINDINGS];
static int g_binding_count = 0;

/** G 值圆点：gx/gy 两条绑定共同驱动一个点，所以宿主与当前值单独记 */
static lv_obj_t *g_dot_host = nullptr;
static lv_obj_t *g_dot = nullptr;
static float g_dot_x = 0.f;
static float g_dot_y = 0.f;
static float g_dot_range = 1.5f;

/**
 * 主题。
 *
 * **刻意不在 C 里解析 JSON**：Kotlin 侧已经有 `GaugeTheme`（带 `toJson`/`fromJson`、
 * 内置主题、自建主题、导入导出），再在 C 里养一个 JSON 解析器纯属重复，
 * 而且一旦两边 schema 理解不一致就会静默画错。这里只收**基本类型**，
 * 由 Kotlin 负责解释语义。
 */
struct Theme {
    uint32_t background = 0x0A0C10;
    uint32_t surface = 0x101418;
    uint32_t surface_edge = 0x2A3038;
    uint32_t accent = 0xFF8A3D;
    uint32_t accent_bright = 0xFFB070;
    uint32_t accent_dim = 0xC05A18;
    uint32_t track = 0x252B34;
    uint32_t tick = 0x3A4250;
    uint32_t value_text = 0xE8EEF6;
    uint32_t label_text = 0x7A8494;
    int card_radius = 12;
    int card_stroke = 1;
    int stroke = 8;
    float needle_ratio = 0.72f;
    uint32_t applied_count = 0;   // 收到过几次主题，排查用
};
static Theme g_theme;

// ================================================================ 显示

/**
 * 把 LVGL 画好的像素贴到 Surface 上。
 *
 * 注意 `abuf.stride` 是**像素**为单位且可能大于宽度（对齐填充），
 * 所以必须按行拷贝，不能整块 memcpy。
 */
/**
 * 把 `g_frame` 整屏贴到 Surface。
 *
 * ⚠️ **绝不能持有 `g_lv_mutex` 时调它**。
 *
 * `ANativeWindow_lock()` 在缓冲队列满时会**阻塞**，等 SurfaceFlinger 还一个空闲缓冲。
 * 而 `flush_cb` 是在 `lv_timer_handler()` 内部被调的，那里**正握着 `g_lv_mutex`** ——
 * 一旦窗口卡住，渲染线程就握着锁停在那里，主线程任何 native 调用（切页、改主题、建布局）
 * 全部堵死，**表现就是"应用无响应"弹窗**。
 *
 * 所以改成：`flush_cb` 只往 `g_frame` 攒像素（纯内存，不阻塞）并置脏标记；
 * 渲染线程**出了锁**再调这里提交。
 */
static void present_frame() {
    if (g_window == nullptr || g_frame == nullptr) return;
    ANativeWindow_Buffer abuf;
    if (ANativeWindow_lock(g_window, &abuf, nullptr) != 0) return;
    const uint64_t t_post = now_us();
    for (int y = 0; y < g_height; y++) {
        uint32_t *dst = (uint32_t *) abuf.bits + (size_t) y * abuf.stride;
        memcpy(dst, g_frame + (size_t) y * g_width, (size_t) g_width * 4);
    }
    ANativeWindow_unlockAndPost(g_window);
    if (g_bench_active) {
        g_bench_frames++;
        g_bench_post_us += now_us() - t_post;
    }
    g_flush_count++;
}

/** `flush_cb` 攒完像素后置它；渲染线程出锁后消费 */
static volatile bool g_present_pending = false;

void flush_cb(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_p) {
    if (g_frame == nullptr) {
        lv_disp_flush_ready(drv);
        return;
    }

    // 把 LVGL 渲染好的**脏区域**搬进持久帧缓冲 `g_frame`，顺便做 R/B 交换。
    //
    // ⚠️ 必须搬到 `g_frame` 而不是直接贴窗口：
    //    - `g_buf` 是 LVGL 的**绘制暂存区**，只有脏区域是新的，其余是残留；
    //    - SurfaceView 是双/三缓冲，`ANativeWindow_lock` 拿到的可能是上一帧的旧缓冲。
    //    只有 `g_frame` 是「当前应该显示什么」的完整快照。
    //
    // 这里**只碰内存、不做任何可能阻塞的事**（提交交给 `present_frame()`，见它的注释）。
    const int w = lv_area_get_width(area);
    const int h = lv_area_get_height(area);
    for (int y = 0; y < h; y++) {
        const int dy = area->y1 + y;
        if (dy < 0 || dy >= g_height) continue;
        uint32_t *dst = g_frame + (size_t) dy * g_width + area->x1;
        const uint32_t *src = (const uint32_t *) color_p + (size_t) y * w;
        for (int x = 0; x < w; x++) {
            const int dx = area->x1 + x;
            if (dx < 0 || dx >= g_width) continue;
            const uint32_t p = src[x];
            dst[x] = g_skip_swap
                     ? p
                     // B,G,R,A → R,G,B,A（见文件头「字节序」）
                     : ((p & 0xFF00FF00u)
                        | ((p & 0x000000FFu) << 16)
                        | ((p & 0x00FF0000u) >> 16));
        }
    }
    g_present_pending = true;
    lv_disp_flush_ready(drv);
}

// ================================================================ 输入

void indev_read_cb(lv_indev_drv_t *drv, lv_indev_data_t *data) {
    data->point.x = g_touch_x;
    data->point.y = g_touch_y;
    data->state = g_touch_down ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

// ================================================================ 渲染线程

// 前向声明：渲染线程要消费这两个（定义在下面的 UI 构建那一节）
void rebuild_ui();

void apply_value(const char *id, float value);

/** Sky 元素推值。**只能在渲染线程（持锁）里调** */
void apply_elem_value(const char *id, float value);

void *render_thread(void *) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    uint32_t last = (uint32_t) (ts.tv_sec * 1000 + ts.tv_nsec / 1000000);

    while (g_running) {
        clock_gettime(CLOCK_MONOTONIC, &ts);
        uint32_t now = (uint32_t) (ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
        const uint32_t delta = now - last;
        last = now;
        if (delta > 0) lv_tick_inc(delta);

        // 锁内做三件事：消费待办（重建/推值）+ 绘制。
        // 顺序很重要：先改对象树，再让 LVGL 画 —— 反过来会画一帧旧的。
        pthread_mutex_lock(&g_lv_mutex);

        // 帧率基准：全速改值 + 强制立即重绘，测渲染吞吐上限
        // ---- 帧率基准 ----
        // 模式 0（吞吐）：每轮改值 + 强制立即重绘，测上限
        // 模式 1（真实）：10Hz 改值 + 正常 lv_timer_handler，让 LVGL 自己决定何时重绘
        if (g_bench_active) {
            const bool do_update = (g_bench_mode == 0)
                                   || (now - g_bench_last_update >= 100);
            if (do_update) {
                for (int i = 0; i < g_binding_count; i++) {
                    const float v = (float) ((g_bench_phase + i * 37) % 100);
                    apply_value(g_bindings[i].pid, v);
                }
                g_bench_phase++;
                g_bench_last_update = now;
            }
            if (g_bench_mode == 0) {
                const uint64_t t0 = now_us();
                lv_refr_now(nullptr);
                g_bench_draw_us += now_us() - t0;
            } else {
                lv_timer_handler();
            }
            if (now >= g_bench_until) {
                const uint32_t ms = now - g_bench_start;
                g_bench_fps = ms > 0 ? (int) ((uint64_t) g_bench_frames * 1000 / ms) : 0;
                g_bench_active = false;
            }
            pthread_mutex_unlock(&g_lv_mutex);
            // **出了锁再提交** —— `ANativeWindow_lock` 会阻塞，握着锁调它会让主线程卡死
            if (g_present_pending) {
                g_present_pending = false;
                present_frame();
            }
            continue;   // 基准期间不休眠，全速跑
        }

        if (g_need_rebuild) {
            g_need_rebuild = false;
            rebuild_ui();
        }

        for (int i = 0; i < PENDING_SLOTS; i++) {
            if (!g_pending[i].used) continue;
            g_pending[i].used = false;
            apply_value(g_pending[i].id, g_pending[i].value);
            apply_elem_value(g_pending[i].id, g_pending[i].value);
        }

        lv_timer_handler();
        pthread_mutex_unlock(&g_lv_mutex);

        // **出了锁再提交**。`ANativeWindow_lock()` 在缓冲队列满时会阻塞等 SurfaceFlinger，
        // 握着 `g_lv_mutex` 调它 = 渲染线程卡住 + 主线程所有 native 调用堵死 = 「无响应」弹窗。
        if (g_present_pending) {
            g_present_pending = false;
            present_frame();
        }

        // 每满一秒结算一次 FPS
        static uint32_t fps_window_start = now;
        if (now - fps_window_start >= 1000) {
            g_fps = g_flush_count;
            g_flush_count = 0;
            fps_window_start = now;
        }

        usleep(5000);   // 5ms 一轮；实际刷新节奏由 LVGL 的刷新周期决定
    }
    return nullptr;
}

// ================================================================ 仪表 UI
//
// 全部按配置**动态创建**。样式编号与 Kotlin 侧 `GaugeItem.STYLE_*` 一一对应，
// 改一边必须改另一边（下面这组宏就是那份「契约」）。

#define STYLE_CIRCLE     0
#define STYLE_DIGITAL    1
#define STYLE_BAR        2
#define STYLE_LINE       3
#define STYLE_DUAL_STACK 4
#define STYLE_QUAD       5
#define STYLE_SUB_DUAL   6
#define STYLE_GFORCE     7

/** 参考画布边长。与 Kotlin 侧 GaugeItem.CANVAS 必须一致 */
#define CANVAS_UNITS 360.0f

#define RING_NONE 0
#define RING_TICK 1

/** 卡片统一外观。`card_stroke = 0` 时**不画边框**（无边框主题） */
static void style_card(lv_obj_t *obj) {
    lv_obj_set_style_bg_color(obj, lv_color_hex(g_theme.surface), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, LV_PART_MAIN);
    if (g_theme.card_stroke > 0) {
        lv_obj_set_style_border_width(obj, g_theme.card_stroke, LV_PART_MAIN);
        lv_obj_set_style_border_color(obj, lv_color_hex(g_theme.surface_edge), LV_PART_MAIN);
    } else {
        lv_obj_set_style_border_width(obj, 0, LV_PART_MAIN);
    }
    lv_obj_set_style_radius(obj, g_theme.card_radius, LV_PART_MAIN);
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_pad_all(obj, 0, LV_PART_MAIN);
}

static Binding *add_binding(const char *pid, int kind) {
    if (pid == nullptr || pid[0] == '\0') return nullptr;
    if (g_binding_count >= MAX_BINDINGS) return nullptr;
    Binding *b = &g_bindings[g_binding_count++];
    memset(b, 0, sizeof(Binding));
    strncpy(b->pid, pid, sizeof(b->pid) - 1);
    b->kind = kind;
    return b;
}

/** 数值文本 + 单位 */
static lv_obj_t *make_value_label(lv_obj_t *parent, const char *unit, bool big) {
    lv_obj_t *lbl = lv_label_create(parent);
    lv_label_set_text(lbl, "--");
    lv_obj_set_style_text_color(lbl, lv_color_hex(g_theme.value_text), 0);
    lv_obj_set_style_text_font(lbl, big ? &lv_font_montserrat_28 : &lv_font_montserrat_14, 0);
    lv_obj_align(lbl, LV_ALIGN_CENTER, 0, big ? -8 : 0);
    if (unit != nullptr && unit[0] != '\0') {
        lv_obj_t *u = lv_label_create(parent);
        lv_label_set_text(u, unit);
        lv_obj_set_style_text_color(u, lv_color_hex(g_theme.label_text), 0);
        lv_obj_align(u, LV_ALIGN_CENTER, 0, big ? 18 : 14);
    }
    return lbl;
}

/**
 * 圆表：`lv_meter` + 可选指针环。
 *
 * **指针环不需要自定义 draw 事件** —— 再挂一个「整圈刻度」的 scale 就行：
 * `ring_segments` 条刻度均匀铺满 360°，正好就是外圈一圈刻度线段。
 */
/**
 * 圆表：**霓虹自定义绘制**（见 `neon_gauge.h`）。
 *
 * 早期用 `lv_meter`，但它的每个指示器只能有一个颜色，做不出设计要求的
 * 10 层渐变辉光。现在换成 `neon_gauge`（`LV_EVENT_DRAW_MAIN` 自绘）。
 */
static void make_circle(int px, int py, int pw, int ph, uint32_t color,
                        int ring_style, int ring_seg, float min, float max,
                        const char *pid, const char *unit) {
    const int side = pw < ph ? pw : ph;

    NeonGaugeConfig cfg = {};
    cfg.min = min;
    cfg.max = max;
    // 危险区：暂按量程 80% 起。⚠️ 应该用 GaugeItem.warnHigh，但当前
    // nativeBuildLayout 的 metrics 里没带它 —— 见文件末尾 TODO
    cfg.danger = min + (max - min) * 0.8f;
    cfg.accent = color;
    cfg.track = g_theme.track;
    cfg.tick = g_theme.tick;
    cfg.text = g_theme.value_text;
    cfg.label = g_theme.label_text;
    cfg.ring_segments = (ring_style == RING_TICK) ? ring_seg : 0;
    cfg.unit = unit;
    cfg.decimals = 0;

    lv_obj_t *gauge = neon_gauge_create(lv_scr_act(), &cfg);
    if (gauge == nullptr) {
        LOGE("neon_gauge_create 失败 pid=%s", pid);
        return;
    }
    lv_obj_set_pos(gauge, px, py);
    lv_obj_set_size(gauge, side, side);

    Binding *b = add_binding(pid, BIND_NEON);
    if (b != nullptr) {
        b->widget = gauge;
        b->min = min;
        b->max = max;
        b->label = nullptr;   // 数值标签由 neon_gauge 内部管理
    }
}

static void make_digital(int px, int py, int pw, int ph, uint32_t color,
                         float min, float max, const char *pid, const char *unit) {
    lv_obj_t *card = lv_obj_create(lv_scr_act());
    lv_obj_set_pos(card, px, py);
    lv_obj_set_size(card, pw, ph);
    style_card(card);

    Binding *b = add_binding(pid, BIND_LABEL);
    if (b != nullptr) {
        b->widget = card;
        b->min = min;
        b->max = max;
        b->label = make_value_label(card, unit, true);
    }
}

static void make_bar(int px, int py, int pw, int ph, uint32_t color,
                     float min, float max, const char *pid, const char *unit) {
    lv_obj_t *card = lv_obj_create(lv_scr_act());
    lv_obj_set_pos(card, px, py);
    lv_obj_set_size(card, pw, ph);
    style_card(card);

    lv_obj_t *bar = lv_bar_create(card);
    const int bar_w = pw - 24 > 20 ? pw - 24 : 20;
    lv_obj_set_size(bar, bar_w, 14);
    lv_obj_align(bar, LV_ALIGN_BOTTOM_MID, 0, -12);
    lv_bar_set_range(bar, (int32_t) min, (int32_t) max);
    lv_obj_set_style_bg_color(bar, lv_color_hex(g_theme.track), LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, lv_color_hex(color), LV_PART_INDICATOR);

    Binding *b = add_binding(pid, BIND_BAR);
    if (b != nullptr) {
        b->widget = bar;
        b->min = min;
        b->max = max;
        b->label = make_value_label(card, unit, true);
    }
}

static void make_chart(int px, int py, int pw, int ph, uint32_t color,
                       float min, float max, const char *pid, const char *unit) {
    lv_obj_t *card = lv_obj_create(lv_scr_act());
    lv_obj_set_pos(card, px, py);
    lv_obj_set_size(card, pw, ph);
    style_card(card);

    lv_obj_t *chart = lv_chart_create(card);
    lv_obj_set_size(chart, pw - 16 > 20 ? pw - 16 : 20, ph - 40 > 20 ? ph - 40 : 20);
    lv_obj_align(chart, LV_ALIGN_TOP_MID, 0, 6);
    lv_chart_set_type(chart, LV_CHART_TYPE_LINE);
    lv_chart_set_range(chart, LV_CHART_AXIS_PRIMARY_Y, (int32_t) min, (int32_t) max);
    // 固定点数：趋势历史本来就只留 150 个采样，画 60 个足够看趋势
    lv_chart_set_point_count(chart, 60);
    lv_chart_set_div_line_count(chart, 3, 0);
    lv_obj_set_style_bg_color(chart, lv_color_hex(g_theme.background), LV_PART_MAIN);
    lv_obj_set_style_border_width(chart, 0, LV_PART_MAIN);
    lv_obj_set_style_line_color(chart, lv_color_hex(g_theme.track), LV_PART_MAIN);
    lv_chart_series_t *ser = lv_chart_add_series(chart, lv_color_hex(color),
                                                 LV_CHART_AXIS_PRIMARY_Y);
    lv_chart_set_all_value(chart, ser, (int32_t) min);

    Binding *b = add_binding(pid, BIND_CHART);
    if (b != nullptr) {
        b->widget = chart;
        b->series = ser;
        b->min = min;
        b->max = max;
        b->label = make_value_label(card, unit, false);
    }
}

/** 多值卡（4/5/6）：主参数大号 + 副参数小号 */
static void make_multi(int px, int py, int pw, int ph, uint32_t color,
                       const char *pid, const char *extras, int style) {
    lv_obj_t *card = lv_obj_create(lv_scr_act());
    lv_obj_set_pos(card, px, py);
    lv_obj_set_size(card, pw, ph);
    style_card(card);

    Binding *b = add_binding(pid, BIND_LABEL);
    if (b != nullptr) {
        b->widget = card;
        b->label = make_value_label(card, "", true);
    }
    (void) color;

    int idx = 0;
    const char *p = extras;
    while (p != nullptr && *p != '\0' && idx < 3) {
        const char *comma = strchr(p, ',');
        char one[24];
        size_t n = comma ? (size_t) (comma - p) : strlen(p);
        if (n >= sizeof(one)) n = sizeof(one) - 1;
        memcpy(one, p, n);
        one[n] = '\0';

        lv_obj_t *sl = lv_label_create(card);
        lv_label_set_text(sl, "--");
        lv_obj_set_style_text_color(sl, lv_color_hex(g_theme.label_text), 0);
        lv_obj_set_style_text_font(sl, &lv_font_montserrat_14, 0);
        if (style == STYLE_DUAL_STACK) {
            lv_obj_align(sl, LV_ALIGN_TOP_MID, 0, 6 + idx * 20);
        } else {
            lv_obj_align(sl, LV_ALIGN_BOTTOM_LEFT, 8 + idx * (pw / 3), -8);
        }

        Binding *sb = add_binding(one, BIND_LABEL);
        if (sb != nullptr) {
            sb->widget = card;
            sb->label = sl;
        }

        idx++;
        if (!comma) break;
        p = comma + 1;
    }
}

/** G 值：一个圆 + 一个点，由 gx/gy 两条绑定共同驱动 */
static void make_gforce(int px, int py, int pw, int ph, uint32_t color,
                        const char *pid, const char *extras, float range) {
    lv_obj_t *card = lv_obj_create(lv_scr_act());
    lv_obj_set_pos(card, px, py);
    lv_obj_set_size(card, pw, ph);
    style_card(card);

    int d = (pw < ph ? pw : ph) - 24;
    if (d < 40) d = 40;
    g_dot_host = lv_obj_create(card);
    lv_obj_set_size(g_dot_host, d, d);
    lv_obj_align(g_dot_host, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_radius(g_dot_host, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    lv_obj_set_style_bg_color(g_dot_host, lv_color_hex(g_theme.background), LV_PART_MAIN);
    lv_obj_set_style_border_width(g_dot_host, 1, LV_PART_MAIN);
    lv_obj_set_style_border_color(g_dot_host, lv_color_hex(g_theme.track), LV_PART_MAIN);
    lv_obj_clear_flag(g_dot_host, LV_OBJ_FLAG_SCROLLABLE);

    g_dot = lv_obj_create(g_dot_host);
    lv_obj_set_size(g_dot, 14, 14);
    lv_obj_set_style_radius(g_dot, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    lv_obj_set_style_bg_color(g_dot, lv_color_hex(color), LV_PART_MAIN);
    lv_obj_set_style_border_width(g_dot, 0, LV_PART_MAIN);
    lv_obj_align(g_dot, LV_ALIGN_CENTER, 0, 0);
    g_dot_range = range > 0.f ? range : 1.5f;
    g_dot_x = g_dot_y = 0.f;

    Binding *bx = add_binding(pid, BIND_DOT);
    if (bx != nullptr) { bx->dot_axis = 0; }

    if (extras != nullptr && extras[0] != '\0') {
        const char *comma = strchr(extras, ',');
        char gy[24];
        size_t n = comma ? (size_t) (comma - extras) : strlen(extras);
        if (n >= sizeof(gy)) n = sizeof(gy) - 1;
        memcpy(gy, extras, n);
        gy[n] = '\0';
        Binding *by = add_binding(gy, BIND_DOT);
        if (by != nullptr) { by->dot_axis = 1; }
    }
}

/**
 * 按一份配置建表。由 `nativeBuildLayout` 调用（**只在渲染线程、持锁**）。
 *
 * @param metrics 每条 6 个：min, max, x, y, w, h（x/y/w/h 是**归一化 0..1**，
 *                与 Android 侧的自由画布同一套坐标）
 */
// ---- 参考线（均匀线段覆盖层）----
//
// 与 Android 侧 `DashGridOverlayView` 对应：均匀竖线 + 横线，密度/样式/透明度可调。
// 关键点是 **z 序**：网格层必须是屏幕的第一个子对象，否则会盖住仪表。
// 所以它在 `build_from_spec()` 里**最先**创建，卡片随后叠加。

#define GRID_MAX_LINES 40

static lv_obj_t *g_grid_layer = nullptr;
static bool g_grid_enabled = false;
static int g_grid_cols = 6;
static int g_grid_rows = 4;
static int g_grid_style = 0;      // 0=实线 1=虚线 2=点线
static int g_grid_alpha = 60;     // 0..255
static int g_grid_stroke = 1;     // px

// ⚠️ `lv_line_set_points()` **只存指针不拷贝**，所以每条线必须有自己的一份点数组。
// 共用一个 static 数组的话所有线会叠在同一条上（这个坑很容易踩）。
static lv_point_t g_grid_pts[GRID_MAX_LINES][2];

static void apply_grid_lines() {
    if (g_grid_layer == nullptr) return;
    lv_obj_clean(g_grid_layer);
    if (!g_grid_enabled || g_grid_alpha <= 0) return;

    const int cols = g_grid_cols < 1 ? 1 : (g_grid_cols > 20 ? 20 : g_grid_cols);
    const int rows = g_grid_rows < 1 ? 1 : (g_grid_rows > 20 ? 20 : g_grid_rows);
    int idx = 0;

    for (int i = 1; i < cols && idx < GRID_MAX_LINES; i++, idx++) {
        const int x = g_width * i / cols;
        g_grid_pts[idx][0].x = (lv_coord_t) x;
        g_grid_pts[idx][0].y = 0;
        g_grid_pts[idx][1].x = (lv_coord_t) x;
        g_grid_pts[idx][1].y = (lv_coord_t) g_height;
        lv_obj_t *l = lv_line_create(g_grid_layer);
        lv_line_set_points(l, g_grid_pts[idx], 2);
        lv_obj_set_style_line_width(l, g_grid_stroke, 0);
        lv_obj_set_style_line_color(l, lv_color_hex(g_theme.tick), 0);
        lv_obj_set_style_line_opa(l, (lv_opa_t) g_grid_alpha, 0);
        if (g_grid_style == 1) {          // 虚线
            lv_obj_set_style_line_dash_width(l, 8, 0);
            lv_obj_set_style_line_dash_gap(l, 6, 0);
        } else if (g_grid_style == 2) {   // 点线
            lv_obj_set_style_line_dash_width(l, 1, 0);
            lv_obj_set_style_line_dash_gap(l, 6, 0);
        }
    }

    for (int j = 1; j < rows && idx < GRID_MAX_LINES; j++, idx++) {
        const int y = g_height * j / rows;
        g_grid_pts[idx][0].x = 0;
        g_grid_pts[idx][0].y = (lv_coord_t) y;
        g_grid_pts[idx][1].x = (lv_coord_t) g_width;
        g_grid_pts[idx][1].y = (lv_coord_t) y;
        lv_obj_t *l = lv_line_create(g_grid_layer);
        lv_line_set_points(l, g_grid_pts[idx], 2);
        lv_obj_set_style_line_width(l, g_grid_stroke, 0);
        lv_obj_set_style_line_color(l, lv_color_hex(g_theme.tick), 0);
        lv_obj_set_style_line_opa(l, (lv_opa_t) g_grid_alpha, 0);
        if (g_grid_style == 1) {
            lv_obj_set_style_line_dash_width(l, 8, 0);
            lv_obj_set_style_line_dash_gap(l, 6, 0);
        } else if (g_grid_style == 2) {
            lv_obj_set_style_line_dash_width(l, 1, 0);
            lv_obj_set_style_line_dash_gap(l, 6, 0);
        }
    }
}

/** 建网格层。**必须在建卡片之前调**，否则它会盖住仪表 */
static void build_grid_layer() {
    g_grid_layer = lv_obj_create(lv_scr_act());
    lv_obj_set_size(g_grid_layer, g_width, g_height);
    lv_obj_set_pos(g_grid_layer, 0, 0);
    lv_obj_set_style_bg_opa(g_grid_layer, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(g_grid_layer, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(g_grid_layer, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(g_grid_layer, 0, LV_PART_MAIN);
    lv_obj_clear_flag(g_grid_layer, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(g_grid_layer, LV_OBJ_FLAG_CLICKABLE);
    apply_grid_lines();
    LOGI("网格层已建：enabled=%d %dx%d style=%d alpha=%d",
         g_grid_enabled ? 1 : 0, g_grid_cols, g_grid_rows, g_grid_style, g_grid_alpha);
}

static void build_from_spec(int n,
                            const char **pids, const char **extras, const char **units,
                            const int *styles, const int *colors,
                            const int *ring_styles, const int *ring_segs,
                            const float *metrics) {
    // **先建网格层**：它是屏幕的第一个子对象，z 序最底。
    // 放在卡片之后建的话会盖住所有仪表。
    build_grid_layer();

    for (int i = 0; i < n; i++) {
        const float *m = metrics + i * 6;
        const float min = m[0], max = m[1];
        // 画布单位（每轴 0..CANVAS_UNITS）→ 像素。
        // 与 Kotlin 侧 `GaugeItem.CANVAS` 是同一套坐标系，改一边必须改另一边。
        int px = (int) (m[2] / CANVAS_UNITS * g_width);
        int py = (int) (m[3] / CANVAS_UNITS * g_height);
        int pw = (int) (m[4] / CANVAS_UNITS * g_width);
        int ph = (int) (m[5] / CANVAS_UNITS * g_height);
        if (pw < 24) pw = 24;
        if (ph < 24) ph = 24;

        // color < 0 = 用主题强调色
        const uint32_t color = colors[i] >= 0
                               ? ((uint32_t) colors[i] & 0xFFFFFFu)
                               : g_theme.accent;
        const char *unit = units[i] ? units[i] : "";

        switch (styles[i]) {
            case STYLE_CIRCLE:
                make_circle(px, py, pw, ph, color, ring_styles[i], ring_segs[i],
                            min, max, pids[i], unit);
                break;
            case STYLE_DIGITAL:
                make_digital(px, py, pw, ph, color, min, max, pids[i], unit);
                break;
            case STYLE_BAR:
                make_bar(px, py, pw, ph, color, min, max, pids[i], unit);
                break;
            case STYLE_LINE:
                make_chart(px, py, pw, ph, color, min, max, pids[i], unit);
                break;
            case STYLE_GFORCE:
                make_gforce(px, py, pw, ph, color, pids[i], extras[i],
                            max > 0.f ? max : 1.5f);
                break;
            default:   // 4/5/6：多值卡
                make_multi(px, py, pw, ph, color, pids[i], extras[i], styles[i]);
                break;
        }
    }
    LOGI("布局已建：%d 块仪表，绑定 %d 条，屏幕 %dx%d",
         n, g_binding_count, g_width, g_height);
}

void build_ui() {
    lv_obj_t *scr = lv_scr_act();
    lv_obj_set_style_bg_color(scr, lv_color_hex(g_theme.background), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, LV_PART_MAIN);
    // 仪表由 Kotlin 通过 nativeBuildLayout 下发；这里不建任何东西
}

void rebuild_ui() {
    lv_obj_t *scr = lv_scr_act();
    if (scr == nullptr) return;
    lv_obj_clean(scr);            // 清掉所有卡片
    g_binding_count = 0;
    g_dot_host = g_dot = nullptr;
    g_grid_layer = nullptr;   // lv_obj_clean 已把它一起删了
    // **必须重设屏幕底色**：uild_ui() 现在只干这一件事。
    // 少了它，换主题后屏幕会一直保持上一套的底色（实测踩过：主题映射验证因此变成 ✗）
    build_ui();
    // 仪表本身由 Kotlin 在 applyTheme 之后紧接着再下发一次 buildLayout 重建
}

void apply_value(const char *id, float value) {
    if (!g_inited || id == nullptr) return;
    char buf[32];
    for (int i = 0; i < g_binding_count; i++) {
        Binding *b = &g_bindings[i];
        if (strcmp(b->pid, id) != 0) continue;

        switch (b->kind) {
            case BIND_METER:
                lv_meter_set_indicator_end_value(b->widget, b->needle, (int32_t) value);
                if (b->arc) lv_meter_set_indicator_end_value(b->widget, b->arc, (int32_t) value);
                if (b->label) {
                    snprintf(buf, sizeof(buf), "%d", (int) value);
                    lv_label_set_text(b->label, buf);
                }
                break;
            case BIND_LABEL:
                if (b->label) {
                    snprintf(buf, sizeof(buf), "%.0f", value);
                    lv_label_set_text(b->label, buf);
                }
                break;
            case BIND_BAR:
                lv_bar_set_value(b->widget, (int32_t) value, LV_ANIM_OFF);
                if (b->label) {
                    snprintf(buf, sizeof(buf), "%.0f", value);
                    lv_label_set_text(b->label, buf);
                }
                break;
            case BIND_CHART:
                if (b->series) {
                    lv_chart_set_next_value(b->widget, b->series, (lv_coord_t) value);
                }
                if (b->label) {
                    snprintf(buf, sizeof(buf), "%.0f", value);
                    lv_label_set_text(b->label, buf);
                }
                break;
            case BIND_NEON:
                neon_gauge_set_value(b->widget, value);
                break;
            case BIND_DOT:
                if (b->dot_axis == 0) g_dot_x = value; else g_dot_y = value;
                if (g_dot_host != nullptr && g_dot != nullptr) {
                    const int half = lv_obj_get_width(g_dot_host) / 2 - 10;
                    const float r = g_dot_range > 0.f ? g_dot_range : 1.5f;
                    int dx = (int) (g_dot_x / r * (float) half);
                    int dy = (int) (-g_dot_y / r * (float) half);
                    if (dx > half) dx = half;
                    if (dx < -half) dx = -half;
                    if (dy > half) dy = half;
                    if (dy < -half) dy = -half;
                    lv_obj_align(g_dot, LV_ALIGN_CENTER, dx, dy);
                }
                break;
            default:
                break;
        }
    }
}
// ---- Sky Gauge 元素渲染 ----
//
// 与 `neon_gauge` 不同：那边是「一个组合控件」，这里是**图元**。
// 元素级模型和 LVGL 几乎一一对应，所以这里直接用 LVGL 原生控件：
//   arc   → lv_arc
//   label → lv_label
//   image → 暂不支持（需要 rgb565 资源管线，见文件末尾 TODO）
//
// 角度换算：Sky Gauge 用「0° = 12 点、顺时针」，LVGL 用「0° = 3 点、顺时针」，
// 所以 `lvgl = (sky + 270) % 360`（与 neon_gauge 同一套换算）。

// ---- 主题内嵌字体（`lv_font_bin`）----
//
// Sky Gauge 主题把字体作为二进制资源内嵌（实测 4 档：16/26/48/96）。
// LVGL 的 `lv_font_load()` 走 `lv_fs`，所以要先启用 `LV_USE_FS_STDIO`
// （驱动器字母 'A'），再由 Kotlin 把资源字节落成文件、把路径传进来。
//
// 这一层是**中文显示的关键** —— 编译进去的 montserrat 不含 CJK，
// 主题里的 Xperia 字体才是随主题走的。
static const int MAX_FONTS = 8;

struct LoadedFont {
    char name[40];
    lv_font_t *font;
};
static LoadedFont g_fonts[MAX_FONTS];
static int g_font_count = 0;

static lv_font_t *font_by_name(const char *name) {
    if (name == nullptr || name[0] == '\0') return nullptr;
    for (int i = 0; i < g_font_count; i++) {
        if (strcmp(g_fonts[i].name, name) == 0) return g_fonts[i].font;
    }
    return nullptr;
}

/** 释放全部已加载字体。**持锁调** */
static void free_fonts() {
    for (int i = 0; i < g_font_count; i++) {
        if (g_fonts[i].font != nullptr) lv_font_free(g_fonts[i].font);
        g_fonts[i].font = nullptr;
    }
    g_font_count = 0;
}
#define ELEM_ARC 0
#define ELEM_LABEL 1
#define ELEM_IMAGE 2

/** 每条元素绑定的 pidId 最长 24；与 Binding 的 pid 一致 */
struct ElemBinding {
    char pid[24];
    int kind;
    lv_obj_t *widget;
    float min, max;
};
static const int MAX_ELEMS = 96;
static ElemBinding g_elems[MAX_ELEMS];
static int g_elem_count = 0;

static inline int sky_angle_to_lvgl(float sky_deg) {
    int a = (int) (sky_deg + 270.0f) % 360;
    if (a < 0) a += 360;
    return a;
}

/** 把 label 摆到 (cx, cy) 为中心的位置。文本变了要重摆（宽度会变） */
static void center_label_at(lv_obj_t *lbl, int cx, int cy) {
    lv_obj_update_layout(lbl);
    const int w = lv_obj_get_width(lbl);
    const int h = lv_obj_get_height(lbl);
    lv_obj_set_pos(lbl, (lv_coord_t) (cx - w / 2), (lv_coord_t) (cy - h / 2));
}

static ElemBinding *add_elem(const char *pid, int kind) {
    if (g_elem_count >= MAX_ELEMS) return nullptr;
    ElemBinding *b = &g_elems[g_elem_count++];
    memset(b, 0, sizeof(ElemBinding));
    if (pid != nullptr) strncpy(b->pid, pid, sizeof(b->pid) - 1);
    b->kind = kind;
    return b;
}

/**
 * 按元素列表重建整屏。
 *
 * @param metrics 每条 10 个：`x, y, w, h, startAngle, endAngle, lineWidth, fontSize, rangeMin, rangeMax`
 * @param pids    已映射到本地的 PID id；空串 = 静态元素
 * @param texts   静态文字（label）或动态格式串（如 `%d`）
 */
static void build_elements_from_spec(
        int n, const int *types, const char **pids, const char **texts,
        const char **font_assets,
        const int *colors, const int *bg_colors,
        const float *metrics, int background) {

    lv_obj_t *scr = lv_scr_act();
    if (scr == nullptr) return;
    lv_obj_set_style_bg_color(scr, lv_color_hex((uint32_t) background & 0xFFFFFFu), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, LV_PART_MAIN);

    for (int i = 0; i < n; i++) {
        const float *m = metrics + i * 10;
        // ⚠️ Sky Gauge 的画布是**正方形** 360×360（他们的屏幕就是方的）。
        // 所以必须**统一缩放（取短边）+ 居中** —— 按 x 用屏宽、y 用屏高各自缩放
        // 会把设计拉变形：圆环是正圆（LVGL 在方框里拟合），标签却按两轴各自定位，
        // 结果两者对不上，整个主题看起来"散了"。
        const int side = g_width < g_height ? g_width : g_height;
        const float k = (float) side / CANVAS_UNITS;
        const int off_x = (g_width - side) / 2;
        const int off_y = (g_height - side) / 2;

        const int px = off_x + (int) (m[0] * k);
        const int py = off_y + (int) (m[1] * k);
        const int pw = (int) (m[2] * k);
        const int ph = (int) (m[3] * k);
        const float a0 = m[4], a1 = m[5];
        const int line_w = (int) (m[6] * k);
        const int font_sz = (int) m[7];
        const float rmin = m[8], rmax = m[9];
        const char *pid = pids[i] != nullptr ? pids[i] : "";
        const char *txt = texts[i] != nullptr ? texts[i] : "";
        const uint32_t fg = colors[i] >= 0 ? ((uint32_t) colors[i] & 0xFFFFFFu) : g_theme.value_text;
        const uint32_t bgc = bg_colors[i] >= 0 ? ((uint32_t) bg_colors[i] & 0xFFFFFFu) : g_theme.track;

        if (types[i] == ELEM_ARC) {
            lv_obj_t *arc = lv_arc_create(scr);
            // 元素没给尺寸时按整屏兜底（实测有些主题 width/height 都是 0）
            const int aw = pw > 8 ? pw : g_width;
            const int ah = ph > 8 ? ph : g_height;
            lv_obj_set_pos(arc, pw > 8 ? px : 0, ph > 8 ? py : 0);
            lv_obj_set_size(arc, aw, ah);
            lv_arc_set_bg_angles(arc, sky_angle_to_lvgl(a0), sky_angle_to_lvgl(a1));
            lv_arc_set_range(arc, (int32_t) rmin, (int32_t) rmax);
            lv_arc_set_value(arc, (int32_t) rmin);
            lv_arc_set_rotation(arc, 0);
            const int w = line_w > 0 ? line_w : 8;
            lv_obj_set_style_arc_width(arc, w, LV_PART_INDICATOR);
            lv_obj_set_style_arc_width(arc, w, LV_PART_MAIN);
            lv_obj_set_style_arc_color(arc, lv_color_hex(fg), LV_PART_INDICATOR);
            lv_obj_set_style_arc_color(arc, lv_color_hex(bgc), LV_PART_MAIN);
            // 不要旋钮，也不要点得动
            lv_obj_remove_style(arc, nullptr, LV_PART_KNOB);
            lv_obj_clear_flag(arc, LV_OBJ_FLAG_CLICKABLE);
            lv_obj_set_style_bg_opa(arc, LV_OPA_TRANSP, LV_PART_MAIN);
            lv_obj_set_style_border_width(arc, 0, LV_PART_MAIN);

            if (pid[0] != '\0') {
                ElemBinding *b = add_elem(pid, ELEM_ARC);
                if (b != nullptr) { b->widget = arc; b->min = rmin; b->max = rmax; }
            }
        } else if (types[i] == ELEM_LABEL) {
            lv_obj_t *lbl = lv_label_create(scr);
            // 动态元素先显示占位；静态元素直接显示 text
            // 占位符用 "0" 而不是 "--"：主题内嵌字体是按需裁剪的（lv_font_bin），
            // 很可能**没有 '-' 字形** —— 那样占位符渲染成空白，看着就像"啥都没有"。
            // 数字字体一定有位数字形。
            lv_label_set_text(lbl, pid[0] != '\0' ? "0" : txt);
            lv_obj_set_style_text_color(lbl, lv_color_hex(fg), 0);
            // 字体：暂用编译进去的几档 montserrat 近似（真正的 font_asset 见 TODO）
            // 优先用主题内嵌的字体（`font_asset` 按名查），没有才回落到编译进去的 montserrat。
            // ⚠️ montserrat **不含中文**，回落时中文会显示成方块；
            // 而且字号会掉档（主题的 96px 会被压成 28px），所以这一步不能少。
            lv_font_t *f = font_by_name(font_assets != nullptr ? font_assets[i] : nullptr);
            if (f != nullptr) {
                lv_obj_set_style_text_font(lbl, f, 0);
            } else if (font_sz >= 40) {
                lv_obj_set_style_text_font(lbl, &lv_font_montserrat_28, 0);
            } else if (font_sz >= 20) {
                lv_obj_set_style_text_font(lbl, &lv_font_montserrat_20, 0);
            } else {
                lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
            }
            // Sky Gauge 的 x/y 是**文字中心**
            center_label_at(lbl, px, py);

            if (pid[0] != '\0') {
                ElemBinding *b = add_elem(pid, ELEM_LABEL);
                if (b != nullptr) {
                    b->widget = lbl;
                    b->min = rmin;
                    b->max = rmax;
                    // 把 x/y 中心记在 widget 上，数值变化后重新居中要用
                    lv_obj_set_user_data(lbl, (void *) (intptr_t) ((px << 16) ^ (py & 0xFFFF)));
                }
            }
        } else {
            // image：需要 rgb565 资源管线，暂不支持。**记一条日志**而不是静默跳过
            LOGW("元素 image 暂不支持（asset=%s）", txt);
        }
    }
    LOGI("Sky 元素已建：%d 个元素，%d 条数据绑定，背景 %06X",
         n, g_elem_count, (unsigned) (background & 0xFFFFFF));
}

/** 数值落到 Sky 元素上。**只在渲染线程（持锁）里调** */
static void apply_elem_value(const char *pid, float value) {
    char buf[32];
    for (int i = 0; i < g_elem_count; i++) {
        ElemBinding *b = &g_elems[i];
        if (strcmp(b->pid, pid) != 0) continue;
        if (b->kind == ELEM_ARC) {
            lv_arc_set_value(b->widget, (int32_t) value);
        } else if (b->kind == ELEM_LABEL) {
            snprintf(buf, sizeof(buf), "%.0f", value);
            lv_label_set_text(b->widget, buf);
            // 文本宽度变了，重新按中心摆放
            const intptr_t packed = (intptr_t) lv_obj_get_user_data(b->widget);
            const int cx = (int) (packed >> 16);
            const int cy = (int) (packed & 0xFFFF);
            center_label_at(b->widget, cx, cy);
        }
    }
}

// TODO(下一轮)：image 元素（需要 rgb565 资源管线）
// TODO(下一轮)：font_asset（`lv_font_bin` 内嵌字体）—— 现在用 montserrat 近似，
//               它**不含中文**，所以中文标签会显示成方块

// ================================================================ JNI

}  // namespace

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeCreate(JNIEnv *env, jclass clazz,
                                                  jobject surface, jint width, jint height) {
    if (g_inited) {
        LOGI("nativeCreate: 已经初始化过，先销毁旧的");
        return JNI_FALSE;
    }
    g_window = ANativeWindow_fromSurface(env, surface);
    if (g_window == nullptr) {
        LOGE("ANativeWindow_fromSurface 失败");
        return JNI_FALSE;
    }
    g_width = width;
    g_height = height;

    ANativeWindow_setBuffersGeometry(g_window, width, height, WINDOW_FORMAT_RGBA_8888);

    lv_init();

    // 全屏缓冲：FULL 刷新模式下 LVGL 每次画满整屏，flush 里整块贴上去
    g_buf = (lv_color_t *) malloc((size_t) width * height * sizeof(lv_color_t));
    g_frame = (uint32_t *) malloc((size_t) width * height * 4);
    if (g_frame != nullptr) memset(g_frame, 0, (size_t) width * height * 4);
    if (g_buf == nullptr) {
        LOGE("帧缓冲分配失败 %dx%d", width, height);
        return JNI_FALSE;
    }
    lv_disp_draw_buf_init(&g_draw_buf, g_buf, nullptr, width * height);

    lv_disp_drv_init(&g_disp_drv);
    g_disp_drv.hor_res = width;
    g_disp_drv.ver_res = height;
    g_disp_drv.flush_cb = flush_cb;
    g_disp_drv.draw_buf = &g_draw_buf;
    lv_disp_drv_register(&g_disp_drv);

    lv_indev_drv_init(&g_indev_drv);
    g_indev_drv.type = LV_INDEV_TYPE_POINTER;
    g_indev_drv.read_cb = indev_read_cb;
    lv_indev_drv_register(&g_indev_drv);

    build_ui();

    g_inited = true;
    g_running = true;
    pthread_create(&g_thread, nullptr, render_thread, nullptr);

    LOGI("LVGL 已启动 %dx%d color_depth=%d", width, height, LV_COLOR_DEPTH);
    return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeDestroy(JNIEnv *, jclass) {
    if (g_running) {
        g_running = false;
        pthread_join(g_thread, nullptr);
    }
    if (g_window != nullptr) {
        ANativeWindow_release(g_window);
        g_window = nullptr;
    }
    free(g_buf);
    free(g_frame);
    g_frame = nullptr;
    g_buf = nullptr;
    g_inited = false;
    g_binding_count = 0;
    g_dot_host = g_dot = nullptr;
    LOGI("LVGL 已销毁");
}

JNIEXPORT void JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeTouch(JNIEnv *, jclass,
                                                 jint x, jint y, jboolean down) {
    g_touch_x = x;
    g_touch_y = y;
    g_touch_down = down;
}

/**
 * 应用主题。
 *
 * 参数是**基本类型**而不是 JSON —— 见 `Theme` 的注释：语义由 Kotlin 侧的
 * `GaugeTheme` 负责解释，这里只存值。这样 C 侧不需要 JSON 解析器，
 * 也不会出现「两边 schema 理解不一致」的静默错误。
 *
 * 收到主题就整体重建 UI（低频操作，代价可忽略），避免出现半新半旧的主题。
 */
/**
 * 下发整份仪表配置（数量、样式、量程、位置、颜色全部由配置决定）。
 *
 * 参数全是基本类型与数组，**没有 JSON** —— 语义由 Kotlin 侧的 `GaugeItem` 负责
 * （见 `Theme` 的注释：不让 C 侧养第二个解析器）。
 *
 * @param metrics 每条 6 个浮点：`min, max, x, y, w, h`
 *                （x/y/w/h 是**归一化 0..1**，与 Android 自由画布同一套坐标）
 * @param colors  每条一个强调色；**负数 = 用主题的 accent**
 * @return 建立成功的绑定条数；参数不合法返回 -1
 */
/**
 * 设置参考线。
 *
 * 只重建网格层内部、**不动仪表** —— 所以切密度/样式是即时的，不用重建整屏。
 * 网格层必须保持在屏幕第一个子对象的位置（LVGL 里 index 0 = z 序最底），
 * 否则会盖住仪表。
 */
/**
 * 帧率基准。跑两轮并给出**耗时拆解**：
 *   模式 0（吞吐上限）：每轮改值 + 强制立即重绘
 *   模式 1（真实负载）：10Hz 改值 + 正常刷新 ← **决定这条路可不可用的那个数**
 *
 * 拆解 `lv_refr_now`（LVGL 软件绘制）与 `ANativeWindow` 提交各占多少，
 * 这样优化才有方向。早先已验过红蓝交换**不是**瓶颈（开/关帧数完全一致）。
 *
 * @param seconds 每轮时长，1..30 秒
 * @return 模式 1（真实负载）的 FPS；未初始化 -1，没有绑定 -2
 */
JNIEXPORT jint JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeBenchmark(JNIEnv *, jclass, jint seconds) {
    if (!g_inited) return -1;
    int sec = seconds;
    if (sec < 1) sec = 3;
    if (sec > 30) sec = 30;

    pthread_mutex_lock(&g_lv_mutex);
    if (g_binding_count == 0) {
        pthread_mutex_unlock(&g_lv_mutex);
        return -2;
    }
    const int n = g_binding_count;
    pthread_mutex_unlock(&g_lv_mutex);

    int fps_real = -1;

    for (int mode = 0; mode <= 1; mode++) {
        pthread_mutex_lock(&g_lv_mutex);
        g_bench_mode = mode;
        g_bench_frames = 0;
        g_bench_phase = 0;
        g_bench_fps = -1;
        g_bench_draw_us = 0;
        g_bench_post_us = 0;
        g_bench_last_update = 0;
        g_bench_start = now_ms();
        g_bench_until = g_bench_start + (uint32_t) sec * 1000;
        g_bench_active = true;
        pthread_mutex_unlock(&g_lv_mutex);

        const uint32_t deadline = now_ms() + (uint32_t) (sec + 5) * 1000;
        while (g_bench_active && now_ms() < deadline) usleep(20000);

        const int frames = g_bench_frames;
        const int fps = g_bench_fps;
        const uint64_t per_draw = frames > 0 ? (g_bench_draw_us / 1000) / (uint64_t) frames : 0;
        const uint64_t per_post = frames > 0 ? (g_bench_post_us / 1000) / (uint64_t) frames : 0;

        LOGI("帧率基准[%s]：%d 帧 / %d 秒 → %d FPS · 每帧 绘制≈%llu ms 提交≈%llu ms（%d 条绑定）",
             mode == 0 ? "吞吐上限" : "真实负载10Hz",
             frames, sec, fps,
             (unsigned long long) per_draw, (unsigned long long) per_post, n);

        if (mode == 1) fps_real = fps;
    }

    pthread_mutex_lock(&g_lv_mutex);
    g_bench_mode = 0;
    pthread_mutex_unlock(&g_lv_mutex);
    return fps_real;
}
JNIEXPORT void JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeSetGrid(
        JNIEnv *, jclass, jboolean enabled, jint cols, jint rows,
        jint style, jint alpha, jint strokePx) {
    if (!g_inited) return;
    pthread_mutex_lock(&g_lv_mutex);
    g_grid_enabled = (enabled == JNI_TRUE);
    g_grid_cols = cols;
    g_grid_rows = rows;
    g_grid_style = style;
    g_grid_alpha = alpha;
    g_grid_stroke = strokePx > 0 ? strokePx : 1;
    if (g_grid_layer != nullptr) {
        apply_grid_lines();
        lv_obj_move_to_index(g_grid_layer, 0);   // 保险：钉回最底层
    }
    pthread_mutex_unlock(&g_lv_mutex);
    LOGI("参考线已设置：enabled=%d %dx%d style=%d alpha=%d stroke=%d",
         g_grid_enabled ? 1 : 0, (int) cols, (int) rows, (int) style,
         (int) alpha, g_grid_stroke);
}

/**
 * 按 **Sky Gauge 元素列表**重建整屏（与 `nativeBuildLayout` 是两条路）。
 *
 * `nativeBuildLayout` 走的是「组合控件」（GaugeItem → neon_gauge / bar / chart）；
 * 这里走的是「图元」（arc / label / image → LVGL 原生控件）。
 * 导入外部主题用这条路，因为对方的模型就是图元级的。
 *
 * @param metrics 每条 10 个浮点：`x, y, w, h, startAngle, endAngle, lineWidth, fontSize, rangeMin, rangeMax`
 * @param pids    已映射到本地的 PID id；空串 = 静态元素
 * @param texts   静态文字（label）或动态格式串
 * @return 数据绑定条数；参数不合法 -1
 */
/**
 * 加载一个主题内嵌字体（`lv_font_bin`）。
 *
 * @param path 设备上的绝对路径。C 侧会加上 LVGL 的驱动器字母前缀（`A:`）
 * @return 是否成功
 */
JNIEXPORT jboolean JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeLoadFont(
        JNIEnv *env, jclass, jstring name, jstring path) {
    if (!g_inited || name == nullptr || path == nullptr) return JNI_FALSE;
    const char *n = env->GetStringUTFChars(name, nullptr);
    const char *p = env->GetStringUTFChars(path, nullptr);
    bool ok = false;
    if (n != nullptr && p != nullptr) {
        char full[512];
        snprintf(full, sizeof(full), "A:%s", p);
        pthread_mutex_lock(&g_lv_mutex);
        lv_font_t *f = lv_font_load(full);
        if (f != nullptr && g_font_count < MAX_FONTS) {
            strncpy(g_fonts[g_font_count].name, n, sizeof(g_fonts[g_font_count].name) - 1);
            g_fonts[g_font_count].font = f;
            g_font_count++;
            ok = true;
        }
        pthread_mutex_unlock(&g_lv_mutex);
        LOGI("字体加载%s：%s（name=%s，已加载 %d 个）", ok ? "成功" : "失败", full, n, g_font_count);
    }
    if (n != nullptr) env->ReleaseStringUTFChars(name, n);
    if (p != nullptr) env->ReleaseStringUTFChars(path, p);
    return ok ? JNI_TRUE : JNI_FALSE;
}

/** 清空已加载字体（换主题时先调它，避免泄漏） */
JNIEXPORT void JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeClearFonts(JNIEnv *, jclass) {
    if (!g_inited) return;
    pthread_mutex_lock(&g_lv_mutex);
    free_fonts();
    pthread_mutex_unlock(&g_lv_mutex);
    LOGI("已释放全部主题字体");
}
JNIEXPORT jint JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeBuildElements(
        JNIEnv *env, jclass,
        jintArray types, jobjectArray pids, jobjectArray texts, jobjectArray fontAssets,
        jintArray colors, jintArray bgColors, jfloatArray metrics, jint background) {

    if (!g_inited || types == nullptr || metrics == nullptr) return -1;
    const int n = env->GetArrayLength(types);
    if (n <= 0) return 0;
    if (n > MAX_ELEMS) {
        LOGE("元素过多：%d（上限 %d）", n, MAX_ELEMS);
        return -1;
    }
    if (env->GetArrayLength(metrics) < n * 10) {
        LOGE("metrics 长度不足：需要 %d，实际 %d", n * 10, env->GetArrayLength(metrics));
        return -1;
    }

    jint *ty = env->GetIntArrayElements(types, nullptr);
    jint *co = env->GetIntArrayElements(colors, nullptr);
    jint *bc = env->GetIntArrayElements(bgColors, nullptr);
    jfloat *me = env->GetFloatArrayElements(metrics, nullptr);

    // 字符串落到 C 缓冲。**每个 jstring 用完立刻 DeleteLocalRef** ——
    // 局部引用表只有 512 个槽，元素一多（×2 个数组）就会撞上限。
    static char pid_buf[MAX_ELEMS][24];
    static char txt_buf[MAX_ELEMS][64];
    static char fa_buf[MAX_ELEMS][40];
    const char *pid_p[MAX_ELEMS];
    const char *txt_p[MAX_ELEMS];
    const char *fa_p[MAX_ELEMS];
    for (int i = 0; i < n; i++) {
        pid_buf[i][0] = '\0';
        txt_buf[i][0] = '\0';
        fa_buf[i][0] = '\0';

        jstring js = (jstring) env->GetObjectArrayElement(pids, i);
        if (js != nullptr) {
            const char *c = env->GetStringUTFChars(js, nullptr);
            if (c != nullptr) {
                strncpy(pid_buf[i], c, sizeof(pid_buf[i]) - 1);
                env->ReleaseStringUTFChars(js, c);
            }
            env->DeleteLocalRef(js);
        }
        js = (jstring) env->GetObjectArrayElement(texts, i);
        if (js != nullptr) {
            const char *c = env->GetStringUTFChars(js, nullptr);
            if (c != nullptr) {
                strncpy(txt_buf[i], c, sizeof(txt_buf[i]) - 1);
                env->ReleaseStringUTFChars(js, c);
            }
            env->DeleteLocalRef(js);
        }
        js = (jstring) env->GetObjectArrayElement(fontAssets, i);
        if (js != nullptr) {
            const char *c = env->GetStringUTFChars(js, nullptr);
            if (c != nullptr) {
                strncpy(fa_buf[i], c, sizeof(fa_buf[i]) - 1);
                env->ReleaseStringUTFChars(js, c);
            }
            env->DeleteLocalRef(js);
        }
        pid_p[i] = pid_buf[i];
        txt_p[i] = txt_buf[i];
        fa_p[i] = fa_buf[i];
    }

    pthread_mutex_lock(&g_lv_mutex);
    lv_obj_t *scr = lv_scr_act();
    if (scr != nullptr) lv_obj_clean(scr);
    // 重建时把另一条路（组合控件）的状态也清干净，避免两套绑定混在一起
    g_binding_count = 0;
    g_elem_count = 0;
    g_dot_host = g_dot = nullptr;
    g_grid_layer = nullptr;
    g_need_rebuild = false;
    build_elements_from_spec(n, ty, pid_p, txt_p, fa_p, co, bc, me, (int) background);
    const int built = g_elem_count;
    pthread_mutex_unlock(&g_lv_mutex);

    env->ReleaseIntArrayElements(types, ty, JNI_ABORT);
    env->ReleaseIntArrayElements(colors, co, JNI_ABORT);
    env->ReleaseIntArrayElements(bgColors, bc, JNI_ABORT);
    env->ReleaseFloatArrayElements(metrics, me, JNI_ABORT);

    LOGI("收到 Sky 元素列表：%d 个 → %d 条绑定", n, built);
    return built;
}

JNIEXPORT jint JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeBuildLayout(
        JNIEnv *env, jclass,
        jobjectArray pids, jobjectArray extras, jobjectArray units,
        jintArray styles, jintArray colors,
        jintArray ringStyles, jintArray ringSegs, jfloatArray metrics) {

    if (!g_inited || pids == nullptr) return -1;
    const int n = env->GetArrayLength(pids);
    if (n <= 0) return 0;
    if (n > 32) {
        LOGE("仪表数量过多：%d（上限 32）", n);
        return -1;
    }
    if (metrics == nullptr || env->GetArrayLength(metrics) < n * 6) {
        LOGE("metrics 长度不足：需要 %d", n * 6);
        return -1;
    }

    jint *st = env->GetIntArrayElements(styles, nullptr);
    jint *co = env->GetIntArrayElements(colors, nullptr);
    jint *rs = env->GetIntArrayElements(ringStyles, nullptr);
    jint *rg = env->GetIntArrayElements(ringSegs, nullptr);
    jfloat *me = env->GetFloatArrayElements(metrics, nullptr);

    // 字符串落到 C 缓冲。**每个 jstring 用完立刻 DeleteLocalRef** ——
    // 局部引用表只有 512 个槽，仪表一多（×3 个数组）就会撞上限。
    char pid_buf[32][24], extra_buf[32][80], unit_buf[32][16];
    const char *pid_p[32], *extra_p[32], *unit_p[32];
    for (int i = 0; i < n; i++) {
        pid_buf[i][0] = extra_buf[i][0] = unit_buf[i][0] = '\0';

        jstring js = (jstring) env->GetObjectArrayElement(pids, i);
        if (js != nullptr) {
            const char *c = env->GetStringUTFChars(js, nullptr);
            if (c != nullptr) {
                strncpy(pid_buf[i], c, sizeof(pid_buf[i]) - 1);
                env->ReleaseStringUTFChars(js, c);
            }
            env->DeleteLocalRef(js);
        }
        if (extras != nullptr) {
            js = (jstring) env->GetObjectArrayElement(extras, i);
            if (js != nullptr) {
                const char *c = env->GetStringUTFChars(js, nullptr);
                if (c != nullptr) {
                    strncpy(extra_buf[i], c, sizeof(extra_buf[i]) - 1);
                    env->ReleaseStringUTFChars(js, c);
                }
                env->DeleteLocalRef(js);
            }
        }
        if (units != nullptr) {
            js = (jstring) env->GetObjectArrayElement(units, i);
            if (js != nullptr) {
                const char *c = env->GetStringUTFChars(js, nullptr);
                if (c != nullptr) {
                    strncpy(unit_buf[i], c, sizeof(unit_buf[i]) - 1);
                    env->ReleaseStringUTFChars(js, c);
                }
                env->DeleteLocalRef(js);
            }
        }
        pid_p[i] = pid_buf[i];
        extra_p[i] = extra_buf[i];
        unit_p[i] = unit_buf[i];
    }

    // **持锁重建**：LVGL 对象树只能在渲染线程上动 —— 但这里由 JNI 线程持锁重建也是安全的，
    // 因为渲染线程的 lv_timer_handler() 同样在这把锁里，两者不会重叠。
    pthread_mutex_lock(&g_lv_mutex);
    lv_obj_t *scr = lv_scr_act();
    if (scr != nullptr) lv_obj_clean(scr);
    g_binding_count = 0;
    g_dot_host = g_dot = nullptr;
    g_need_rebuild = false;   // 见下方注释：刚重建过，别让渲染线程再清一遍
    build_from_spec(n, pid_p, extra_p, unit_p, st, co, rs, rg, me);
    const int built = g_binding_count;
    pthread_mutex_unlock(&g_lv_mutex);

    env->ReleaseIntArrayElements(styles, st, JNI_ABORT);
    env->ReleaseIntArrayElements(colors, co, JNI_ABORT);
    env->ReleaseIntArrayElements(ringStyles, rs, JNI_ABORT);
    env->ReleaseIntArrayElements(ringSegs, rg, JNI_ABORT);
    env->ReleaseFloatArrayElements(metrics, me, JNI_ABORT);

    LOGI("收到布局：%d 块仪表 → %d 条绑定", n, built);
    return built;
}

JNIEXPORT void JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeApplyTheme(
        JNIEnv *, jclass,
        jint background, jint surface, jint surfaceEdge,
        jint accent, jint accentBright, jint accentDim,
        jint track, jint tick, jint valueText, jint labelText,
        jfloat cardRadiusDp, jfloat cardStrokeDp, jfloat strokeDp, jfloat needleRatio) {

    pthread_mutex_lock(&g_lv_mutex);
    g_theme.background = (uint32_t) background & 0xFFFFFFu;
    g_theme.surface = (uint32_t) surface & 0xFFFFFFu;
    g_theme.surface_edge = (uint32_t) surfaceEdge & 0xFFFFFFu;
    g_theme.accent = (uint32_t) accent & 0xFFFFFFu;
    g_theme.accent_bright = (uint32_t) accentBright & 0xFFFFFFu;
    g_theme.accent_dim = (uint32_t) accentDim & 0xFFFFFFu;
    g_theme.track = (uint32_t) track & 0xFFFFFFu;
    g_theme.tick = (uint32_t) tick & 0xFFFFFFu;
    g_theme.value_text = (uint32_t) valueText & 0xFFFFFFu;
    g_theme.label_text = (uint32_t) labelText & 0xFFFFFFu;

    g_theme.card_radius = (int) (cardRadiusDp + 0.5f);
    // 0 = 无边框（「无边框主题」就是靠这个）
    g_theme.card_stroke = (cardStrokeDp >= 0.5f) ? (int) (cardStrokeDp + 0.5f) : 0;
    g_theme.stroke = (int) (strokeDp + 0.5f);
    if (g_theme.stroke < 1) g_theme.stroke = 1;
    g_theme.needle_ratio = needleRatio;
    g_theme.applied_count++;
    const uint32_t n = g_theme.applied_count;
    pthread_mutex_unlock(&g_lv_mutex);

    LOGI("主题已应用 #%u bg=%06X surface=%06X edge=%06X accent=%06X/%06X/%06X "
         "stroke=%d radius=%d border=%d needle=%.2f",
         (unsigned) n,
         (unsigned) g_theme.background, (unsigned) g_theme.surface,
         (unsigned) g_theme.surface_edge,
         (unsigned) g_theme.accent, (unsigned) g_theme.accent_bright,
         (unsigned) g_theme.accent_dim,
         g_theme.stroke, g_theme.card_radius, g_theme.card_stroke,
         g_theme.needle_ratio);

    // **不在这里重建** —— 交给渲染线程（见 g_lv_mutex）。
    // 从 JNI 线程直接 lv_obj_clean() 会与渲染线程抢对象树，实测会 native crash。
    if (g_inited) g_need_rebuild = true;
}

/**
 * 推一个值给对应仪表。
 *
 * 这里刻意用**字符串 pidId** 而不是控件指针 —— 将来换成按配置动态建表时，
 * Kotlin 侧不需要知道控件是怎么组织的。
 */
JNIEXPORT void JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeSetValue(JNIEnv *env, jclass,
                                                    jstring pidId, jfloat value) {
    if (!g_inited || pidId == nullptr) return;
    const char *id = env->GetStringUTFChars(pidId, nullptr);
    if (id == nullptr) return;

    // **只排队，不直接动控件** —— LVGL 的对象树只能在渲染线程上改（见 g_lv_mutex）。
    // 同一条 PID 复用同一个槽位，所以 10Hz 高频推送也不会把队列撑满。
    pthread_mutex_lock(&g_lv_mutex);
    int slot = -1;
    for (int i = 0; i < PENDING_SLOTS; i++) {
        if (g_pending[i].used && strcmp(g_pending[i].id, id) == 0) { slot = i; break; }
    }
    if (slot < 0) {
        for (int i = 0; i < PENDING_SLOTS; i++) {
            if (!g_pending[i].used) { slot = i; break; }
        }
    }
    if (slot >= 0) {
        strncpy(g_pending[slot].id, id, sizeof(g_pending[slot].id) - 1);
        g_pending[slot].id[sizeof(g_pending[slot].id) - 1] = '\0';
        g_pending[slot].value = value;
        g_pending[slot].used = true;
    }
    pthread_mutex_unlock(&g_lv_mutex);

    env->ReleaseStringUTFChars(pidId, id);
}

/**
 * 读回上一帧某点的颜色（**LVGL 序 0xAARRGGBB**）。
 *
 * 这是自动化验证的唯一抓手：看不了图，但可以断言
 * 「指针扫过位置的像素等于主题强调色」。
 */
JNIEXPORT jint JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeProbePixel(JNIEnv *, jclass, jint x, jint y) {
    if (g_buf == nullptr || x < 0 || y < 0 || x >= g_width || y >= g_height) return 0;
    const uint32_t p = ((uint32_t *) g_buf)[(size_t) y * g_width + x];
    // 内存序 B,G,R,A → 0xAARRGGBB，正好就是 LVGL 语义下的 ARGB
    const uint32_t b = p & 0xFFu, g = (p >> 8) & 0xFFu, r = (p >> 16) & 0xFFu, a = (p >> 24) & 0xFFu;
    return (jint) ((a << 24) | (r << 16) | (g << 8) | b);
}

/**
 * 把整屏粗采样成 8×6 个颜色，返回**文字版截图**。
 *
 * 自动化验证看不了图，这个比「非背景像素占比」有用得多：
 * 一眼能看出画面上到底有什么、各块在哪。
 */
JNIEXPORT jstring JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeProbeGrid(JNIEnv *env, jclass) {
    char buf[1024];
    int pos = 0;
    const int nx = 8, ny = 6;
    if (g_buf == nullptr) return env->NewStringUTF("(no-buf)");

    pthread_mutex_lock(&g_lv_mutex);
    // 直接写 logcat，**不走 AppLog** —— AppLog 有去重/限流/批量落盘，
    // 排查阶段被它吞掉一行会白白绕一大圈。
    LOGI("---- 画面 %dx%d (8x6 粗采样) ----", g_width, g_height);
    for (int j = 0; j < ny; j++) {
        char row[256];
        int rp = 0;
        for (int i = 0; i < nx; i++) {
            const int x = (g_width * (2 * i + 1)) / (2 * nx);
            const int y = (g_height * (2 * j + 1)) / (2 * ny);
            const uint32_t p = ((uint32_t *) g_buf)[(size_t) y * g_width + x] & 0x00FFFFFFu;
            rp += snprintf(row + rp, sizeof(row) - (size_t) rp, "%06X ", (unsigned) p);
            pos += snprintf(buf + pos, sizeof(buf) - (size_t) pos, "%06X ", (unsigned) p);
        }
        LOGI("  %s", row);
        pos += snprintf(buf + pos, sizeof(buf) - (size_t) pos, "\n");
    }

    // 亮像素统计：文字/高亮都会落在这里。8x6 粗采样太稀疏，可能整片漏掉文字
    {
        int bright = 0, total2 = 0;
        for (int y = 0; y < g_height; y += 4) {
            for (int x = 0; x < g_width; x += 4) {
                total2++;
                const uint32_t p = ((uint32_t *) g_buf)[(size_t) y * g_width + x];
                const int r = (int) ((p >> 16) & 0xFF), g2 = (int) ((p >> 8) & 0xFF), b = (int) (p & 0xFF);
                if (r > 150 && g2 > 150 && b > 150) bright++;
            }
        }
        LOGI("  亮像素（可能是文字）= %d / %d（%.2f%%）", bright, total2,
             total2 > 0 ? (bright * 100.0 / total2) : 0.0);
    }
    // 绑定表摘要：哪条 PID、什么类型、绑到几个控件
    for (int i = 0; i < g_binding_count && i < 12; i++) {
        LOGI("  bind[%d] pid=%s kind=%d widget=%p label=%p",
             i, g_bindings[i].pid, g_bindings[i].kind,
             (void *) g_bindings[i].widget, (void *) g_bindings[i].label);
    }
    LOGI("  绑定总数=%d", g_binding_count);
    pthread_mutex_unlock(&g_lv_mutex);
    return env->NewStringUTF(buf);
}

/**
 * 读回屏幕背景色（LVGL 序 0xRRGGBB）。
 *
 * 用来验证「主题 → LVGL」这条路：Kotlin 把主题的 `background` 传进来，
 * 这里读回实际渲染出来的屏幕底色，两者相等就说明映射生效了。
 */
/**
 * 数一数画面里有多少像素接近给定颜色（容差 24/通道，按 8 像素步长采样）。
 *
 * 这是**比「读左上角像素当背景色」可靠得多**的主题判据：
 * 卡片会盖住 (0,0)，但主题的强调色一定会出现在指针/弧/条上。
 * NEON 强调色 FF8A00、ICE 是 28D7FF，两者相差极大，不会误判。
 */
JNIEXPORT jint JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeCountColor(JNIEnv *, jclass, jint rgb) {
    if (g_buf == nullptr) return -1;
    const uint32_t want = (uint32_t) rgb & 0x00FFFFFFu;
    const int wr = (int) ((want >> 16) & 0xFFu);
    const int wg = (int) ((want >> 8) & 0xFFu);
    const int wb = (int) (want & 0xFFu);
    int hits = 0;
    pthread_mutex_lock(&g_lv_mutex);
    for (int y = 0; y < g_height; y += 4) {
        for (int x = 0; x < g_width; x += 4) {
            const uint32_t p = ((uint32_t *) g_buf)[(size_t) y * g_width + x] & 0x00FFFFFFu;
            const int dr = (int) ((p >> 16) & 0xFFu) - wr;
            const int dg = (int) ((p >> 8) & 0xFFu) - wg;
            const int db = (int) (p & 0xFFu) - wb;
            if (dr > -24 && dr < 24 && dg > -24 && dg < 24 && db > -24 && db < 24) hits++;
        }
    }
    pthread_mutex_unlock(&g_lv_mutex);
    return hits;
}
JNIEXPORT jint JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeProbeScreenBg(JNIEnv *, jclass) {
    if (g_buf == nullptr) return -1;
    pthread_mutex_lock(&g_lv_mutex);
    const jint bg = (jint) (((uint32_t *) g_buf)[0] & 0x00FFFFFFu);
    pthread_mutex_unlock(&g_lv_mutex);
    return bg;
}

/**
 * 整屏内容哈希。用来判断「画面有没有变」—— 8×6 粗采样太稀疏，
 * 指针只动一点它可能看不出来；这个扫全屏，变化一定检测得到。
 */
JNIEXPORT jint JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeProbeHash(JNIEnv *, jclass) {
    if (g_buf == nullptr) return 0;
    pthread_mutex_lock(&g_lv_mutex);
    uint32_t h = 2166136261u;   // FNV-1a
    const size_t n = (size_t) g_width * g_height;
    for (size_t i = 0; i < n; i += 7) {
        h = (h ^ ((uint32_t *) g_buf)[i]) * 16777619u;
    }
    pthread_mutex_unlock(&g_lv_mutex);
    return (jint) h;
}

/**
 * 诊断字符串：inited / 尺寸 / 控件数 / FPS / 画面墨量。
 *
 * `ink` 是**非背景色像素的采样占比（千分比）** —— 左上角像素当作背景色。
 * 这是看不了图时判断「LVGL 到底有没有画东西」最直接的办法：
 * 全是 0 说明只画了背景（控件没建出来或没刷新），几百说明控件画上了。
 */
JNIEXPORT jstring JNICALL
Java_com_icar_obd_ui_lvgl_LvglBridge_nativeSelfTest(JNIEnv *env, jclass) {
    uint32_t bg = 0;
    int non_bg = 0;
    int total = 0;
    pthread_mutex_lock(&g_lv_mutex);
    if (g_buf != nullptr) {
        bg = ((uint32_t *) g_buf)[0] & 0x00FFFFFFu;
        for (int y = 0; y < g_height; y += 8) {
            for (int x = 0; x < g_width; x += 8) {
                total++;
                const uint32_t p = ((uint32_t *) g_buf)[(size_t) y * g_width + x] & 0x00FFFFFFu;
                if (p != bg) non_bg++;
            }
        }
    }
    const int ink_pm = total > 0 ? (non_bg * 1000 / total) : 0;
    pthread_mutex_unlock(&g_lv_mutex);

    // LVGL 的内存池用量 —— 池子太小会导致控件创建静默失败（返回 NULL），
    // 现象就是「什么都没画」但也不报错，非常难查。所以把用量一并报出来。
    lv_mem_monitor_t mon;
    lv_mem_monitor(&mon);

    char buf[420];
    // ⚠️ 墨量一定要打成百分比。早先打成 "ink=593/46610"（千分比 / 采样数），
    // 被自己误读成「593 个像素」→ 一度以为画面是空的，白查了一轮。
    snprintf(buf, sizeof(buf),
             "inited=%d size=%dx%d gaugeBind=%d elemBind=%d fps=%d bg=%06X ink=%d.%d%% samples=%d "
             "mem=%uKB free=%uKB frag=%u%%",
             g_inited ? 1 : 0, g_width, g_height,
             g_binding_count, g_elem_count,
             (int) g_fps, (unsigned) bg, ink_pm / 10, ink_pm % 10, total,
             (unsigned) (mon.total_size / 1024), (unsigned) (mon.free_size / 1024),
             (unsigned) mon.frag_pct);
    return env->NewStringUTF(buf);
}

}  // extern "C"
