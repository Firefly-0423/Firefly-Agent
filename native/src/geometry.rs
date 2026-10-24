//! 截图覆盖层用到的纯几何计算：裁剪、拖拽手柄、旋转换算、工具栏摆放，以及标注列表。

/// 整数矩形：左上角加宽高。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RectI {
    /// 左上角横坐标
    pub x: i32,
    /// 左上角纵坐标
    pub y: i32,
    /// 宽度
    pub width: u32,
    /// 高度
    pub height: u32,
}

/// 整数坐标点。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PointI {
    pub x: i32,
    pub y: i32,
}

/// 选区边框上的八个缩放手柄。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectionHandle {
    // 四个角
    TopLeft,
    TopRight,
    BottomRight,
    BottomLeft,
    // 四条边的中点
    Top,
    Right,
    Bottom,
    Left,
}

/// 标注可选的颜色。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnnotationColor {
    Red,
    Yellow,
    Green,
    Blue,
}

/// 标注工具。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnnotationTool {
    Rectangle,
    Arrow,
}

/// 一个已画出的标记：由起止两点与颜色决定。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mark {
    /// 矩形框
    Rect {
        /// 起点
        start: PointI,
        /// 终点
        end: PointI,
        color: AnnotationColor,
    },
    /// 箭头
    Arrow {
        /// 箭尾
        start: PointI,
        /// 箭头所指处
        end: PointI,
        color: AnnotationColor,
    },
}

/// 当前标注会话：选中的工具、颜色，以及已画出的标记（按先后顺序）。
#[derive(Clone, Debug)]
pub struct AnnotationState {
    /// 当前选中的工具，None 表示未进入标注
    pub tool: Option<AnnotationTool>,
    /// 当前颜色
    pub color: AnnotationColor,
    // 绘制顺序即撤销顺序的反向
    marks: Vec<Mark>,
}

impl Default for AnnotationState {
    fn default() -> Self {
        AnnotationState {
            tool: None,
            color: AnnotationColor::Red,
            marks: vec![],
        }
    }
}

impl AnnotationState {
    /// 追加一个标记。
    pub fn push(&mut self, mark: Mark) {
        self.marks.push(mark)
    }

    /// 撤销最近一个标记。
    pub fn undo(&mut self) -> Option<Mark> {
        self.marks.pop()
    }

    /// 清空全部标记。
    pub fn clear(&mut self) {
        self.marks.clear()
    }

    /// 标记个数。
    pub fn len(&self) -> usize {
        self.marks.len()
    }

    /// 是否没有任何标记。
    pub fn is_empty(&self) -> bool {
        self.marks.is_empty()
    }

    /// 全部标记，按绘制先后排列。
    pub fn marks(&self) -> &[Mark] {
        self.marks.as_slice()
    }
}

/// 显示器的旋转角度。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisplayRotation {
    /// 不旋转
    Identity,
    /// 旋转 90 度
    Rotate90,
    /// 旋转 180 度
    Rotate180,
    /// 旋转 270 度
    Rotate270,
}
/// 以 i64 表示的四条边，避免中间计算溢出。
#[derive(Clone, Copy)]
struct Edges {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

impl Edges {
    fn of(rect: RectI) -> Self {
        let left = i64::from(rect.x);
        let top = i64::from(rect.y);
        Edges {
            left,
            top,
            right: left + i64::from(rect.width),
            bottom: top + i64::from(rect.height),
        }
    }

    fn from_size(width: u32, height: u32) -> Self {
        Edges {
            left: 0,
            top: 0,
            right: i64::from(width),
            bottom: i64::from(height),
        }
    }

    /// 两个区域的交集；没有面积则为 None。
    fn intersect(self, other: Edges) -> Option<Edges> {
        let common = Edges {
            left: self.left.max(other.left),
            top: self.top.max(other.top),
            right: self.right.min(other.right),
            bottom: self.bottom.min(other.bottom),
        };
        (common.left < common.right && common.top < common.bottom).then_some(common)
    }

    fn into_rect(self) -> Option<RectI> {
        build_rect(
            self.left,
            self.top,
            self.right - self.left,
            self.bottom - self.top,
        )
    }
}

fn build_rect(x: i64, y: i64, width: i64, height: i64) -> Option<RectI> {
    let x = i32::try_from(x).ok()?;
    let y = i32::try_from(y).ok()?;
    let width = u32::try_from(width).ok()?;
    let height = u32::try_from(height).ok()?;
    Some(RectI {
        x,
        y,
        width,
        height,
    })
}

/// 把 `rect` 裁到 `area` 内；`area` 为空或无交集时返回 None。
fn clip_within(rect: RectI, area: RectI) -> Option<RectI> {
    if area.width == 0 || area.height == 0 {
        return None;
    }
    Edges::of(rect).intersect(Edges::of(area))?.into_rect()
}

/// 把 `rect` 裁到以原点为起点的 width x height 区域内。
fn clip_to_extent(rect: RectI, width: u32, height: u32) -> Option<RectI> {
    if width == 0 || height == 0 {
        return None;
    }
    Edges::of(rect)
        .intersect(Edges::from_size(width, height))?
        .into_rect()
}

/// 把窗口矩形裁到显示器内，并换算为相对显示器左上角的坐标。
pub fn localize_window_rect(window: RectI, display: RectI) -> Option<RectI> {
    let inside = clip_within(window, display)?;
    let x = inside.x.checked_sub(display.x)?;
    let y = inside.y.checked_sub(display.y)?;
    Some(RectI {
        x,
        y,
        width: inside.width,
        height: inside.height,
    })
}

/// 判断点落在选区哪个缩放手柄上（边长为 `handle_size` 的方块）；无命中返回 None。
pub fn hit_test_selection_handle(
    selection: RectI,
    point: PointI,
    // 手柄方块的边长，为 0 时永远不命中
    handle_size: u32,
) -> Option<SelectionHandle> {
    if handle_size == 0 {
        return None;
    }
    let far_x = selection.x.saturating_add_unsigned(selection.width);
    let far_y = selection.y.saturating_add_unsigned(selection.height);
    let mid_x = selection.x + i32::try_from(selection.width / 2).unwrap_or(i32::MAX);
    let mid_y = selection.y + i32::try_from(selection.height / 2).unwrap_or(i32::MAX);
    let columns = [selection.x, mid_x, far_x];
    let rows = [selection.y, mid_y, far_y];

    // (手柄, 列下标, 行下标)，按顺时针从左上角开始
    const RING: [(SelectionHandle, usize, usize); 8] = [
        (SelectionHandle::TopLeft, 0, 0),
        (SelectionHandle::Top, 1, 0),
        (SelectionHandle::TopRight, 2, 0),
        (SelectionHandle::Right, 2, 1),
        (SelectionHandle::BottomRight, 2, 2),
        (SelectionHandle::Bottom, 1, 2),
        (SelectionHandle::BottomLeft, 0, 2),
        (SelectionHandle::Left, 0, 1),
    ];

    let reach = u32::try_from(i32::try_from(handle_size.div_ceil(2)).unwrap_or(i32::MAX))
        .unwrap_or(u32::MAX);
    for (handle, col, row) in RING {
        if point.x.abs_diff(columns[col]) <= reach && point.y.abs_diff(rows[row]) <= reach {
            return Some(handle);
        }
    }
    None
}

/// 拖动某个手柄后得到的新选区；点先被限制在 `bounds` 内，结果小于 `minimum_size` 则为 None。
pub fn resize_selection(
    selection: RectI,
    handle: SelectionHandle,
    point: PointI,
    // 选区不得超出的范围
    bounds: RectI,
    minimum_size: u32,
) -> Option<RectI> {
    let limit = Edges::of(bounds);
    let px = i64::from(point.x).clamp(limit.left, limit.right);
    let py = i64::from(point.y).clamp(limit.top, limit.bottom);

    let mut edges = Edges::of(selection);
    use SelectionHandle::*;
    if matches!(handle, TopLeft | Left | BottomLeft) {
        edges.left = px;
    }
    if matches!(handle, TopRight | Right | BottomRight) {
        edges.right = px;
    }
    if matches!(handle, TopLeft | Top | TopRight) {
        edges.top = py;
    }
    if matches!(handle, BottomLeft | Bottom | BottomRight) {
        edges.bottom = py;
    }

    // 拖过对边时翻转
    if edges.right < edges.left {
        std::mem::swap(&mut edges.left, &mut edges.right);
    }
    if edges.bottom < edges.top {
        std::mem::swap(&mut edges.top, &mut edges.bottom);
    }

    let min = i64::from(minimum_size);
    if edges.right - edges.left < min || edges.bottom - edges.top < min {
        return None;
    }
    edges.into_rect()
}

/// 把源图坐标系下的矩形换算到按 `rotation` 旋转后的显示坐标系；结果任一边短于 4 则为 None。
pub fn rotate_rect_to_display(
    rect: RectI,
    // 源图尺寸（旋转前）
    source_width: u32,
    source_height: u32,
    rotation: DisplayRotation,
) -> Option<RectI> {
    let inner = clip_to_extent(rect, source_width, source_height)?;
    let e = Edges::of(inner);
    let src_w = i64::from(source_width);
    let src_h = i64::from(source_height);
    let (w, h) = (i64::from(inner.width), i64::from(inner.height));

    let (turned, out_w, out_h) = match rotation {
        DisplayRotation::Identity => (inner, src_w, src_h),
        DisplayRotation::Rotate90 => (build_rect(src_h - e.bottom, e.left, h, w)?, src_h, src_w),
        DisplayRotation::Rotate180 => (
            build_rect(src_w - e.right, src_h - e.bottom, w, h)?,
            src_w,
            src_h,
        ),
        DisplayRotation::Rotate270 => (build_rect(e.top, src_w - e.right, h, w)?, src_h, src_w),
    };

    let result = clip_to_extent(
        turned,
        u32::try_from(out_w).ok()?,
        u32::try_from(out_h).ok()?,
    )?;
    if result.width < 4 || result.height < 4 {
        return None;
    }
    Some(result)
}

/// 在显示器内为选区安排工具栏：优先放在下方，其次上方，再不行贴着选区底边。
pub fn place_toolbar(
    selection: RectI,
    display: RectI,
    toolbar_width: u32,
    toolbar_height: u32,
    // 工具栏与选区之间留出的间隙
    gap: u32,
) -> Option<RectI> {
    let too_big = toolbar_width > display.width || toolbar_height > display.height;
    if display.width == 0 || display.height == 0 || too_big {
        return None;
    }

    let sel = Edges::of(clip_within(selection, display)?);
    let screen = Edges::of(display);
    let bar_w = i64::from(toolbar_width);
    let bar_h = i64::from(toolbar_height);
    let gap = i64::from(gap);
    let cap = i64::from(i32::MAX);

    // 水平方向居中于选区，并限制在显示器内
    let centered = sel.left + ((sel.right - sel.left) - bar_w).div_euclid(2);
    let x = centered.clamp(screen.left, (screen.right - bar_w).min(cap));

    let below = sel.bottom + gap;
    let above = sel.top - gap - bar_h;
    let y = if below + bar_h <= screen.bottom {
        below
    } else if above >= screen.top {
        above
    } else {
        (sel.bottom - bar_h).clamp(screen.top, (screen.bottom - bar_h).min(cap))
    };

    build_rect(x, y, bar_w, bar_h)
}
