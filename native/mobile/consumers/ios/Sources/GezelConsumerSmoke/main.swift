import GezelLlama

precondition(gezel_llama_abi_version() == 1)
guard let engine = gezel_llama_create() else { fatalError("Could not create Gezel runtime") }
gezel_llama_destroy(engine)
print("Gezel prebuilt runtime linked successfully")
