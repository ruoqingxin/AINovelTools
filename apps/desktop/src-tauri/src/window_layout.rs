use tauri::{LogicalPosition, LogicalSize, Runtime, Window};

const WINDOW_MARGIN: f64 = 16.0;
const DEFAULT_MINIMUM: (f64, f64) = (960.0, 640.0);

#[derive(Debug)]
struct WindowLayout {
    minimum: LogicalSize<f64>,
    fitted: LogicalSize<f64>,
    resize: bool,
}

fn layout_for_work_area(
    work_area: (f64, f64),
    frame: (f64, f64),
    current: (f64, f64),
) -> Option<WindowLayout> {
    if [work_area.0, work_area.1, current.0, current.1]
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
        || [frame.0, frame.1]
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
    {
        return None;
    }
    let available = (
        work_area.0 - frame.0 - WINDOW_MARGIN,
        work_area.1 - frame.1 - WINDOW_MARGIN,
    );
    if available.0 <= 0.0 || available.1 <= 0.0 {
        return None;
    }
    let fitted = LogicalSize::new(current.0.min(available.0), current.1.min(available.1));
    Some(WindowLayout {
        minimum: LogicalSize::new(
            DEFAULT_MINIMUM.0.min(fitted.width),
            DEFAULT_MINIMUM.1.min(fitted.height),
        ),
        resize: current.0 - fitted.width > 1.0 || current.1 - fitted.height > 1.0,
        fitted,
    })
}

fn centered_position(
    origin: LogicalPosition<f64>,
    work_area: (f64, f64),
    frame: (f64, f64),
    fitted: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    LogicalPosition::new(
        origin.x + (work_area.0 - fitted.width - frame.0) / 2.0,
        origin.y + (work_area.1 - fitted.height - frame.1) / 2.0,
    )
}

pub fn fit_to_monitor<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return Ok(());
    }
    let work_area = monitor.work_area();
    let inner = window.inner_size()?;
    let outer = window.outer_size()?;
    let frame = (
        f64::from(outer.width.saturating_sub(inner.width)) / scale,
        f64::from(outer.height.saturating_sub(inner.height)) / scale,
    );
    let work = (
        f64::from(work_area.size.width) / scale,
        f64::from(work_area.size.height) / scale,
    );
    let Some(layout) = layout_for_work_area(
        work,
        frame,
        (
            f64::from(inner.width) / scale,
            f64::from(inner.height) / scale,
        ),
    ) else {
        return Ok(());
    };
    window.set_min_size(Some(layout.minimum))?;
    if !layout.resize
        || window.is_maximized()?
        || window.is_minimized()?
        || window.is_fullscreen()?
    {
        return Ok(());
    }
    // Keep the resized outer frame inside the work area, including offset monitors.
    window.set_size(layout.fitted)?;
    window.set_position(centered_position(
        work_area.position.to_logical(scale),
        work,
        frame,
        layout.fitted,
    ))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{centered_position, layout_for_work_area};

    #[test]
    fn fits_small_monitor_at_two_hundred_percent() {
        let layout = layout_for_work_area((683.0, 364.0), (8.0, 20.0), (1280.0, 820.0)).unwrap();
        assert_eq!(layout.minimum, tauri::LogicalSize::new(659.0, 328.0));
        assert_eq!(layout.fitted, layout.minimum);
        assert!(layout.resize);
    }

    #[test]
    fn fits_full_hd_at_one_hundred_fifty_percent() {
        let layout = layout_for_work_area((1280.0, 693.0), (8.0, 24.0), (1280.0, 820.0)).unwrap();
        assert_eq!(layout.minimum, tauri::LogicalSize::new(960.0, 640.0));
        assert_eq!(layout.fitted, tauri::LogicalSize::new(1256.0, 653.0));
        assert!(layout.resize);
    }

    #[test]
    fn preserves_user_size_when_it_fits() {
        let layout = layout_for_work_area((1920.0, 1040.0), (16.0, 39.0), (1000.0, 700.0)).unwrap();
        assert_eq!(layout.minimum, tauri::LogicalSize::new(960.0, 640.0));
        assert_eq!(layout.fitted, tauri::LogicalSize::new(1000.0, 700.0));
        assert!(!layout.resize);
    }

    #[test]
    fn shrinks_only_the_oversized_dimension() {
        let layout = layout_for_work_area((1024.0, 728.0), (16.0, 39.0), (980.0, 820.0)).unwrap();
        assert_eq!(layout.fitted, tauri::LogicalSize::new(980.0, 673.0));
        assert!(layout.resize);
    }

    #[test]
    fn minimum_does_not_enlarge_a_previously_small_window() {
        let layout = layout_for_work_area((1920.0, 1040.0), (16.0, 39.0), (659.0, 328.0)).unwrap();
        assert_eq!(layout.minimum, tauri::LogicalSize::new(659.0, 328.0));
        assert!(!layout.resize);
    }

    #[test]
    fn centers_inside_work_area_on_negative_origin_monitor() {
        let position = centered_position(
            tauri::LogicalPosition::new(-683.0, 40.0),
            (683.0, 364.0),
            (8.0, 20.0),
            tauri::LogicalSize::new(659.0, 328.0),
        );
        assert_eq!(position, tauri::LogicalPosition::new(-675.0, 48.0));
    }

    #[test]
    fn ignores_invalid_or_unavailable_metrics() {
        for (work, frame, current) in [
            ((0.0, 800.0), (16.0, 39.0), (1280.0, 820.0)),
            ((1920.0, 1080.0), (-1.0, 39.0), (1280.0, 820.0)),
            ((1920.0, 1080.0), (16.0, 39.0), (f64::NAN, 820.0)),
            ((32.0, 32.0), (16.0, 39.0), (1280.0, 820.0)),
        ] {
            assert!(layout_for_work_area(work, frame, current).is_none());
        }
    }
}
