// gezel-service-host — the Windows service host for gezeld.
//
// Registered by the Gezel installer as the ImagePath of `GezelService`
// (restricted LocalService). Replaces the vendored NSSM wrapper with a
// host whose launch contract is compiled in: it can only spawn its
// sibling `Gezel.exe` running `<home>\service\dist\bin\gezeld.js`, with
// a fixed environment derived from its own install location and the
// fixed data home. There is deliberately no flag, subcommand, or config
// channel that makes it run anything else — a signed general-purpose
// service wrapper is a persistence gadget; this binary is not.
//
// Responsibilities (what NSSM used to provide):
//   - spawn gezeld with the service environment, CWD = data home
//   - redirect child stdout/stderr to logs\service-{stdout,stderr}.log
//     with 10 MB spawn-time rotation
//   - restart on crash (3 restarts per 60 s sliding budget, no backoff —
//     parity with the Electron supervisor's constants)
//   - graceful stop: CTRL_BREAK to the child's process group (gezeld
//     handles SIGBREAK), 3 s grace, then job-object kill of the whole
//     process tree
//
// The pure path/env/rotation/budget logic is platform-neutral and
// exercised by `--self-test` (wired into CTest); all Win32 service code
// is behind _WIN32.

#include <algorithm>
#include <cstdint>
#include <cwchar>
#include <cwctype>
#include <deque>
#include <functional>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#include <filesystem>
namespace fs = std::filesystem;
#endif

namespace {

// The service/host constants are only referenced from the _WIN32 block;
// [[maybe_unused]] keeps the cross-platform self-test build warning-clean.
[[maybe_unused]] constexpr wchar_t kServiceName[] = L"GezelService";
[[maybe_unused]] constexpr wchar_t kDefaultHome[] = L"C:\\ProgramData\\Gezel";
// Parity with packages/app/src/supervisor/index.ts GRACEFUL_STOP_MS /
// RESTART_BUDGET_COUNT / RESTART_BUDGET_WINDOW_MS.
[[maybe_unused]] constexpr unsigned long kGraceMs = 3000;
[[maybe_unused]] constexpr unsigned long kPostKillWaitMs = 2000;
constexpr int kRestartBudget = 3;
constexpr unsigned long long kBudgetWindowMs = 60000;
[[maybe_unused]] constexpr unsigned long long kFastExitMs = 5000;
// Parity with the NSSM-era AppRotateBytes setting.
constexpr unsigned long long kRotateBytes = 10485760;
[[maybe_unused]] constexpr int kRotateKeep = 5;

using EnvEntry = std::pair<std::wstring, std::wstring>;

std::wstring to_lower(const std::wstring& value) {
  std::wstring out;
  out.reserve(value.size());
  for (const wchar_t ch : value) out.push_back(static_cast<wchar_t>(std::towlower(ch)));
  return out;
}

// ── Pure logic (self-tested, no Win32) ─────────────────────────────

std::wstring derive_instdir(const std::wstring& module_path) {
  const size_t slash = module_path.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return L".";
  if (slash == 0) return module_path.substr(0, 1);
  return module_path.substr(0, slash);
}

std::wstring build_child_cmdline(const std::wstring& instdir, const std::wstring& home) {
  return L"\"" + instdir + L"\\Gezel.exe\" \"" + home + L"\\service\\dist\\bin\\gezeld.js\"";
}

// The service environment contract, formerly NSSM's AppEnvironmentExtra
// in installer/nsis-hooks.nsh. GEZEL_PORT=43935 reserves the canonical
// machine-service endpoint; CLI-owned fallback daemons use ephemeral ports.
// GEZEL_SYSTEM_SCOPE=1 tells gezeld the runtime auth-token is a cross-account
// client credential. The TEMP/TMP overrides matter too — without them
// Chromium/Node temp writes land in the unwritable LocalService
// profile.
std::vector<EnvEntry> env_overrides(const std::wstring& instdir, const std::wstring& home) {
  const std::wstring unpacked = instdir + L"\\resources\\app.asar.unpacked";
  return {
      {L"ELECTRON_RUN_AS_NODE", L"1"},
      {L"GEZEL_HOME", home},
      {L"GEZEL_PORT", L"43935"},
      {L"GEZEL_SYSTEM_SCOPE", L"1"},
      {L"GEZEL_UI_DIR", unpacked + L"\\dist\\ui"},
      {L"GEZEL_PNPM_PATH", unpacked + L"\\dist\\pnpm-bundle\\bin\\pnpm.mjs"},
      {L"GEZEL_NODE_PATH", unpacked + L"\\dist\\node-bundle\\node.exe"},
      {L"GEZEL_NATIVE_BIN_DIR", unpacked + L"\\native-bin"},
      {L"HOME", home},
      {L"USERPROFILE", home},
      {L"APPDATA", home + L"\\appdata"},
      {L"LOCALAPPDATA", home + L"\\localappdata"},
      {L"TEMP", home + L"\\tmp"},
      {L"TMP", home + L"\\tmp"},
      {L"TMPDIR", home + L"\\tmp"},
  };
}

// Parse a CreateProcess-style double-null environment block. Entries
// may legally start with '=' (drive-cwd records) — the key search
// starts at index 1.
std::vector<EnvEntry> parse_env_block(const std::wstring& block) {
  std::vector<EnvEntry> out;
  size_t pos = 0;
  while (pos < block.size()) {
    const size_t end = block.find(L'\0', pos);
    const std::wstring entry = block.substr(pos, end - pos);
    if (entry.empty()) break;
    const size_t eq = entry.find(L'=', 1);
    if (eq != std::wstring::npos) {
      out.emplace_back(entry.substr(0, eq), entry.substr(eq + 1));
    }
    pos = (end == std::wstring::npos) ? block.size() : end + 1;
  }
  return out;
}

// Case-insensitive upsert of overrides into the inherited block, then
// the case-insensitive sort CreateProcessW's environment convention
// expects. Inherited vars (SystemRoot, PATH, COMSPEC, …) must survive.
std::vector<EnvEntry> merge_env(std::vector<EnvEntry> base, const std::vector<EnvEntry>& overrides) {
  for (const EnvEntry& override_entry : overrides) {
    const std::wstring key = to_lower(override_entry.first);
    bool replaced = false;
    for (EnvEntry& existing : base) {
      if (to_lower(existing.first) == key) {
        existing = override_entry;
        replaced = true;
        break;
      }
    }
    if (!replaced) base.push_back(override_entry);
  }
  std::sort(base.begin(), base.end(), [](const EnvEntry& a, const EnvEntry& b) {
    return to_lower(a.first) < to_lower(b.first);
  });
  return base;
}

std::wstring serialize_env_block(const std::vector<EnvEntry>& entries) {
  std::wstring block;
  for (const EnvEntry& entry : entries) {
    block += entry.first;
    block += L'=';
    block += entry.second;
    block += L'\0';
  }
  block += L'\0';
  return block;
}

bool should_rotate(unsigned long long size_bytes) { return size_bytes >= kRotateBytes; }

// service-stdout + tm → service-stdout-20260723-101502.log. The
// sortable timestamp format is what lets pruning use a plain sort.
std::wstring rotated_name(const std::wstring& base, int year, int month, int day, int hour,
                          int minute, int second) {
  wchar_t buf[32];
  swprintf(buf, sizeof(buf) / sizeof(buf[0]), L"-%04d%02d%02d-%02d%02d%02d.log", year, month, day,
           hour, minute, second);
  return base + buf;
}

std::vector<std::wstring> rotations_to_prune(std::vector<std::wstring> names, int keep) {
  std::sort(names.begin(), names.end(), std::greater<std::wstring>());
  if (static_cast<int>(names.size()) <= keep) return {};
  return {names.begin() + keep, names.end()};
}

class RestartBudget {
 public:
  bool allow(unsigned long long now_ms) {
    while (!attempts_.empty() && attempts_.front() + kBudgetWindowMs <= now_ms) {
      attempts_.pop_front();
    }
    if (static_cast<int>(attempts_.size()) >= kRestartBudget) return false;
    attempts_.push_back(now_ms);
    return true;
  }

 private:
  std::deque<unsigned long long> attempts_;
};

enum class Command { Run, Help, SelfTest, Invalid };

Command parse_cli(int argc, char** argv) {
  if (argc == 2) {
    const std::string arg = argv[1];
    if (arg == "run") return Command::Run;
    if (arg == "--help" || arg == "-h") return Command::Help;
    if (arg == "--self-test") return Command::SelfTest;
  }
  return Command::Invalid;
}

void print_help() {
  std::cout << "Gezel service host\n\n"
            << "Runs gezeld as the GezelService Windows service. Registered by the\n"
            << "Gezel installer; the `run` entry only works when started by the\n"
            << "Windows Service Control Manager.\n\n"
            << "Usage:\n"
            << "  gezel-service-host run          (SCM service entry)\n"
            << "  gezel-service-host --self-test\n"
            << "  gezel-service-host --help\n";
}

// ── Self-test ──────────────────────────────────────────────────────

int self_test() {
  int failures = 0;
  const auto expect = [&failures](bool cond, const char* what) {
    if (!cond) {
      std::cerr << "self-test failed: " << what << '\n';
      failures += 1;
    }
  };

  expect(derive_instdir(L"C:\\Program Files\\Gezel\\gezel-service-host.exe") ==
             L"C:\\Program Files\\Gezel",
         "instdir derivation");

  expect(build_child_cmdline(L"C:\\Program Files\\Gezel", L"C:\\ProgramData\\Gezel") ==
             L"\"C:\\Program Files\\Gezel\\Gezel.exe\" "
             L"\"C:\\ProgramData\\Gezel\\service\\dist\\bin\\gezeld.js\"",
         "child cmdline quoting");

  const std::vector<EnvEntry> overrides =
      env_overrides(L"C:\\Program Files\\Gezel", L"C:\\ProgramData\\Gezel");
  const std::vector<std::pair<std::wstring, std::wstring>> expected_env = {
      {L"ELECTRON_RUN_AS_NODE", L"1"},
      {L"GEZEL_HOME", L"C:\\ProgramData\\Gezel"},
      {L"GEZEL_PORT", L"43935"},
      {L"GEZEL_SYSTEM_SCOPE", L"1"},
      {L"GEZEL_UI_DIR",
       L"C:\\Program Files\\Gezel\\resources\\app.asar.unpacked\\dist\\ui"},
      {L"GEZEL_PNPM_PATH",
       L"C:\\Program Files\\Gezel\\resources\\app.asar.unpacked\\dist\\pnpm-bundle\\bin\\pnpm.mjs"},
      {L"GEZEL_NODE_PATH",
       L"C:\\Program Files\\Gezel\\resources\\app.asar.unpacked\\dist\\node-bundle\\node.exe"},
      {L"GEZEL_NATIVE_BIN_DIR",
       L"C:\\Program Files\\Gezel\\resources\\app.asar.unpacked\\native-bin"},
      {L"HOME", L"C:\\ProgramData\\Gezel"},
      {L"USERPROFILE", L"C:\\ProgramData\\Gezel"},
      {L"APPDATA", L"C:\\ProgramData\\Gezel\\appdata"},
      {L"LOCALAPPDATA", L"C:\\ProgramData\\Gezel\\localappdata"},
      {L"TEMP", L"C:\\ProgramData\\Gezel\\tmp"},
      {L"TMP", L"C:\\ProgramData\\Gezel\\tmp"},
      {L"TMPDIR", L"C:\\ProgramData\\Gezel\\tmp"},
  };
  expect(overrides.size() == expected_env.size(), "env override count");
  for (const auto& want : expected_env) {
    bool found = false;
    for (const auto& have : overrides) {
      if (have.first == want.first) {
        found = have.second == want.second;
        break;
      }
    }
    expect(found, "env override value");
    if (!found) std::wcerr << L"  missing/mismatched: " << want.first << L'\n';
  }

  const std::vector<EnvEntry> base = {
      {L"Path", L"C:\\Windows"}, {L"SystemRoot", L"C:\\Windows"}, {L"temp", L"C:\\old-temp"}};
  const std::vector<EnvEntry> merged =
      merge_env(base, {{L"TEMP", L"C:\\new-temp"}, {L"GEZEL_HOME", L"C:\\ProgramData\\Gezel"}});
  expect(merged.size() == 4, "merge size");
  bool temp_replaced = false;
  bool system_root_kept = false;
  for (const auto& entry : merged) {
    if (to_lower(entry.first) == L"temp") temp_replaced = entry.second == L"C:\\new-temp";
    if (entry.first == L"SystemRoot") system_root_kept = true;
  }
  expect(temp_replaced, "case-insensitive env override wins");
  expect(system_root_kept, "inherited env survives merge");
  expect(std::is_sorted(merged.begin(), merged.end(),
                        [](const EnvEntry& a, const EnvEntry& b) {
                          return to_lower(a.first) < to_lower(b.first);
                        }),
         "merged env sorted");

  const std::wstring block =
      serialize_env_block({{L"A", L"1"}, {L"B", L"two"}});
  const std::wstring expected_block = std::wstring(L"A=1\0B=two\0\0", 11);
  expect(block == expected_block, "env block serialization");
  const std::vector<EnvEntry> reparsed = parse_env_block(block);
  expect(reparsed.size() == 2 && reparsed[1].second == L"two", "env block round-trip");
  expect(parse_env_block(std::wstring(L"=C:=C:\\cwd\0X=y\0\0", 16)).size() == 2,
         "drive-cwd entries parse");

  expect(!should_rotate(kRotateBytes - 1) && should_rotate(kRotateBytes), "rotation threshold");
  expect(rotated_name(L"service-stdout", 2026, 7, 23, 10, 15, 2) ==
             L"service-stdout-20260723-101502.log",
         "rotation naming");
  const std::vector<std::wstring> pruned = rotations_to_prune(
      {L"service-stdout-20260101-000000.log", L"service-stdout-20260301-000000.log",
       L"service-stdout-20260201-000000.log"},
      2);
  expect(pruned.size() == 1 && pruned[0] == L"service-stdout-20260101-000000.log",
         "rotation pruning keeps newest");

  RestartBudget budget;
  expect(budget.allow(0) && budget.allow(1000) && budget.allow(2000), "budget allows 3");
  expect(!budget.allow(3000), "budget denies 4th inside window");
  expect(budget.allow(61500), "budget window slides");

  const char* run_args[] = {"gezel-service-host", "run"};
  const char* help_args[] = {"gezel-service-host", "--help"};
  const char* bad_args[] = {"gezel-service-host", "install"};
  expect(parse_cli(2, const_cast<char**>(run_args)) == Command::Run, "cli run");
  expect(parse_cli(2, const_cast<char**>(help_args)) == Command::Help, "cli help");
  expect(parse_cli(2, const_cast<char**>(bad_args)) == Command::Invalid, "cli rejects unknown");
  expect(parse_cli(1, const_cast<char**>(run_args)) == Command::Invalid, "cli rejects bare");

  if (failures > 0) return 1;
  std::cout << "service-host self-test passed\n";
  return 0;
}

#ifdef _WIN32

// ── Win32 service layer ────────────────────────────────────────────

SERVICE_STATUS_HANDLE g_status_handle = nullptr;
CRITICAL_SECTION g_status_lock;
DWORD g_check_point = 1;
HANDLE g_stop_event = nullptr;
HANDLE g_host_log = INVALID_HANDLE_VALUE;
bool g_console_ok = false;

void host_log(const std::wstring& message) {
  if (g_host_log == INVALID_HANDLE_VALUE) return;
  SYSTEMTIME st;
  GetLocalTime(&st);
  wchar_t prefix[40];
  swprintf(prefix, 40, L"%04d-%02d-%02dT%02d:%02d:%02d ", st.wYear, st.wMonth, st.wDay, st.wHour,
           st.wMinute, st.wSecond);
  std::wstring line = std::wstring(prefix) + message + L"\r\n";
  int needed = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (needed <= 1) return;
  std::string utf8(static_cast<size_t>(needed - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, line.c_str(), -1, utf8.data(), needed, nullptr, nullptr);
  DWORD written = 0;
  WriteFile(g_host_log, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
}

// The single funnel for SetServiceStatus. dwCheckPoint must increase
// monotonically across the HandlerEx thread and the SvcMain thread —
// never call SetServiceStatus anywhere else.
void report_status(DWORD state, DWORD win32_exit, DWORD service_exit, DWORD wait_hint) {
  EnterCriticalSection(&g_status_lock);
  SERVICE_STATUS status{};
  status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState = state;
  status.dwWin32ExitCode = win32_exit;
  status.dwServiceSpecificExitCode = service_exit;
  status.dwWaitHint = wait_hint;
  status.dwControlsAccepted =
      (state == SERVICE_RUNNING) ? (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN) : 0;
  status.dwCheckPoint =
      (state == SERVICE_RUNNING || state == SERVICE_STOPPED) ? 0 : g_check_point++;
  SetServiceStatus(g_status_handle, &status);
  LeaveCriticalSection(&g_status_lock);
}

DWORD WINAPI handler_ex(DWORD control, DWORD, LPVOID, LPVOID) {
  switch (control) {
    case SERVICE_CONTROL_STOP:
    case SERVICE_CONTROL_SHUTDOWN:
      report_status(SERVICE_STOP_PENDING, NO_ERROR, 0, 10000);
      SetEvent(g_stop_event);
      return NO_ERROR;
    case SERVICE_CONTROL_INTERROGATE:
      return NO_ERROR;
    default:
      return ERROR_CALL_NOT_IMPLEMENTED;
  }
}

BOOL WINAPI host_ctrl_handler(DWORD) {
  // The CTRL_BREAK we emit targets the child's process group, which the
  // host is not part of — but a handler guarantees the host can never be
  // taken down by console events regardless.
  return TRUE;
}

void rotate_file_if_needed(const fs::path& dir, const std::wstring& base) {
  const fs::path current = dir / (base + L".log");
  std::error_code ec;
  const auto size = fs::file_size(current, ec);
  if (ec || !should_rotate(size)) return;
  SYSTEMTIME st;
  GetLocalTime(&st);
  const std::wstring target =
      rotated_name(base, st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
  fs::rename(current, dir / target, ec);
  std::vector<std::wstring> rotations;
  for (const auto& entry : fs::directory_iterator(dir, ec)) {
    const std::wstring name = entry.path().filename().wstring();
    if (name.rfind(base + L"-", 0) == 0 && name.size() > base.size() + 5) {
      rotations.push_back(name);
    }
  }
  for (const std::wstring& stale : rotations_to_prune(rotations, kRotateKeep)) {
    fs::remove(dir / stale, ec);
  }
}

HANDLE open_append_handle(const fs::path& path, bool inheritable) {
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = inheritable ? TRUE : FALSE;
  // FILE_APPEND_DATA (not GENERIC_WRITE): kernel-level atomic appends
  // serialize interleaved writers.
  return CreateFileW(path.c_str(), FILE_APPEND_DATA,
                     FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &sa, OPEN_ALWAYS,
                     FILE_ATTRIBUTE_NORMAL, nullptr);
}

HANDLE make_job() {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  // Kill-on-close is the backstop: if the host dies for any reason, the
  // whole gezeld tree dies with it. No breakaway flags — Node/libuv
  // children never request breakaway, so nothing legitimate needs it,
  // and a compromised child cannot escape containment.
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    CloseHandle(job);
    return nullptr;
  }
  return job;
}

struct Child {
  HANDLE process = nullptr;
  DWORD pid = 0;
  ULONGLONG started_at = 0;
};

bool spawn_child(const std::wstring& cmdline, const std::wstring& env_block,
                 const std::wstring& home, HANDLE out_handle, HANDLE err_handle, HANDLE nul_handle,
                 HANDLE job, Child* child) {
  SIZE_T attr_size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attr_size);
  std::vector<unsigned char> attr_buf(attr_size);
  auto* attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attr_buf.data());
  if (!InitializeProcThreadAttributeList(attrs, 1, 0, &attr_size)) return false;
  HANDLE inherit[3] = {nul_handle, out_handle, err_handle};
  if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit,
                                 sizeof(inherit), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attrs);
    return false;
  }

  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = nul_handle;
  si.StartupInfo.hStdOutput = out_handle;
  si.StartupInfo.hStdError = err_handle;
  si.lpAttributeList = attrs;

  // Console strategy is LOAD-BEARING: the child must share the host's
  // (hidden, session-0) console for GenerateConsoleCtrlEvent to reach
  // it — that is gezeld's only graceful-stop path on Windows. Do NOT
  // add CREATE_NO_WINDOW / DETACHED_PROCESS / CREATE_NEW_CONSOLE here:
  // any of them silently turns every stop into a hard kill.
  // CREATE_NEW_PROCESS_GROUP makes the child's pid a ctrl-event target
  // group; CREATE_SUSPENDED lets us jail it in the job before it can
  // spawn anything.
  std::wstring mutable_cmdline = cmdline;
  std::wstring mutable_env = env_block;
  PROCESS_INFORMATION pi{};
  const BOOL ok = CreateProcessW(
      nullptr, mutable_cmdline.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP |
          CREATE_UNICODE_ENVIRONMENT,
      mutable_env.data(), home.c_str(), &si.StartupInfo, &pi);
  DeleteProcThreadAttributeList(attrs);
  if (!ok) return false;

  if (job && !AssignProcessToJobObject(job, pi.hProcess)) {
    host_log(L"AssignProcessToJobObject failed; terminating child");
    TerminateProcess(pi.hProcess, 1);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return false;
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  child->process = pi.hProcess;
  child->pid = pi.dwProcessId;
  child->started_at = GetTickCount64();
  return true;
}

void stop_ladder(Child* child, HANDLE job) {
  if (child->process && WaitForSingleObject(child->process, 0) == WAIT_TIMEOUT) {
    BOOL sent = FALSE;
    if (g_console_ok) {
      sent = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child->pid);
      host_log(sent ? L"sent CTRL_BREAK to gezeld" : L"CTRL_BREAK failed; hard stop");
    }
    if (sent) {
      const ULONGLONG deadline = GetTickCount64() + kGraceMs;
      for (;;) {
        const ULONGLONG now = GetTickCount64();
        if (now >= deadline) break;
        const DWORD slice = static_cast<DWORD>(std::min<ULONGLONG>(1000, deadline - now));
        const DWORD wait = WaitForSingleObject(child->process, slice);
        report_status(SERVICE_STOP_PENDING, NO_ERROR, 0, 10000);
        if (wait == WAIT_OBJECT_0) {
          host_log(L"gezeld exited gracefully");
          break;
        }
      }
    }
  }
  // Unconditional sweep: even after a graceful child exit, grandchildren
  // (engine servers, ptys, python) may linger in the job.
  if (job) TerminateJobObject(job, 1);
  if (child->process) {
    WaitForSingleObject(child->process, kPostKillWaitMs);
    report_status(SERVICE_STOP_PENDING, NO_ERROR, 0, 5000);
    CloseHandle(child->process);
    child->process = nullptr;
  }
  if (job) CloseHandle(job);
  host_log(L"service stopped");
  report_status(SERVICE_STOPPED, NO_ERROR, 0, 0);
}

void supervise(const std::wstring& cmdline, const std::wstring& env_block,
               const std::wstring& home, const fs::path& logs_dir, HANDLE nul_handle, HANDLE job) {
  RestartBudget budget;
  bool first_spawn = true;
  for (;;) {
    rotate_file_if_needed(logs_dir, L"service-stdout");
    rotate_file_if_needed(logs_dir, L"service-stderr");
    HANDLE out_handle = open_append_handle(logs_dir / L"service-stdout.log", true);
    HANDLE err_handle = open_append_handle(logs_dir / L"service-stderr.log", true);
    if (out_handle == INVALID_HANDLE_VALUE || err_handle == INVALID_HANDLE_VALUE) {
      host_log(L"failed to open child log files");
      if (out_handle != INVALID_HANDLE_VALUE) CloseHandle(out_handle);
      if (err_handle != INVALID_HANDLE_VALUE) CloseHandle(err_handle);
      if (job) CloseHandle(job);
      report_status(SERVICE_STOPPED, ERROR_OPEN_FAILED, 0, 0);
      return;
    }

    Child child;
    const bool spawned =
        spawn_child(cmdline, env_block, home, out_handle, err_handle, nul_handle, job, &child);
    // The child holds inherited copies; releasing ours keeps the files
    // renamable for the next rotation pass.
    CloseHandle(out_handle);
    CloseHandle(err_handle);
    if (!spawned) {
      const DWORD error = GetLastError();
      host_log(L"CreateProcess for gezeld failed, error " + std::to_wstring(error));
      if (job) CloseHandle(job);
      report_status(SERVICE_STOPPED, error ? error : ERROR_PROCESS_ABORTED, 0, 0);
      return;
    }
    host_log(L"gezeld started, pid " + std::to_wstring(child.pid));
    if (first_spawn) {
      report_status(SERVICE_RUNNING, NO_ERROR, 0, 0);
      first_spawn = false;
    }

    HANDLE waits[2] = {g_stop_event, child.process};
    const DWORD which = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    if (which == WAIT_OBJECT_0) {
      stop_ladder(&child, job);
      return;
    }

    DWORD exit_code = 0;
    GetExitCodeProcess(child.process, &exit_code);
    const ULONGLONG ran_ms = GetTickCount64() - child.started_at;
    if (exit_code == 1 && ran_ms < kFastExitMs) {
      host_log(L"gezeld exited 1 after " + std::to_wstring(ran_ms) +
               L"ms - likely another daemon owns the home (see service-stderr.log)");
    } else {
      host_log(L"gezeld exited code " + std::to_wstring(exit_code) + L" after " +
               std::to_wstring(ran_ms) + L"ms");
    }
    // Sweep orphaned grandchildren BEFORE respawn — a stale engine
    // server would squat ports and model locks the new gezeld needs.
    if (job) TerminateJobObject(job, exit_code);
    CloseHandle(child.process);

    if (!budget.allow(GetTickCount64())) {
      host_log(L"restart budget exhausted (3 crashes in 60s); stopping service");
      if (job) CloseHandle(job);
      report_status(SERVICE_STOPPED, ERROR_SERVICE_SPECIFIC_ERROR, exit_code, 0);
      return;
    }
  }
}

void WINAPI svc_main(DWORD, LPWSTR*) {
  g_status_handle = RegisterServiceCtrlHandlerExW(kServiceName, handler_ex, nullptr);
  if (!g_status_handle) return;
  report_status(SERVICE_START_PENDING, NO_ERROR, 0, 10000);
  g_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  wchar_t module_path[MAX_PATH];
  GetModuleFileNameW(nullptr, module_path, MAX_PATH);
  const std::wstring instdir = derive_instdir(module_path);
  const std::wstring home = kDefaultHome;
  const fs::path home_path(home);
  const fs::path logs_dir = home_path / L"logs";

  // Never create the home itself: the installer owns its hardened ACL,
  // and a host-created directory would carry default ProgramData
  // permissions. logs\ under the hardened parent is fine.
  std::error_code ec;
  if (!fs::exists(home_path, ec)) {
    report_status(SERVICE_STOPPED, ERROR_PATH_NOT_FOUND, 0, 0);
    return;
  }
  fs::create_directory(logs_dir, ec);

  rotate_file_if_needed(logs_dir, L"service-host");
  g_host_log = open_append_handle(logs_dir / L"service-host.log", false);

  const fs::path gezel_exe = fs::path(instdir) / L"Gezel.exe";
  const fs::path gezeld_js = home_path / L"service" / L"dist" / L"bin" / L"gezeld.js";
  if (!fs::exists(gezel_exe, ec) || !fs::exists(gezeld_js, ec)) {
    host_log(L"missing launch target: " +
             (fs::exists(gezel_exe, ec) ? gezeld_js.wstring() : gezel_exe.wstring()));
    report_status(SERVICE_STOPPED, ERROR_FILE_NOT_FOUND, 0, 0);
    return;
  }

  // Services start without a console; create a hidden session-0 one so
  // ctrl events can reach the child (see spawn_child).
  if (AllocConsole() || GetLastError() == ERROR_ACCESS_DENIED) {
    g_console_ok = true;
    SetConsoleCtrlHandler(nullptr, TRUE);
    SetConsoleCtrlHandler(host_ctrl_handler, TRUE);
  } else {
    host_log(L"AllocConsole failed; graceful stop degraded to hard kill");
  }

  LPWCH raw_env = GetEnvironmentStringsW();
  std::wstring inherited;
  if (raw_env) {
    const wchar_t* cursor = raw_env;
    while (*cursor) {
      const size_t len = wcslen(cursor);
      inherited.append(cursor, len + 1);
      cursor += len + 1;
    }
    FreeEnvironmentStringsW(raw_env);
  }
  const std::wstring env_block =
      serialize_env_block(merge_env(parse_env_block(inherited), env_overrides(instdir, home)));
  const std::wstring cmdline = build_child_cmdline(instdir, home);

  HANDLE nul_handle;
  {
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    nul_handle = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                             OPEN_EXISTING, 0, nullptr);
  }

  HANDLE job = make_job();
  if (!job) host_log(L"CreateJobObject failed; process-tree containment degraded");

  host_log(L"service host starting: " + cmdline);
  supervise(cmdline, env_block, home, logs_dir, nul_handle, job);

  if (nul_handle != INVALID_HANDLE_VALUE) CloseHandle(nul_handle);
  if (g_host_log != INVALID_HANDLE_VALUE) CloseHandle(g_host_log);
}

int run_service() {
  InitializeCriticalSection(&g_status_lock);
  wchar_t name[] = L"GezelService";
  SERVICE_TABLE_ENTRYW table[] = {{name, svc_main}, {nullptr, nullptr}};
  if (!StartServiceCtrlDispatcherW(table)) {
    if (GetLastError() == ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
      std::cerr << "gezel-service-host must be started by the Windows Service Control "
                   "Manager (service GezelService); it has no standalone mode.\n";
      return 3;
    }
    return 4;
  }
  return 0;
}

#else

int run_service() {
  std::cerr << "gezel-service-host is Windows-only; `run` does nothing on this platform.\n";
  return 2;
}

#endif  // _WIN32

}  // namespace

int main(int argc, char** argv) {
  switch (parse_cli(argc, argv)) {
    case Command::Help:
      print_help();
      return 0;
    case Command::SelfTest:
      return self_test();
    case Command::Run:
      return run_service();
    case Command::Invalid:
    default:
      print_help();
      return argc == 1 ? 0 : 2;
  }
}
