// Link-only probe: forces the packaged library's CPU/Metal registration and
// public C API into the binary without downloading a model or running inference.
#include "gezel_llama.h"

int main() {
    auto * engine = gezel_llama_create();
    auto params = gezel_llama_default_load_options();
    gezel_llama_error error{};
    gezel_llama_unload(engine, &error);
    gezel_llama_destroy(engine);
    return params.abi_version == gezel_llama_abi_version() && error.code == GEZEL_LLAMA_OK ? 0 : 1;
}
