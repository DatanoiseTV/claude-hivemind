//! Rendering. Lays out a header band (global stats + global activity
//! sparklines) over a responsive grid that shows every project hive at once,
//! each card carrying its instances, a task-progress gauge, msg/edit activity
//! sparklines, and a live feed. A footer shows keybinds or the broadcast input.

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Gauge, Paragraph, RenderDirection, Sparkline},
    Frame,
};

use crate::app::App;
use crate::client::Group;

const MSG_COLOR: Color = Color::Cyan;
const EDIT_COLOR: Color = Color::Magenta;

// Static neon palette — no animation, so nothing shimmers.
const NEON_GREEN: Color = Color::Rgb(0, 230, 150); // live / fresh presence
const AMBER: Color = Color::Rgb(255, 200, 40); // selected / focused
const GLOW: Color = Color::Rgb(120, 245, 255); // brief flash when a hive acts
const OFFLINE: Color = Color::Rgb(230, 70, 70);

pub fn draw(f: &mut Frame, app: &App) {
    let chunks = Layout::vertical([
        Constraint::Length(6),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .split(f.area());

    draw_header(f, chunks[0], app);
    draw_body(f, chunks[1], app);
    draw_footer(f, chunks[2], app);
}

// --- Header -----------------------------------------------------------------

fn draw_header(f: &mut Frame, area: Rect, app: &App) {
    let up = if app.connected {
        fmt_dur(app.hub_now - app.hub_started)
    } else {
        "—".into()
    };
    let border_color = if app.connected { NEON_GREEN } else { OFFLINE };
    let live = if app.connected { spinner(app.frame) } else { "○" };
    let title = format!(" {} HIVEMIND · hub up {} · pid {} · proto v{} ", live, up, app.hub_pid, app.hub_protocol);
    let block = Block::bordered()
        .border_type(BorderType::Plain)
        .border_style(Style::new().fg(border_color))
        .title(Span::styled(title, Style::new().fg(border_color).add_modifier(Modifier::BOLD)));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let cols = Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).split(inner);
    draw_header_stats(f, cols[0], app);
    draw_header_graphs(f, cols[1], app);
}

fn draw_header_stats(f: &mut Frame, area: Rect, app: &App) {
    let hives = app.groups.len();
    let instances: usize = app.groups.iter().map(|g| g.agents.len()).sum();
    let peak: u64 = app.groups.iter().map(|g| g.stats.peak_agents).sum();
    let mut open = 0u64;
    let mut wip = 0u64;
    let mut done = 0u64;
    let mut total_tasks = 0u64;
    let mut msgs = 0u64;
    let mut edits = 0u64;
    for g in &app.groups {
        for t in &g.tasks {
            total_tasks += 1;
            match t.status.as_str() {
                "open" => open += 1,
                "claimed" | "in_progress" => wip += 1,
                "done" => done += 1,
                _ => {}
            }
        }
        msgs += g.stats.messages + g.stats.broadcasts + g.stats.turns;
        edits += g.stats.edits;
    }

    let lines = vec![
        Line::from(vec![
            Span::styled(format!(" {}", hives), Style::new().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::raw(" hives   "),
            Span::styled(format!("{}", instances), Style::new().fg(NEON_GREEN).add_modifier(Modifier::BOLD)),
            Span::raw(" instances   "),
            Span::styled(format!("peak {}", peak), Style::new().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::raw(format!(" {} tasks   ", total_tasks)),
            Span::styled(format!("{} open", open), Style::new().fg(Color::Cyan)),
            Span::raw("  "),
            Span::styled(format!("{} wip", wip), Style::new().fg(Color::Yellow)),
            Span::raw("  "),
            Span::styled(format!("{} done", done), Style::new().fg(NEON_GREEN)),
        ]),
        Line::from(vec![
            Span::styled(format!(" {} activity", msgs), Style::new().fg(MSG_COLOR)),
            Span::raw("   "),
            Span::styled(format!("{} edits", edits), Style::new().fg(EDIT_COLOR)),
        ]),
        Line::from(if app.connected {
            Span::styled(format!(" ● {}", app.status_line), Style::new().fg(NEON_GREEN))
        } else {
            Span::styled(format!(" ○ {}", app.status_line), Style::new().fg(OFFLINE))
        }),
    ];
    f.render_widget(Paragraph::new(lines), area);
}

fn draw_header_graphs(f: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([Constraint::Ratio(1, 2), Constraint::Ratio(1, 2)]).split(area);
    spark_with_label(f, rows[0], "actv/s", &app.global_msg, MSG_COLOR);
    spark_with_label(f, rows[1], "edits/s", &app.global_edit, EDIT_COLOR);
}

fn spark_with_label(
    f: &mut Frame,
    area: Rect,
    label: &str,
    ring: &std::collections::VecDeque<u64>,
    color: Color,
) {
    if area.height == 0 {
        return;
    }
    let last = ring.back().copied().unwrap_or(0);
    let cols = Layout::horizontal([Constraint::Length(11), Constraint::Min(0)]).split(area);
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(format!("{:>7}", label), Style::new().fg(color)),
            Span::styled(format!(" {:>2}", last), Style::new().fg(Color::White)),
        ])),
        cols[0],
    );
    let data: Vec<u64> = ring.iter().copied().collect();
    let max = data.iter().copied().max().unwrap_or(1).max(1);
    f.render_widget(
        Sparkline::default()
            .data(data)
            .max(max)
            .direction(RenderDirection::RightToLeft)
            .style(Style::new().fg(color)),
        cols[1],
    );
}

// --- Body grid --------------------------------------------------------------

fn draw_body(f: &mut Frame, area: Rect, app: &App) {
    if app.focused && !app.groups.is_empty() {
        draw_focus(f, area, app);
        return;
    }
    if app.groups.is_empty() {
        let msg = if app.connected {
            "No active hives.\nStart Claude Code in a project that has the hivemind plugin enabled."
        } else {
            "Waiting for the hive hub…\nIt starts automatically when a Claude Code instance with the hivemind plugin opens."
        };
        f.render_widget(
            Paragraph::new(msg)
                .alignment(Alignment::Center)
                .style(Style::new().fg(Color::DarkGray))
                .block(Block::bordered().border_type(BorderType::Plain).border_style(Style::new().fg(Color::DarkGray))),
            area,
        );
        return;
    }

    let n = app.groups.len();
    let cols = ((area.width as usize) / 46).clamp(1, n.max(1)).min(n);
    let rows = n.div_ceil(cols);

    let row_constraints: Vec<Constraint> = (0..rows).map(|_| Constraint::Ratio(1, rows as u32)).collect();
    let row_areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints(row_constraints)
        .split(area);

    for (r, row_area) in row_areas.iter().enumerate() {
        let col_constraints: Vec<Constraint> =
            (0..cols).map(|_| Constraint::Ratio(1, cols as u32)).collect();
        let col_areas = Layout::default()
            .direction(Direction::Horizontal)
            .constraints(col_constraints)
            .split(*row_area);
        for (c, cell) in col_areas.iter().enumerate() {
            let idx = r * cols + c;
            if idx < n {
                draw_card(f, *cell, app, idx);
            }
        }
    }
}

fn draw_card(f: &mut Frame, area: Rect, app: &App, idx: usize) {
    let g = &app.groups[idx];
    let selected = idx == app.selected;
    let flash = app.flash.get(&g.group.id).copied().unwrap_or(0);
    // Solid glow while a hive is active (no fade -> no shimmer), then back to a
    // static colour. Selected = amber, otherwise gray.
    let border_style = if flash > 0 {
        Style::new().fg(GLOW).add_modifier(Modifier::BOLD)
    } else if selected {
        Style::new().fg(AMBER).add_modifier(Modifier::BOLD)
    } else {
        Style::new().fg(Color::Gray)
    };
    let title = format!(" {} · {} inst ", trunc(&g.group.label, 22), g.agents.len());
    let block = Block::bordered()
        .border_type(BorderType::Plain)
        .border_style(border_style)
        .title(Span::styled(title, border_style));
    let inner = block.inner(area);
    f.render_widget(block, area);

    if inner.height < 5 || inner.width < 8 {
        return; // too small to draw the detail; the title still shows
    }

    let parts = Layout::vertical([
        Constraint::Length(3), // instances
        Constraint::Length(1), // task gauge
        Constraint::Length(1), // counts
        Constraint::Length(1), // activity sparkline
        Constraint::Min(0),    // feed
    ])
    .split(inner);

    draw_instances(f, parts[0], g, app.hub_now, app.frame);
    draw_task_gauge(f, parts[1], g);
    draw_counts(f, parts[2], g);
    draw_card_spark(f, parts[3], &g.group.id, app, true);
    draw_feed(f, parts[4], g);
}

fn draw_instances(f: &mut Frame, area: Rect, g: &Group, now: i64, frame: u64) {
    let mut lines: Vec<Line> = Vec::new();
    let max_rows = area.height as usize;
    let show = g.agents.len().min(max_rows.saturating_sub(if g.agents.len() > max_rows { 1 } else { 0 }));
    for a in g.agents.iter().take(show) {
        let age = now - a.last_seen;
        let working = a.current_task.is_some();
        // A spinning marker for instances actively on a task; a softly pulsing
        // green dot for fresh presence; amber/red as it goes stale.
        let (dot, dot_color) = if working {
            (spinner(frame).to_string(), AMBER)
        } else if age < 20_000 {
            ("●".to_string(), NEON_GREEN)
        } else if age < 60_000 {
            ("●".to_string(), Color::Yellow)
        } else {
            ("●".to_string(), Color::Red)
        };
        // Prefer showing the current task; fall back to a non-idle status.
        let (doing, doing_color) = if let Some(t) = &a.current_task {
            (format!(" ▶{}", t), Color::Yellow)
        } else if a.status.is_empty() || a.status == "idle" || a.status == "active" {
            (String::new(), Color::DarkGray)
        } else {
            (format!(" {}", trunc(&a.status, 16)), Color::DarkGray)
        };
        lines.push(Line::from(vec![
            Span::styled(format!("{} ", dot), Style::new().fg(dot_color)),
            Span::styled(trunc(&a.name, 13), Style::new().fg(Color::White)),
            Span::styled(doing, Style::new().fg(doing_color)),
        ]));
    }
    if g.agents.len() > show {
        lines.push(Line::from(Span::styled(
            format!("  +{} more", g.agents.len() - show),
            Style::new().fg(Color::DarkGray),
        )));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("  (no instances)", Style::new().fg(Color::DarkGray))));
    }
    f.render_widget(Paragraph::new(lines), area);
}

fn draw_task_gauge(f: &mut Frame, area: Rect, g: &Group) {
    let total = g.tasks.len();
    let done = g.tasks.iter().filter(|t| t.status == "done").count();
    let ratio = if total > 0 { done as f64 / total as f64 } else { 0.0 };
    let label = if total > 0 {
        format!("{}/{} done", done, total)
    } else {
        "no tasks".into()
    };
    f.render_widget(
        Gauge::default()
            .ratio(ratio.clamp(0.0, 1.0))
            .gauge_style(Style::new().fg(Color::Green).bg(Color::Rgb(40, 40, 40)))
            .label(Span::styled(label, Style::new().fg(Color::White)))
            .use_unicode(true),
        area,
    );
}

fn draw_counts(f: &mut Frame, area: Rect, g: &Group) {
    let mut ready = 0;
    let mut blocked = 0;
    let mut wip = 0;
    let mut done = 0;
    for t in &g.tasks {
        match t.status.as_str() {
            "open" => {
                if t.ready {
                    ready += 1
                } else {
                    blocked += 1
                }
            }
            "claimed" | "in_progress" => wip += 1,
            "done" => done += 1,
            _ => {}
        }
    }
    let line = Line::from(vec![
        Span::styled(format!("{} ready", ready), Style::new().fg(Color::Cyan)),
        Span::raw(" "),
        Span::styled(format!("{} blkd", blocked), Style::new().fg(Color::DarkGray)),
        Span::raw(" "),
        Span::styled(format!("{} wip", wip), Style::new().fg(Color::Yellow)),
        Span::raw(" "),
        Span::styled(format!("{} done", done), Style::new().fg(Color::Green)),
        Span::styled(format!("  L{} C{}", g.locks.len(), g.notes.len()), Style::new().fg(Color::DarkGray)),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn draw_card_spark(f: &mut Frame, area: Rect, group_id: &str, app: &App, is_msg: bool) {
    let (data, color): (Vec<u64>, Color) = match app.hist.get(group_id) {
        Some(h) if is_msg => (h.msg.iter().copied().collect(), MSG_COLOR),
        Some(h) => (h.edit.iter().copied().collect(), EDIT_COLOR),
        None => (Vec::new(), if is_msg { MSG_COLOR } else { EDIT_COLOR }),
    };
    let max = data.iter().copied().max().unwrap_or(1).max(1);
    f.render_widget(
        Sparkline::default()
            .data(data)
            .max(max)
            .direction(RenderDirection::RightToLeft)
            .style(Style::new().fg(color)),
        area,
    );
}

fn draw_feed(f: &mut Frame, area: Rect, g: &Group) {
    if area.height == 0 {
        return;
    }
    let take = area.height as usize;
    let mut lines: Vec<Line> = Vec::new();
    for a in g.activity.iter().rev().take(take).rev() {
        let color = match a.kind.as_str() {
            "task" => Color::Yellow,
            "context" => Color::Magenta,
            "system" => Color::DarkGray,
            "operator" => Color::Cyan,
            _ => Color::White,
        };
        lines.push(Line::from(vec![
            Span::styled(format!("{} ", trunc(&a.from_name, 12)), Style::new().fg(color)),
            Span::styled(trunc(&a.body, area.width.saturating_sub(14) as usize), Style::new().fg(Color::Gray)),
        ]));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("  (quiet)", Style::new().fg(Color::DarkGray))));
    }
    f.render_widget(Paragraph::new(lines), area);
}

// --- Focus view (one hive, full detail) ------------------------------------

fn draw_focus(f: &mut Frame, area: Rect, app: &App) {
    let g = match app.groups.get(app.selected) {
        Some(g) => g,
        None => return,
    };
    let title = format!(
        " {} FOCUS · {} · {} instance(s) · {} task(s) ",
        spinner(app.frame),
        trunc(&g.group.label, 30),
        g.agents.len(),
        g.tasks.len()
    );
    let block = Block::bordered()
        .border_type(BorderType::Plain)
        .border_style(Style::new().fg(AMBER).add_modifier(Modifier::BOLD))
        .title(Span::styled(title, Style::new().fg(AMBER).add_modifier(Modifier::BOLD)));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let inst_h = (g.agents.len() as u16 + 2).clamp(3, 9);
    let parts = Layout::vertical([
        Constraint::Length(inst_h),
        Constraint::Min(4),
        Constraint::Length(9),
    ])
    .split(inner);

    draw_focus_instances(f, parts[0], g, app.hub_now, app.frame);
    draw_focus_tasks(f, parts[1], g);

    let bottom = Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)]).split(parts[2]);
    draw_focus_feed(f, bottom[0], g);
    draw_focus_changes(f, bottom[1], g, app.hub_now);
}

fn draw_focus_instances(f: &mut Frame, area: Rect, g: &Group, now: i64, frame: u64) {
    let block = Block::bordered().border_style(Style::new().fg(Color::DarkGray)).title("instances");
    let inner = block.inner(area);
    f.render_widget(block, area);
    let mut lines: Vec<Line> = Vec::new();
    for a in &g.agents {
        let age = now - a.last_seen;
        let working = a.current_task.is_some();
        let (dot, dot_color) = if working {
            (format!("{} ", spinner(frame)), AMBER)
        } else if age < 20_000 {
            ("● ".to_string(), NEON_GREEN)
        } else if age < 60_000 {
            ("● ".to_string(), Color::Yellow)
        } else {
            ("● ".to_string(), Color::Red)
        };
        let env = [a.client.as_str(), a.model.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("/");
        let caps = if a.capabilities.is_empty() { String::new() } else { format!(" {{{}}}", a.capabilities.join(",")) };
        let disp = if a.dispatchable { " ⌨" } else { "" };
        let doing = match &a.current_task {
            Some(t) => format!(" ▶ {}", t),
            None if a.status.is_empty() || a.status == "idle" => " idle".into(),
            None => format!(" {}", a.status),
        };
        lines.push(Line::from(vec![
            Span::styled(dot, Style::new().fg(dot_color)),
            Span::styled(format!("{:<16}", trunc(&a.name, 16)), Style::new().fg(Color::White)),
            Span::styled(if env.is_empty() { String::new() } else { format!(" {}", trunc(&env, 20)) }, Style::new().fg(Color::Green)),
            Span::styled(caps, Style::new().fg(Color::Cyan)),
            Span::styled(disp, Style::new().fg(AMBER)),
            Span::styled(doing, Style::new().fg(Color::Yellow)),
            Span::styled(format!("  ({})", fmt_dur(now - a.last_seen)), Style::new().fg(Color::DarkGray)),
        ]));
    }
    // Named participants (subagents) sharing a session — lightweight, no socket.
    for p in &g.participants {
        lines.push(Line::from(vec![
            Span::styled("⊹ ", Style::new().fg(MSG_COLOR)),
            Span::styled(format!("{:<16}", trunc(&p.name, 16)), Style::new().fg(MSG_COLOR)),
            Span::styled(" subagent", Style::new().fg(Color::DarkGray)),
            Span::styled(
                if p.pending > 0 { format!("  {} pending", p.pending) } else { String::new() },
                Style::new().fg(AMBER),
            ),
        ]));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("(no instances)", Style::new().fg(Color::DarkGray))));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_focus_tasks(f: &mut Frame, area: Rect, g: &Group) {
    let block = Block::bordered().border_style(Style::new().fg(Color::DarkGray)).title("task board");
    let inner = block.inner(area);
    f.render_widget(block, area);

    let order = |s: &str| match s {
        "claimed" | "in_progress" => 0,
        "open" => 1,
        "done" => 2,
        _ => 3,
    };
    let mut tasks: Vec<&crate::client::Task> = g.tasks.iter().collect();
    tasks.sort_by(|a, b| order(&a.status).cmp(&order(&b.status)).then(b.priority.cmp(&a.priority)));

    let cap = inner.height as usize;
    let mut lines: Vec<Line> = Vec::new();
    for t in tasks.iter().take(cap) {
        let (label, color) = match t.status.as_str() {
            "open" if t.ready => ("READY  ".to_string(), Color::Cyan),
            "open" => (format!("BLK<{}>", t.blocked_by.join(",")), Color::DarkGray),
            "claimed" | "in_progress" => ("WIP    ".to_string(), Color::Yellow),
            "done" => ("DONE   ".to_string(), Color::Green),
            "failed" => ("FAIL   ".to_string(), Color::Red),
            other => (other.to_string(), Color::Gray),
        };
        let owner = t.claimed_by.as_deref().map(|o| format!(" @{}", o)).unwrap_or_default();
        let prio = if t.priority != 0 { format!(" p{}", t.priority) } else { String::new() };
        let tags = if t.tags.is_empty() { String::new() } else { format!(" #{}", t.tags.join(" #")) };
        lines.push(Line::from(vec![
            Span::styled(format!("{:<5}", t.id), Style::new().fg(Color::White)),
            Span::styled(format!("{:<10}", label), Style::new().fg(color)),
            Span::styled(trunc(&t.title, inner.width.saturating_sub(28) as usize), Style::new().fg(Color::Gray)),
            Span::styled(format!("{}{}{}", prio, owner, tags), Style::new().fg(Color::DarkGray)),
        ]));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("(board empty)", Style::new().fg(Color::DarkGray))));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_focus_feed(f: &mut Frame, area: Rect, g: &Group) {
    let block = Block::bordered().border_style(Style::new().fg(Color::DarkGray)).title("activity feed");
    let inner = block.inner(area);
    f.render_widget(block, area);
    let take = inner.height as usize;
    let mut lines: Vec<Line> = Vec::new();
    for a in g.activity.iter().rev().take(take).rev() {
        let color = match a.kind.as_str() {
            "task" => Color::Yellow,
            "context" => Color::Magenta,
            "system" => Color::DarkGray,
            "operator" => Color::Cyan,
            _ => Color::White,
        };
        lines.push(Line::from(vec![
            Span::styled(format!("{} ", trunc(&a.from_name, 12)), Style::new().fg(color)),
            Span::styled(trunc(&a.body, inner.width.saturating_sub(14) as usize), Style::new().fg(Color::Gray)),
        ]));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("(quiet)", Style::new().fg(Color::DarkGray))));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_focus_changes(f: &mut Frame, area: Rect, g: &Group, now: i64) {
    let block = Block::bordered().border_style(Style::new().fg(Color::DarkGray)).title("recent file edits");
    let inner = block.inner(area);
    f.render_widget(block, area);
    let take = inner.height as usize;
    let mut lines: Vec<Line> = Vec::new();
    for c in g.changes.iter().rev().take(take).rev() {
        // External (filesystem-watched) changes get an "ext" tag so they stand
        // out from edits agents made themselves.
        let external = c.tool == "fs" || c.who == "filesystem";
        let (tag, tag_color) = if external { ("ext ", AMBER) } else { ("    ", Color::DarkGray) };
        lines.push(Line::from(vec![
            Span::styled(format!("{:>4} ", fmt_dur(now - c.ts)), Style::new().fg(Color::DarkGray)),
            Span::styled(tag, Style::new().fg(tag_color)),
            Span::styled(path_tail(&c.file, inner.width.saturating_sub(14) as usize), Style::new().fg(Color::Gray)),
        ]));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("(no edits yet)", Style::new().fg(Color::DarkGray))));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

// --- Footer -----------------------------------------------------------------

fn draw_footer(f: &mut Frame, area: Rect, app: &App) {
    if app.input_mode {
        let label = app
            .selected_group()
            .map(|g| g.group.label.clone())
            .unwrap_or_else(|| "—".into());
        let line = Line::from(vec![
            Span::styled(format!(" say to {}> ", trunc(&label, 18)), Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled(format!("{}\u{2588}", app.input), Style::new().fg(Color::White)),
        ]);
        f.render_widget(Paragraph::new(line).style(Style::new().bg(Color::Rgb(30, 30, 30))), area);
        return;
    }
    let paused = if app.paused { "  [PAUSED]" } else { "" };
    let (enter_key, enter_label) = if app.focused { ("esc", " back  ") } else { ("enter", " focus  ") };
    let line = Line::from(vec![
        Span::styled(" q", Style::new().fg(Color::Yellow)),
        Span::raw(" quit  "),
        Span::styled("↑↓/jk", Style::new().fg(Color::Yellow)),
        Span::raw(" select  "),
        Span::styled(enter_key, Style::new().fg(Color::Yellow)),
        Span::raw(enter_label),
        Span::styled("b", Style::new().fg(Color::Yellow)),
        Span::raw(" broadcast  "),
        Span::styled("p", Style::new().fg(Color::Yellow)),
        Span::raw(" pause  "),
        Span::styled("actv", Style::new().fg(MSG_COLOR)),
        Span::raw("/"),
        Span::styled("edits", Style::new().fg(EDIT_COLOR)),
        Span::styled(paused.to_string(), Style::new().fg(Color::Red).add_modifier(Modifier::BOLD)),
    ]);
    f.render_widget(Paragraph::new(line).style(Style::new().bg(Color::Rgb(20, 20, 20))), area);
}

// --- helpers ----------------------------------------------------------------

fn trunc(s: &str, n: usize) -> String {
    if n == 0 {
        return String::new();
    }
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else if n <= 1 {
        chars.into_iter().take(n).collect()
    } else {
        let mut out: String = chars.into_iter().take(n - 1).collect();
        out.push('…');
        out
    }
}

fn path_tail(p: &str, n: usize) -> String {
    let tail = p.rsplit('/').next().unwrap_or(p);
    trunc(tail, n)
}

// --- animation helpers ------------------------------------------------------
//
// Motion is deliberately restrained to avoid flicker: a single rotating spinner
// where work is actually happening, and a brief *solid* glow on a card the
// moment its hive does something. No per-frame colour fades (those re-tint every
// border cell each frame and shimmer); colours are otherwise static.

// A gentle spinner that advances ~3x/sec (every ~3rd frame at 10fps) so it reads
// as a smooth rotation rather than a frantic blur.
const SPINNER: [&str; 8] = ["◐", "◓", "◑", "◒", "◐", "◓", "◑", "◒"];

fn spinner(frame: u64) -> &'static str {
    SPINNER[((frame / 3) as usize) % SPINNER.len()]
}

fn fmt_dur(ms: i64) -> String {
    let s = (ms / 1000).max(0);
    if s < 60 {
        format!("{}s", s)
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else if s < 86400 {
        format!("{}h{}m", s / 3600, (s % 3600) / 60)
    } else {
        format!("{}d", s / 86400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::App;
    use crate::client::{Agent, Group, GroupRef, Activity, Participant, Stats, Task};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn fake_app() -> App {
        let mut app = App::new();
        app.connected = true;
        app.hub_now = 1_000_000;
        app.hub_started = 900_000;
        app.hub_pid = 1234;
        app.hub_protocol = 1;

        let mut g = Group::default();
        g.group = GroupRef { id: "g1".into(), label: "supercode".into() };
        g.agents = vec![
            Agent { name: "swift-otter".into(), cwd: "/tmp/supercode/src".into(), status: "on t3".into(), client: "claude-code".into(), model: "opus".into(), capabilities: vec!["rust".into()], current_task: Some("t3".into()), dispatchable: true, last_seen: 1_000_000 },
            Agent { name: "keen-lynx".into(), cwd: "/tmp/supercode".into(), status: "idle".into(), client: "opencode".into(), model: "gpt-5".into(), capabilities: vec!["frontend".into()], current_task: None, dispatchable: false, last_seen: 985_000 },
        ];
        g.tasks = vec![
            Task { id: "t1".into(), title: "wire button".into(), status: "done".into(), claimed_by: Some("swift-otter".into()), ready: false, ..Default::default() },
            Task { id: "t2".into(), title: "add api".into(), status: "open".into(), claimed_by: None, ready: false, blocked_by: vec!["t1".into()], priority: 2, ..Default::default() },
            Task { id: "t3".into(), title: "tests".into(), status: "claimed".into(), claimed_by: Some("keen-lynx".into()), tags: vec!["rust".into()], ..Default::default() },
            Task { id: "t4".into(), title: "ready work".into(), status: "open".into(), ready: true, ..Default::default() },
        ];
        g.participants = vec![Participant { name: "sub-frontend".into(), pending: 1 }];
        g.activity = vec![Activity { from_name: "swift-otter".into(), body: "claimed t3".into(), kind: "task".into(), ts: 1_000_000 }];
        g.changes = vec![crate::client::Change { who: "supercode:ab".into(), file: "/tmp/supercode/src/hub.js".into(), tool: "Edit".into(), ts: 999_000 }];
        g.stats = Stats { messages: 10, broadcasts: 3, edits: 5, turns: 7, tasks_posted: 4, peak_agents: 2 };

        // A second hive that is empty, to exercise zero-task / zero-agent paths.
        let empty = Group { group: GroupRef { id: "g2".into(), label: "scratch".into() }, ..Default::default() };

        app.groups = vec![g, empty];
        app
    }

    fn render_at(w: u16, h: u16) {
        let app = fake_app();
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        // The assertion is simply that this does not panic at any size.
        terminal.draw(|f| draw(f, &app)).unwrap();
    }

    #[test]
    fn renders_without_panic_across_sizes() {
        for (w, h) in [(120, 40), (80, 24), (200, 60), (46, 14), (30, 9), (20, 6)] {
            render_at(w, h);
        }
    }

    #[test]
    fn header_and_hives_are_drawn() {
        let app = fake_app();
        let mut terminal = Terminal::new(TestBackend::new(140, 44)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        let s: String = terminal.backend().buffer().content.iter().map(|c| c.symbol()).collect();
        assert!(s.contains("HIVEMIND"), "header title present");
        assert!(s.contains("supercode"), "first hive label present");
        assert!(s.contains("scratch"), "second hive label present");
    }

    #[test]
    fn focus_view_renders_detail() {
        let mut app = fake_app();
        app.focused = true;
        let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        let s: String = terminal.backend().buffer().content.iter().map(|c| c.symbol()).collect();
        assert!(s.contains("FOCUS"), "focus header shown");
        assert!(s.contains("task board"), "task board panel shown");
        assert!(s.contains("recent file edits"), "changes panel shown");
        assert!(s.contains("READY"), "ready task state shown");
    }

    #[test]
    fn focus_renders_without_panic_across_sizes() {
        for (w, h) in [(120, 40), (80, 24), (60, 16), (40, 10)] {
            let mut app = fake_app();
            app.focused = true;
            let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
            terminal.draw(|f| draw(f, &app)).unwrap();
        }
    }

    // Dev tool: `cargo test preview -- --ignored --nocapture` prints the real
    // rendered dashboard as text, so the README mockup can be checked against it.
    #[test]
    #[ignore]
    fn preview() {
        let (w, h) = (96usize, 30usize);
        let app = fake_app();
        let mut terminal = Terminal::new(TestBackend::new(w as u16, h as u16)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        let buf = terminal.backend().buffer();
        let mut out = String::from("\n");
        for y in 0..h {
            for x in 0..w {
                out.push_str(buf.content[y * w + x].symbol());
            }
            out.push('\n');
        }
        eprintln!("{}", out);
    }

    #[test]
    fn animation_frames_render_without_panic() {
        let mut app = fake_app();
        app.flash.insert("g1".into(), crate::app::FLASH_FRAMES);
        // Advance through a full spinner/pulse cycle in both views.
        for i in 0..40 {
            app.animate();
            app.focused = i % 2 == 0;
            let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
            terminal.draw(|f| draw(f, &app)).unwrap();
        }
    }

    #[test]
    fn input_mode_renders_prompt() {
        let mut app = fake_app();
        app.input_mode = true;
        app.input = "deploy now".into();
        let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        let s: String = terminal.backend().buffer().content.iter().map(|c| c.symbol()).collect();
        assert!(s.contains("say to"), "broadcast prompt shown");
        assert!(s.contains("deploy now"), "typed text shown");
    }
}
