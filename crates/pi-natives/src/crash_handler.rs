//! Native crash diagnostics.
//!
//! Installs Rust-side panic and allocation-error hooks the first time the
//! native module loads, so any crash inside `pi-natives` writes an actionable
//! record (thread, payload, backtrace) to disk and to stderr before the host
//! process exits.
//!
//! Without these hooks, Bun receives only the bare
//! `memory allocation of N bytes failed` line and aborts with no stack —
//! see issue #2211 ("Windows crash: Rust allocator failure after tasklist.exe
//! popup"). The cdylib builds with `panic = "unwind"`, so a panic in vendored
//! uutils code unwinds to the shell boundary and is recovered as a failed
//! command; such recoverable panics are logged to disk only, while fatal
//! crashes (allocation failure, or panics with no active uutils scope) still
//! get the stderr dump + process exit. Either way the record stays diagnosable.
//!
//! Notes:
//! - Backtraces are captured via [`Backtrace::force_capture`], so they work
//!   regardless of `RUST_BACKTRACE`.
//! - The crash log path mirrors the JS side (`packages/utils/src/dirs.ts`):
//!   `$XDG_STATE_HOME/pi/logs/` on Linux / macOS after XDG migration, otherwise
//!   `<home>/.pi/logs/`.
//! - Hook installation is idempotent across repeated module loads.

use std::{
	alloc::Layout,
	backtrace::Backtrace,
	ffi::OsStr,
	fmt::Write as _,
	fs::{self, OpenOptions},
	io::Write as _,
	path::{Path, PathBuf},
	process,
	sync::{
		Once,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{SystemTime, UNIX_EPOCH},
};

/// Default directory name for pi's per-user state.
const CONFIG_DIR_NAME: &str = ".pi";

/// App name used as the XDG-root subdirectory (`$XDG_STATE_HOME/pi/`),
/// matching `APP_NAME` in `packages/utils/src/dirs.ts`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const APP_NAME: &str = "pi";

static INSTALL: Once = Once::new();
static ALLOC_HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Install the panic and allocation-error hooks. Idempotent.
pub fn install() {
	INSTALL.call_once(|| {
		let prev_panic = std::panic::take_hook();
		std::panic::set_hook(Box::new(move |info| {
			let report = format_panic_report(info);
			// A panic raised while a uutils scope is active is caught at the
			// uutils boundary (pi-shell `run_uutil`): the command fails with a
			// non-zero exit instead of crashing the host. Record it to the log
			// for diagnosis, but keep the recovered panic out of the user-facing
			// stderr crash dump and skip the default abort hook.
			let recoverable = pi_uutils_ctx::is_active();
			persist(&report, CrashKind::Panic, !recoverable);
			if !recoverable {
				prev_panic(info);
			}
		}));

		std::alloc::set_alloc_error_hook(|layout| {
			// Print the canonical line before doing anything allocation-prone.
			// If this is genuine process-wide OOM, report formatting/path work may
			// recursively enter this hook; the secondary entry writes the same
			// stack-only fallback and aborts immediately.
			write_alloc_failure_line(std::io::stderr(), layout.size());
			if ALLOC_HOOK_ACTIVE.swap(true, Ordering::AcqRel) {
				process::abort();
			}
			let report = format_alloc_report(layout);
			persist(&report, CrashKind::Alloc, true);
			process::abort();
		});
	});
}

#[derive(Clone, Copy)]
enum CrashKind {
	Panic,
	Alloc,
}

impl CrashKind {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Panic => "panic",
			Self::Alloc => "alloc",
		}
	}
}

fn format_panic_report(info: &std::panic::PanicHookInfo<'_>) -> String {
	let bt = Backtrace::force_capture();
	let location = info.location().map_or_else(
		|| String::from("<unknown>"),
		|l| format!("{}:{}:{}", l.file(), l.line(), l.column()),
	);
	let mut out = report_header(CrashKind::Panic);
	let _ = writeln!(out, "location: {location}");
	let _ = writeln!(out, "message:  {}", panic_payload(info.payload()));
	let _ = writeln!(out, "backtrace:\n{bt}");
	out
}

fn format_alloc_report(layout: Layout) -> String {
	// Capturing a backtrace allocates. If the global allocator is in a state
	// where small allocations keep failing this will recurse into the hook —
	// `Backtrace::force_capture` swallows the secondary failure internally and
	// returns an empty backtrace, which is still strictly more useful than the
	// nothing the default handler prints.
	let bt = Backtrace::force_capture();
	let mut out = report_header(CrashKind::Alloc);
	let _ = writeln!(out, "size:      {} bytes", layout.size());
	let _ = writeln!(out, "alignment: {} bytes", layout.align());
	let _ = writeln!(out, "backtrace:\n{bt}");
	out
}

fn report_header(kind: CrashKind) -> String {
	let thread_name = thread::current().name().unwrap_or("<unnamed>").to_owned();
	let now_ms = unix_millis();
	format!(
		"pi-natives {kind} crash\npid:       {pid}\nthread:    {thread_name}\ntimestamp: {now_ms} \
		 (unix ms)\n",
		kind = kind.as_str(),
		pid = process::id(),
	)
}
fn write_alloc_failure_line(mut out: impl std::io::Write, size: usize) {
	let _ = out.write_all(b"memory allocation of ");
	let mut digits = [0u8; usize::MAX.ilog10() as usize + 1];
	let mut pos = digits.len();
	let mut value = size;
	if value == 0 {
		pos -= 1;
		digits[pos] = b'0';
	} else {
		while value > 0 {
			pos -= 1;
			digits[pos] = b'0' + (value % 10) as u8;
			value /= 10;
		}
	}
	let _ = out.write_all(&digits[pos..]);
	let _ = out.write_all(b" bytes failed\n");
}

fn panic_payload(payload: &(dyn std::any::Any + Send)) -> String {
	if let Some(s) = payload.downcast_ref::<&'static str>() {
		(*s).to_owned()
	} else if let Some(s) = payload.downcast_ref::<String>() {
		s.clone()
	} else {
		String::from("<non-string panic payload>")
	}
}

fn persist(report: &str, kind: CrashKind, echo_stderr: bool) {
	// Echo to stderr so the user sees something even when the file write fails
	// (read-only home, missing $HOME, …). Suppressed for recoverable uutils
	// panics, which surface as a failed command instead of a crash.
	if echo_stderr {
		let _ = writeln!(std::io::stderr(), "{report}");
	}

	let Some(path) = crash_log_path(kind) else {
		return;
	};
	if let Some(parent) = path.parent() {
		let _ = fs::create_dir_all(parent);
	}
	if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
		let _ = f.write_all(report.as_bytes());
		let _ = f.flush();
		let _ = f.sync_data();
		if echo_stderr {
			let _ =
				writeln!(std::io::stderr(), "pi-natives crash report written to {}", path.display());
		}
	}
}

fn crash_log_path(kind: CrashKind) -> Option<PathBuf> {
	let dir = logs_dir()?;
	Some(build_crash_log_path(&dir, kind, process::id(), unix_millis()))
}

fn build_crash_log_path(dir: &Path, kind: CrashKind, pid: u32, now_ms: u128) -> PathBuf {
	dir.join(format!("native-{}-{pid}-{now_ms}.log", kind.as_str()))
}

fn logs_dir() -> Option<PathBuf> {
	let home = home_dir()?;
	let xdg_logs = xdg_state_logs_from_env();
	Some(resolve_logs_dir(&home, xdg_logs))
}

fn resolve_logs_dir(home: &Path, xdg_state_logs: Option<PathBuf>) -> PathBuf {
	// XDG takes precedence so native crash reports land beside JS logs after
	// `pi config init-xdg` migrates state.
	if let Some(p) = xdg_state_logs {
		return p;
	}
	home.join(CONFIG_DIR_NAME).join("logs")
}

/// Compute the XDG-state logs dir if the runtime environment matches the
/// JS-side eligibility rules in `packages/utils/src/dirs.ts`: linux/macos,
/// `$XDG_STATE_HOME` set, and `$XDG_STATE_HOME/pi` exists on disk.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn xdg_state_logs_from_env() -> Option<PathBuf> {
	let xdg_state_home = std::env::var_os("XDG_STATE_HOME");
	xdg_state_logs(xdg_state_home.as_deref(), Path::exists)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::missing_const_for_fn, reason = "windows/non-xdg platforms keep the signature")]
fn xdg_state_logs_from_env() -> Option<PathBuf> {
	None
}

/// Pure XDG-eligibility computation extracted for unit testing — no env
/// reads, no fs reads. `pi_dir_exists` decides whether the candidate
/// `<xdg_state_home>/pi` actually lives on disk.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn xdg_state_logs(
	xdg_state_home: Option<&OsStr>,
	pi_dir_exists: impl FnOnce(&Path) -> bool,
) -> Option<PathBuf> {
	let xdg = xdg_state_home.filter(|s| !s.is_empty())?;
	let pi_dir = Path::new(xdg).join(APP_NAME);
	if !pi_dir_exists(&pi_dir) {
		return None;
	}
	Some(pi_dir.join("logs"))
}

fn home_dir() -> Option<PathBuf> {
	#[cfg(unix)]
	{
		std::env::var_os("HOME").map(PathBuf::from)
	}
	#[cfg(windows)]
	{
		if let Some(profile) = std::env::var_os("USERPROFILE") {
			return Some(PathBuf::from(profile));
		}
		let drive = std::env::var_os("HOMEDRIVE")?;
		let path = std::env::var_os("HOMEPATH")?;
		let mut combined = drive;
		combined.push(path);
		Some(PathBuf::from(combined))
	}
}

fn unix_millis() -> u128 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| d.as_millis())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn alloc_report_contains_size_alignment_and_backtrace() {
		let layout = Layout::from_size_align(7714, 8).unwrap();
		let report = format_alloc_report(layout);
		assert!(report.contains("pi-natives alloc crash"), "report missing header: {report}");
		assert!(report.contains("size:      7714 bytes"), "report missing size: {report}");
		assert!(report.contains("alignment: 8 bytes"), "report missing alignment: {report}");
		assert!(report.contains("backtrace:"), "report missing backtrace section: {report}");
		assert!(
			report.contains(&format!("pid:       {}", process::id())),
			"report missing pid: {report}"
		);
		assert!(report.contains("thread:"), "report missing thread: {report}");
	}

	#[test]
	fn alloc_failure_line_matches_rust_default_text_without_heap_formatting() {
		let mut buf = Vec::new();
		write_alloc_failure_line(&mut buf, 7714);
		assert_eq!(buf, b"memory allocation of 7714 bytes failed\n");
		buf.clear();
		write_alloc_failure_line(&mut buf, usize::MAX);
		assert_eq!(buf, format!("memory allocation of {} bytes failed\n", usize::MAX).as_bytes());
	}

	#[test]
	fn panic_payload_handles_str_string_and_other() {
		let static_str: Box<dyn std::any::Any + Send> = Box::new("static panic");
		assert_eq!(panic_payload(&*static_str), "static panic");

		let owned: Box<dyn std::any::Any + Send> = Box::new(String::from("owned panic"));
		assert_eq!(panic_payload(&*owned), "owned panic");

		let other: Box<dyn std::any::Any + Send> = Box::new(42u32);
		assert_eq!(panic_payload(&*other), "<non-string panic payload>");
	}

	#[test]
	fn resolve_logs_dir_defaults_under_dot_pi() {
		let dir = resolve_logs_dir(Path::new("/tmp/pi-natives-test-home"), None);
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.pi/logs"));
	}

	#[test]
	fn resolve_logs_dir_prefers_xdg_when_provided() {
		let dir = resolve_logs_dir(
			Path::new("/tmp/pi-natives-test-home"),
			Some(PathBuf::from("/xdg/state/pi/logs")),
		);
		assert_eq!(dir, PathBuf::from("/xdg/state/pi/logs"));
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_resolves_when_dir_exists() {
		let dir = xdg_state_logs(Some(OsStr::new("/xdg/state")), |_p| true);
		assert_eq!(dir, Some(PathBuf::from("/xdg/state/pi/logs")));
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_skipped_when_pi_dir_missing() {
		let dir = xdg_state_logs(Some(OsStr::new("/xdg/state")), |_p| false);
		assert_eq!(dir, None);
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_skipped_when_xdg_state_home_unset_or_empty() {
		assert_eq!(xdg_state_logs(None, |_p| true), None);
		assert_eq!(xdg_state_logs(Some(OsStr::new("")), |_p| true), None);
	}

	#[test]
	fn build_crash_log_path_tags_kind_and_pid() {
		let dir = Path::new("/tmp/pi-natives-test-home/.pi/logs");
		let panic_log = build_crash_log_path(dir, CrashKind::Panic, 4242, 1_700_000_000_000);
		assert_eq!(
			panic_log,
			PathBuf::from("/tmp/pi-natives-test-home/.pi/logs/native-panic-4242-1700000000000.log")
		);
		let alloc_log = build_crash_log_path(dir, CrashKind::Alloc, 99, 1);
		assert_eq!(
			alloc_log,
			PathBuf::from("/tmp/pi-natives-test-home/.pi/logs/native-alloc-99-1.log")
		);
	}
}
