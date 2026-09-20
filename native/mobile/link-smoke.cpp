// Link-only probe: forces the packaged library's CPU/Metal registration and
// public C API into the binary without downloading a model or running inference.
#include "llama.h"

int main() {
    llama_backend_init();
    const auto params = llama_context_default_params();
    const bool gpu = llama_supports_gpu_offload();
    llama_backend_free();
    return params.n_ctx > 0 || gpu ? 0 : 1;
}
