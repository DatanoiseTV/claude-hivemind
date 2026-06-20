//! hivemind-monitor — a ratatui dashboard for the Claude Code Hivemind hub.
//!
//! Connects to the hub's Unix socket and renders every active project hive at
//! once: presence, task-board progress, live message/edit activity graphs, a
//! per-hive feed, and an operator-broadcast input. Read-only except for the
//! optional operator broadcast (press `b`).

mod app;
mod client;
mod ui;

use std::io;
use std::time::Duration;

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};

use app::App;

fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    let mut app = App::new();
    app.tick(); // seed an initial snapshot so the first frame isn't blank
    let result = run(&mut terminal, &mut app);
    ratatui::restore();
    result
}

fn run(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> io::Result<()> {
    loop {
        if !app.paused && app.last_fetch.elapsed() >= Duration::from_millis(1000) {
            app.tick();
        }

        terminal.draw(|f| ui::draw(f, app))?;

        // Poll briefly so the UI stays responsive to keys while still ticking
        // the data refresh roughly once a second.
        if event::poll(Duration::from_millis(200))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                let ctrl_c = key.modifiers.contains(KeyModifiers::CONTROL)
                    && matches!(key.code, KeyCode::Char('c'));
                if ctrl_c {
                    break;
                }

                if app.input_mode {
                    match key.code {
                        KeyCode::Enter => app.submit_broadcast(),
                        KeyCode::Esc => {
                            app.input_mode = false;
                            app.input.clear();
                        }
                        KeyCode::Backspace => {
                            app.input.pop();
                        }
                        KeyCode::Char(c) => app.input.push(c),
                        _ => {}
                    }
                } else {
                    match key.code {
                        KeyCode::Char('q') | KeyCode::Esc => break,
                        KeyCode::Down | KeyCode::Char('j') => app.select_next(),
                        KeyCode::Up | KeyCode::Char('k') => app.select_prev(),
                        KeyCode::Right | KeyCode::Char('l') => app.select_next(),
                        KeyCode::Left | KeyCode::Char('h') => app.select_prev(),
                        KeyCode::Char('b') => {
                            if !app.groups.is_empty() {
                                app.input_mode = true;
                                app.input.clear();
                            }
                        }
                        KeyCode::Char('p') => app.paused = !app.paused,
                        KeyCode::Char('r') => app.tick(),
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(())
}
