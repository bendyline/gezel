import GezelRuntime
import GezelCapacitor

public func runtime() throws -> GezelNativeRuntime { try .shared() }
public func plugin() -> GezelRuntimePlugin { GezelRuntimePlugin() }
