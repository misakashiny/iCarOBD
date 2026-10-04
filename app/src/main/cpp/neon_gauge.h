/**
 * iCarOBD · 霓虹圆表（LVGL 自定义绘制）
 *
 * ## 为什么不用 `lv_meter`
 *
 * 设计参考 `evilgenius79/Esp32-gauge` 的霓虹表盘 —— 它的核心是
 * **10 层渐变辉光**：扫弧、指针、中心环各叠 10 层，从近黑递进到高亮，
 * 再加橙/黄两层热芯。
 *
 * `lv_meter` 的每个指示器**只能有一个颜色**，做不出分层叠加。
 * 所以这里挂 `LV_EVENT_DRAW_MAIN`，用 `lv_draw_arc()` / `lv_draw_line()`
 * 自己把 10 层画出来。
 *
 * ## 与参考实现的差异（刻意的）
 *
 * 1. **配色从主题 accent 派生**，不照抄它的红/橙/黄。
 *    参考实现把颜色写死了，换主题必然串色。
 * 2. **角度换算了**：参考用「0° = 12 点」，LVGL 用「0° = 3 点」，
 *    所以 `lvgl = (ref + 270) % 360`。扫弧 225° 起、270° 扫（7:30 → 4:30）。
 * 3. **指针用 5 层渐细的线**而不是三角形 —— 视觉接近，代码简单得多。
 * 4. **暂不画刻度数字**（参考实现会画）。见文件末尾 TODO。
 */
#ifndef ICAROBD_NEON_GAUGE_H
#define ICAROBD_NEON_GAUGE_H

#include "lvgl.h"

/** 一块霓虹表的配置。全部由调用方给，控件本身不认识「主题」这个概念 */
typedef struct {
    float min;
    float max;
    /** 危险区起始值；<= min 表示不设危险区 */
    float danger;
    /** 强调色 0xRRGGBB —— 辉光全部由它派生 */
    uint32_t accent;
    /** 轨道（底弧）色 */
    uint32_t track;
    /** 刻度色 */
    uint32_t tick;
    /** 数值字色 */
    uint32_t text;
    /** 单位/标签字色 */
    uint32_t label;
    /** 指针环段数：>0 时在**最外圈**画一圈均匀刻度线段 */
    int ring_segments;
    /** 单位文本，可为 NULL */
    const char *unit;
    /** 小数位：0 = 整数 */
    int decimals;
} NeonGaugeConfig;

/** 建一块霓虹表。返回的对象可直接用 `lv_obj_del` 删除 */
lv_obj_t *neon_gauge_create(lv_obj_t *parent, const NeonGaugeConfig *cfg);

/** 推值。会重绘指针/弧/数值 */
void neon_gauge_set_value(lv_obj_t *obj, float value);

/** 改强调色（换主题时用） */
void neon_gauge_set_accent(lv_obj_t *obj, uint32_t accent);

#endif  // ICAROBD_NEON_GAUGE_H
