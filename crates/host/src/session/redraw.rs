//! Writing a screen out as the terminal bytes that draw it again.
//!
//! The bytes start with a full reset, so they draw the same screen in any
//! terminal of the screen's size, then draw the primary screen from the top
//! of its scrollback, the alternate screen over it when that is showing, the
//! saved and current cursor, the pen the program is writing with, and the
//! modes the program set. Written into an empty terminal they reproduce the
//! screen cell for cell: characters, wide and combining characters, colours,
//! attributes, underline colours, hyperlinks, wrapped lines and the cursor.
//!
//! What `alacritty_terminal` keeps private is not carried: a scrolling region
//! narrower than the screen, custom tab stops and the window title. A program
//! that set them sets them again on its next repaint.

use std::io::Write as _;

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags, Hyperlink};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, CursorStyle, NamedColor, Rgb};

/// The bytes that draw `term` again. `term` is left as it was; it is
/// borrowed mutably only to reach the primary screen behind the alternate
/// one.
pub(super) fn redraw<T: EventListener>(term: &mut Term<T>) -> Vec<u8> {
    let mut out = Writer::default();
    out.raw(b"\x1bc");
    out.palette(term.colors());
    if term.mode().contains(TermMode::ALT_SCREEN) {
        let primary = primary_grid(term);
        out.grid(&primary, true);
        out.cursor(&primary);
        // The alternate screen starts with the primary one's cursor.
        out.raw(b"\x1b[?1049h\x1b[H");
        out.grid(term.grid(), false);
    } else {
        out.grid(term.grid(), true);
    }
    out.modes(*term.mode());
    out.cursor_style(term.cursor_style());
    out.cursor(term.grid());
    out.bytes
}

/// The primary screen, from the top of its scrollback, whichever screen is
/// showing.
///
/// `alacritty_terminal` exposes only the screen that is showing, so while the
/// alternate one is, this switches to the primary one, copies it and switches
/// back, putting the alternate screen back whole: switching to it again
/// clears it.
pub(crate) fn primary_grid<T: EventListener>(term: &mut Term<T>) -> Grid<Cell> {
    if !term.mode().contains(TermMode::ALT_SCREEN) {
        return term.grid().clone();
    }
    let alternate = term.grid().clone();
    term.swap_alt();
    let primary = term.grid().clone();
    term.swap_alt();
    *term.grid_mut() = alternate;
    primary
}

/// The attributes a cell is written with.
#[derive(Debug, Clone, PartialEq)]
struct Pen {
    fg: Color,
    bg: Color,
    flags: Flags,
    underline: Option<Color>,
    link: Option<Hyperlink>,
}

/// The cell flags that are attributes, rather than layout.
const STYLE: Flags = Flags::INVERSE
    .union(Flags::BOLD)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::DIM)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

impl Default for Pen {
    fn default() -> Self {
        Self::of(&Cell::default())
    }
}

impl Pen {
    fn of(cell: &Cell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            flags: cell.flags & STYLE,
            underline: cell.underline_color(),
            link: cell.hyperlink(),
        }
    }

    fn same_sgr(&self, other: &Self) -> bool {
        self.fg == other.fg
            && self.bg == other.bg
            && self.flags == other.flags
            && self.underline == other.underline
    }
}

#[derive(Default)]
struct Writer {
    bytes: Vec<u8>,
    pen: Pen,
}

impl Writer {
    fn raw(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    fn text(&mut self, text: std::fmt::Arguments<'_>) {
        // Writing to a Vec cannot fail.
        let _ = self.bytes.write_fmt(text);
    }

    fn palette(&mut self, colors: &Colors) {
        for index in 0..256 {
            if let Some(rgb) = colors[index] {
                self.text(format_args!("\x1b]4;{index};{}\x07", spec(rgb)));
            }
        }
        for (named, osc) in [
            (NamedColor::Foreground, 10),
            (NamedColor::Background, 11),
            (NamedColor::Cursor, 12),
        ] {
            if let Some(rgb) = colors[named] {
                self.text(format_args!("\x1b]{osc};{}\x07", spec(rgb)));
            }
        }
    }

    /// Draws `grid` from the top of its scrollback (or of its screen) down,
    /// so lines past the screen's height scroll into the terminal's
    /// scrollback as they did on the host.
    fn grid(&mut self, grid: &Grid<Cell>, with_history: bool) {
        let cols = grid.columns();
        let top = if with_history {
            grid.topmost_line().0
        } else {
            0
        };
        let bottom = grid.bottommost_line().0;
        let mut continues = false;
        for line in top..=bottom {
            if line != top && !continues {
                // A new line takes the pen's background, so it is reset first.
                self.pen(&Pen::default());
                self.raw(b"\r\n");
            }
            let row = &grid[Line(line)];
            let wrapped = row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
            let mut end = if wrapped {
                cols
            } else {
                (0..cols)
                    .rev()
                    .find(|&col| row[Column(col)] != Cell::default())
                    .map_or(0, |col| col + 1)
            };
            if continues {
                // At least one cell, so the line above is marked as wrapping
                // into this one.
                end = end.max(1);
            }
            for col in 0..end {
                let cell = &row[Column(col)];
                // A wide character writes its own spacer, and one that did
                // not fit at the end of a line writes the leading spacer
                // before it.
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                self.pen(&Pen::of(cell));
                if cell.c == '\t' {
                    self.tab(col);
                } else {
                    self.cell(cell);
                }
            }
            continues = wrapped;
        }
        self.pen(&Pen::default());
    }

    fn cell(&mut self, cell: &Cell) {
        let mut buf = [0; 4];
        self.raw(cell.c.encode_utf8(&mut buf).as_bytes());
        for &c in cell.zerowidth().unwrap_or_default() {
            self.raw(c.encode_utf8(&mut buf).as_bytes());
        }
    }

    /// A tab cell: a space in the cell's attributes, turned into a tab where
    /// it stands, then on to the next cell.
    fn tab(&mut self, col: usize) {
        self.raw(b" ");
        self.text(format_args!("\x1b[{}G\t\x1b[{}G", col + 1, col + 2));
    }

    /// The saved cursor, then the cursor, then the pen the program writes
    /// with.
    fn cursor(&mut self, grid: &Grid<Cell>) {
        let saved = &grid.saved_cursor;
        self.goto(saved.point);
        self.pen(&Pen::of(&saved.template));
        self.raw(b"\x1b7");

        let cursor = &grid.cursor;
        self.goto(cursor.point);
        if cursor.input_needs_wrap {
            self.pending_wrap(grid, cursor.point);
        }
        self.pen(&Pen::of(&cursor.template));
    }

    /// Puts the cursor past the end of its line, where the next character
    /// wraps, by writing the line's last cell again.
    fn pending_wrap(&mut self, grid: &Grid<Cell>, point: Point) {
        let row = &grid[point.line];
        let cell = &row[point.column];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) && point.column.0 > 0 {
            let wide = &row[point.column - 1];
            self.goto(Point::new(point.line, point.column - 1));
            self.pen(&Pen::of(wide));
            self.cell(wide);
        } else if !cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
            self.pen(&Pen::of(cell));
            self.cell(cell);
        }
    }

    fn goto(&mut self, point: Point) {
        self.text(format_args!(
            "\x1b[{};{}H",
            point.line.0.max(0) + 1,
            point.column.0 + 1
        ));
    }

    fn pen(&mut self, pen: &Pen) {
        if !self.pen.same_sgr(pen) {
            self.raw(b"\x1b[0");
            for (flag, code) in [
                (Flags::BOLD, "1"),
                (Flags::DIM, "2"),
                (Flags::ITALIC, "3"),
                (Flags::UNDERLINE, "4"),
                (Flags::DOUBLE_UNDERLINE, "4:2"),
                (Flags::UNDERCURL, "4:3"),
                (Flags::DOTTED_UNDERLINE, "4:4"),
                (Flags::DASHED_UNDERLINE, "4:5"),
                (Flags::INVERSE, "7"),
                (Flags::HIDDEN, "8"),
                (Flags::STRIKEOUT, "9"),
            ] {
                if pen.flags.contains(flag) {
                    self.text(format_args!(";{code}"));
                }
            }
            self.colour(pen.fg, Layer::Fg);
            self.colour(pen.bg, Layer::Bg);
            if let Some(colour) = pen.underline {
                self.colour(colour, Layer::Underline);
            }
            self.raw(b"m");
        }
        if self.pen.link != pen.link {
            match &pen.link {
                Some(link) => {
                    self.text(format_args!("\x1b]8;id={};{}\x1b\\", link.id(), link.uri()))
                }
                None => self.raw(b"\x1b]8;;\x1b\\"),
            }
        }
        self.pen = pen.clone();
    }

    fn colour(&mut self, colour: Color, layer: Layer) {
        let (base, bright, extended) = match layer {
            Layer::Fg => (30, 90, 38),
            Layer::Bg => (40, 100, 48),
            Layer::Underline => (0, 0, 58),
        };
        match colour {
            Color::Named(named) => {
                let index = named as usize;
                match (layer, index) {
                    (Layer::Underline, _) => {}
                    (_, 0..=7) => self.text(format_args!(";{}", base + index)),
                    (_, 8..=15) => self.text(format_args!(";{}", bright + index - 8)),
                    // The default colour is what the reset already set.
                    _ => {}
                }
            }
            Color::Indexed(index) => self.text(format_args!(";{extended};5;{index}")),
            Color::Spec(Rgb { r, g, b }) => {
                self.text(format_args!(";{extended};2;{r};{g};{b}"));
            }
        }
    }

    /// Every mode the program changed from a new terminal's.
    fn modes(&mut self, mode: TermMode) {
        let defaults = TermMode::default();
        for (flag, set, reset) in [
            (TermMode::APP_CURSOR, "\x1b[?1h", ""),
            (TermMode::APP_KEYPAD, "\x1b=", ""),
            (TermMode::MOUSE_REPORT_CLICK, "\x1b[?1000h", ""),
            (TermMode::MOUSE_DRAG, "\x1b[?1002h", ""),
            (TermMode::MOUSE_MOTION, "\x1b[?1003h", ""),
            (TermMode::FOCUS_IN_OUT, "\x1b[?1004h", ""),
            (TermMode::UTF8_MOUSE, "\x1b[?1005h", ""),
            (TermMode::SGR_MOUSE, "\x1b[?1006h", ""),
            (TermMode::ALTERNATE_SCROLL, "", "\x1b[?1007l"),
            (TermMode::URGENCY_HINTS, "", "\x1b[?1042l"),
            (TermMode::BRACKETED_PASTE, "\x1b[?2004h", ""),
            (TermMode::SHOW_CURSOR, "", "\x1b[?25l"),
            (TermMode::LINE_WRAP, "", "\x1b[?7l"),
            (TermMode::INSERT, "\x1b[4h", ""),
            (TermMode::LINE_FEED_NEW_LINE, "\x1b[20h", ""),
            (TermMode::ORIGIN, "\x1b[?6h", ""),
        ] {
            let on = mode.contains(flag);
            if on != defaults.contains(flag) {
                self.raw(if on { set } else { reset }.as_bytes());
            }
        }
    }

    fn cursor_style(&mut self, style: CursorStyle) {
        if style == CursorStyle::default() {
            return;
        }
        let steady = match style.shape {
            CursorShape::Block => 2,
            CursorShape::Underline => 4,
            CursorShape::Beam => 6,
            CursorShape::HollowBlock | CursorShape::Hidden => return,
        };
        let code = if style.blinking { steady - 1 } else { steady };
        self.text(format_args!("\x1b[{code} q"));
    }
}

#[derive(Clone, Copy)]
enum Layer {
    Fg,
    Bg,
    Underline,
}

fn spec(Rgb { r, g, b }: Rgb) -> String {
    format!("rgb:{r:02x}/{g:02x}/{b:02x}")
}
