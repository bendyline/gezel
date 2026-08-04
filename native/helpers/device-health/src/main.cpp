#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <ctime>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace fs = std::filesystem;

namespace {

struct DeviceReading {
  std::string vendor;
  std::string device_id;
  std::optional<std::string> name;
  std::optional<double> temperature_c;
  std::optional<double> thermal_margin_c;
  std::optional<double> utilization_percent;
  std::optional<double> memory_used_mb;
  std::optional<double> memory_total_mb;
  std::optional<bool> thermal_slowdown;
  std::optional<bool> power_brake;
};

struct ProbeReport {
  std::vector<std::string> sources;
  std::vector<DeviceReading> readings;
  std::vector<std::string> errors;
  std::vector<std::string> diagnostics;
};

std::string json_escape(const std::string& value) {
  std::ostringstream out;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<int>(ch) << std::dec;
        } else {
          out << static_cast<char>(ch);
        }
    }
  }
  return out.str();
}

std::string sampled_at_utc() {
  const auto now = std::chrono::system_clock::now();
  const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(
      now.time_since_epoch()) % 1000;
  const std::time_t time = std::chrono::system_clock::to_time_t(now);
  std::tm utc{};
#ifdef _WIN32
  gmtime_s(&utc, &time);
#else
  gmtime_r(&time, &utc);
#endif
  std::ostringstream out;
  out << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setw(3)
      << std::setfill('0') << milliseconds.count() << 'Z';
  return out.str();
}

void write_string_array(std::ostream& out, const std::vector<std::string>& values) {
  out << '[';
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) out << ',';
    out << '"' << json_escape(values[index]) << '"';
  }
  out << ']';
}

template <typename T>
void write_number_field(std::ostream& out, const char* name,
                        const std::optional<T>& value) {
  if (value && std::isfinite(static_cast<double>(*value))) {
    out << ",\"" << name << "\":" << *value;
  }
}

void write_bool_field(std::ostream& out, const char* name,
                      const std::optional<bool>& value) {
  if (value) out << ",\"" << name << "\":" << (*value ? "true" : "false");
}

std::string serialize_report(const ProbeReport& report,
                             const std::string& sampled_at = sampled_at_utc()) {
  std::ostringstream out;
  out << "{\"schemaVersion\":1,\"sampledAt\":\"" << json_escape(sampled_at)
      << "\",\"sources\":";
  write_string_array(out, report.sources);
  out << ",\"readings\":[";
  for (std::size_t index = 0; index < report.readings.size(); ++index) {
    if (index > 0) out << ',';
    const DeviceReading& reading = report.readings[index];
    out << "{\"vendor\":\"" << json_escape(reading.vendor)
        << "\",\"deviceId\":\"" << json_escape(reading.device_id) << '"';
    if (reading.name) out << ",\"name\":\"" << json_escape(*reading.name) << '"';
    write_number_field(out, "temperatureC", reading.temperature_c);
    write_number_field(out, "thermalMarginC", reading.thermal_margin_c);
    write_number_field(out, "utilizationPercent", reading.utilization_percent);
    write_number_field(out, "memoryUsedMb", reading.memory_used_mb);
    write_number_field(out, "memoryTotalMb", reading.memory_total_mb);
    write_bool_field(out, "thermalSlowdown", reading.thermal_slowdown);
    write_bool_field(out, "powerBrake", reading.power_brake);
    out << '}';
  }
  out << "],\"errors\":";
  write_string_array(out, report.errors);
  out << ",\"diagnostics\":";
  write_string_array(out, report.diagnostics);
  out << '}';
  return out.str();
}

std::optional<std::string> read_text(const fs::path& path) {
  std::ifstream input(path);
  if (!input) return std::nullopt;
  std::ostringstream value;
  value << input.rdbuf();
  std::string text = value.str();
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) {
    text.pop_back();
  }
  return text;
}

std::optional<double> parse_number(const std::optional<std::string>& text) {
  if (!text || text->empty()) return std::nullopt;
  try {
    std::size_t parsed = 0;
    const double value = std::stod(*text, &parsed);
    if (parsed == 0 || !std::isfinite(value)) return std::nullopt;
    return value;
  } catch (...) {
    return std::nullopt;
  }
}

// NVML is loaded dynamically from the installed NVIDIA driver. These small
// declarations mirror its stable public C ABI and avoid a build-time SDK dep.
using NvmlDevice = struct nvmlDevice_st*;
struct NvmlUtilization { unsigned int gpu; unsigned int memory; };
struct NvmlMemory { unsigned long long total; unsigned long long free; unsigned long long used; };
constexpr int kNvmlSuccess = 0;

#ifdef _WIN32
using DynamicLibrary = HMODULE;
void* symbol(DynamicLibrary library, const char* name) {
  return reinterpret_cast<void*>(GetProcAddress(library, name));
}
void close_library(DynamicLibrary library) { if (library) FreeLibrary(library); }

DynamicLibrary load_system_library(const wchar_t* name) {
  wchar_t system_dir[MAX_PATH]{};
  const UINT length = GetSystemDirectoryW(system_dir, MAX_PATH);
  if (length == 0 || length >= MAX_PATH) return nullptr;
  std::wstring path(system_dir, length);
  path += L"\\";
  path += name;
  return LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
}
#else
using DynamicLibrary = void*;
void* symbol(DynamicLibrary library, const char* name) { return dlsym(library, name); }
void close_library(DynamicLibrary library) { if (library) dlclose(library); }
#endif

template <typename T>
T load_symbol(DynamicLibrary library, const char* name) {
  return reinterpret_cast<T>(symbol(library, name));
}

void probe_nvml(ProbeReport& report) {
#ifdef _WIN32
  DynamicLibrary library = load_system_library(L"nvml.dll");
#else
  DynamicLibrary library = dlopen("libnvidia-ml.so.1", RTLD_NOW | RTLD_LOCAL);
#endif
  if (!library) {
    report.diagnostics.push_back("nvml: driver library not found");
    return;
  }

  using Init = int (*)();
  using Shutdown = int (*)();
  using DeviceCount = int (*)(unsigned int*);
  using DeviceHandle = int (*)(unsigned int, NvmlDevice*);
  using DeviceName = int (*)(NvmlDevice, char*, unsigned int);
  using DeviceTemperature = int (*)(NvmlDevice, unsigned int, unsigned int*);
  using DeviceUtilization = int (*)(NvmlDevice, NvmlUtilization*);
  using DeviceMemory = int (*)(NvmlDevice, NvmlMemory*);

  const Init init = load_symbol<Init>(library, "nvmlInit_v2");
  const Shutdown shutdown = load_symbol<Shutdown>(library, "nvmlShutdown");
  const DeviceCount count_devices =
      load_symbol<DeviceCount>(library, "nvmlDeviceGetCount_v2");
  const DeviceHandle get_device =
      load_symbol<DeviceHandle>(library, "nvmlDeviceGetHandleByIndex_v2");
  const DeviceName get_name = load_symbol<DeviceName>(library, "nvmlDeviceGetName");
  const DeviceTemperature get_temperature =
      load_symbol<DeviceTemperature>(library, "nvmlDeviceGetTemperature");
  const DeviceUtilization get_utilization =
      load_symbol<DeviceUtilization>(library, "nvmlDeviceGetUtilizationRates");
  const DeviceMemory get_memory =
      load_symbol<DeviceMemory>(library, "nvmlDeviceGetMemoryInfo");

  if (!init || !shutdown || !count_devices || !get_device) {
    report.errors.push_back("nvml: required entry points are missing");
    close_library(library);
    return;
  }
  if (init() != kNvmlSuccess) {
    report.diagnostics.push_back("nvml: driver rejected telemetry initialization");
    close_library(library);
    return;
  }

  unsigned int count = 0;
  if (count_devices(&count) != kNvmlSuccess) {
    report.errors.push_back("nvml: failed to enumerate devices");
    shutdown();
    close_library(library);
    return;
  }

  const std::size_t initial_count = report.readings.size();
  for (unsigned int index = 0; index < count; ++index) {
    NvmlDevice device = nullptr;
    if (get_device(index, &device) != kNvmlSuccess || !device) continue;
    DeviceReading reading{"nvidia", std::to_string(index)};
    if (get_name) {
      char name[256]{};
      if (get_name(device, name, sizeof(name)) == kNvmlSuccess && name[0] != '\0') {
        reading.name = std::string(name);
      }
    }
    if (get_temperature) {
      unsigned int temperature = 0;
      if (get_temperature(device, 0, &temperature) == kNvmlSuccess) {
        reading.temperature_c = static_cast<double>(temperature);
      }
    }
    if (get_utilization) {
      NvmlUtilization utilization{};
      if (get_utilization(device, &utilization) == kNvmlSuccess) {
        reading.utilization_percent = static_cast<double>(utilization.gpu);
      }
    }
    if (get_memory) {
      NvmlMemory memory{};
      if (get_memory(device, &memory) == kNvmlSuccess) {
        constexpr double bytes_per_mb = 1024.0 * 1024.0;
        reading.memory_used_mb = static_cast<double>(memory.used) / bytes_per_mb;
        reading.memory_total_mb = static_cast<double>(memory.total) / bytes_per_mb;
      }
    }
    report.readings.push_back(std::move(reading));
  }
  if (report.readings.size() > initial_count) {
    report.sources.push_back("nvml");
  } else {
    report.diagnostics.push_back("nvml: no NVIDIA devices exposed by the driver");
  }
  shutdown();
  close_library(library);
}

#ifdef _WIN32

// Minimal AMD ADL ABI declarations. The corresponding SDK definitions are
// MIT-licensed; see ../THIRD_PARTY_NOTICES.md. ADL itself comes from the AMD
// display driver and is loaded only from System32.
constexpr int kAdlOk = 0;
constexpr int kAdlMaxPath = 256;
constexpr int kAdlPmLogMaxSensors = 256;
constexpr int kAdlPmTemperatureEdge = 8;
constexpr int kAdlPmActivityGfx = 19;
constexpr int kAdlPmTemperatureHotspot = 27;
constexpr int kAdlPmThrottlerStatus = 35;
constexpr int kAdlThrottlePower = 1 << 0;
constexpr int kAdlThrottleThermal = 1 << 1;

using AdlContext = void*;
using AdlMallocCallback = void*(__stdcall*)(int);

struct AdlAdapterInfo {
  int size;
  int adapter_index;
  char udid[kAdlMaxPath];
  int bus_number;
  int device_number;
  int function_number;
  int vendor_id;
  char adapter_name[kAdlMaxPath];
  char display_name[kAdlMaxPath];
  int present;
  int exists;
  char driver_path[kAdlMaxPath];
  char driver_path_ext[kAdlMaxPath];
  char pnp_string[kAdlMaxPath];
  int os_display_index;
};

struct AdlSingleSensorData { int supported; int value; };
struct AdlPmLogDataOutput {
  int size;
  AdlSingleSensorData sensors[kAdlPmLogMaxSensors];
};
struct AdlMemoryInfo2 {
  long long memory_size;
  char memory_type[kAdlMaxPath];
  long long memory_bandwidth;
  long long hyper_memory_size;
  long long invisible_memory_size;
  long long visible_memory_size;
};

void* __stdcall adl_alloc(int size) { return std::malloc(static_cast<std::size_t>(size)); }

void probe_amd_adl(ProbeReport& report) {
  DynamicLibrary library = load_system_library(L"atiadlxx.dll");
  if (!library) {
    report.diagnostics.push_back("amd-adl: driver library not found");
    return;
  }

  using Create = int(__stdcall*)(AdlMallocCallback, int, AdlContext*);
  using Destroy = int(__stdcall*)(AdlContext);
  using NumberOfAdapters = int(__stdcall*)(AdlContext, int*);
  using AdapterInfo = int(__stdcall*)(AdlContext, AdlAdapterInfo*, int);
  using QueryPmLog = int(__stdcall*)(AdlContext, int, AdlPmLogDataOutput*);
  using MemoryInfo = int(__stdcall*)(AdlContext, int, AdlMemoryInfo2*);
  using MemoryUsage = int(__stdcall*)(AdlContext, int, int*);

  const Create create = load_symbol<Create>(library, "ADL2_Main_Control_Create");
  const Destroy destroy = load_symbol<Destroy>(library, "ADL2_Main_Control_Destroy");
  const NumberOfAdapters number_of_adapters =
      load_symbol<NumberOfAdapters>(library, "ADL2_Adapter_NumberOfAdapters_Get");
  const AdapterInfo adapter_info =
      load_symbol<AdapterInfo>(library, "ADL2_Adapter_AdapterInfo_Get");
  const QueryPmLog query_pm_log =
      load_symbol<QueryPmLog>(library, "ADL2_New_QueryPMLogData_Get");
  const MemoryInfo memory_info =
      load_symbol<MemoryInfo>(library, "ADL2_Adapter_MemoryInfo2_Get");
  // DedicatedVRAMUsage is the pool-wide Windows counter behind Radeon
  // Software's memory meter. Older drivers may expose only VRAMUsage, whose
  // signature and MB unit are identical, so keep it as a compatibility
  // fallback. Either query is optional: temperature safety must still work
  // on a driver that exposes neither memory counter.
  const MemoryUsage dedicated_memory_usage = load_symbol<MemoryUsage>(
      library, "ADL2_Adapter_DedicatedVRAMUsage_Get");
  const MemoryUsage memory_usage =
      load_symbol<MemoryUsage>(library, "ADL2_Adapter_VRAMUsage_Get");

  if (!create || !destroy || !number_of_adapters || !adapter_info || !query_pm_log) {
    report.errors.push_back("amd-adl: required entry points are missing");
    close_library(library);
    return;
  }

  AdlContext context = nullptr;
  if (create(adl_alloc, 1, &context) != kAdlOk || !context) {
    report.diagnostics.push_back("amd-adl: driver rejected telemetry initialization");
    close_library(library);
    return;
  }

  int count = 0;
  if (number_of_adapters(context, &count) != kAdlOk || count <= 0 || count > 128) {
    report.diagnostics.push_back("amd-adl: no AMD adapters exposed by the driver");
    destroy(context);
    close_library(library);
    return;
  }
  std::vector<AdlAdapterInfo> adapters(static_cast<std::size_t>(count));
  for (auto& adapter : adapters) adapter.size = sizeof(AdlAdapterInfo);
  if (adapter_info(context, adapters.data(), sizeof(AdlAdapterInfo) * count) != kAdlOk) {
    report.errors.push_back("amd-adl: failed to enumerate adapter details");
    destroy(context);
    close_library(library);
    return;
  }

  const std::size_t initial_count = report.readings.size();
  std::set<std::string> physical_devices;
  for (const AdlAdapterInfo& adapter : adapters) {
    if (!adapter.present || adapter.bus_number < 0) continue;
    const std::string key = std::to_string(adapter.bus_number) + ':' +
                            std::to_string(adapter.device_number) + ':' +
                            std::to_string(adapter.function_number);
    if (!physical_devices.insert(key).second) continue;

    AdlPmLogDataOutput data{};
    data.size = sizeof(data);
    if (query_pm_log(context, adapter.adapter_index, &data) != kAdlOk) continue;
    DeviceReading reading{"amd", std::to_string(adapter.adapter_index)};
    if (adapter.adapter_name[0] != '\0') reading.name = std::string(adapter.adapter_name);

    const auto sensor = [&](int index) -> std::optional<double> {
      if (index < 0 || index >= kAdlPmLogMaxSensors || !data.sensors[index].supported) {
        return std::nullopt;
      }
      return static_cast<double>(data.sensors[index].value);
    };
    const auto edge = sensor(kAdlPmTemperatureEdge);
    const auto hotspot = sensor(kAdlPmTemperatureHotspot);
    if (edge && hotspot) reading.temperature_c = std::max(*edge, *hotspot);
    else if (hotspot) reading.temperature_c = hotspot;
    else if (edge) reading.temperature_c = edge;
    reading.utilization_percent = sensor(kAdlPmActivityGfx);

    if (memory_info) {
      AdlMemoryInfo2 memory{};
      if (memory_info(context, adapter.adapter_index, &memory) == kAdlOk &&
          memory.memory_size > 0) {
        reading.memory_total_mb = static_cast<double>(memory.memory_size) / (1024.0 * 1024.0);
      }
    }
    int used_mb = 0;
    const bool has_dedicated_usage =
        dedicated_memory_usage &&
        dedicated_memory_usage(context, adapter.adapter_index, &used_mb) == kAdlOk &&
        used_mb >= 0;
    if (!has_dedicated_usage) {
      used_mb = 0;
    }
    const bool has_compatible_usage =
        !has_dedicated_usage && memory_usage &&
        memory_usage(context, adapter.adapter_index, &used_mb) == kAdlOk && used_mb >= 0;
    if (has_dedicated_usage || has_compatible_usage) {
      reading.memory_used_mb = static_cast<double>(used_mb);
    }
    if (data.sensors[kAdlPmThrottlerStatus].supported) {
      const int throttle = data.sensors[kAdlPmThrottlerStatus].value;
      reading.thermal_slowdown = (throttle & kAdlThrottleThermal) != 0;
      reading.power_brake = (throttle & kAdlThrottlePower) != 0;
    }
    report.readings.push_back(std::move(reading));
  }

  if (report.readings.size() > initial_count) {
    report.sources.push_back("amd-adl");
  } else {
    report.diagnostics.push_back("amd-adl: performance telemetry unavailable for AMD adapters");
  }
  destroy(context);
  close_library(library);
}

#else

std::string lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  return value;
}

std::optional<double> first_hwmon_temperature(const fs::path& device,
                                               std::optional<double>& margin) {
  const fs::path hwmon_root = device / "hwmon";
  std::optional<double> best;
  std::optional<double> best_critical;
  std::error_code error;
  if (!fs::exists(hwmon_root, error)) return std::nullopt;
  for (const auto& hwmon : fs::directory_iterator(hwmon_root, error)) {
    if (error) break;
    for (const auto& entry : fs::directory_iterator(hwmon.path(), error)) {
      if (error) break;
      const std::string filename = entry.path().filename().string();
      if (filename.rfind("temp", 0) != 0 ||
          filename.size() < 7 || filename.substr(filename.size() - 6) != "_input") {
        continue;
      }
      const auto millidegrees = parse_number(read_text(entry.path()));
      if (!millidegrees || *millidegrees < -50000 || *millidegrees > 200000) continue;
      const std::string stem = filename.substr(0, filename.size() - 6);
      const std::string label = lower_ascii(read_text(hwmon.path() / (stem + "_label")).value_or(""));
      const double degrees = *millidegrees / 1000.0;
      const bool preferred = label.find("hotspot") != std::string::npos ||
                             label.find("junction") != std::string::npos ||
                             label.find("edge") != std::string::npos ||
                             label.find("gpu") != std::string::npos;
      if (!best || preferred || degrees > *best) {
        best = degrees;
        const auto critical = parse_number(read_text(hwmon.path() / (stem + "_crit")));
        best_critical = critical ? std::optional<double>(*critical / 1000.0) : std::nullopt;
      }
    }
  }
  if (best && best_critical && *best_critical >= *best) margin = *best_critical - *best;
  return best;
}

void probe_linux_sysfs(ProbeReport& report) {
  const fs::path drm_root("/sys/class/drm");
  std::error_code error;
  if (!fs::exists(drm_root, error)) {
    report.diagnostics.push_back("linux-sysfs: /sys/class/drm is unavailable");
    return;
  }
  const std::size_t initial_count = report.readings.size();
  for (const auto& entry : fs::directory_iterator(drm_root, error)) {
    if (error) break;
    const std::string card = entry.path().filename().string();
    if (card.rfind("card", 0) != 0 || card.find('-') != std::string::npos) continue;
    const fs::path device = entry.path() / "device";
    const std::string vendor_id = lower_ascii(read_text(device / "vendor").value_or(""));
    std::string vendor;
    std::string vendor_name;
    if (vendor_id == "0x1002") {
      vendor = "amd";
      vendor_name = "AMD GPU";
    } else if (vendor_id == "0x8086") {
      vendor = "generic";
      vendor_name = "Intel GPU";
    } else {
      // NVIDIA is handled by NVML; other DRM devices have no stable telemetry ABI.
      continue;
    }

    DeviceReading reading{vendor, card};
    const std::string device_id = read_text(device / "device").value_or("");
    reading.name = device_id.empty() ? vendor_name : vendor_name + " " + device_id;
    reading.temperature_c = first_hwmon_temperature(device, reading.thermal_margin_c);
    reading.utilization_percent = parse_number(read_text(device / "gpu_busy_percent"));
    const auto memory_used = parse_number(read_text(device / "mem_info_vram_used"));
    const auto memory_total = parse_number(read_text(device / "mem_info_vram_total"));
    if (memory_used) reading.memory_used_mb = *memory_used / (1024.0 * 1024.0);
    if (memory_total) reading.memory_total_mb = *memory_total / (1024.0 * 1024.0);

    const bool has_telemetry = reading.temperature_c || reading.utilization_percent ||
                               reading.memory_used_mb || reading.memory_total_mb;
    if (has_telemetry) report.readings.push_back(std::move(reading));
  }
  if (report.readings.size() > initial_count) {
    report.sources.push_back("linux-sysfs");
  } else {
    report.diagnostics.push_back("linux-sysfs: no AMD or Intel GPU telemetry found");
  }
}

#endif

ProbeReport sample_devices() {
  ProbeReport report;
  probe_nvml(report);
#ifdef _WIN32
  probe_amd_adl(report);
#else
  probe_linux_sysfs(report);
#endif
  return report;
}

int self_test() {
  ProbeReport report;
  report.sources = {"contract-test"};
  DeviceReading reading{"amd", "card0"};
  reading.name = "GPU \"A\"";
  reading.temperature_c = 72.5;
  reading.thermal_margin_c = 17.5;
  reading.utilization_percent = 99;
  reading.memory_used_mb = 4096;
  reading.memory_total_mb = 16384;
  reading.thermal_slowdown = false;
  reading.power_brake = true;
  report.readings.push_back(reading);
  report.diagnostics.push_back("line one\nline two");
  const std::string json = serialize_report(report, "2026-07-13T00:00:00.000Z");
  const std::vector<std::string> required = {
      "\"schemaVersion\":1", "\"vendor\":\"amd\"", "\"temperatureC\":72.5",
      "\"powerBrake\":true", "GPU \\\"A\\\"", "line one\\nline two"};
  for (const std::string& fragment : required) {
    if (json.find(fragment) == std::string::npos) {
      std::cerr << "self-test failed: missing " << fragment << '\n';
      return 1;
    }
  }
  if (parse_number(std::optional<std::string>("123.5")) != 123.5 ||
      parse_number(std::optional<std::string>("not-a-number"))) {
    std::cerr << "self-test failed: numeric parser\n";
    return 1;
  }
  std::cout << "device-health self-test passed\n";
  return 0;
}

void print_help() {
  std::cout
      << "Gezel device health helper\n\n"
      << "Usage:\n"
      << "  gezel-device-health sample --json\n"
      << "  gezel-device-health --self-test\n";
}

}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--self-test") return self_test();
  if (argc == 2 && (std::string(argv[1]) == "--help" || std::string(argv[1]) == "-h")) {
    print_help();
    return 0;
  }
  if (argc == 3 && std::string(argv[1]) == "sample" && std::string(argv[2]) == "--json") {
    std::cout << serialize_report(sample_devices()) << '\n';
    return 0;
  }
  print_help();
  return argc == 1 ? 0 : 2;
}
