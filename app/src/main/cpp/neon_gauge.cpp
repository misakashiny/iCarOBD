#include "neon_gauge.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

// =============================================================================
// 参考设计常量（来自 evilgenius79/Esp32-gauge 的 gauge_render.cpp）
// =============================================================================

// 扫弧：225° 起、270° 扫（7:30 → 4:30）。角度以「0° = 12 点、顺时针」为基准
static constexpr float ARC_START_REF = 225.0f;
static constexpr float ARC_SWEEP_REF = 270.0f;

// 10 层辉光
static constexpr int BLOOM_STEPS = 10;

// 指针：5 层渐细（宽度系数 × scale，越宽越暗）
static constexpr float NEEDLE_W[5] = {9.0f, 7.0f, 5.0f, 3.5f, 2.5f};

// 半径系数表（240px 基准的一半 = 120）
struct NeonLayout {
    int cx, cy;
    float scale;
    int bloom;
    int rOuter, rTickOut, rTickMaj, rTickMin, rLabel, rNeedle, rTail;
    int rRingOut, rRingIn, rSweepOut, rSweepIn;
};

static NeonLayout layout_of(int w, int h) {
    NeonLayout L;
    const int side = w < h ? w : h;
    const int radius = side / 2;
    const float s = (float) radius / 120.0f;

    L.cx = w / 2;
    L.cy = h / 2;
    L.scale = s;

    L.rOuter = (int) (117 * s);
    L.rTickOut = (int) (113 * s);
    L.rTickMaj = (int) (100 * s);
    L.rTickMin = (int) (106 * s);
    L.rLabel = (int) (85 * s);
    L.rNeedle = (int) (97 * s);
    L.rTail = (int) (15 * s);
    L.rRingOut = (int) (30 * s);
    L.rRingIn = (int) (20 * s);
    L.rSweepOut = (int) (116 * s);
    L.rSweepIn = (int) (108 * s);

    int bw = (int) (10 * s);
    if (bw < 6) bw = 6;
    L.bloom = bw;
    return L;
}

// =============================================================================
// 控件状态
// =============================================================================

struct NeonState {
    NeonGaugeConfig cfg;
    float value;
    lv_obj_t *lbl_value;
    lv_obj_t *lbl_unit;
};

static NeonState *state_of(lv_obj_t *o) {
    return (NeonState *) lv_obj_get_user_data(o);
}

static void on_delete(lv_event_t *e) {
    NeonState *st = state_of(lv_event_get_target(e));
    if (st != nullptr) free(st);
}

// =============================================================================
// 颜色工具
// =============================================================================

/**
 * 第 `step` 层辉光的颜色（0 = 最暗，BLOOM_STEPS-1 = 最亮）。
 *
 * **从主题 accent 派生**，不是写死的红/橙/黄 ——
 * 参考实现把颜色写死了，换个主题必然串色。
 */
static lv_color_t bloom_color(int step, lv_color_t base) {
    const float t = (float) step / (float) (BLOOM_STEPS - 1);
    // 0.07 → 1.0：最外层保留一点底色，不是纯黑
    const float k = 0.07f + 0.93f * t;
    return lv_color_mix(base, lv_color_black(), (uint8_t) ((1.0f - k) * 255.0f));
}

/** 向白色靠拢，用于「热芯」 */
static lv_color_t brighten(lv_color_t c, float k) {
    return lv_color_mix(lv_color_white(), c, (uint8_t) ((1.0f - k) * 255.0f));
}

// =============================================================================
// 绘制原语
// =============================================================================

/** 角度换算：参考用「0° = 12 点」，LVGL 用「0° = 3 点」 */
static inline int ref_to_lvgl(float ref_deg) {
    int a = (int) (ref_deg + 270.0f) % 360;
    if (a < 0) a += 360;
    return a;
}

/** 画一段圆环。LVGL 的 arc 是「从 radius 向内 width」 */
static void draw_ring(lv_draw_ctx_t *ctx, int cx, int cy,
                      int r_out, int r_in, int start, int end,
                      lv_color_t color, lv_opa_t opa) {
    if (r_in >= r_out || r_out <= 0 || start == end) return;
    lv_draw_arc_dsc_t d;
    lv_draw_arc_dsc_init(&d);
    d.color = color;
    d.width = (uint16_t) (r_out - r_in);
    d.opa = opa;
    d.rounded = 0;
    lv_point_t c = {(lv_coord_t) cx, (lv_coord_t) cy};
    lv_draw_arc(ctx, &d, &c, (uint16_t) r_out, (uint16_t) start, (uint16_t) end);
}

/** 画一段可能跨 360° 的弧（LVGL 不处理 start > end，要拆两段） */
static void draw_span(lv_draw_ctx_t *ctx, int cx, int cy,
                      int r_out, int r_in, int start, int span,
                      lv_color_t color, lv_opa_t opa) {
    if (span <= 0) return;
    if (span > 360) span = 360;
    const int end = start + span;
    if (end <= 360) {
        draw_ring(ctx, cx, cy, r_out, r_in, start, end, color, opa);
    } else {
        draw_ring(ctx, cx, cy, r_out, r_in, start, 360, color, opa);
        draw_ring(ctx, cx, cy, r_out, r_in, 0, end - 360, color, opa);
    }
}

static void draw_line(lv_draw_ctx_t *ctx, int x1, int y1, int x2, int y2,
                      int width, lv_color_t color, lv_opa_t opa) {
    if (width < 1) width = 1;
    lv_draw_line_dsc_t d;
    lv_draw_line_dsc_init(&d);
    d.color = color;
    d.width = (uint16_t) width;
    d.opa = opa;
    d.round_start = 0;
    d.round_end = 0;
    lv_point_t p1 = {(lv_coord_t) x1, (lv_coord_t) y1};
    lv_point_t p2 = {(lv_coord_t) x2, (lv_coord_t) y2};
    lv_draw_line(ctx, &d, &p1, &p2);
}

/** 极坐标取点：0° = 12 点，顺时针 */
static inline float px_of(int cx, int r, float deg) {
    return (float) cx + (float) r * sinf(deg * (float) M_PI / 180.0f);
}
static inline float py_of(int cy, int r, float deg) {
    return (float) cy - (float) r * cosf(deg * (float) M_PI / 180.0f);
}

// =============================================================================
// 表盘各层
// =============================================================================

/** 表盘：外圈、刻度、（可选）最外圈指针环 */
static void draw_face(lv_draw_ctx_t *ctx, const NeonLayout &L,
                      const NeonState &st, lv_color_t tick_c, lv_color_t danger_c) {
    const int cx = L.cx, cy = L.cy;
    const NeonGaugeConfig &cfg = st.cfg;

    // 外圈淡环
    draw_ring(ctx, cx, cy, L.rOuter, L.rOuter - (L.scale > 1 ? 2 : 1),
              0, 360, lv_color_hex(cfg.track), LV_OPA_60);

    const float range = cfg.max - cfg.min;
    if (range <= 0) return;
    const float danger_frac = (cfg.danger > cfg.min) ? (cfg.danger - cfg.min) / range : 2.0f;
    const int tick_w = L.scale > 1.0f ? (int) L.scale : 1;

    // 小刻度：每大格 5 条
    const int minor = 40;
    for (int i = 0; i <= minor; i++) {
        const float frac = (float) i / (float) minor;
        const float deg = ARC_START_REF + ARC_SWEEP_REF * frac;
        const lv_color_t c = (frac >= danger_frac) ? danger_c : lv_color_hex(cfg.tick);
        draw_line(ctx,
                  (int) px_of(cx, L.rTickOut, deg), (int) py_of(cy, L.rTickOut, deg),
                  (int) px_of(cx, L.rTickMin, deg), (int) py_of(cy, L.rTickMin, deg),
                  tick_w, c, LV_OPA_COVER);
    }

    // 大刻度：8 格
    const int major = 8;
    for (int i = 0; i <= major; i++) {
        const float frac = (float) i / (float) major;
        const float deg = ARC_START_REF + ARC_SWEEP_REF * frac;
        const lv_color_t c = (frac >= danger_frac) ? danger_c : lv_color_hex(cfg.text);
        draw_line(ctx,
                  (int) px_of(cx, L.rTickOut, deg), (int) py_of(cy, L.rTickOut, deg),
                  (int) px_of(cx, L.rTickMaj, deg), (int) py_of(cy, L.rTickMaj, deg),
                  tick_w + 1, c, LV_OPA_COVER);
    }

    // 指针环：**最外圈一圈均匀刻度线段**（Android 版的 RING_TICK 同款）
    if (cfg.ring_segments > 2) {
        const int n = cfg.ring_segments;
        for (int i = 0; i < n; i++) {
            const float deg = 360.0f * (float) i / (float) n;
            draw_line(ctx,
                      (int) px_of(cx, L.rOuter, deg), (int) py_of(cy, L.rOuter, deg),
                      (int) px_of(cx, L.rOuter - 6, deg), (int) py_of(cy, L.rOuter - 6, deg),
                      tick_w, lv_color_hex(cfg.accent), LV_OPA_50);
        }
    }
}

/** 扫弧：10 层辉光 + 热芯 */
static void draw_sweep(lv_draw_ctx_t *ctx, const NeonLayout &L,
                       const NeonState &st) {
    const NeonGaugeConfig &cfg = st.cfg;
    const float range = cfg.max - cfg.min;
    if (range <= 0) return;

    float frac = (st.value - cfg.min) / range;
    if (frac <= 0.0f) return;
    if (frac > 1.0f) frac = 1.0f;

    const int start = ref_to_lvgl(ARC_START_REF);
    const int span = (int) (ARC_SWEEP_REF * frac);
    const lv_color_t base = lv_color_hex(cfg.accent);

    // 10 层：越靠内越亮（offset 从 bloom 递减到 0）
    for (int i = 0; i < BLOOM_STEPS; i++) {
        const float t = (float) i / (float) (BLOOM_STEPS - 1);
        const int offset = L.bloom - (int) (t * (float) L.bloom);
        const int r_out = L.rSweepOut + offset;
        int r_in = L.rSweepIn - offset;
        if (r_in < 1) r_in = 1;
        draw_span(ctx, L.cx, L.cy, r_out, r_in, start, span,
                  bloom_color(i, base), LV_OPA_COVER);
    }

    // 热芯：提亮两层
    draw_span(ctx, L.cx, L.cy, L.rSweepOut - 1, L.rSweepIn + 1, start, span,
              brighten(base, 0.55f), LV_OPA_COVER);
    int inset = (int) (3 * L.scale);
    if (inset < 2) inset = 2;
    draw_span(ctx, L.cx, L.cy, L.rSweepOut - inset, L.rSweepIn + inset, start, span,
              brighten(base, 0.85f), LV_OPA_COVER);
}

/** 指针：5 层渐细 + 亮芯 */
static void draw_needle(lv_draw_ctx_t *ctx, const NeonLayout &L,
                        const NeonState &st) {
    const NeonGaugeConfig &cfg = st.cfg;
    const float range = cfg.max - cfg.min;
    if (range <= 0) return;

    float frac = (st.value - cfg.min) / range;
    if (frac < 0.0f) frac = 0.0f;
    if (frac > 1.0f) frac = 1.0f;

    const float deg = ARC_START_REF + ARC_SWEEP_REF * frac;
    const lv_color_t base = lv_color_hex(cfg.accent);
    const int cx = L.cx, cy = L.cy;

    // 尾巴 + 尖端
    const int tip_x = (int) px_of(cx, L.rNeedle, deg);
    const int tip_y = (int) py_of(cy, L.rNeedle, deg);
    const int tail_x = (int) px_of(cx, L.rTail, deg + 180.0f);
    const int tail_y = (int) py_of(cy, L.rTail, deg + 180.0f);

    for (int i = 0; i < 5; i++) {
        int w = (int) (NEEDLE_W[i] * L.scale);
        if (w < 1) w = 1;
        // 越宽越暗：i=0 最暗最宽，i=4 是主体
        const lv_color_t c = (i == 4) ? brighten(base, 0.35f) : bloom_color(i + 1, base);
        draw_line(ctx, cx, cy, tip_x, tip_y, w, c, LV_OPA_COVER);
        draw_line(ctx, cx, cy, tail_x, tail_y, w, c, LV_OPA_COVER);
    }

    // 亮芯
    draw_line(ctx, cx, cy, tip_x, tip_y, 1, brighten(base, 0.9f), LV_OPA_COVER);
}

/** 中心环：10 层辉光 + 主环 + 高光 + 暗心 + 心点 */
static void draw_center(lv_draw_ctx_t *ctx, const NeonLayout &L,
                        const NeonState &st) {
    const lv_color_t base = lv_color_hex(st.cfg.accent);
    const int cx = L.cx, cy = L.cy;

    int bw = (int) (8 * L.scale);
    if (bw < 4) bw = 4;

    for (int i = 0; i < BLOOM_STEPS; i++) {
        const float t = (float) i / (float) (BLOOM_STEPS - 1);
        const int offset = bw - (int) (t * (float) bw);
        const int r_out = L.rRingOut + offset;
        int r_in = L.rRingIn - offset;
        if (r_in < 1) r_in = 1;
        draw_ring(ctx, cx, cy, r_out, r_in, 0, 360, bloom_color(i, base), LV_OPA_COVER);
    }

    draw_ring(ctx, cx, cy, L.rRingOut, L.rRingIn, 0, 360, brighten(base, 0.3f), LV_OPA_COVER);

    int inset = (int) (2 * L.scale);
    if (inset < 1) inset = 1;
    draw_ring(ctx, cx, cy, L.rRingOut - inset, L.rRingIn + inset, 0, 360,
              brighten(base, 0.8f), LV_OPA_COVER);

    // 暗心（盖住内圈）+ 心点
    draw_ring(ctx, cx, cy, L.rRingIn - 1, 0, 0, 360, lv_color_black(), LV_OPA_COVER);
    int dot = (int) (4 * L.scale);
    if (dot < 3) dot = 3;
    draw_ring(ctx, cx, cy, dot, 0, 0, 360, brighten(base, 0.4f), LV_OPA_COVER);
}

// =============================================================================
// 绘制入口
// =============================================================================

static void gauge_draw_cb(lv_event_t *e) {
    if (lv_event_get_code(e) != LV_EVENT_DRAW_MAIN) return;

    lv_obj_t *obj = lv_event_get_target(e);
    NeonState *st = state_of(obj);
    if (st == nullptr) return;

    lv_draw_ctx_t *ctx = lv_event_get_draw_ctx(e);
    if (ctx == nullptr) return;

    lv_area_t coords;
    lv_obj_get_coords(obj, &coords);
    const int w = lv_area_get_width(&coords);
    const int h = lv_area_get_height(&coords);

    NeonLayout L = layout_of(w, h);
    // 布局是相对控件左上角的，画的时候要挪到绝对坐标
    const int ox = coords.x1, oy = coords.y1;
    L.cx += ox;
    L.cy += oy;

    draw_face(ctx, L, *st, lv_color_hex(st->cfg.tick), lv_color_hex(0xFF3030));
    draw_sweep(ctx, L, *st);
    draw_needle(ctx, L, *st);
    draw_center(ctx, L, *st);
}

// =============================================================================
// 对外接口
// =============================================================================

lv_obj_t *neon_gauge_create(lv_obj_t *parent, const NeonGaugeConfig *cfg) {
    if (parent == nullptr || cfg == nullptr) return nullptr;

    lv_obj_t *obj = lv_obj_create(parent);
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(obj, LV_RADIUS_CIRCLE, LV_PART_MAIN);

    NeonState *st = (NeonState *) calloc(1, sizeof(NeonState));
    if (st == nullptr) {
        lv_obj_del(obj);
        return nullptr;
    }
    st->cfg = *cfg;
    st->value = cfg->min;
    lv_obj_set_user_data(obj, st);
    lv_obj_add_event_cb(obj, gauge_draw_cb, LV_EVENT_DRAW_MAIN, nullptr);
    lv_obj_add_event_cb(obj, on_delete, LV_EVENT_DELETE, nullptr);

    // 数值（大号，居中偏上）
    st->lbl_value = lv_label_create(obj);
    lv_label_set_text(st->lbl_value, "--");
    lv_obj_set_style_text_color(st->lbl_value, lv_color_hex(cfg->text), 0);
    lv_obj_set_style_text_font(st->lbl_value, &lv_font_montserrat_28, 0);
    lv_obj_align(st->lbl_value, LV_ALIGN_CENTER, 0, -10);

    // 单位（小号，数值下方）
    if (cfg->unit != nullptr && cfg->unit[0] != '\0') {
        st->lbl_unit = lv_label_create(obj);
        lv_label_set_text(st->lbl_unit, cfg->unit);
        lv_obj_set_style_text_color(st->lbl_unit, lv_color_hex(cfg->label), 0);
        lv_obj_set_style_text_font(st->lbl_unit, &lv_font_montserrat_14, 0);
        lv_obj_align(st->lbl_unit, LV_ALIGN_CENTER, 0, 20);
    }

    return obj;
}

void neon_gauge_set_value(lv_obj_t *obj, float value) {
    NeonState *st = state_of(obj);
    if (st == nullptr) return;
    if (value == st->value) return;
    st->value = value;

    if (st->lbl_value != nullptr) {
        char buf[24];
        if (st->cfg.decimals <= 0) {
            snprintf(buf, sizeof(buf), "%.0f", value);
        } else {
            snprintf(buf, sizeof(buf), "%.*f", st->cfg.decimals, value);
        }
        lv_label_set_text(st->lbl_value, buf);
    }
    lv_obj_invalidate(obj);
}

void neon_gauge_set_accent(lv_obj_t *obj, uint32_t accent) {
    NeonState *st = state_of(obj);
    if (st == nullptr) return;
    st->cfg.accent = accent;
    lv_obj_invalidate(obj);
}

// TODO(下一轮)：刻度数字。参考实现会在每个大刻度位置画数值，
// 这里暂缺 —— 需要为每个大刻度建 label 子对象（8 块表 × 9 个 ≈ 72 个对象），
// 先确认霓虹外观与帧率都满意，再决定要不要加。
